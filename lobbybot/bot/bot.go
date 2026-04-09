package bot

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"lobbybot/protocol"
	"log"
	"mime/multipart"
	nethttp "net/http"
	"net/http/cookiejar"
	"net/textproto"
	"net/url"
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

	send             SendFunc
	mu               sync.Mutex
	guardCh          chan string
	cancelCh         chan struct{}
	steamClient      *steam.Client
	dotaClient       *dota2.Dota2
	pendingAuth      bool   // waiting for Steam Guard code
	pendingGuardCode string // code to use on next connect
	guardIsTwoFactor bool   // true = mobile auth, false = email
	sentryHash       steam.SentryHash
	loginKey         string
	activeLobbyID    string // lobby DB ID for event routing
	expectedTeams         map[uint64]string // steamID64 → "radiant"/"dire"
	gameStartedCh         chan struct{} // signals when game has started
	lastLobby             *gcccm.CSODOTALobby // last known lobby state for diffing
	lobbyCacheCancel      func() // cancel the lobby cache watcher
	expectedRadiantTeamId int
	expectedDireTeamId    int
	detectedRadiantTeamId int
	detectedDireTeamId    int
	launchSent            bool // prevent repeated LaunchLobby calls

	// Steam Community web session cookies (set after WebLoggedOnEvent)
	webSessionId        string
	webSteamLogin       string
	webSteamLoginSecure string
}

