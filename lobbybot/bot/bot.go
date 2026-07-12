package bot

import (
	"context"
	"encoding/hex"
	"fmt"
	"lobbybot/protocol"
	"log"
	"sync"
	"time"

	"github.com/paralin/go-dota2"
	"github.com/paralin/go-dota2/cso"
	devents "github.com/paralin/go-dota2/events"
	gcccm "github.com/paralin/go-dota2/protocol"
	"github.com/paralin/go-dota2/socache"
	"github.com/paralin/go-steam"
	"github.com/paralin/go-steam/protocol/steamlang"
	"github.com/paralin/go-steam/steamid"
	"github.com/sirupsen/logrus"
)

const (
	StatusOffline      = "offline"
	StatusConnecting   = "connecting"
	StatusAwaitGuard   = "awaiting_guard"
	StatusConnectingGC = "connecting_gc"
	StatusAvailable    = "available"
	StatusBusy         = "busy"
	StatusError        = "error"
)

type Bot struct {
	ID           string
	Username     string
	Password     string
	RefreshToken string
	Status       string
	SteamID      string
	DisplayName  string

	send SendFunc
	mu   sync.Mutex
	// processMu serializes the two goroutines that diff lobby state against
	// lastLobby (the cache-event watcher and the 15s safety poll) so their
	// read-diff-write sequences can't interleave. Always acquired before b.mu,
	// never while holding it.
	processMu sync.Mutex
	guardCh   chan string
	// cancelCh belongs to the current connect session; Disconnect closes it so
	// every waiter (reconnect sleeps, Steam Guard wait) observes cancellation.
	// Connect creates a fresh one, so a stale close can't abort a new session.
	cancelCh              chan struct{}
	steamClient           *steam.Client
	dotaClient            *dota2.Dota2
	pendingAuth           bool   // waiting for Steam Guard code
	pendingGuardCode      string // code to use on next connect
	guardIsTwoFactor      bool   // true = mobile auth, false = email
	sentryHash            steam.SentryHash
	loginKey              string
	usedTokenLogin        bool                // last logon attempt used the refresh token
	loginFailedHard       bool                // logon rejected (bad token/password) — don't auto-reconnect
	activeLobbyID         string              // lobby DB ID for event routing
	expectedTeams         map[uint64]string   // steamID64 → "radiant"/"dire"
	gameStartedCh         chan struct{}       // signals when game has started
	lastLobby             *gcccm.CSODOTALobby // last known lobby state for diffing
	lobbyCacheCancel      func()              // cancel the lobby cache watcher
	expectedRadiantTeamId int
	expectedDireTeamId    int
	detectedRadiantTeamId int
	detectedDireTeamId    int
	launchSent            bool // prevent repeated LaunchLobby calls
	gameStartedSent       bool // game_started already sent for the current lobby (reset per lobby in SetActiveLobbyID)
	gcReady               bool // GC session is live (welcomed / HAVE_SESSION); gates going back to 'available'
	enforceTeams          bool // kick players onto their expected team (lobbyAutoAssignTeams); off = free team pick
}

func NewBot(id, username, password, refreshToken string, send SendFunc) *Bot {
	return &Bot{
		ID:            id,
		Username:      username,
		Password:      password,
		RefreshToken:  refreshToken,
		Status:        StatusOffline,
		send:          send,
		guardCh:       make(chan string, 1),
		gameStartedCh: make(chan struct{}, 1),
	}
}

func (b *Bot) log(msg string) {
	log.Printf("[Bot %s] %s", b.ID, msg)
	b.send("bot_log", protocol.BotLogEvent{BotID: b.ID, Message: msg})
}

func (b *Bot) setStatus(status string, errMsg ...string) {
	b.mu.Lock()
	b.Status = status
	steamID := b.SteamID
	displayName := b.DisplayName
	b.mu.Unlock()

	evt := protocol.BotStatusEvent{
		BotID:       b.ID,
		Status:      status,
		SteamID:     steamID,
		DisplayName: displayName,
	}
	if len(errMsg) > 0 {
		evt.Error = errMsg[0]
	}
	b.send("bot_status", evt)
}

func (b *Bot) Connect() {
	// Guard against double-connect. A second Connect() on a bot that's already
	// live (non-terminal status) would create a duplicate Steam client + event
	// loop on the same account, orphaning the first session; the two goroutines
	// then race b.Status and can leave the bot stuck reporting 'offline' even
	// though it's connected. This fires after a Node restart, when the freshly
	// reset DB makes Node auto-connect bots the Go service still holds live.
	// Legitimate restarts (RecoverGCSession, idle-recycle, manual reconnect, the
	// internal reconnect loop) all Disconnect() first, which sets StatusOffline,
	// so they pass this guard. We re-report status so Node reconciles its cache.
	b.mu.Lock()
	cur := b.Status
	if cur != StatusOffline && cur != StatusError {
		b.mu.Unlock()
		b.log(fmt.Sprintf("Connect() ignored — bot already %s", cur))
		b.ResendStatus()
		return
	}
	// Compare-and-set under the lock: claim the connecting transition here so a
	// second, near-simultaneous Connect() sees StatusConnecting and bails,
	// instead of both spawning a Steam client + event loop on the same account.
	b.Status = StatusConnecting
	b.loginFailedHard = false
	// Fresh cancel channel per session — a Disconnect() aimed at a previous
	// session closed the previous channel and can't affect this one.
	cancel := make(chan struct{})
	b.cancelCh = cancel
	b.mu.Unlock()

	b.log(fmt.Sprintf("Connecting as %s...", b.Username))
	b.setStatus(StatusConnecting)

	b.mu.Lock()
	b.steamClient = steam.NewClient()
	b.steamClient.ConnectionTimeout = 30 * time.Second
	sc := b.steamClient
	b.mu.Unlock()
	go b.handleSteamEvents(sc, cancel)

	b.log("Connecting to Steam network...")
	sc.Connect()
}

