package lobby

import (
	"context"
	"errors"
	"fmt"
	"lobbybot/bot"
	"lobbybot/protocol"
	"log"
	"sync"
	"time"
)

type SendFunc func(msgType string, data interface{}) error

type Lobby struct {
	ID                    string
	GameName              string
	Password              string
	ServerRegion          int
	GameMode              int
	AutoAssignTeams       bool
	LeagueID              int
	DotaTvDelay           int
	Cheats                bool
	AllowSpectating       bool
	PauseSetting          int
	SelectionPriority     int
	CmPick                int
	PenaltyRadiant        int
	PenaltyDire           int
	SeriesType            int
	RadiantName           string
	DireName              string
	ExpectedRadiantTeamId int
	ExpectedDireTeamId    int
	ExpectedPlayers       []protocol.LobbyPlayer
	JoinedPlayers         []protocol.LobbyPlayer
	Bot                   *bot.Bot
	Status                string
	MatchID               string
	TimeoutMinutes        int
	cancel                context.CancelFunc
}

type Manager struct {
	lobbies    map[string]*Lobby
	mu         sync.RWMutex
	botManager *bot.Manager
	send       SendFunc
}

func (l *Lobby) timeoutDuration() time.Duration {
	if l.TimeoutMinutes > 0 {
		return time.Duration(l.TimeoutMinutes) * time.Minute
	}
	return 10 * time.Minute // default
}

type gameWaitResult int

const (
	gameWaitStarted gameWaitResult = iota
	gameWaitCancelled
	gameWaitTimeout
)

// draftFailsafe caps how long the bot stays in the lobby after a game launch
// waiting for the draft to be confirmed before leaving anyway.
const draftFailsafe = 2 * time.Minute

// awaitGameStart blocks until the lobby's game is safely underway, the
// context is cancelled, or the player-wait timeout elapses. When the game
// launches the bot does NOT leave immediately: if some players fail to load,
// the match is aborted and everyone is dumped back into this lobby — a bot
// that already left can't manage the re-launch. So it holds the lobby until
// the draft actually starts (all players loaded), with a failsafe, and on an
// aborted start it resumes watching (the timeout restarts — players are
// actively in the lobby at that point).
func (m *Manager) awaitGameStart(ctx context.Context, b *bot.Bot, timeout time.Duration, botLog func(string)) gameWaitResult {
	for {
		select {
		case <-b.GameStartedCh():
			botLog("Game launched — staying in lobby until the draft starts (players loading)")
			switch b.WaitForDraft(ctx, draftFailsafe) {
			case bot.DraftStarted:
				botLog("Draft started — all players loaded")
				return gameWaitStarted
			case bot.DraftWaitExpired:
				botLog(fmt.Sprintf("Draft not confirmed within %d minutes — leaving lobby anyway", int(draftFailsafe.Minutes())))
				return gameWaitStarted
			case bot.DraftAborted:
				botLog("Game start aborted — players returned to the lobby; resuming watch")
			case bot.DraftCancelled:
				return gameWaitCancelled
			}
		case <-ctx.Done():
			return gameWaitCancelled
		case <-time.After(timeout):
			return gameWaitTimeout
		}
	}
}

func NewManager(botMgr *bot.Manager, send SendFunc) *Manager {
	return &Manager{
		lobbies:    make(map[string]*Lobby),
		botManager: botMgr,
		send:       send,
	}
}

