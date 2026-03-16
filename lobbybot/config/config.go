package config

import "os"

type Config struct {
	WSURL string
	Token string
}

func Load() Config {
	wsURL := os.Getenv("WS_URL")
	if wsURL == "" {
		wsURL = "ws://localhost:3001/ws/lobbybot"
	}
	token := os.Getenv("BOT_SERVICE_TOKEN")
	return Config{WSURL: wsURL, Token: token}
}