func (b *Bot) handleSteamEvents(sc *steam.Client, cancel <-chan struct{}) {
	for event := range sc.Events() {
		switch e := event.(type) {
		case *steam.ConnectedEvent:
			// Snapshot credentials under the lock — the guard-code goroutine and
			// SetSentryHashHex/SetLoginKey write these from other goroutines.
			b.mu.Lock()
			code := b.pendingGuardCode
			b.pendingGuardCode = ""
			twoFactor := b.guardIsTwoFactor
			sentry := b.sentryHash
			refreshToken := b.RefreshToken
			loginKey := b.loginKey
			b.mu.Unlock()

			details := &steam.LogOnDetails{
				Username:               b.Username,
				SentryFileHash:         sentry,
				ShouldRememberPassword: true,
			}
			b.usedTokenLogin = false
			if code != "" {
				details.Password = b.Password
				if twoFactor {
					b.log("Connected to Steam. Logging in with 2FA code...")
					details.TwoFactorCode = code
				} else {
					b.log("Connected to Steam. Logging in with email code...")
					details.AuthCode = code
				}
			} else if refreshToken != "" {
				// Preferred path: Steam rejects legacy password logons with
				// InvalidPassword, so a token minted via the modern auth flow
				// is the only way in.
				b.log("Connected to Steam. Logging in with refresh token...")
				details.AccessToken = refreshToken
				b.usedTokenLogin = true
			} else if loginKey != "" {
				b.log("Connected to Steam. Logging in with saved login key...")
				details.LoginKey = loginKey
			} else {
				b.log("Connected to Steam. Logging in with password...")
				details.Password = b.Password
			}
			sc.Auth.LogOn(details)

		case *steam.LoggedOnEvent:
			steamID := sc.SteamId().String()
			b.mu.Lock()
			b.SteamID = steamID
			loginKey := b.loginKey
			sentryLen := len(b.sentryHash)
			b.mu.Unlock()
			b.log(fmt.Sprintf("Logged into Steam (SteamID: %s)", steamID))
			b.log(fmt.Sprintf("Login key: '%s', Sentry: %d bytes", loginKey, sentryLen))

		case *steam.AccountInfoEvent:
			b.mu.Lock()
			b.DisplayName = e.PersonaName
			b.mu.Unlock()
			b.log(fmt.Sprintf("Account: %s (country: %s)", e.PersonaName, e.Country))
			b.setStatus(StatusConnectingGC)

			sc.Social.SetPersonaState(steamlang.EPersonaState_Online)

			logger := logrus.New()
			logger.SetLevel(logrus.DebugLevel)
			b.mu.Lock()
			b.dotaClient = dota2.New(sc, logger)
			dc := b.dotaClient
			b.mu.Unlock()
			dc.SetPlaying(true)

			b.log("Connecting to Dota 2 Game Coordinator...")
			// Give Steam a moment to register the game before saying hello
			go func() {
				time.Sleep(2 * time.Second)
				// Snapshot under the lock — a concurrent Disconnect/reconnect can
				// replace or clear dotaClient, and dereferencing a nil'd pointer
				// here would panic the whole process.
				b.mu.Lock()
				gc := b.dotaClient
				b.mu.Unlock()
				if gc == nil {
					return
				}
				b.log("Sending GC Hello...")
				gc.SayHello()
				// Retry hello if no response
				time.Sleep(5 * time.Second)
				b.mu.Lock()
				status := b.Status
				gc = b.dotaClient
				b.mu.Unlock()
				if gc != nil && status == StatusConnectingGC {
					b.log("No GC response, retrying hello...")
					gc.SayHello()
				}
			}()

		case *steam.LogOnFailedEvent:
			result := e.Result
			if result == steamlang.EResult_AccountLogonDenied ||
				result == steamlang.EResult_AccountLoginDeniedNeedTwoFactor {
				twoFactor := result == steamlang.EResult_AccountLoginDeniedNeedTwoFactor
				guardType := "email"
				if twoFactor {
					guardType = "mobile authenticator"
				}
				b.log(fmt.Sprintf("Steam Guard code required (%s) — waiting for code...", guardType))
				b.setStatus(StatusAwaitGuard)
				b.mu.Lock()
				b.guardIsTwoFactor = twoFactor
				b.pendingAuth = true
				b.mu.Unlock()

				// Steam disconnects after failed login, so we need to wait for code
				// then reconnect and login with it
				go func() {
					select {
					case code := <-b.guardCh:
						b.log("Steam Guard code received, reconnecting...")
						b.mu.Lock()
						b.pendingAuth = false
						b.pendingGuardCode = code
						b.mu.Unlock()
						// Reconnect — the ConnectedEvent handler will use the code
						sc.Connect()
					case <-time.After(5 * time.Minute):
						b.log("Steam Guard code timed out")
						// Clear pendingAuth, otherwise the DisconnectedEvent handler
						// keeps swallowing disconnects as "waiting for code" and the
						// bot never reconnects.
						b.mu.Lock()
						b.pendingAuth = false
						b.mu.Unlock()
						b.setStatus(StatusError, "Steam Guard code timed out")
					case <-cancel:
						b.mu.Lock()
						b.pendingAuth = false
						b.mu.Unlock()
						return
					}
				}()
			} else {
				b.log(fmt.Sprintf("Login failed: %v", result))
				b.mu.Lock()
				b.loginFailedHard = true
				b.mu.Unlock()
				if b.usedTokenLogin {
					// Token rejected (expired/revoked). Tell Node so it wipes
					// the stored token and mints a fresh one before retrying.
					b.send("bot_status", protocol.BotStatusEvent{
						BotID:        b.ID,
						Status:       StatusError,
						Error:        fmt.Sprintf("Login failed: %v (refresh token rejected)", result),
						TokenInvalid: true,
					})
					b.mu.Lock()
					b.Status = StatusError
					b.mu.Unlock()
				} else {
					b.setStatus(StatusError, fmt.Sprintf("Login failed: %v", result))
				}
			}

		case *steam.MachineAuthUpdateEvent:
			b.log("Machine auth updated — sentry saved")
			b.mu.Lock()
			b.sentryHash = e.Hash
			status := b.Status
			b.mu.Unlock()
			b.send("bot_status", protocol.BotStatusEvent{
				BotID:      b.ID,
				Status:     status,
				SentryHash: fmt.Sprintf("%x", e.Hash),
			})

		case *steam.LoginKeyEvent:
			b.log("Login key received — won't need 2FA next time")
			b.mu.Lock()
			b.loginKey = e.LoginKey
			status := b.Status
			b.mu.Unlock()
			b.send("bot_status", protocol.BotStatusEvent{
				BotID:    b.ID,
				Status:   status,
				LoginKey: e.LoginKey,
			})

		case *devents.ClientWelcomed:
			b.log("Dota 2 GC welcomed! Bot is ready.")
			// Only advertise available if we're NOT mid-lobby. A GC re-welcome
			// (reconnect) while busy would otherwise let Node hand this bot a
			// second match — the same double-bot guard the
			// GCConnectionStatusChanged handler applies below.
			b.mu.Lock()
			b.gcReady = true
			busy := b.activeLobbyID != ""
			b.mu.Unlock()
			if busy {
				b.log(fmt.Sprintf("GC welcomed but still busy with lobby %s — staying busy", b.activeLobbyID))
			} else {
				b.setStatus(StatusAvailable)
			}
			// Start lobby cache watcher
			go b.watchLobbyCacheEvents()

		case *devents.GCConnectionStatusChanged:
			b.log(fmt.Sprintf("GC status: %s → %s", e.OldState.String(), e.NewState.String()))
			if e.NewState == gcccm.GCConnectionStatus_GCConnectionStatus_HAVE_SESSION {
				// Only transition to available if we're NOT busy with an active
				// lobby. GC session can flicker during lobby creation — blindly
				// resetting to available would let Node reassign us to a second
				// match, causing double-bot bugs.
				b.mu.Lock()
				b.gcReady = true
				idle := b.activeLobbyID == ""
				b.mu.Unlock()
				if idle {
					b.setStatus(StatusAvailable)
				} else {
					b.log("GC session restored but still busy with a lobby — staying busy")
				}
			} else {
				// GC session lost (GC_GOING_DOWN / NO_SESSION). A bot with no GC
				// session can't create or manage lobbies, so it must stop
				// advertising as available — otherwise Node hands it a match it
				// can't fulfil. Demote to connecting_gc; the HAVE_SESSION branch
				// above (or a fresh ClientWelcomed) promotes it back when the
				// session returns. Only act when currently available: busy bots
				// stay busy (an in-flight match has its own lifecycle, and the
				// double down-transition GOING_DOWN→NO_SESSION must not clobber
				// it), and other states are left untouched.
				b.mu.Lock()
				b.gcReady = false
				wasAvailable := b.Status == StatusAvailable
				b.mu.Unlock()
				if wasAvailable {
					b.log("GC session lost while idle — no longer available until GC reconnects")
					b.setStatus(StatusConnectingGC)
				}
			}

		case *devents.UnhandledGCPacket:
			b.log(fmt.Sprintf("Unhandled GC packet: msgType=%d", e.Packet.MsgType))

		case *steam.DisconnectedEvent:
			b.mu.Lock()
			waiting := b.pendingAuth
			status := b.Status
			failedHard := b.loginFailedHard
			b.mu.Unlock()
			if waiting {
				b.log("Disconnected (waiting for Steam Guard code)")
				continue // don't exit the event loop, we'll reconnect after code
			}
			if failedHard {
				// Steam rejected our credentials outright — retrying with the
				// same ones is pointless and risks rate-limiting. Node retries
				// after refreshing the token, or an admin reconnects manually.
				b.log("Not auto-reconnecting after login rejection")
				return
			}
			// If we were online or connecting, auto-reconnect with a fresh client.
			// Add jitter (3-8s) so multiple bots on the same IP don't all hit
			// Steam simultaneously after a mass disconnect.
			if status != StatusOffline {
				delay := b.reconnectDelay()
				b.log(fmt.Sprintf("Disconnected from Steam — reconnecting in %s...", delay))
				b.setStatus(StatusConnecting)
				select {
				case <-cancel:
					b.setStatus(StatusOffline)
					return
				case <-time.After(delay):
				}
				b.reconnect(cancel)
				return // exit this event loop; reconnect starts a new one
			}
			return

		case error:
			delay := b.reconnectDelay()
			b.log(fmt.Sprintf("Steam error: %v — reconnecting in %s...", e, delay))
			b.setStatus(StatusConnecting)
			select {
			case <-cancel:
				b.setStatus(StatusOffline)
				return
			case <-time.After(delay):
			}
			b.reconnect(cancel)
			return // exit this event loop; reconnect starts a new one
		}
	}
}

