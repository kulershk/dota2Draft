package lobby

import (
	"context"
	"fmt"
	"lobbybot/bot"
	"lobbybot/protocol"
	"log"
	"sync"
	"time"
)

type SendFunc func(msgType string, data interface{}) error

type Lobby struct {
	ID                  string
	GameName            string
	Password            string
	ServerRegion        int
	GameMode            int
	AutoAssignTeams     bool
	LeagueID            int
	DotaTvDelay         int
	Cheats              bool
	AllowSpectating     bool
	PauseSetting        int
	SelectionPriority   int
	CmPick              int
	PenaltyRadiant      int
	PenaltyDire         int
	SeriesType          int
	RadiantName           string
	DireName              string
	ExpectedRadiantTeamId int
	ExpectedDireTeamId    int
	ExpectedPlayers       []protocol.LobbyPlayer
	JoinedPlayers   []protocol.LobbyPlayer
	Bot             *bot.Bot
	Status          string
	MatchID         string
	cancel          context.CancelFunc
}

type Manager struct {
	lobbies    map[string]*Lobby
	mu         sync.RWMutex
	botManager *bot.Manager
	send       SendFunc
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

	// Find an available bot
	b := m.botManager.FindAvailable()
	if b == nil {
		m.mu.Unlock()
		m.send("lobby_error", protocol.LobbyErrorEvent{
			LobbyID: cmd.LobbyID,
			Error:   "No available bot",
		})
		return fmt.Errorf("no available bot")
	}

	ctx, cancel := context.WithCancel(context.Background())
	gameMode := cmd.GameMode
	if gameMode == 0 {
		gameMode = 2 // default Captain's Mode
	}

	lobby := &Lobby{
		ID:                cmd.LobbyID,
		GameName:          cmd.GameName,
		Password:          cmd.Password,
		ServerRegion:      cmd.ServerRegion,
		GameMode:          gameMode,
		AutoAssignTeams:   cmd.AutoAssignTeams,
		LeagueID:          cmd.LeagueID,
		DotaTvDelay:       cmd.DotaTvDelay,
		Cheats:            cmd.Cheats,
		AllowSpectating:   cmd.AllowSpectating,
		PauseSetting:      cmd.PauseSetting,
		SelectionPriority: cmd.SelectionPriority,
		CmPick:            cmd.CmPick,
		PenaltyRadiant:    cmd.PenaltyRadiant,
		PenaltyDire:       cmd.PenaltyDire,
		SeriesType:        cmd.SeriesType,
		RadiantName:           cmd.RadiantName,
		DireName:              cmd.DireName,
		ExpectedRadiantTeamId: cmd.ExpectedRadiantTeamId,
		ExpectedDireTeamId:    cmd.ExpectedDireTeamId,
		ExpectedPlayers:       cmd.Players,
		Bot:             b,
		Status:          "creating",
		cancel:          cancel,
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
	botLog("(Lobby state updates are tracked via GC events)")

	// Wait for game start, cancel, or timeout (45 min max)
	select {
	case <-lobby.Bot.GameStartedCh():
		botLog("Game started — leaving lobby and freeing bot")
	case <-ctx.Done():
		botLog("Lobby cancelled")
	case <-time.After(45 * time.Minute):
		botLog("Lobby timed out after 45 minutes")
		m.send("lobby_error", protocol.LobbyErrorEvent{LobbyID: lobby.ID, Error: "Lobby timed out"})
	}

	lobby.Bot.LeaveLobby()
	lobby.Bot.SetActiveLobbyID("")
	lobby.Bot.SetExpectedTeams(nil)
	lobby.Bot.SetBusy(false)
	m.removeLobby(lobby.ID)
}

func (m *Manager) CancelLobby(lobbyID string) error {
	m.mu.RLock()
	lobby, ok := m.lobbies[lobbyID]
	m.mu.RUnlock()

	if !ok {
		return fmt.Errorf("lobby %s not found", lobbyID)
	}

	log.Printf("[Lobby %s] Cancelling", lobbyID)
	if lobby.cancel != nil {
		lobby.cancel()
	}
	if lobby.Bot != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		lobby.Bot.DestroyLobby(ctx)
		lobby.Bot.SetBusy(false)
	}

	m.send("lobby_status", protocol.LobbyStatusEvent{
		LobbyID: lobbyID,
		Status:  "cancelled",
	})

	m.removeLobby(lobbyID)
	return nil
}

func (m *Manager) ForceLaunch(lobbyID string) error {
	m.mu.RLock()
	lobby, ok := m.lobbies[lobbyID]
	m.mu.RUnlock()

	if !ok {
		return fmt.Errorf("lobby %s not found", lobbyID)
	}

	log.Printf("[Lobby %s] Force launching", lobbyID)

	// Validate team IDs — both sides must have a team selected
	detRadiant, detDire := lobby.Bot.GetDetectedTeamIds()
	if detRadiant == 0 {
		errMsg := "Radiant has no team selected"
		m.send("lobby_error", protocol.LobbyErrorEvent{LobbyID: lobbyID, Error: errMsg})
		return fmt.Errorf(errMsg)
	}
	if detDire == 0 {
		errMsg := "Dire has no team selected"
		m.send("lobby_error", protocol.LobbyErrorEvent{LobbyID: lobbyID, Error: errMsg})
		return fmt.Errorf(errMsg)
	}
	// Validate against expected team IDs (saved from first game)
	if lobby.ExpectedRadiantTeamId != 0 && detRadiant != lobby.ExpectedRadiantTeamId {
		errMsg := fmt.Sprintf("Wrong Radiant team: expected %d, got %d", lobby.ExpectedRadiantTeamId, detRadiant)
		m.send("lobby_error", protocol.LobbyErrorEvent{LobbyID: lobbyID, Error: errMsg})
		return fmt.Errorf(errMsg)
	}
	if lobby.ExpectedDireTeamId != 0 && detDire != lobby.ExpectedDireTeamId {
		errMsg := fmt.Sprintf("Wrong Dire team: expected %d, got %d", lobby.ExpectedDireTeamId, detDire)
		m.send("lobby_error", protocol.LobbyErrorEvent{LobbyID: lobbyID, Error: errMsg})
		return fmt.Errorf(errMsg)
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
