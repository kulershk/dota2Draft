package protocol

import "encoding/json"

// Envelope wraps all messages with a type field
type Envelope struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data,omitempty"`
}

// Commands (Node → Go)
type AddBotCmd struct {
	BotID    string `json:"botId"`
	Username string `json:"username"`
	Password string `json:"password"`
	RefreshToken string `json:"refreshToken,omitempty"`
}

type ConnectBotCmd struct {
	BotID        string `json:"botId"`
	Username     string `json:"username"`
	Password     string `json:"password"`
	RefreshToken string `json:"refreshToken,omitempty"`
	SentryHash   string `json:"sentryHash,omitempty"`
	LoginKey     string `json:"loginKey,omitempty"`
}

type DisconnectBotCmd struct {
	BotID string `json:"botId"`
}

type SteamGuardCmd struct {
	BotID string `json:"botId"`
	Code  string `json:"code"`
}

type LobbyPlayer struct {
	SteamID string `json:"steamId"`
	Name    string `json:"name"`
	Team    string `json:"team"` // "radiant" or "dire"
}

type CreateLobbyCmd struct {
	LobbyID             string        `json:"lobbyId"`
	GameName            string        `json:"gameName"`
	Password            string        `json:"password"`
	ServerRegion        int           `json:"serverRegion"`
	GameMode            int           `json:"gameMode"`
	AutoAssignTeams     bool          `json:"autoAssignTeams"`
	LeagueID            int           `json:"leagueId"`
	DotaTvDelay         int           `json:"dotaTvDelay"`
	Cheats              bool          `json:"cheats"`
	AllowSpectating     bool          `json:"allowSpectating"`
	PauseSetting        int           `json:"pauseSetting"`
	SelectionPriority   int           `json:"selectionPriority"`
	CmPick              int           `json:"cmPick"`
	PenaltyRadiant      int           `json:"penaltyRadiant"`
	PenaltyDire         int           `json:"penaltyDire"`
	SeriesType          int           `json:"seriesType"`
	RadiantName         string        `json:"radiantName"`
	DireName            string        `json:"direName"`
	ExpectedRadiantTeamId int         `json:"expectedRadiantTeamId"`
	ExpectedDireTeamId    int         `json:"expectedDireTeamId"`
	Players             []LobbyPlayer `json:"players"`
}

type RejoinLobbyCmd struct {
	LobbyID  string        `json:"lobbyId"`
	BotID    string        `json:"botId"`
	GameName string        `json:"gameName"`
	Password string        `json:"password"`
	Players  []LobbyPlayer `json:"players"`
}

type CancelLobbyCmd struct {
	LobbyID string `json:"lobbyId"`
}

type ForceLaunchCmd struct {
	LobbyID        string `json:"lobbyId"`
	SkipValidation bool   `json:"skipValidation"`
}

type SyncCmd struct {
	Bots    []ConnectBotCmd  `json:"bots"`
	Lobbies []CreateLobbyCmd `json:"lobbies"`
}

// Events (Go → Node)
type BotStatusEvent struct {
	BotID        string `json:"botId"`
	Status       string `json:"status"`
	SteamID      string `json:"steamId,omitempty"`
	DisplayName  string `json:"displayName,omitempty"`
	Error        string `json:"error,omitempty"`
	RefreshToken string `json:"refreshToken,omitempty"`
	SentryHash   string `json:"sentryHash,omitempty"`
	LoginKey     string `json:"loginKey,omitempty"`
}

type BotLogEvent struct {
	BotID   string `json:"botId"`
	Message string `json:"message"`
}

type LobbyStatusEvent struct {
	LobbyID       string        `json:"lobbyId"`
	Status        string        `json:"status"`
	PlayersJoined []LobbyPlayer `json:"playersJoined,omitempty"`
}

type PlayerJoinedEvent struct {
	LobbyID string `json:"lobbyId"`
	SteamID string `json:"steamId"`
	Name    string `json:"name"`
	Team    string `json:"team"`
	Slot    int    `json:"slot"`
}

type PlayerLeftEvent struct {
	LobbyID string `json:"lobbyId"`
	SteamID string `json:"steamId"`
}

type GameStartedEvent struct {
	LobbyID string `json:"lobbyId"`
	MatchID string `json:"matchId"`
}

type LobbyTeamIdsEvent struct {
	LobbyID          string `json:"lobbyId"`
	RadiantTeamId    int    `json:"radiantTeamId"`
	DireTeamId       int    `json:"direTeamId"`
	RadiantTeamName  string `json:"radiantTeamName"`
	DireTeamName     string `json:"direTeamName"`
}

type LobbyErrorEvent struct {
	LobbyID string `json:"lobbyId"`
	Error   string `json:"error"`
}
