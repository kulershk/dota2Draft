package bot

import (
	"sync"

	"lobbybot/protocol"

	gcccm "github.com/paralin/go-dota2/protocol"
)

type sentMsg struct {
	Type string
	Data interface{}
}

// recorder captures everything a Bot sends to Node.
type recorder struct {
	mu   sync.Mutex
	msgs []sentMsg
}

func (r *recorder) send(t string, d interface{}) error {
	r.mu.Lock()
	r.msgs = append(r.msgs, sentMsg{t, d})
	r.mu.Unlock()
	return nil
}

func (r *recorder) all() []sentMsg {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]sentMsg(nil), r.msgs...)
}

func (r *recorder) ofType(t string) []sentMsg {
	var out []sentMsg
	for _, m := range r.all() {
		if m.Type == t {
			out = append(out, m)
		}
	}
	return out
}

func newTestBot() (*Bot, *recorder) {
	r := &recorder{}
	return NewBot("1", "user", "pass", "token", r.send), r
}

func lastStatus(r *recorder) string {
	st := r.ofType("bot_status")
	if len(st) == 0 {
		return ""
	}
	return st[len(st)-1].Data.(protocol.BotStatusEvent).Status
}

func mkMember(id uint64, team gcccm.DOTA_GC_TEAM) *gcccm.CSODOTALobbyMember {
	return &gcccm.CSODOTALobbyMember{Id: &id, Team: &team}
}

func mkLobby(state gcccm.CSODOTALobby_State, matchID uint64, members ...*gcccm.CSODOTALobbyMember) *gcccm.CSODOTALobby {
	return &gcccm.CSODOTALobby{State: &state, MatchId: &matchID, AllMembers: members}
}