func (m *Manager) CreateLobby(cmd protocol.CreateLobbyCmd) error {
	m.mu.Lock()
	if _, exists := m.lobbies[cmd.LobbyID]; exists {
		m.mu.Unlock()
		return fmt.Errorf("lobby %s already exists", cmd.LobbyID)
	}

	// Use the specific bot that Node selected (so both sides agree on which
	// bot is busy). Fall back to FindAvailable for backwards compatibility.
	var b *bot.Bot
	if cmd.BotID != "" {
		b = m.botManager.GetBot(cmd.BotID)
		if b == nil {
			m.mu.Unlock()
			m.send("lobby_error", protocol.LobbyErrorEvent{
				LobbyID: cmd.LobbyID,
				Error:   fmt.Sprintf("Specified bot %s not found", cmd.BotID),
			})
			return fmt.Errorf("bot %s not found", cmd.BotID)
		}
		if !b.IsAvailable() {
			m.mu.Unlock()
			m.send("lobby_error", protocol.LobbyErrorEvent{
				LobbyID: cmd.LobbyID,
				Error:   fmt.Sprintf("Specified bot %s is not available (status: %s)", cmd.BotID, b.Status),
			})
			return fmt.Errorf("bot %s not available", cmd.BotID)
		}
	} else {
		b = m.botManager.FindAvailable()
		if b == nil {
			m.mu.Unlock()
			m.send("lobby_error", protocol.LobbyErrorEvent{
				LobbyID: cmd.LobbyID,
				Error:   "No available bot",
			})
			return fmt.Errorf("no available bot")
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	gameMode := cmd.GameMode
	if gameMode == 0 {
		gameMode = 2 // default Captain's Mode
	}

	lobby := &Lobby{
		ID:                    cmd.LobbyID,
		GameName:              cmd.GameName,
		Password:              cmd.Password,
		ServerRegion:          cmd.ServerRegion,
		GameMode:              gameMode,
		AutoAssignTeams:       cmd.AutoAssignTeams,
		LeagueID:              cmd.LeagueID,
		DotaTvDelay:           cmd.DotaTvDelay,
		Cheats:                cmd.Cheats,
		AllowSpectating:       cmd.AllowSpectating,
		PauseSetting:          cmd.PauseSetting,
		SelectionPriority:     cmd.SelectionPriority,
		CmPick:                cmd.CmPick,
		PenaltyRadiant:        cmd.PenaltyRadiant,
		PenaltyDire:           cmd.PenaltyDire,
		SeriesType:            cmd.SeriesType,
		RadiantName:           cmd.RadiantName,
		DireName:              cmd.DireName,
		ExpectedRadiantTeamId: cmd.ExpectedRadiantTeamId,
		ExpectedDireTeamId:    cmd.ExpectedDireTeamId,
		ExpectedPlayers:       cmd.Players,
		Bot:                   b,
		Status:                "creating",
		TimeoutMinutes:        cmd.TimeoutMinutes,
		cancel:                cancel,
	}
	m.lobbies[cmd.LobbyID] = lobby
	m.mu.Unlock()

	// Mark bot as busy
	b.SetBusy(true)

	go m.runLobby(ctx, lobby)
	return nil
}

func (m *Manager) runLobby(ctx context.Context, lobby *Lobby) {
	botLog := func(msg string) {
		m.send("bot_log", protocol.BotLogEvent{
			BotID:   lobby.Bot.ID,
			Message: msg,
		})
		log.Printf("[Lobby %s] %s", lobby.ID, msg)
	}

	// Set active lobby ID, expected team assignments, and expected team IDs on bot
	lobby.Bot.SetActiveLobbyID(lobby.ID)
	lobby.Bot.SetExpectedTeams(lobby.ExpectedPlayers)
	lobby.Bot.SetEnforceTeams(lobby.AutoAssignTeams)
	lobby.Bot.SetExpectedTeamIds(lobby.ExpectedRadiantTeamId, lobby.ExpectedDireTeamId)

	botLog(fmt.Sprintf("Creating lobby '%s' (region: %d, mode: %d)", lobby.GameName, lobby.ServerRegion, lobby.GameMode))

	err := lobby.Bot.CreatePracticeLobby(lobby.GameName, lobby.Password, bot.LobbyOptions{
		ServerRegion:      lobby.ServerRegion,
		GameMode:          lobby.GameMode,
		LeagueId:          lobby.LeagueID,
		DotaTvDelay:       lobby.DotaTvDelay,
		Cheats:            lobby.Cheats,
		AllowSpectating:   lobby.AllowSpectating,
		PauseSetting:      lobby.PauseSetting,
		SelectionPriority: lobby.SelectionPriority,
		CmPick:            lobby.CmPick,
		PenaltyRadiant:    lobby.PenaltyRadiant,
		PenaltyDire:       lobby.PenaltyDire,
		SeriesType:        lobby.SeriesType,
		RadiantName:       lobby.RadiantName,
		DireName:          lobby.DireName,
	})
	if err != nil {
		botLog(fmt.Sprintf("Failed to create lobby: %v", err))
		m.send("lobby_error", protocol.LobbyErrorEvent{LobbyID: lobby.ID, Error: err.Error()})
		lobby.Bot.SetActiveLobbyID("")
		lobby.Bot.SetBusy(false)
		m.removeLobby(lobby.ID)
		// A context-deadline error means the GC never answered the create —
		// the bot's GC session is almost certainly dead, and go-dota2 won't
		// recover it on its own. Without this, every later create on this bot
		// would time out the same way until someone restarts it. Force a
		// reconnect so the bot self-heals for the next attempt.
		if errors.Is(err, context.DeadlineExceeded) {
			lobby.Bot.RecoverGCSession("create lobby timed out — GC not responding")
		}
		return
	}

	// Wait for GC to confirm lobby creation (up to 10s)
	botLog("Waiting for GC to confirm lobby creation...")
	time.Sleep(3 * time.Second)

	botLog(fmt.Sprintf("Lobby created. Password: %s", lobby.Password))
	lobby.Status = "waiting"
	m.send("lobby_status", protocol.LobbyStatusEvent{LobbyID: lobby.ID, Status: "waiting"})

	// Invite all players
	botLog(fmt.Sprintf("Inviting %d players...", len(lobby.ExpectedPlayers)))
	for _, p := range lobby.ExpectedPlayers {
		if p.SteamID != "" {
			lobby.Bot.InvitePlayer(p.SteamID)
			botLog(fmt.Sprintf("Invited %s (%s) to %s", p.Name, p.SteamID, p.Team))
		}
	}

	botLog("Lobby ready. Waiting for players to join...")
	botLog("(Lobby state updates are tracked via GC events + cache polling fallback)")

	// Poll the lobby cache as a safety net: go-dota2 sometimes stops delivering
	// cache subscription events mid-lobby, which means we'd miss the match-id
	// assignment and game-start transition. Polling keeps b.lastLobby fresh and
	// triggers gameStartedCh even when the subscriber channel goes quiet.
	pollCtx, pollCancel := context.WithCancel(ctx)
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-pollCtx.Done():
				return
			case <-ticker.C:
				lobby.Bot.PollLobbyFromCache()
			}
		}
	}()
	defer pollCancel()

	// Wait for the game to be safely underway, cancel, or timeout
	timeout := lobby.timeoutDuration()
	gameStarted := false
	switch m.awaitGameStart(ctx, lobby.Bot, timeout, botLog) {
	case gameWaitStarted:
		botLog("Game started — leaving lobby and freeing bot")
		gameStarted = true
	case gameWaitCancelled:
		botLog("Lobby cancelled")
	case gameWaitTimeout:
		botLog(fmt.Sprintf("Lobby timed out after %d minutes — destroying lobby", int(timeout.Minutes())))
		m.send("lobby_error", protocol.LobbyErrorEvent{LobbyID: lobby.ID, Error: fmt.Sprintf("Lobby timed out (%d min)", int(timeout.Minutes()))})
	}

	if gameStarted {
		lobby.Bot.AbandonAndLeaveLobby()
	} else {
		destroyCtx, destroyCancel := context.WithTimeout(context.Background(), 5*time.Second)
		lobby.Bot.DestroyLobby(destroyCtx)
		destroyCancel()
		lobby.Bot.LeaveLobby()
	}
	lobby.Bot.SetActiveLobbyID("")
	lobby.Bot.SetExpectedTeams(nil)
	lobby.Bot.SetBusy(false)
	m.removeLobby(lobby.ID)
}