func NewBot(id, username, password, refreshToken string, send SendFunc) *Bot {
	return &Bot{
		ID:           id,
		Username:     username,
		Password:     password,
		RefreshToken: refreshToken,
		Status:       StatusOffline,
		send:         send,
		guardCh:       make(chan string, 1),
		cancelCh:      make(chan struct{}, 1),
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
	b.mu.Unlock()

	evt := protocol.BotStatusEvent{
		BotID:       b.ID,
		Status:      status,
		SteamID:     b.SteamID,
		DisplayName: b.DisplayName,
	}
	if len(errMsg) > 0 {
		evt.Error = errMsg[0]
	}
	b.send("bot_status", evt)
}

func (b *Bot) Connect() {
	b.log(fmt.Sprintf("Connecting as %s...", b.Username))
	b.setStatus(StatusConnecting)

	b.steamClient = steam.NewClient()
	b.steamClient.ConnectionTimeout = 30 * time.Second
	go b.handleSteamEvents()

	b.log("Connecting to Steam network...")
	b.steamClient.Connect()
}

func (b *Bot) handleSteamEvents() {
	for event := range b.steamClient.Events() {
		switch e := event.(type) {
		case *steam.ConnectedEvent:
			details := &steam.LogOnDetails{
				Username:               b.Username,
				SentryFileHash:         b.sentryHash,
				ShouldRememberPassword: true,
			}
			if b.pendingGuardCode != "" {
				code := b.pendingGuardCode
				b.pendingGuardCode = ""
				details.Password = b.Password
				if b.guardIsTwoFactor {
					b.log("Connected to Steam. Logging in with 2FA code...")
					details.TwoFactorCode = code
				} else {
					b.log("Connected to Steam. Logging in with email code...")
					details.AuthCode = code
				}
			} else if b.loginKey != "" {
				b.log("Connected to Steam. Logging in with saved login key...")
				details.LoginKey = b.loginKey
			} else {
				b.log("Connected to Steam. Logging in with password...")
				details.Password = b.Password
			}
			b.steamClient.Auth.LogOn(details)

		case *steam.LoggedOnEvent:
			b.SteamID = b.steamClient.SteamId().String()
			b.log(fmt.Sprintf("Logged into Steam (SteamID: %s)", b.SteamID))
			b.log(fmt.Sprintf("Login key: '%s', Sentry: %d bytes", b.loginKey, len(b.sentryHash)))

		case *steam.AccountInfoEvent:
			b.DisplayName = e.PersonaName
			b.log(fmt.Sprintf("Account: %s (country: %s)", e.PersonaName, e.Country))
			b.setStatus(StatusConnectingGC)

			b.steamClient.Social.SetPersonaState(steamlang.EPersonaState_Online)

			logger := logrus.New()
			logger.SetLevel(logrus.DebugLevel)
			b.dotaClient = dota2.New(b.steamClient, logger)
			b.dotaClient.SetPlaying(true)

			b.log("Connecting to Dota 2 Game Coordinator...")
			// Give Steam a moment to register the game before saying hello
			go func() {
				time.Sleep(2 * time.Second)
				b.log("Sending GC Hello...")
				b.dotaClient.SayHello()
				// Retry hello if no response
				time.Sleep(5 * time.Second)
				b.mu.Lock()
				status := b.Status
				b.mu.Unlock()
				if status == StatusConnectingGC {
					b.log("No GC response, retrying hello...")
					b.dotaClient.SayHello()
				}
			}()

		case *steam.LogOnFailedEvent:
			result := e.Result
			if result == steamlang.EResult_AccountLogonDenied ||
				result == steamlang.EResult_AccountLoginDeniedNeedTwoFactor {
				b.guardIsTwoFactor = (result == steamlang.EResult_AccountLoginDeniedNeedTwoFactor)
				guardType := "email"
				if b.guardIsTwoFactor {
					guardType = "mobile authenticator"
				}
				b.log(fmt.Sprintf("Steam Guard code required (%s) — waiting for code...", guardType))
				b.setStatus(StatusAwaitGuard)
				b.pendingAuth = true

				// Steam disconnects after failed login, so we need to wait for code
				// then reconnect and login with it
				go func() {
					select {
					case code := <-b.guardCh:
						b.log("Steam Guard code received, reconnecting...")
						b.pendingAuth = false
						b.pendingGuardCode = code
						// Reconnect — the ConnectedEvent handler will use the code
						if b.steamClient != nil {
							b.steamClient.Connect()
						}
					case <-time.After(5 * time.Minute):
						b.log("Steam Guard code timed out")
						b.setStatus(StatusError, "Steam Guard code timed out")
					case <-b.cancelCh:
						return
					}
				}()
			} else {
				b.log(fmt.Sprintf("Login failed: %v", result))
				b.setStatus(StatusError, fmt.Sprintf("Login failed: %v", result))
			}

		case *steam.MachineAuthUpdateEvent:
			b.log("Machine auth updated — sentry saved")
			b.sentryHash = e.Hash
			b.send("bot_status", protocol.BotStatusEvent{
				BotID:      b.ID,
				Status:     b.Status,
				SentryHash: fmt.Sprintf("%x", e.Hash),
			})

		case *steam.LoginKeyEvent:
			b.log("Login key received — won't need 2FA next time")
			b.loginKey = e.LoginKey
			b.send("bot_status", protocol.BotStatusEvent{
				BotID:    b.ID,
				Status:   b.Status,
				LoginKey: e.LoginKey,
			})

		case *steam.WebSessionIdEvent:
			b.log("Web session id received — requesting web logon...")
			if b.steamClient != nil && b.steamClient.Web != nil {
				b.steamClient.Web.LogOn()
			}

		case *steam.WebLoggedOnEvent:
			if b.steamClient != nil && b.steamClient.Web != nil {
				b.mu.Lock()
				b.webSessionId = b.steamClient.Web.SessionId
				b.webSteamLogin = b.steamClient.Web.SteamLogin
				b.webSteamLoginSecure = b.steamClient.Web.SteamLoginSecure
				b.mu.Unlock()
				b.log("Web session ready (community cookies stored)")
			}

		case steam.WebLogOnErrorEvent:
			b.log(fmt.Sprintf("Web logon error: %v", e))

		case *devents.ClientWelcomed:
			b.log("Dota 2 GC welcomed! Bot is ready.")
			b.setStatus(StatusAvailable)
			// Start lobby cache watcher
			go b.watchLobbyCacheEvents()

		case *devents.GCConnectionStatusChanged:
			b.log(fmt.Sprintf("GC status: %s → %s", e.OldState.String(), e.NewState.String()))
			if e.NewState == gcccm.GCConnectionStatus_GCConnectionStatus_HAVE_SESSION {
				b.setStatus(StatusAvailable)
			}

		case *devents.UnhandledGCPacket:
			b.log(fmt.Sprintf("Unhandled GC packet: msgType=%d", e.Packet.MsgType))

		case *steam.DisconnectedEvent:
			b.mu.Lock()
			waiting := b.pendingAuth
			status := b.Status
			b.mu.Unlock()
			if waiting {
				b.log("Disconnected (waiting for Steam Guard code)")
				continue // don't exit the event loop, we'll reconnect after code
			}
			// If we were online or connecting, auto-reconnect with a fresh client
			if status != StatusOffline {
				b.log("Disconnected from Steam — reconnecting in 3s...")
				b.setStatus(StatusConnecting)
				time.Sleep(3 * time.Second)
				select {
				case <-b.cancelCh:
					b.setStatus(StatusOffline)
					return
				default:
				}
				b.reconnect()
				return // exit this event loop; reconnect starts a new one
			}
			return

		case error:
			b.log(fmt.Sprintf("Steam error: %v — reconnecting in 3s...", e))
			b.setStatus(StatusConnecting)
			time.Sleep(3 * time.Second)
			select {
			case <-b.cancelCh:
				b.setStatus(StatusOffline)
				return
			default:
			}
			b.reconnect()
			return // exit this event loop; reconnect starts a new one
		}
	}
}

func (b *Bot) reconnect() {
	b.log("Creating fresh Steam client for reconnect...")
	// Clean up old dota client if any
	if b.dotaClient != nil {
		b.dotaClient.SetPlaying(false)
		b.dotaClient.Close()
		b.dotaClient = nil
	}
	// Stop old lobby cache watcher
	b.mu.Lock()
	if b.lobbyCacheCancel != nil {
		b.lobbyCacheCancel()
		b.lobbyCacheCancel = nil
	}
	b.mu.Unlock()
	// Create fresh client and start new event loop
	b.steamClient = steam.NewClient()
	b.steamClient.ConnectionTimeout = 30 * time.Second
	go b.handleSteamEvents()
	b.log("Reconnecting to Steam network...")
	b.steamClient.Connect()
}

func (b *Bot) Disconnect() {
	b.log("Disconnecting...")
	select {
	case b.cancelCh <- struct{}{}:
	default:
	}
	// Stop lobby cache watcher
	b.mu.Lock()
	if b.lobbyCacheCancel != nil {
		b.lobbyCacheCancel()
		b.lobbyCacheCancel = nil
	}
	b.mu.Unlock()
	if b.dotaClient != nil {
		b.dotaClient.SetPlaying(false)
		b.dotaClient.Close()
		b.dotaClient = nil
	}
	if b.steamClient != nil {
		b.steamClient.Disconnect()
		b.steamClient = nil
	}
	b.setStatus(StatusOffline)
}

func (b *Bot) SubmitSteamGuard(code string) {
	select {
	case b.guardCh <- code:
		b.log("Steam Guard code submitted")
	default:
		b.log("No pending Steam Guard request")
	}
}

func (b *Bot) SetSentryHashHex(hexStr string) {
	decoded, err := hex.DecodeString(hexStr)
	if err == nil && len(decoded) > 0 {
		b.sentryHash = steam.SentryHash(decoded)
	}
}

func (b *Bot) SetLoginKey(key string) {
	b.loginKey = key
}

func (b *Bot) SetActiveLobbyID(id string) {
	b.activeLobbyID = id
}

// SetAvatar uploads a new profile picture to Steam Community for this bot.
// Requires that the bot has an active web session (cookies set after WebLoggedOnEvent).
func (b *Bot) SetAvatar(imageBytes []byte, mimeType, filename string) error {
	b.mu.Lock()
	sessionId := b.webSessionId
	steamLogin := b.webSteamLogin
	steamLoginSecure := b.webSteamLoginSecure
	steamID := b.SteamID
	b.mu.Unlock()

	if sessionId == "" || steamLoginSecure == "" {
		return fmt.Errorf("bot %s has no active web session", b.ID)
	}
	if steamID == "" {
		return fmt.Errorf("bot %s has no SteamID yet", b.ID)
	}
	if mimeType == "" {
		mimeType = "image/jpeg"
	}
	if filename == "" {
		filename = "avatar.jpg"
	}

	jar, _ := cookiejar.New(nil)
	base, _ := url.Parse("https://steamcommunity.com/")
	jar.SetCookies(base, []*nethttp.Cookie{
		{Name: "sessionid", Value: sessionId},
		{Name: "steamLogin", Value: steamLogin},
		{Name: "steamLoginSecure", Value: steamLoginSecure},
	})
	client := &nethttp.Client{Jar: jar, Timeout: 60 * time.Second}

	body := &bytes.Buffer{}
	mp := multipart.NewWriter(body)
	_ = mp.WriteField("MAX_FILE_SIZE", "1048576")
	_ = mp.WriteField("type", "player_avatar_image")
	_ = mp.WriteField("sId", steamID)
	_ = mp.WriteField("sessionid", sessionId)
	_ = mp.WriteField("doSub", "1")
	_ = mp.WriteField("json", "1")
	hdr := make(textproto.MIMEHeader)
	hdr.Set("Content-Disposition", fmt.Sprintf(`form-data; name="avatar"; filename=%q`, filename))
	hdr.Set("Content-Type", mimeType)
	part, err := mp.CreatePart(hdr)
	if err != nil {
		return fmt.Errorf("create multipart part: %w", err)
	}
	if _, err := part.Write(imageBytes); err != nil {
		return fmt.Errorf("write avatar bytes: %w", err)
	}
	if err := mp.Close(); err != nil {
		return fmt.Errorf("close multipart: %w", err)
	}

	req, err := nethttp.NewRequest("POST", "https://steamcommunity.com/actions/FileUploader", body)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", mp.FormDataContentType())
	req.Header.Set("Referer", "https://steamcommunity.com/profiles/"+steamID+"/edit/avatar")
	req.Header.Set("User-Agent", "Mozilla/5.0 (lobbybot)")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("upload request: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return fmt.Errorf("steam responded %d: %s", resp.StatusCode, string(respBody))
	}
	// Steam returns JSON like {"success":true,"images":{...}} or {"success":false,"message":"..."}
	var parsed struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		// If the body isn't JSON, treat the whole body as the error message
		return fmt.Errorf("steam returned non-json response: %s", string(respBody))
	}
	if !parsed.Success {
		msg := parsed.Message
		if msg == "" {
			msg = "unknown steam error"
		}
		return fmt.Errorf("steam rejected avatar: %s", msg)
	}
	b.log("Avatar updated successfully")
	return nil
}