// reconnectDelay returns 3-8s of jitter so multiple bots on the same IP
// don't all slam Steam at the same instant after a mass disconnect.
func (b *Bot) reconnectDelay() time.Duration {
	// Use bot ID hash as a simple per-bot offset so each bot gets a
	// different delay even if called at the exact same moment.
	h := 0
	for _, c := range b.ID {
		h += int(c)
	}
	base := 3 + (h % 6) // 3-8 seconds
	return time.Duration(base) * time.Second
}

func (b *Bot) reconnect(cancel <-chan struct{}) {
	b.log("Creating fresh Steam client for reconnect...")
	// Detach the old dota client + cache watcher under the lock so any concurrent
	// reader (processLobbyUpdate, the SayHello goroutine) snapshots either the
	// old client or nil — never a half-torn-down pointer.
	b.mu.Lock()
	b.gcReady = false
	dc := b.dotaClient
	b.dotaClient = nil
	if b.lobbyCacheCancel != nil {
		b.lobbyCacheCancel()
		b.lobbyCacheCancel = nil
	}
	b.mu.Unlock()
	// Close the old client outside the lock (Close can block).
	if dc != nil {
		dc.SetPlaying(false)
		dc.Close()
	}
	// Create fresh client and start new event loop
	b.mu.Lock()
	b.steamClient = steam.NewClient()
	b.steamClient.ConnectionTimeout = 30 * time.Second
	sc := b.steamClient
	b.mu.Unlock()
	go b.handleSteamEvents(sc, cancel)
	b.log("Reconnecting to Steam network...")
	sc.Connect()
}

func (b *Bot) Disconnect() {
	b.log("Disconnecting...")
	// Detach clients + cache watcher under the lock, then do the blocking
	// Close/Disconnect outside it. Concurrent readers snapshot the pointers
	// under the same lock, so they see either a live client or nil.
	// Closing cancelCh (instead of a single buffered token) wakes every waiter
	// of this session — reconnect sleeps and the Steam Guard wait alike — and a
	// later Connect() creates a fresh channel, so this close can't leak into
	// the next session.
	b.mu.Lock()
	if b.cancelCh != nil {
		close(b.cancelCh)
		b.cancelCh = nil
	}
	if b.lobbyCacheCancel != nil {
		b.lobbyCacheCancel()
		b.lobbyCacheCancel = nil
	}
	b.gcReady = false
	dc := b.dotaClient
	b.dotaClient = nil
	sc := b.steamClient
	b.steamClient = nil
	b.mu.Unlock()
	if dc != nil {
		dc.SetPlaying(false)
		dc.Close()
	}
	if sc != nil {
		sc.Disconnect()
	}
	b.setStatus(StatusOffline)
}

// RecoverGCSession forces a full Steam+GC reconnect to clear a silently-dead
// GC session. When the GC drops/forgets a session without telling us, the
// Steam connection stays up but every GC request (CreateLobby, etc.) hangs
// until its context deadline. go-dota2 can't detect or recover from this on
// its own — only a fresh ClientHello handshake does — so a bot left in this
// state would fail every later lobby creation until an operator restarts it.
//
// We trigger recovery by disconnecting the underlying Steam client, which
// emits a DisconnectedEvent and drives the existing auto-reconnect path in
// handleSteamEvents (fresh client → login → GC hello → ClientWelcomed →
// available). This mirrors a manual bot restart, so the next lobby attempt
// works without intervention.
func (b *Bot) RecoverGCSession(reason string) {
	b.mu.Lock()
	sc := b.steamClient
	b.mu.Unlock()
	if sc != nil && sc.Connected() {
		b.log(fmt.Sprintf("Recovering GC session (%s) — forcing reconnect", reason))
		sc.Disconnect()
		return
	}
	// Steam itself isn't connected: the disconnect/error path is already
	// reconnecting (or the bot is offline), so there's nothing to force here.
	b.log(fmt.Sprintf("RecoverGCSession (%s): Steam not connected — relying on existing reconnect path", reason))
}