func (m *Manager) RejoinLobby(cmd protocol.RejoinLobbyCmd) error {
	m.mu.Lock()
	if _, exists := m.lobbies[cmd.LobbyID]; exists {
		m.mu.Unlock()
		log.Printf("[Lobby %s] Already tracked, skipping rejoin", cmd.LobbyID)
		return nil
	}

	// Find the specific bot (it may be busy since it was assigned to this lobby)
	b := m.botManager.GetBot(cmd.BotID)
	if b == nil {
		m.mu.Unlock()
		log.Printf("[Lobby %s] Bot %s not found for rejoin", cmd.LobbyID, cmd.BotID)
		return fmt.Errorf("bot %s not found", cmd.BotID)
	}

	ctx, cancel := context.WithCancel(context.Background())
	lobby := &Lobby{
		ID:              cmd.LobbyID,
		GameName:        cmd.GameName,
		Password:        cmd.Password,
		ExpectedPlayers: cmd.Players,
		Bot:             b,
		Status:          "waiting",
		TimeoutMinutes:  cmd.TimeoutMinutes,
		cancel:          cancel,
	}
	m.lobbies[cmd.LobbyID] = lobby
	m.mu.Unlock()

	// Claim the lobby before checking the cache: SetActiveLobbyID also stops the
	// watcher's "stale lobby with no assignment" sweep from leaving the real
	// Dota lobby while we wait for the cache to confirm it.
	b.SetBusy(true)
	b.SetActiveLobbyID(cmd.LobbyID)
	b.SetExpectedTeams(cmd.Players)
	b.SetEnforceTeams(cmd.AutoAssignTeams)

	log.Printf("[Lobby %s] Rejoining — bot %s re-watching lobby", cmd.LobbyID, cmd.BotID)
	m.send("bot_log", protocol.BotLogEvent{
		BotID:   cmd.BotID,
		Message: fmt.Sprintf("Rejoining lobby '%s' after reconnect — waiting for GC lobby cache", cmd.GameName),
	})

	go func() {
		defer func() {
			b.SetActiveLobbyID("")
			b.SetExpectedTeams(nil)
			b.SetBusy(false)
			m.removeLobby(cmd.LobbyID)
		}()

		// Wait up to 15s for the SO cache to deliver the lobby. Right after a
		// service restart the rejoin command arrives milliseconds after
		// ClientWelcomed — long before the GC has sent the lobby snapshot — so a
		// single instant IsInLobby() check here always concluded "lost" and tore
		// down a lobby the bot was still sitting in.
		inLobby := b.IsInLobby()
		for i := 0; !inLobby && i < 15; i++ {
			select {
			case <-ctx.Done():
				log.Printf("[Lobby %s] Cancelled while waiting for lobby cache after rejoin", cmd.LobbyID)
				return
			case <-time.After(1 * time.Second):
			}
			b.PollLobbyFromCache()
			inLobby = b.IsInLobby()
		}
		if !inLobby {
			// Bot really lost the lobby — report error
			m.send("bot_log", protocol.BotLogEvent{
				BotID:   cmd.BotID,
				Message: fmt.Sprintf("Bot is NOT in Dota lobby anymore — lobby '%s' may need to be recreated", cmd.GameName),
			})
			m.send("lobby_error", protocol.LobbyErrorEvent{
				LobbyID: cmd.LobbyID,
				Error:   "Bot lost connection to lobby after reconnect",
			})
			return
		}

		// Bot is still in the Dota lobby — re-track it
		m.send("bot_log", protocol.BotLogEvent{
			BotID:   cmd.BotID,
			Message: fmt.Sprintf("Lobby '%s' confirmed via GC cache — re-tracking", cmd.GameName),
		})
		m.send("lobby_status", protocol.LobbyStatusEvent{
			LobbyID: cmd.LobbyID,
			Status:  "waiting",
		})

		timeout := lobby.timeoutDuration()

		// Cache polling fallback — see runLobby for rationale
		pollCtx, pollCancel := context.WithCancel(ctx)
		defer pollCancel()
		go func() {
			ticker := time.NewTicker(15 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-pollCtx.Done():
					return
				case <-ticker.C:
					b.PollLobbyFromCache()
				}
			}
		}()

		botLog := func(msg string) {
			log.Printf("[Lobby %s] %s", cmd.LobbyID, msg)
			m.send("bot_log", protocol.BotLogEvent{BotID: cmd.BotID, Message: msg})
		}

		switch m.awaitGameStart(ctx, b, timeout, botLog) {
		case gameWaitStarted:
			botLog("Game started after rejoin — leaving lobby and freeing bot")
			b.AbandonAndLeaveLobby()
		case gameWaitCancelled:
			botLog("Lobby cancelled after rejoin — destroying")
			destroyCtx, destroyCancel := context.WithTimeout(context.Background(), 5*time.Second)
			b.DestroyLobby(destroyCtx)
			destroyCancel()
			b.LeaveLobby()
		case gameWaitTimeout:
			botLog(fmt.Sprintf("Lobby timed out after rejoin (%d min) — destroying", int(timeout.Minutes())))
			m.send("lobby_error", protocol.LobbyErrorEvent{LobbyID: cmd.LobbyID, Error: fmt.Sprintf("Lobby timed out (%d min)", int(timeout.Minutes()))})
			destroyCtx, destroyCancel := context.WithTimeout(context.Background(), 5*time.Second)
			b.DestroyLobby(destroyCtx)
			destroyCancel()
			b.LeaveLobby()
		}
	}()

	return nil
}