func (b *Bot) watchLobbyCacheEvents() {
	if b.dotaClient == nil {
		b.log("Cannot watch lobby cache: dota client not connected")
		return
	}

	eventCh, unsub, err := b.dotaClient.GetCache().SubscribeType(cso.Lobby)
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
		container, err := b.dotaClient.GetCache().GetContainerForTypeID(uint32(cso.Lobby))
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
	switch event.EventType {
	case socache.EventTypeCreate:
		lobby := event.Object.(*gcccm.CSODOTALobby)
		b.log(fmt.Sprintf("CACHE: Lobby created (id: %d, state: %s)",
			lobby.GetLobbyId(), lobby.GetState().String()))
		// If bot has no active lobby assignment, wait briefly for rejoin_lobby command
		// then leave if still unassigned
		if b.activeLobbyID == "" {
			b.log("CACHE: Found lobby with no active assignment — waiting 5s for rejoin command...")
			b.lastLobby = lobby
			go func() {
				time.Sleep(5 * time.Second)
				b.mu.Lock()
				assigned := b.activeLobbyID != ""
				b.mu.Unlock()
				if !assigned {
					b.log("CACHE: No rejoin received — leaving stale lobby")
					b.LeaveLobby()
					b.mu.Lock()
					b.lastLobby = nil
					b.mu.Unlock()
				} else {
					b.log("CACHE: Rejoin received — keeping lobby")
				}
			}()
			return
		}
		b.processLobbyUpdate(nil, lobby)
		b.lastLobby = lobby

	case socache.EventTypeUpdate:
		lobby := event.Object.(*gcccm.CSODOTALobby)
		b.log(fmt.Sprintf("CACHE: Lobby updated (id: %d, state: %s)",
			lobby.GetLobbyId(), lobby.GetState().String()))
		b.processLobbyUpdate(b.lastLobby, lobby)
		b.lastLobby = lobby

	case socache.EventTypeDestroy:
		b.log("CACHE: Lobby destroyed")
		b.lastLobby = nil
	}
}