func (b *Bot) SubmitSteamGuard(code string) {
	select {
	case b.guardCh <- code:
		b.log("Steam Guard code submitted")
	default:
		b.log("No pending Steam Guard request")
	}
}

func (b *Bot) RequestMatchDetails(matchID uint64) (*protocol.MatchDetailsEvent, error) {
	dc := b.dc()
	if dc == nil {
		return nil, fmt.Errorf("dota client not connected")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	resp, err := dc.RequestMatchDetails(ctx, matchID)
	if err != nil {
		return nil, fmt.Errorf("GC request failed: %w", err)
	}
	if resp.GetResult() != 1 || resp.Match == nil {
		return nil, fmt.Errorf("GC returned no match data (result=%d)", resp.GetResult())
	}

	m := resp.Match
	outcome := m.GetMatchOutcome()
	// EMatchOutcome: 2 = RadVictory, 3 = DireVictory. Anything else — 0 (Unknown)
	// or 64-69 (NotScored_*: never started, leaver, server crash, cancelled, …) —
	// has no valid winner. Erroring here (instead of defaulting to a Dire win)
	// keeps the caller from recording a bogus result; the game stays unresolved
	// and can be retried / handled manually.
	if outcome != 2 && outcome != 3 {
		return nil, fmt.Errorf("match %d not decisively scored (outcome=%d)", m.GetMatchId(), outcome)
	}
	radiantWin := outcome == 2

	players := make([]protocol.MatchDetailsPlayer, 0, len(m.Players))
	for _, p := range m.Players {
		slot := p.GetPlayerSlot()
		isRadiant := slot < 128
		win := 0
		if (isRadiant && radiantWin) || (!isRadiant && !radiantWin) {
			win = 1
		}
		players = append(players, protocol.MatchDetailsPlayer{
			AccountID:   p.GetAccountId(),
			PlayerSlot:  slot,
			HeroID:      p.GetHeroId(),
			Kills:       p.GetKills(),
			Deaths:      p.GetDeaths(),
			Assists:     p.GetAssists(),
			LastHits:    p.GetLastHits(),
			Denies:      p.GetDenies(),
			GoldPerMin:  p.GetGoldPerMin(),
			XpPerMin:    p.GetXpPerMin(),
			HeroDamage:  p.GetHeroDamage(),
			TowerDamage: p.GetTowerDamage(),
			HeroHealing: p.GetHeroHealing(),
			Level:       p.GetLevel(),
			NetWorth:    p.GetGold() + p.GetGoldSpent(),
			Item0:       p.GetItem_0(),
			Item1:       p.GetItem_1(),
			Item2:       p.GetItem_2(),
			Item3:       p.GetItem_3(),
			Item4:       p.GetItem_4(),
			Item5:       p.GetItem_5(),
			Backpack0:   p.GetItem_6(),
			Backpack1:   p.GetItem_7(),
			Backpack2:   p.GetItem_8(),
			ItemNeutral: p.GetItem_9(),
			IsRadiant:   isRadiant,
			Win:         win,
			PlayerName:  p.GetPlayerName(),
		})
	}

	return &protocol.MatchDetailsEvent{
		MatchID:    fmt.Sprintf("%d", m.GetMatchId()),
		RadiantWin: radiantWin,
		Duration:   m.GetDuration(),
		StartTime:  m.GetStarttime(),
		GameMode:   uint32(m.GetGameMode()),
		Players:    players,
	}, nil
}

func (b *Bot) SetSentryHashHex(hexStr string) {
	decoded, err := hex.DecodeString(hexStr)
	if err == nil && len(decoded) > 0 {
		b.mu.Lock()
		b.sentryHash = steam.SentryHash(decoded)
		b.mu.Unlock()
	}
}

func (b *Bot) SetLoginKey(key string) {
	b.mu.Lock()
	b.loginKey = key
	b.mu.Unlock()
}

func (b *Bot) SetActiveLobbyID(id string) {
	if id == "" {
		b.log("ACTION: SetActiveLobbyID cleared")
	} else {
		b.log(fmt.Sprintf("ACTION: SetActiveLobbyID(%s)", id))
		// New lobby starting — drain any stale game-start token left buffered on
		// this bot's gameStartedCh by a previous lobby. gameStartedCh is a
		// per-bot buffered(1) channel; an undrained token would make runLobby's
		// select fire immediately and abandon this fresh lobby seconds after
		// creation. This is the single hook hit on every lobby start.
		select {
		case <-b.gameStartedCh:
		default:
		}
	}
	b.mu.Lock()
	if id != "" {
		// Re-arm the once-per-lobby game_started guard.
		b.gameStartedSent = false
	}
	b.activeLobbyID = id
	b.mu.Unlock()
}

func (b *Bot) watchLobbyCacheEvents() {
	dc := b.dc()
	if dc == nil {
		b.log("Cannot watch lobby cache: dota client not connected")
		return
	}

	eventCh, unsub, err := dc.GetCache().SubscribeType(cso.Lobby)
	if err != nil {
		b.log(fmt.Sprintf("Failed to subscribe to lobby cache: %v", err))
		return
	}

	// Store cancel func so Disconnect can stop this goroutine
	stopCh := make(chan struct{})
	b.mu.Lock()
	b.lobbyCacheCancel = func() {
		unsub()
		close(stopCh)
	}
	b.mu.Unlock()

	b.log("Lobby cache watcher started")

	// Check if a lobby already exists in cache (e.g. bot was in a lobby before restart)
	go func() {
		time.Sleep(3 * time.Second) // give cache time to populate
		gc := b.dc()
		if gc == nil {
			return
		}
		container, err := gc.GetCache().GetContainerForTypeID(uint32(cso.Lobby))
		if err != nil {
			return
		}
		existing := container.GetOne()
		if existing == nil {
			return
		}
		lobby, ok := existing.(*gcccm.CSODOTALobby)
		if !ok {
			return
		}
		b.log(fmt.Sprintf("CACHE: Found existing lobby on startup (id: %d, state: %s)", lobby.GetLobbyId(), lobby.GetState().String()))
		b.mu.Lock()
		b.lastLobby = lobby
		assigned := b.activeLobbyID != ""
		b.mu.Unlock()
		if !assigned {
			b.log("CACHE: Existing lobby with no assignment — waiting 5s for rejoin command...")
			time.Sleep(5 * time.Second)
			b.mu.Lock()
			nowAssigned := b.activeLobbyID != ""
			b.mu.Unlock()
			if !nowAssigned {
				b.log("CACHE: No rejoin received — leaving stale lobby")
				b.LeaveLobby()
				b.mu.Lock()
				b.lastLobby = nil
				b.mu.Unlock()
			} else {
				b.log("CACHE: Rejoin received — keeping lobby")
			}
		}
	}()

	for {
		select {
		case <-stopCh:
			b.log("Lobby cache watcher stopped")
			return
		case event, ok := <-eventCh:
			if !ok {
				b.log("Lobby cache channel closed")
				return
			}
			b.handleLobbyCacheEvent(event)
		}
	}
}

func (b *Bot) handleLobbyCacheEvent(event *socache.CacheEvent) {
	// processMu serializes this handler with PollLobbyFromCache — both diff
	// against lastLobby and their read-diff-write sequences must not interleave.
	b.processMu.Lock()
	defer b.processMu.Unlock()

	switch event.EventType {
	case socache.EventTypeCreate:
		lobby := event.Object.(*gcccm.CSODOTALobby)
		b.log(fmt.Sprintf("CACHE: Lobby created (id: %d, state: %s)",
			lobby.GetLobbyId(), lobby.GetState().String()))
		// If bot has no active lobby assignment, wait briefly for rejoin_lobby command
		// then leave if still unassigned
		b.mu.Lock()
		assigned := b.activeLobbyID != ""
		b.mu.Unlock()
		if !assigned {
			b.log("CACHE: Found lobby with no active assignment — waiting 5s for rejoin command...")
			b.setLastLobby(lobby)
			go func() {
				time.Sleep(5 * time.Second)
				b.mu.Lock()
				assigned := b.activeLobbyID != ""
				b.mu.Unlock()
				if !assigned {
					b.log("CACHE: No rejoin received — leaving stale lobby")
					b.LeaveLobby()
				} else {
					b.log("CACHE: Rejoin received — keeping lobby")
				}
			}()
			return
		}
		b.processLobbyUpdate(nil, lobby)
		b.setLastLobby(lobby)

	case socache.EventTypeUpdate:
		lobby := event.Object.(*gcccm.CSODOTALobby)
		b.log(fmt.Sprintf("CACHE: Lobby updated (id: %d, state: %s)",
			lobby.GetLobbyId(), lobby.GetState().String()))
		b.processLobbyUpdate(b.getLastLobby(), lobby)
		b.setLastLobby(lobby)

	case socache.EventTypeDestroy:
		b.log("CACHE: Lobby destroyed")
		b.setLastLobby(nil)
	}
}

func (b *Bot) processLobbyUpdate(oldLobby, newLobby *gcccm.CSODOTALobby) {
	// Snapshot the lobby assignment once — SetActiveLobbyID writes it from the
	// command goroutine. All events below route to this snapshot.
	b.mu.Lock()
	lobbyID := b.activeLobbyID
	b.mu.Unlock()
	// Skip if bot has already left the lobby
	if lobbyID == "" {
		return
	}

	newMembers := newLobby.GetAllMembers()
	matchID := newLobby.GetMatchId()

	// Build old members map for diffing
	oldMembers := make(map[uint64]gcccm.DOTA_GC_TEAM)
	if oldLobby != nil {
		for _, m := range oldLobby.GetAllMembers() {
			oldMembers[m.GetId()] = m.GetTeam()
		}
	}

	// Build new members map
	newMembersMap := make(map[uint64]gcccm.DOTA_GC_TEAM)
	for _, m := range newMembers {
		newMembersMap[m.GetId()] = m.GetTeam()
	}

	// Detect joins, leaves, and team changes
	for _, m := range newMembers {
		pid := m.GetId()
		newTeam := teamName(m.GetTeam())
		steamId := fmt.Sprintf("%d", pid)
		if _, existed := oldMembers[pid]; !existed {
			b.log(fmt.Sprintf("Player %d joined lobby → %s", pid, newTeam))
			b.send("player_joined", protocol.PlayerJoinedEvent{
				LobbyID: lobbyID,
				SteamID: steamId,
				Team:    newTeam,
			})
		} else if oldMembers[pid] != m.GetTeam() {
			b.log(fmt.Sprintf("Player %d changed team: %s → %s", pid, teamName(oldMembers[pid]), newTeam))
			b.send("player_joined", protocol.PlayerJoinedEvent{
				LobbyID: lobbyID,
				SteamID: steamId,
				Team:    newTeam,
			})
		}
	}
	for pid := range oldMembers {
		if _, stillHere := newMembersMap[pid]; !stillHere {
			b.log(fmt.Sprintf("Player %d left lobby", pid))
			b.send("player_left", protocol.PlayerLeftEvent{
				LobbyID: lobbyID,
				SteamID: fmt.Sprintf("%d", pid),
			})
		}
	}

	// Send full player list update to Node so it stays in sync
	var joinedPlayers []protocol.LobbyPlayer
	for _, m := range newMembers {
		team := teamName(m.GetTeam())
		if team == "radiant" || team == "dire" {
			joinedPlayers = append(joinedPlayers, protocol.LobbyPlayer{
				SteamID: fmt.Sprintf("%d", m.GetId()),
				Team:    team,
			})
		}
	}
	// Report the *current* lobby state, not a hardcoded "waiting". This handler
	// runs on every SO-cache update — including during SERVERSETUP and RUN — so
	// hardcoding "waiting" clobbered the real cointoss/active status back to
	// "waiting" on every in-game cache tick, making the status flip-flop while
	// the game was actually running.
	lobbyStatus := "waiting"
	switch newLobby.GetState() {
	case gcccm.CSODOTALobby_SERVERSETUP:
		lobbyStatus = "cointoss"
	case gcccm.CSODOTALobby_RUN:
		lobbyStatus = "active"
	}
	b.send("lobby_status", protocol.LobbyStatusEvent{
		LobbyID:       lobbyID,
		Status:        lobbyStatus,
		PlayersJoined: joinedPlayers,
	})

	// Detect team IDs from lobby team details
	teamDetails := newLobby.GetTeamDetails()
	if len(teamDetails) >= 2 {
		radiantId := int(teamDetails[0].GetTeamId())
		direId := int(teamDetails[1].GetTeamId())
		b.mu.Lock()
		teamIdsChanged := radiantId != b.detectedRadiantTeamId || direId != b.detectedDireTeamId
		if teamIdsChanged {
			b.detectedRadiantTeamId = radiantId
			b.detectedDireTeamId = direId
		}
		b.mu.Unlock()
		if teamIdsChanged {
			radiantName := teamDetails[0].GetTeamName()
			direName := teamDetails[1].GetTeamName()
			b.log(fmt.Sprintf("Team IDs — Radiant: %d (%s), Dire: %d (%s)", radiantId, radiantName, direId, direName))
			b.send("lobby_team_ids", protocol.LobbyTeamIdsEvent{
				LobbyID:         lobbyID,
				RadiantTeamId:   radiantId,
				DireTeamId:      direId,
				RadiantTeamName: radiantName,
				DireTeamName:    direName,
			})
		}
	}

	lobbyState := newLobby.GetState()
	oldState := gcccm.CSODOTALobby_UI
	if oldLobby != nil {
		oldState = oldLobby.GetState()
	}

	b.log(fmt.Sprintf("  State: %s → %s (matchID: %d)", oldState.String(), lobbyState.String(), matchID))

	// Lobby status (cointoss/active/waiting) is reported from the per-cache-update
	// send above, which already derives it from the current state — no separate
	// transition-only send needed (and a duplicate one would just race it).

	// Detect match ID assigned. Use a sticky once-per-lobby guard instead of a
	// pure edge (old==0 → new!=0): the edge can be missed when the match-id-bearing
	// cache update is dropped, only seen on the 15s safety poll, or after a rejoin
	// where the lobby already had a match id — leaving the lobby stuck on
	// 'waiting'/'active' with no match id captured server-side. Firing once per
	// lobby is safe — the server's game_started handler is idempotent.
	b.mu.Lock()
	fireGameStarted := matchID != 0 && !b.gameStartedSent
	if fireGameStarted {
		b.gameStartedSent = true
	}
	b.mu.Unlock()
	if fireGameStarted {
		b.log(fmt.Sprintf("Match ID assigned: %d", matchID))
		b.send("game_started", protocol.GameStartedEvent{
			LobbyID: lobbyID,
			MatchID: fmt.Sprintf("%d", matchID),
		})
		// Auto-launch immediately since we have a match ID but lobby is still in UI
		if lobbyState == gcccm.CSODOTALobby_UI && b.dc() != nil {
			b.mu.Lock()
			doLaunch := !b.launchSent
			if doLaunch {
				b.launchSent = true
			}
			b.mu.Unlock()
			if doLaunch {
				b.log("Auto-launching after match ID assigned...")
				b.LaunchLobby()
			}
		}
	}

	// Auto-launch after coin toss: both teams have made their selection priority choices
	if matchID != 0 && lobbyState != gcccm.CSODOTALobby_RUN {
		priorityChoice := newLobby.GetSeriesCurrentPriorityTeamChoice()
		nonPriorityChoice := newLobby.GetSeriesCurrentNonPriorityTeamChoice()
		oldPriorityChoice := gcccm.DOTASelectionPriorityChoice(0)
		oldNonPriorityChoice := gcccm.DOTASelectionPriorityChoice(0)
		if oldLobby != nil {
			oldPriorityChoice = oldLobby.GetSeriesCurrentPriorityTeamChoice()
			oldNonPriorityChoice = oldLobby.GetSeriesCurrentNonPriorityTeamChoice()
		}
		bothChosen := priorityChoice != 0 && nonPriorityChoice != 0
		wasNotBothChosen := oldPriorityChoice == 0 || oldNonPriorityChoice == 0
		if bothChosen && wasNotBothChosen {
			b.log(fmt.Sprintf("Coin toss completed — priority: %s, non-priority: %s — auto-launching...",
				priorityChoice.String(), nonPriorityChoice.String()))
			// Re-arm the launch guard so we can launch again after coin toss
			dcLive := b.dc() != nil
			b.mu.Lock()
			b.launchSent = dcLive
			b.mu.Unlock()
			if dcLive {
				b.LaunchLobby()
			}
		}
	}

	// Capture server_steam_id whenever the GC populates it (transition 0 → non-zero).
	// This is what Steam's IDOTA2MatchStats_570 GetRealtimeStats endpoint needs to
	// return live scores. Forward to Node so it can seed queue_matches.server_steam_id
	// without waiting on the player-summary derive (which depends on player privacy).
	newServerId := newLobby.GetServerId()
	oldServerId := uint64(0)
	if oldLobby != nil {
		oldServerId = oldLobby.GetServerId()
	}
	if newServerId != 0 && newServerId != oldServerId {
		b.log(fmt.Sprintf("Server SteamID assigned: %d", newServerId))
		b.send("lobby_server_id", protocol.LobbyServerIDEvent{
			LobbyID:       lobbyID,
			ServerSteamID: fmt.Sprintf("%d", newServerId),
		})
	}

	// Only signal bot to leave when game is actually running. By the time state
	// reaches RUN, server_steam_id is virtually always populated, but the
	// transition above already handled the broadcast — this is just the leave
	// trigger.
	if lobbyState == gcccm.CSODOTALobby_RUN && oldState != gcccm.CSODOTALobby_RUN {
		b.log("Game is now running — leaving lobby")
		select {
		case b.gameStartedCh <- struct{}{}:
		default:
		}
	}

	// Log current lobby roster
	for _, m := range newMembers {
		b.log(fmt.Sprintf("  Slot: %d | %s | player %d", m.GetSlot(), teamName(m.GetTeam()), m.GetId()))
	}

	// Enforce team assignments — kick players on wrong team back to unassigned.
	// Skip once the game is running: a concurrent cleanup may have cleared
	// expectedTeams, and enforcement is pointless after launch anyway.
	//
	// Snapshot the shared map + client pointers under the mutex. SetExpectedTeams
	// (called from the command goroutine) replaces the whole map atomically and
	// never mutates a published map, so the local reference is safe to read
	// without the lock; snapshotting the clients avoids a nil-deref if
	// Disconnect/reconnect clears them mid-iteration.
	b.mu.Lock()
	expectedTeams := b.expectedTeams
	enforce := b.enforceTeams
	dc := b.dotaClient
	sc := b.steamClient
	b.mu.Unlock()

	if lobbyState != gcccm.CSODOTALobby_RUN &&
		enforce && expectedTeams != nil && dc != nil && sc != nil {
		for _, m := range newMembers {
			playerID := m.GetId()
			currentTeam := m.GetTeam()

			// Skip bot itself
			if playerID == sc.SteamId().ToUint64() {
				continue
			}
			// Skip players not on a team slot
			if currentTeam != gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_GOOD_GUYS &&
				currentTeam != gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_BAD_GUYS {
				continue
			}

			// Convert 64-bit Steam ID to 32-bit account ID for the kick API
			accountID := uint32(playerID - 76561197960265728)

			expectedTeam, known := expectedTeams[playerID]
			if !known {
				b.log(fmt.Sprintf("ENFORCE: Unknown player %d on %s — kicking to unassigned",
					playerID, teamName(currentTeam)))
				dc.KickLobbyMemberFromTeam(accountID)
				continue
			}

			wrongTeam := false
			if expectedTeam == "radiant" && currentTeam != gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_GOOD_GUYS {
				wrongTeam = true
			} else if expectedTeam == "dire" && currentTeam != gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_BAD_GUYS {
				wrongTeam = true
			}
			if wrongTeam {
				b.log(fmt.Sprintf("ENFORCE: Player %d on %s but expected %s — kicking to unassigned",
					playerID, teamName(currentTeam), expectedTeam))
				dc.KickLobbyMemberFromTeam(accountID)
			} else {
				b.log(fmt.Sprintf("ENFORCE: Player %d on %s — correct", playerID, teamName(currentTeam)))
			}
		}
	}

	// NOTE: the authoritative lobby_status (with the derived cointoss/active/
	// waiting state and the radiant/dire roster) was already sent above at the
	// start of this handler. A second send here previously hardcoded
	// Status:"waiting", which clobbered the real state back to "waiting" on
	// every in-game cache tick — the exact regression commit 0f505d1 fixed.
	// Per-player joins/leaves are reported via the player_joined/player_left
	// events above, so no additional lobby_status send is needed here.
}

func (b *Bot) SetExpectedTeams(players []protocol.LobbyPlayer) {
	if players == nil {
		b.log("ACTION: SetExpectedTeams cleared")
		b.mu.Lock()
		b.expectedTeams = nil
		b.mu.Unlock()
		return
	}
	b.log(fmt.Sprintf("ACTION: SetExpectedTeams(%d players)", len(players)))
	// Build the map locally, then publish the whole reference atomically under
	// the mutex — processLobbyUpdate snapshots it under the same lock and never
	// mutates it, so there is no concurrent map read+write.
	m := make(map[uint64]string)
	for _, p := range players {
		sid := parseSteamID(p.SteamID)
		if sid != 0 {
			m[sid] = p.Team
		}
	}
	b.mu.Lock()
	b.expectedTeams = m
	b.mu.Unlock()
}

func (b *Bot) IsAvailable() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.Status == StatusAvailable
}