func (m *Manager) CancelLobby(lobbyID string) error {
	m.mu.RLock()
	lobby, ok := m.lobbies[lobbyID]
	m.mu.RUnlock()

	if !ok {
		return fmt.Errorf("lobby %s not found", lobbyID)
	}

	log.Printf("[Lobby %s] Cancelling", lobbyID)
	if lobby.Bot != nil {
		m.send("bot_log", protocol.BotLogEvent{
			BotID:   lobby.Bot.ID,
			Message: fmt.Sprintf("ACTION: CancelLobby(%s)", lobbyID),
		})
	}

	// Only cancel the context. runLobby (or the rejoin watcher) owns the teardown
	// on ctx.Done — DestroyLobby, free the bot, removeLobby. Doing that teardown
	// here as well would double-free the bot and let the delayed runLobby cleanup
	// destroy/clear a lobby the freed bot was meanwhile reassigned to.
	if lobby.cancel != nil {
		lobby.cancel()
	} else if lobby.Bot != nil {
		// No watcher context (shouldn't happen) — free the bot directly so it
		// isn't stranded busy.
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		lobby.Bot.DestroyLobby(ctx)
		lobby.Bot.SetBusy(false)
		m.removeLobby(lobbyID)
	}

	m.send("lobby_status", protocol.LobbyStatusEvent{
		LobbyID: lobbyID,
		Status:  "cancelled",
	})
	return nil
}

