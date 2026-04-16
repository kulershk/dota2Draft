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
	BotID               string        `json:"botId,omitempty"`
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
	TimeoutMinutes      int           `json:"timeoutMinutes,omitempty"`
}

type RejoinLobbyCmd struct {
	LobbyID        string        `json:"lobbyId"`
	BotID          string        `json:"botId"`
	GameName       string        `json:"gameName"`
	Password       string        `json:"password"`
	Players        []LobbyPlayer `json:"players"`
	TimeoutMinutes int           `json:"timeoutMinutes,omitempty"`
}

type CancelLobbyCmd struct {
	LobbyID string `json:"lobbyId"`
}

type ForceLaunchCmd struct {
	LobbyID        string `json:"lobbyId"`
	SkipValidation bool   `json:"skipValidation"`
}

type RequestMatchDetailsCmd struct {
	MatchID string `json:"matchId"` // Dota 2 match ID (dotabuff_id)
	BotID   string `json:"botId"`   // Which bot to use for the GC request
}

type MatchDetailsPlayer struct {
	AccountID    uint32 `json:"account_id"`
	PlayerSlot   uint32 `json:"player_slot"`
	HeroID       int32  `json:"hero_id"`
	Kills        uint32 `json:"kills"`
	Deaths       uint32 `json:"deaths"`
	Assists      uint32 `json:"assists"`
	LastHits     uint32 `json:"last_hits"`
	Denies       uint32 `json:"denies"`
	GoldPerMin   uint32 `json:"gold_per_min"`
	XpPerMin     uint32 `json:"xp_per_min"`
	HeroDamage   uint32 `json:"hero_damage"`
	TowerDamage  uint32 `json:"tower_damage"`
	HeroHealing  uint32 `json:"hero_healing"`
	Level        uint32 `json:"level"`
	NetWorth     uint32 `json:"net_worth"`
	Item0        int32  `json:"item_0"`
	Item1        int32  `json:"item_1"`
	Item2        int32  `json:"item_2"`
	Item3        int32  `json:"item_3"`
	Item4        int32  `json:"item_4"`
	Item5        int32  `json:"item_5"`
	Backpack0    int32  `json:"backpack_0"`
	Backpack1    int32  `json:"backpack_1"`
	Backpack2    int32  `json:"backpack_2"`
	ItemNeutral  int32  `json:"item_neutral"`
	IsRadiant    bool   `json:"isRadiant"`
	Win          int    `json:"win"`
	PlayerName   string `json:"personaname"`
}

type MatchDetailsEvent struct {
	MatchID     string               `json:"matchId"`
	RadiantWin  bool                 `json:"radiant_win"`
	Duration    uint32               `json:"duration"`
	StartTime   uint32               `json:"start_time"`
	GameMode    uint32               `json:"game_mode"`
	Players     []MatchDetailsPlayer `json:"players"`
	Error       string               `json:"error,omitempty"`
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