func (b *Bot) IsInLobby() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.lastLobby != nil
}

// getLastLobby / setLastLobby guard lastLobby with b.mu — it is shared between
// the cache watcher, the safety poll, IsInLobby, LeaveLobby and ResendLobbyState.
func (b *Bot) getLastLobby() *gcccm.CSODOTALobby {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.lastLobby
}

func (b *Bot) setLastLobby(l *gcccm.CSODOTALobby) {
	b.mu.Lock()
	b.lastLobby = l
	b.mu.Unlock()
}

// dc returns the current Dota 2 client under the lock (nil if disconnected).
// Callers must nil-check the returned pointer and use it instead of b.dotaClient
// so a concurrent Disconnect/reconnect can't nil the field mid-call and panic.
func (b *Bot) dc() *dota2.Dota2 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.dotaClient
}

func (b *Bot) GetActiveLobbyID() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.activeLobbyID
}

// ResendLobbyState re-emits state Node may have missed if the WS was down
// when the underlying GC event fired (most importantly server_steam_id).
// Safe to call repeatedly; Node's handler de-dupes by current DB value.
func (b *Bot) ResendLobbyState() {
	b.mu.Lock()
	lobbyID := b.activeLobbyID
	lobby := b.lastLobby
	b.mu.Unlock()
	if lobbyID == "" || lobby == nil {
		return
	}
	if serverID := lobby.GetServerId(); serverID != 0 {
		b.log(fmt.Sprintf("Re-emitting lobby_server_id %d after WS reconnect", serverID))
		b.send("lobby_server_id", protocol.LobbyServerIDEvent{
			LobbyID:       lobbyID,
			ServerSteamID: fmt.Sprintf("%d", serverID),
		})
	}
}