func (b *Bot) processLobbyUpdate(oldLobby, newLobby *gcccm.CSODOTALobby) {
	// Skip if bot has already left the lobby
	if b.activeLobbyID == "" {
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
				LobbyID: b.activeLobbyID,
				SteamID: steamId,
				Team:    newTeam,
			})
		} else if oldMembers[pid] != m.GetTeam() {
			b.log(fmt.Sprintf("Player %d changed team: %s → %s", pid, teamName(oldMembers[pid]), newTeam))
			b.send("player_joined", protocol.PlayerJoinedEvent{
				LobbyID: b.activeLobbyID,
				SteamID: steamId,
				Team:    newTeam,
			})
		}
	}
	for pid := range oldMembers {
		if _, stillHere := newMembersMap[pid]; !stillHere {
			b.log(fmt.Sprintf("Player %d left lobby", pid))
			b.send("player_left", protocol.PlayerLeftEvent{
				LobbyID: b.activeLobbyID,
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
	b.send("lobby_status", protocol.LobbyStatusEvent{
		LobbyID:       b.activeLobbyID,
		Status:        "waiting",
		PlayersJoined: joinedPlayers,
	})

	// Detect team IDs from lobby team details
	teamDetails := newLobby.GetTeamDetails()
	if len(teamDetails) >= 2 {
		radiantId := int(teamDetails[0].GetTeamId())
		direId := int(teamDetails[1].GetTeamId())
		if radiantId != b.detectedRadiantTeamId || direId != b.detectedDireTeamId {
			b.detectedRadiantTeamId = radiantId
			b.detectedDireTeamId = direId
			radiantName := teamDetails[0].GetTeamName()
			direName := teamDetails[1].GetTeamName()
			b.log(fmt.Sprintf("Team IDs — Radiant: %d (%s), Dire: %d (%s)", radiantId, radiantName, direId, direName))
			b.send("lobby_team_ids", protocol.LobbyTeamIdsEvent{
				LobbyID:         b.activeLobbyID,
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

	// Report state changes to Node so frontend can track lobby phase
	if lobbyState != oldState && b.activeLobbyID != "" {
		statusName := ""
		switch lobbyState {
		case gcccm.CSODOTALobby_SERVERSETUP:
			statusName = "cointoss"
		case gcccm.CSODOTALobby_RUN:
			statusName = "active"
		}
		if statusName != "" {
			b.send("lobby_status", protocol.LobbyStatusEvent{
				LobbyID: b.activeLobbyID,
				Status:  statusName,
			})
		}
	}

	// Detect match ID assigned
	if matchID != 0 && (oldLobby == nil || oldLobby.GetMatchId() == 0) {
		b.log(fmt.Sprintf("Match ID assigned: %d", matchID))
		b.send("game_started", protocol.GameStartedEvent{
			LobbyID: b.activeLobbyID,
			MatchID: fmt.Sprintf("%d", matchID),
		})
		// Auto-launch immediately since we have a match ID but lobby is still in UI
		if lobbyState == gcccm.CSODOTALobby_UI && b.dotaClient != nil && !b.launchSent {
			b.log("Auto-launching after match ID assigned...")
			b.launchSent = true
			b.dotaClient.LaunchLobby()
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
			b.launchSent = false // reset so we can launch again after coin toss
			if b.dotaClient != nil {
				b.launchSent = true
				b.dotaClient.LaunchLobby()
			}
		}
	}

	// Only signal bot to leave when game is actually running
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

	// Enforce team assignments — kick players on wrong team back to unassigned
	if b.expectedTeams != nil && b.dotaClient != nil && b.steamClient != nil {
		for _, m := range newMembers {
			playerID := m.GetId()
			currentTeam := m.GetTeam()

			// Skip bot itself
			if playerID == b.steamClient.SteamId().ToUint64() {
				continue
			}
			// Skip players not on a team slot
			if currentTeam != gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_GOOD_GUYS &&
				currentTeam != gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_BAD_GUYS {
				continue
			}

			// Convert 64-bit Steam ID to 32-bit account ID for the kick API
			accountID := uint32(playerID - 76561197960265728)

			expectedTeam, known := b.expectedTeams[playerID]
			if !known {
				b.log(fmt.Sprintf("ENFORCE: Unknown player %d on %s — kicking to unassigned",
					playerID, teamName(currentTeam)))
				b.dotaClient.KickLobbyMemberFromTeam(accountID)
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
				b.dotaClient.KickLobbyMemberFromTeam(accountID)
			} else {
				b.log(fmt.Sprintf("ENFORCE: Player %d on %s — correct", playerID, teamName(currentTeam)))
			}
		}
	}

	// Report joined players to Node.js (exclude the bot itself)
	var joined []protocol.LobbyPlayer
	for _, m := range newMembers {
		if b.steamClient != nil && m.GetId() == b.steamClient.SteamId().ToUint64() {
			continue
		}
		team := teamName(m.GetTeam())
		joined = append(joined, protocol.LobbyPlayer{
			SteamID: fmt.Sprintf("%d", m.GetId()),
			Team:    team,
		})
	}

	if b.activeLobbyID != "" {
		b.send("lobby_status", protocol.LobbyStatusEvent{
			LobbyID:       b.activeLobbyID,
			Status:        "waiting",
			PlayersJoined: joined,
		})
	}
}

func (b *Bot) SetExpectedTeams(players []protocol.LobbyPlayer) {
	b.expectedTeams = make(map[uint64]string)
	for _, p := range players {
		sid := parseSteamID(p.SteamID)
		if sid != 0 {
			b.expectedTeams[sid] = p.Team
		}
	}
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

func (b *Bot) GetActiveLobbyID() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.activeLobbyID
}

func (b *Bot) SetBusy(busy bool) {
	b.mu.Lock()
	if busy {
		b.Status = StatusBusy
	} else {
		b.Status = StatusAvailable
	}
	status := b.Status
	b.mu.Unlock()
	b.send("bot_status", protocol.BotStatusEvent{BotID: b.ID, Status: status})
}

func (b *Bot) SetExpectedTeamIds(radiant, dire int) {
	b.expectedRadiantTeamId = radiant
	b.expectedDireTeamId = dire
}

func (b *Bot) GetDetectedTeamIds() (int, int) {
	return b.detectedRadiantTeamId, b.detectedDireTeamId
}

func (b *Bot) GameStartedCh() <-chan struct{} {
	return b.gameStartedCh
}

func (b *Bot) GetDotaClient() *dota2.Dota2 {
	return b.dotaClient
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
	if b.dotaClient == nil {
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
	err := b.dotaClient.LeaveCreateLobby(createCtx, details, true)
	if err != nil {
		return err
	}

	// Subscribe to lobby cache updates so we can wait for GC to confirm team change
	cacheCtr, err := b.dotaClient.GetCache().GetContainerForTypeID(uint32(cso.Lobby))
	if err != nil {
		// Fallback: just send the command without waiting
		b.log("Could not subscribe to lobby cache, sending team change without waiting")
		b.dotaClient.JoinLobbyTeam(gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_PLAYER_POOL, 0)
		return nil
	}

	eventCh, eventCancel, err := cacheCtr.Subscribe()
	if err != nil {
		b.dotaClient.JoinLobbyTeam(gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_PLAYER_POOL, 0)
		return nil
	}
	defer eventCancel()

	// Move bot to unassigned (player pool) so real players can pick Radiant/Dire
	accountID := uint32(b.steamClient.SteamId().ToUint64() & 0xFFFFFFFF)
	b.dotaClient.KickLobbyMemberFromTeam(accountID)

	// Wait for GC to confirm the team change
	moveCtx, moveCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer moveCancel()

	for {
		select {
		case <-moveCtx.Done():
			b.log("Timed out waiting for team move confirmation, trying JoinLobbyTeam fallback")
			b.dotaClient.JoinLobbyTeam(gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_PLAYER_POOL, 0)
			return nil
		case <-eventCh:
			// Check if bot is no longer on Radiant/Dire
			lobbyObj := cacheCtr.GetOne()
			if lobbyObj == nil {
				continue
			}
			lob := lobbyObj.(*gcccm.CSODOTALobby)
			botOnTeam := false
			for _, m := range lob.GetAllMembers() {
				if m.GetId() == b.steamClient.SteamId().ToUint64() {
					team := m.GetTeam()
					if team == gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_GOOD_GUYS || team == gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_BAD_GUYS {
						botOnTeam = true
					}
					break
				}
			}
			if !botOnTeam {
				b.log("Bot moved to unassigned — team slots are free")
				return nil
			}
		}
	}
}

func (b *Bot) InvitePlayer(steamID64 string) {
	if b.dotaClient == nil {
		return
	}
	sid := steamid.SteamId(parseSteamID(steamID64))
	b.dotaClient.InviteLobbyMember(sid)
}

func (b *Bot) LaunchLobby() {
	if b.dotaClient != nil {
		b.dotaClient.LaunchLobby()
	}
}

func (b *Bot) LeaveLobby() {
	b.lastLobby = nil
	b.detectedRadiantTeamId = 0
	b.detectedDireTeamId = 0
	b.launchSent = false
	if b.dotaClient != nil {
		b.dotaClient.LeaveLobby()
	}
}

func (b *Bot) AbandonAndLeaveLobby() {
	b.lastLobby = nil
	b.detectedRadiantTeamId = 0
	b.detectedDireTeamId = 0
	b.launchSent = false
	if b.dotaClient != nil {
		b.dotaClient.AbandonLobby()
		b.dotaClient.LeaveLobby()
	}
}

func (b *Bot) DestroyLobby(ctx context.Context) {
	if b.dotaClient != nil {
		b.dotaClient.DestroyLobby(ctx)
	}
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
