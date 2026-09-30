package lobby

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"lobbybot/bot"
	"lobbybot/protocol"
)

type rec struct {
	mu          sync.Mutex
	msgs        []protocol.BotLogEvent
	lobbyErrors []protocol.LobbyErrorEvent
	kickResults []protocol.KickResultEvent
	all         []string
}

func (r *rec) send(t string, d interface{}) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.all = append(r.all, t)
	if l, ok := d.(protocol.BotLogEvent); ok {
		r.msgs = append(r.msgs, l)
	}
	if e, ok := d.(protocol.LobbyErrorEvent); ok {
		r.lobbyErrors = append(r.lobbyErrors, e)
	}
	if k, ok := d.(protocol.KickResultEvent); ok {
		r.kickResults = append(r.kickResults, k)
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

func TestForceLaunchNoTeamIdsEmitsLaunchRejected(t *testing.T) {
	r := &rec{}
	b := bot.NewBot("1", "u", "p", "t", r.send)
	m := NewManager(bot.NewManager(r.send), r.send)
	m.lobbies["9"] = &Lobby{ID: "9", Bot: b}

	// skipValidation=false and the bot has never detected a Radiant/Dire team
	// (GetDetectedTeamIds defaults to 0, 0), so ForceLaunch must reject the
	// launch — but as a "launch_rejected" Kind, since the lobby itself is
	// still healthy and shouldn't be torn down/retried by Node.
	if err := m.ForceLaunch("9", false); err == nil {
		t.Fatal("ForceLaunch with no detected team ids must fail validation")
	}

	found := false
	for _, e := range r.lobbyErrors {
		if e.LobbyID == "9" && e.Kind == "launch_rejected" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a lobby_error with Kind=launch_rejected, got %+v", r.lobbyErrors)
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

// TestReleaseLobbyClearsBotAndLobby exercises the cleanup helper that
// runLobby's `defer m.releaseLobby(lobby)` relies on for every exit path,
// including an unwinding panic — a deferred function always runs during a
// panic unwind, so proving this helper does the right thing is equivalent to
// proving runLobby can't leak a busy bot / tracked lobby on panic. Triggering
// an actual panic from inside CreatePracticeLobby would need a production
// test hook (e.g. an injectable panic point) that isn't worth adding just for
// this test, so this targets the shared helper directly instead.
func TestReleaseLobbyClearsBotAndLobby(t *testing.T) {
	r := &rec{}
	b := bot.NewBot("1", "u", "p", "t", r.send)
	b.SetActiveLobbyID("9")
	b.SetExpectedTeams([]protocol.LobbyPlayer{{SteamID: "1"}})
	b.SetBusy(true)
	m := NewManager(bot.NewManager(r.send), r.send)
	lobby := &Lobby{ID: "9", Bot: b}
	m.lobbies["9"] = lobby

	m.releaseLobby(lobby)

	if id := b.GetActiveLobbyID(); id != "" {
		t.Errorf("ActiveLobbyID = %q, want empty", id)
	}
	if b.Status == bot.StatusBusy {
		t.Error("bot still busy after releaseLobby")
	}
	m.mu.RLock()
	_, tracked := m.lobbies["9"]
	m.mu.RUnlock()
	if tracked {
		t.Error("lobby still tracked after releaseLobby")
	}
}

// A timeout while the bot's GC session is down is not a player no-show: the
// error text must not match Node's /timed out/i (which bans the roster).
func TestTimeoutErrorText(t *testing.T) {
	if s := timeoutErrorText(true, 10); !strings.Contains(strings.ToLower(s), "timed out") {
		t.Errorf("GC ready: %q must report a timeout", s)
	}
	if s := timeoutErrorText(false, 10); strings.Contains(strings.ToLower(s), "timed out") {
		t.Errorf("GC down: %q must not look like a player timeout", s)
	}
}

func TestFinishLobbyTimeoutWithoutGCIsNotNoShow(t *testing.T) {
	r := &rec{}
	b := bot.NewBot("1", "u", "p", "t", r.send) // fresh bot: no GC session
	m := NewManager(bot.NewManager(r.send), r.send)
	m.finishLobby(context.Background(), "9", b, 10*time.Millisecond, func(string, string) {})
	if len(r.lobbyErrors) != 1 {
		t.Fatalf("lobby errors = %+v, want 1", r.lobbyErrors)
	}
	if e := r.lobbyErrors[0].Error; strings.Contains(strings.ToLower(e), "timed out") {
		t.Errorf("lobby_error %q would be treated as a no-show timeout", e)
	}
}

// kick_player for a lobby Go no longer tracks (finished, or its bot died) must
// still produce an outcome for the admin timeline.
func TestKickPlayerUntrackedLobbyReportsGone(t *testing.T) {
	r := &rec{}
	m := NewManager(bot.NewManager(r.send), r.send)
	m.KickPlayer(protocol.KickPlayerCmd{LobbyID: "9", SteamID: "76561198000000001", Mode: "kick"})
	want := protocol.KickResultEvent{LobbyID: "9", SteamID: "76561198000000001", Mode: "kick", Reason: "lobby_gone"}
	if len(r.kickResults) != 1 || r.kickResults[0] != want {
		t.Fatalf("kick_result = %+v, want %+v", r.kickResults, want)
	}
	// set_lobby_blocklist for an untracked lobby is a silent no-op.
	m.SetLobbyBlocklist(protocol.SetLobbyBlocklistCmd{LobbyID: "9", SteamIDs: []string{"76561198000000001"}})
}

func TestKickPlayerRoutesToLobbyBot(t *testing.T) {
	r := &rec{}
	b := bot.NewBot("1", "u", "p", "t", r.send) // no GC session
	b.SetActiveLobbyID("9")
	m := NewManager(bot.NewManager(r.send), r.send)
	m.lobbies["9"] = &Lobby{ID: "9", Bot: b}
	m.KickPlayer(protocol.KickPlayerCmd{LobbyID: "9", SteamID: "76561198000000001", Mode: "unassign"})
	if len(r.kickResults) != 1 || r.kickResults[0].Reason != "no_gc" || r.kickResults[0].Mode != "unassign" {
		t.Fatalf("kick_result = %+v, want the bot's no_gc rejection", r.kickResults)
	}
}