// ResendStatus re-emits the bot's current status to Node — used on WS
// (re)connect so Node's DB recovers the true status after the link drops,
// instead of holding a stale "available"/"busy" that no longer matches reality.
func (b *Bot) ResendStatus() {
	b.mu.Lock()
	status := b.Status
	b.mu.Unlock()
	b.send("bot_status", protocol.BotStatusEvent{BotID: b.ID, Status: status})
}

func (b *Bot) SetBusy(busy bool) {
	b.mu.Lock()
	if busy {
		b.Status = StatusBusy
	} else if b.gcReady {
		b.Status = StatusAvailable
	} else {
		// Freeing the bot, but the GC session isn't live (dropped mid-lobby, or
		// Steam is mid-reconnect) — don't advertise 'available' or Node would
		// hand it a match it can't host. Demote to connecting_gc; ClientWelcomed
		// / HAVE_SESSION promotes it back to available once the session returns.
		b.Status = StatusConnectingGC
	}
	status := b.Status
	b.mu.Unlock()
	b.log(fmt.Sprintf("ACTION: SetBusy(%v) → status=%s", busy, status))
	b.send("bot_status", protocol.BotStatusEvent{BotID: b.ID, Status: status})
}

// SetEnforceTeams controls whether processLobbyUpdate kicks players onto their
// expected team (the lobbyAutoAssignTeams setting). When false, players pick
// their own Radiant/Dire slots freely and the bot does not enforce.
func (b *Bot) SetEnforceTeams(v bool) {
	b.mu.Lock()
	b.enforceTeams = v
	b.mu.Unlock()
}

