package lobby

import (
	"strings"
	"sync"
	"testing"

	"lobbybot/bot"
	"lobbybot/protocol"
)

type rec struct {
	mu   sync.Mutex
	msgs []protocol.BotLogEvent
	all  []string
}

func (r *rec) send(t string, d interface{}) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.all = append(r.all, t)
	if l, ok := d.(protocol.BotLogEvent); ok {
		r.msgs = append(r.msgs, l)
	}
	return nil
}

func TestForceLaunchDeDupes(t *testing.T) {
	r := &rec{}
	b := bot.NewBot("1", "u", "p", "t", r.send)
	m := NewManager(bot.NewManager(r.send), r.send)
	m.lobbies["9"] = &Lobby{ID: "9", Bot: b}

	_ = m.ForceLaunch("9", true)
	_ = m.ForceLaunch("9", true) // within cooldown → skipped

	n := 0
	for _, l := range r.msgs {
		if strings.Contains(l.Message, "Force launching game") {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("launches sent = %d, want 1", n)
	}
}

func TestRejoinRefusesBotBusyElsewhere(t *testing.T) {
	r := &rec{}
	bm := bot.NewManager(r.send)
	bm.AddBot("1", "u", "p", "t")
	bm.GetBot("1").SetActiveLobbyID("5")
	m := NewManager(bm, r.send)
	if err := m.RejoinLobby(protocol.RejoinLobbyCmd{LobbyID: "6", BotID: "1"}); err == nil {
		t.Fatal("rejoin onto a bot already running lobby 5 must fail")
	}
	found := false
	for _, typ := range r.all {
		if typ == "lobby_error" {
			found = true
		}
	}
	if !found {
		t.Fatal("expected lobby_error for the refused rejoin")
	}
}
