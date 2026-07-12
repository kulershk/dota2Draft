package main

import (
	"encoding/json"
	"lobbybot/bot"
	"lobbybot/config"
	"lobbybot/lobby"
	"lobbybot/protocol"
	"lobbybot/ws"
	"log"
	"strconv"
)

func main() {
	log.Println("Dota 2 Lobby Bot Service starting...")
	cfg := config.Load()

	var wsClient *ws.Client
	var botMgr *bot.Manager
	var lobbyMgr *lobby.Manager

	sendFn := func(msgType string, data interface{}) error {
		if wsClient != nil {
			return wsClient.Send(msgType, data)
		}
		return nil
	}

	botMgr = bot.NewManager(sendFn)
	lobbyMgr = lobby.NewManager(botMgr, sendFn)

	// decode unmarshals a command payload; a malformed payload is logged and
	// skipped instead of silently proceeding with a zero-value command.
	decode := func(msgType string, data json.RawMessage, v interface{}) bool {
		if err := json.Unmarshal(data, v); err != nil {
			log.Printf("Invalid %s payload: %v", msgType, err)
			return false
		}
		return true
	}

	handler := func(msgType string, data json.RawMessage) {
		log.Printf("Received command: %s", msgType)
		switch msgType {
		case "sync":
			var cmd protocol.SyncCmd
			if !decode(msgType, data, &cmd) {
				return
			}
			log.Printf("Received sync: %d bots, %d lobbies", len(cmd.Bots), len(cmd.Lobbies))
			for _, b := range cmd.Bots {
				botMgr.AddBot(b.BotID, b.Username, b.Password, b.RefreshToken)
				log.Printf("Synced bot %s (%s)", b.BotID, b.Username)
			}

		case "add_bot":
			var cmd protocol.AddBotCmd
			if !decode(msgType, data, &cmd) {
				return
			}
			botMgr.AddBot(cmd.BotID, cmd.Username, cmd.Password, cmd.RefreshToken)

		case "connect_bot":
			var cmd protocol.ConnectBotCmd
			if !decode(msgType, data, &cmd) {
				return
			}
			botMgr.AddBot(cmd.BotID, cmd.Username, cmd.Password, cmd.RefreshToken)
			if b := botMgr.GetBot(cmd.BotID); b != nil {
				if cmd.SentryHash != "" {
					b.SetSentryHashHex(cmd.SentryHash)
				}
				if cmd.LoginKey != "" {
					b.SetLoginKey(cmd.LoginKey)
				}
			}
			if err := botMgr.ConnectBot(cmd.BotID); err != nil {
				log.Printf("Connect bot error: %v", err)
			}

		case "disconnect_bot":
			var cmd protocol.DisconnectBotCmd
			if !decode(msgType, data, &cmd) {
				return
			}
			botMgr.DisconnectBot(cmd.BotID)

		case "list_bots":
			// Report every bot's live status so Node can reconcile its DB
			// before picking a bot for a lobby.
			sendFn("bots_list", protocol.BotsListEvent{Bots: botMgr.ListBots()})

		case "steam_guard":
			var cmd protocol.SteamGuardCmd
			if !decode(msgType, data, &cmd) {
				return
			}
			botMgr.SubmitSteamGuard(cmd.BotID, cmd.Code)

		case "create_lobby":
			var cmd protocol.CreateLobbyCmd
			if !decode(msgType, data, &cmd) {
				return
			}
			if err := lobbyMgr.CreateLobby(cmd); err != nil {
				log.Printf("Create lobby error: %v", err)
			}

		case "rejoin_lobby":
			var cmd protocol.RejoinLobbyCmd
			if !decode(msgType, data, &cmd) {
				return
			}
			if err := lobbyMgr.RejoinLobby(cmd); err != nil {
				log.Printf("Rejoin lobby error: %v", err)
			}

		case "cancel_lobby":
			var cmd protocol.CancelLobbyCmd
			if !decode(msgType, data, &cmd) {
				return
			}
			lobbyMgr.CancelLobby(cmd.LobbyID)

		case "force_launch":
			var cmd protocol.ForceLaunchCmd
			if !decode(msgType, data, &cmd) {
				return
			}
			lobbyMgr.ForceLaunch(cmd.LobbyID, cmd.SkipValidation)

		case "request_match_details":
			var cmd protocol.RequestMatchDetailsCmd
			if !decode(msgType, data, &cmd) {
				return
			}
			go func() {
				matchID, err := strconv.ParseUint(cmd.MatchID, 10, 64)
				if err != nil {
					log.Printf("Invalid match ID: %s", cmd.MatchID)
					sendFn("match_details", protocol.MatchDetailsEvent{MatchID: cmd.MatchID, Error: "Invalid match ID"})
					return
				}
				b := botMgr.GetBot(cmd.BotID)
				if b == nil {
					// Fall back to any available bot
					b = botMgr.FindAvailable()
				}
				if b == nil {
					sendFn("match_details", protocol.MatchDetailsEvent{MatchID: cmd.MatchID, Error: "No bot available"})
					return
				}
				result, err := b.RequestMatchDetails(matchID)
				if err != nil {
					log.Printf("Match details request failed: %v", err)
					sendFn("match_details", protocol.MatchDetailsEvent{MatchID: cmd.MatchID, Error: err.Error()})
					return
				}
				sendFn("match_details", *result)
			}()

		default:
			log.Printf("Unknown message type: %s", msgType)
		}
	}

	wsClient = ws.NewClient(cfg.WSURL, cfg.Token, handler)
	// On every (re)connect, push any lobby state Node may have lost across
	// the disconnect — most importantly server_steam_id, which the live-stats
	// poller needs and which otherwise required manual admin injection after
	// every deploy. Also re-report every bot's current status: a WS reconnect
	// otherwise left Node holding stale statuses (bots showing "available"/
	// "busy" that no longer matched reality), which made Retry Lobby fail with
	// a confusing "bot offline" until an admin manually reconnected the bots.
	wsClient.OnConnect = func() {
		botMgr.ResendAllLobbyState()
		botMgr.ResendAllBotStatus()
	}

	log.Printf("Connecting to Node.js at %s", cfg.WSURL)
	go wsClient.Run() // runs reconnect loop in background

	wsClient.WaitConnected()
	log.Println("Connected to Node.js. Lobby bot service ready.")

	// Block forever
	select {}
}