func (b *Bot) SetExpectedTeamIds(radiant, dire int) {
	b.log(fmt.Sprintf("ACTION: SetExpectedTeamIds(radiant=%d, dire=%d)", radiant, dire))
	b.mu.Lock()
	b.expectedRadiantTeamId = radiant
	b.expectedDireTeamId = dire
	b.mu.Unlock()
}

func (b *Bot) GetDetectedTeamIds() (int, int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.detectedRadiantTeamId, b.detectedDireTeamId
}

func (b *Bot) GameStartedCh() <-chan struct{} {
	return b.gameStartedCh
}

func (b *Bot) GetDotaClient() *dota2.Dota2 {
	return b.dc()
}

type LobbyOptions struct {
	ServerRegion      int
	GameMode          int
	LeagueId          int
	DotaTvDelay       int
	Cheats            bool
	AllowSpectating   bool
	PauseSetting      int
	SelectionPriority int
	CmPick            int
	PenaltyRadiant    int
	PenaltyDire       int
	SeriesType        int
	RadiantName       string
	DireName          string
}

func (b *Bot) CreatePracticeLobby(gameName, password string, opts LobbyOptions) error {
	b.mu.Lock()
	dc := b.dotaClient
	sc := b.steamClient
	b.mu.Unlock()
	if dc == nil || sc == nil {
		return fmt.Errorf("dota client not connected")
	}

	gameMode := uint32(opts.GameMode)
	visibility := gcccm.DOTALobbyVisibility_DOTALobbyVisibility_Public
	region := uint32(opts.ServerRegion)
	allowCheats := opts.Cheats
	fillBots := false
	allowSpectating := opts.AllowSpectating
	pauseSetting := gcccm.LobbyDotaPauseSetting(opts.PauseSetting)
	selectionPriority := gcccm.DOTASelectionPriorityRules(opts.SelectionPriority)
	cmPick := gcccm.DOTA_CM_PICK(opts.CmPick)

	// Team details (index 0 = Radiant, index 1 = Dire)
	var teamDetails []*gcccm.CLobbyTeamDetails
	radiantName := opts.RadiantName
	direName := opts.DireName
	if radiantName != "" || direName != "" {
		teamDetails = []*gcccm.CLobbyTeamDetails{
			{TeamName: &radiantName},
			{TeamName: &direName},
		}
	}

	details := &gcccm.CMsgPracticeLobbySetDetails{
		GameName:               &gameName,
		PassKey:                &password,
		ServerRegion:           &region,
		GameMode:               &gameMode,
		Visibility:             &visibility,
		AllowCheats:            &allowCheats,
		FillWithBots:           &fillBots,
		AllowSpectating:        &allowSpectating,
		PauseSetting:           &pauseSetting,
		SelectionPriorityRules: &selectionPriority,
		CmPick:                 &cmPick,
		TeamDetails:            teamDetails,
	}

	if opts.LeagueId > 0 {
		lid := uint32(opts.LeagueId)
		details.Leagueid = &lid
	}
	if opts.DotaTvDelay >= 0 {
		delay := gcccm.LobbyDotaTVDelay(opts.DotaTvDelay)
		details.DotaTvDelay = &delay
	}
	if opts.PenaltyRadiant > 0 {
		p := uint32(opts.PenaltyRadiant)
		details.PenaltyLevelRadiant = &p
	}
	if opts.PenaltyDire > 0 {
		p := uint32(opts.PenaltyDire)
		details.PenaltyLevelDire = &p
	}
	if opts.SeriesType > 0 {
		st := uint32(opts.SeriesType)
		details.SeriesType = &st
	}

	// Create lobby and wait for GC confirmation
	createCtx, createCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer createCancel()
	err := dc.LeaveCreateLobby(createCtx, details, true)
	if err != nil {
		return err
	}

	// Move bot to unassigned so real players can pick Radiant/Dire. Do NOT
	// subscribe to the cache container here — it competes with the main
	// watcher's SubscribeType slot and orphans its channel when we unsubscribe,
	// causing all subsequent lobby events to be missed. Fire-and-forget both
	// commands instead; the bot is already in the player pool after lobby
	// creation anyway, so confirmation isn't required.
	accountID := uint32(sc.SteamId().ToUint64() & 0xFFFFFFFF)
	dc.KickLobbyMemberFromTeam(accountID)
	dc.JoinLobbyTeam(gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_PLAYER_POOL, 0)
	b.log("Sent team-pool commands (no wait)")
	return nil
}