func (m *Manager) ForceLaunch(lobbyID string, skipValidation bool) error {
	m.mu.RLock()
	lobby, ok := m.lobbies[lobbyID]
	m.mu.RUnlock()

	if !ok {
		return fmt.Errorf("lobby %s not found", lobbyID)
	}

	log.Printf("[Lobby %s] Force launching", lobbyID)
	m.send("bot_log", protocol.BotLogEvent{
		BotID:   lobby.Bot.ID,
		Message: fmt.Sprintf("ACTION: ForceLaunch(%s, skipValidation=%v)", lobbyID, skipValidation),
	})

	if !skipValidation {
		// Validate team IDs — both sides must have a team selected
		detRadiant, detDire := lobby.Bot.GetDetectedTeamIds()
		if detRadiant == 0 {
			errMsg := "Radiant has no team selected"
			m.send("lobby_error", protocol.LobbyErrorEvent{LobbyID: lobbyID, Error: errMsg})
			return errors.New(errMsg)
		}
		if detDire == 0 {
			errMsg := "Dire has no team selected"
			m.send("lobby_error", protocol.LobbyErrorEvent{LobbyID: lobbyID, Error: errMsg})
			return errors.New(errMsg)
		}
		// Validate against expected team IDs (saved from first game)
		if lobby.ExpectedRadiantTeamId != 0 && detRadiant != lobby.ExpectedRadiantTeamId {
			errMsg := fmt.Sprintf("Wrong Radiant team: expected %d, got %d", lobby.ExpectedRadiantTeamId, detRadiant)
			m.send("lobby_error", protocol.LobbyErrorEvent{LobbyID: lobbyID, Error: errMsg})
			return errors.New(errMsg)
		}
		if lobby.ExpectedDireTeamId != 0 && detDire != lobby.ExpectedDireTeamId {
			errMsg := fmt.Sprintf("Wrong Dire team: expected %d, got %d", lobby.ExpectedDireTeamId, detDire)
			m.send("lobby_error", protocol.LobbyErrorEvent{LobbyID: lobbyID, Error: errMsg})
			return errors.New(errMsg)
		}
	}

	m.send("bot_log", protocol.BotLogEvent{
		BotID:   lobby.Bot.ID,
		Message: "Force launching game...",
	})
	lobby.Bot.LaunchLobby()

	m.send("lobby_status", protocol.LobbyStatusEvent{
		LobbyID: lobbyID,
		Status:  "launching",
	})
	return nil
}

func (m *Manager) removeLobby(lobbyID string) {
	m.mu.Lock()
	delete(m.lobbies, lobbyID)
	m.mu.Unlock()
}