func (b *Bot) InvitePlayer(steamID64 string) {
	dc := b.dc()
	if dc == nil {
		b.log(fmt.Sprintf("ACTION: InvitePlayer(%s) skipped — dota client not connected", steamID64))
		return
	}
	b.log(fmt.Sprintf("ACTION: InvitePlayer(%s)", steamID64))
	sid := steamid.SteamId(parseSteamID(steamID64))
	dc.InviteLobbyMember(sid)
}

func (b *Bot) LaunchLobby() {
	dc := b.dc()
	if dc == nil {
		b.log("ACTION: LaunchLobby skipped — dota client not connected")
		return
	}
	b.log("ACTION: LaunchLobby")
	dc.LaunchLobby()
}

func (b *Bot) LeaveLobby() {
	b.log("ACTION: LeaveLobby")
	b.mu.Lock()
	b.lastLobby = nil
	b.detectedRadiantTeamId = 0
	b.detectedDireTeamId = 0
	b.launchSent = false
	dc := b.dotaClient
	b.mu.Unlock()
	if dc != nil {
		dc.LeaveLobby()
	}
}

func (b *Bot) AbandonAndLeaveLobby() {
	b.log("ACTION: AbandonAndLeaveLobby")
	b.mu.Lock()
	b.lastLobby = nil
	b.detectedRadiantTeamId = 0
	b.detectedDireTeamId = 0
	b.launchSent = false
	dc := b.dotaClient
	b.mu.Unlock()
	if dc != nil {
		dc.AbandonLobby()
		dc.LeaveLobby()
	}
}

func (b *Bot) DestroyLobby(ctx context.Context) {
	dc := b.dc()
	if dc == nil {
		b.log("ACTION: DestroyLobby skipped — dota client not connected")
		return
	}
	b.log("ACTION: DestroyLobby")
	dc.DestroyLobby(ctx)
}

// PollLobbyFromCache reads the current lobby state directly from the cache
// container and re-runs processLobbyUpdate. Safety net for when cache
// subscription events stop firing — the cache itself stays fresh even when
// subscriber channels go quiet, so a direct read still catches state changes
// (match ID assigned, state → RUN, etc).
func (b *Bot) PollLobbyFromCache() {
	dc := b.dc()
	if dc == nil {
		return
	}
	container, err := dc.GetCache().GetContainerForTypeID(uint32(cso.Lobby))
	if err != nil {
		return
	}
	obj := container.GetOne()
	if obj == nil {
		return
	}
	lob, ok := obj.(*gcccm.CSODOTALobby)
	if !ok {
		return
	}
	b.log(fmt.Sprintf("POLL: Cache read — state: %s, matchID: %d, members: %d",
		lob.GetState().String(), lob.GetMatchId(), len(lob.GetAllMembers())))
	// Serialize with the cache-event watcher — see handleLobbyCacheEvent.
	b.processMu.Lock()
	defer b.processMu.Unlock()
	b.processLobbyUpdate(b.getLastLobby(), lob)
	b.setLastLobby(lob)
}

func parseSteamID(s string) uint64 {
	var id uint64
	fmt.Sscanf(s, "%d", &id)
	return id
}

func teamName(team gcccm.DOTA_GC_TEAM) string {
	switch team {
	case gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_GOOD_GUYS:
		return "radiant"
	case gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_BAD_GUYS:
		return "dire"
	case gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_BROADCASTER:
		return "broadcaster"
	case gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_SPECTATOR:
		return "spectator"
	case gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_PLAYER_POOL:
		return "unassigned"
	case gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_NOTEAM:
		return "noteam"
	default:
		return fmt.Sprintf("unknown(%d)", int(team))
	}
}
