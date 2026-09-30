package bot

import (
	"context"
	"strings"
	"testing"
	"time"

	"lobbybot/protocol"

	"github.com/paralin/go-dota2"
	gcccm "github.com/paralin/go-dota2/protocol"
	"github.com/paralin/go-steam"
	"github.com/sirupsen/logrus"
)

func TestLiveMembersUsesMemberIndices(t *testing.T) {
	a := mkMember(1, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_GOOD_GUYS)
	gone := mkMember(2, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_BAD_GUYS)
	c := mkMember(3, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_PLAYER_POOL)
	l := mkLobby(gcccm.CSODOTALobby_UI, 0, a, gone, c)
	l.MemberIndices = []uint32{0, 2}
	l.LeftMemberIndices = []uint32{1}
	got := liveMembers(l)
	if len(got) != 2 || got[0].GetId() != 1 || got[1].GetId() != 3 {
		t.Fatalf("liveMembers = %v, want ids [1 3]", got)
	}
}

func TestLiveMembersLegacyPayload(t *testing.T) {
	l := mkLobby(gcccm.CSODOTALobby_UI, 0, mkMember(1, 0), mkMember(2, 0))
	if got := liveMembers(l); len(got) != 2 {
		t.Fatalf("no indices → all_members as-is, got %d", len(got))
	}
}

func TestLiveMembersAllLeft(t *testing.T) {
	l := mkLobby(gcccm.CSODOTALobby_UI, 0, mkMember(1, 0))
	l.LeftMemberIndices = []uint32{0}
	if got := liveMembers(l); len(got) != 0 {
		t.Fatalf("every member left → empty roster, got %d", len(got))
	}
}

func TestLobbyStatusFor(t *testing.T) {
	cases := map[gcccm.CSODOTALobby_State]string{
		gcccm.CSODOTALobby_UI:           "waiting",
		gcccm.CSODOTALobby_READYUP:      "launching",
		gcccm.CSODOTALobby_NOTREADY:     "launching",
		gcccm.CSODOTALobby_SERVERASSIGN: "launching",
		gcccm.CSODOTALobby_SERVERSETUP:  "cointoss",
		gcccm.CSODOTALobby_RUN:          "active",
		gcccm.CSODOTALobby_POSTGAME:     "active",
	}
	for s, want := range cases {
		if got := lobbyStatusFor(s); got != want {
			t.Errorf("lobbyStatusFor(%v) = %q, want %q", s, got, want)
		}
	}
}

func TestProcessLobbyUpdateIgnoresLeftMembers(t *testing.T) {
	b, r := newTestBot()
	b.activeLobbyID = "7"
	l := mkLobby(gcccm.CSODOTALobby_UI, 0,
		mkMember(76561198000000001, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_GOOD_GUYS),
		mkMember(76561198000000002, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_BAD_GUYS))
	l.MemberIndices = []uint32{0}
	l.LeftMemberIndices = []uint32{1}
	b.processLobbyUpdate(nil, l)
	st := r.ofType("lobby_status")
	if len(st) != 1 {
		t.Fatalf("want one lobby_status, got %d", len(st))
	}
	if p := st[0].Data.(protocol.LobbyStatusEvent).PlayersJoined; len(p) != 1 || p[0].SteamID != "76561198000000001" {
		t.Fatalf("roster must exclude the member at a left index, got %+v", p)
	}
}

func TestResendLobbyStateReplaysMatchID(t *testing.T) {
	b, r := newTestBot()
	b.activeLobbyID = "7"
	b.lastMatchIDSent = 111
	server := uint64(90000)
	l := mkLobby(gcccm.CSODOTALobby_RUN, 111, mkMember(76561198000000001, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_GOOD_GUYS))
	l.ServerId = &server
	b.lastLobby = l

	b.ResendLobbyState()

	gs := r.ofType("game_started")
	if len(gs) != 1 || gs[0].Data.(protocol.GameStartedEvent).MatchID != "111" {
		t.Fatalf("expected game_started 111 to be replayed, got %+v", gs)
	}
	st := r.ofType("lobby_status")
	if len(st) != 1 || st[0].Data.(protocol.LobbyStatusEvent).Status != "active" {
		t.Fatalf("expected lobby_status active, got %+v", st)
	}
	if len(r.ofType("lobby_server_id")) != 1 {
		t.Fatal("expected lobby_server_id replay")
	}
}

func TestResendLobbyStateNoLobbyNoop(t *testing.T) {
	b, r := newTestBot()
	b.ResendLobbyState()
	if len(r.all()) != 0 {
		t.Fatalf("expected no messages, got %+v", r.all())
	}
}

func TestResendLobbyStateNoMatchIDSkipsGameStarted(t *testing.T) {
	b, r := newTestBot()
	b.activeLobbyID = "7"
	b.lastMatchIDSent = 0 // no match ID sent yet
	server := uint64(90000)
	l := mkLobby(gcccm.CSODOTALobby_RUN, 0, mkMember(76561198000000001, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_GOOD_GUYS))
	l.ServerId = &server
	b.lastLobby = l

	b.ResendLobbyState()

	if len(r.ofType("game_started")) != 0 {
		t.Fatal("expected game_started to NOT be replayed when matchID is 0")
	}
	st := r.ofType("lobby_status")
	if len(st) != 1 || st[0].Data.(protocol.LobbyStatusEvent).Status != "active" {
		t.Fatalf("expected lobby_status active even without match ID, got %+v", st)
	}
	if len(r.ofType("lobby_server_id")) != 1 {
		t.Fatal("expected lobby_server_id replay")
	}
}

func TestAbortSendsGameAbortedBeforeStatus(t *testing.T) {
	b, r := newTestBot()
	b.activeLobbyID = "7"
	b.lastMatchIDSent = 111
	b.launchSent = true
	old := mkLobby(gcccm.CSODOTALobby_RUN, 111)
	now := mkLobby(gcccm.CSODOTALobby_UI, 111)

	b.processLobbyUpdate(old, now)

	var order []string
	for _, m := range r.all() {
		if m.Type == "game_aborted" || m.Type == "lobby_status" {
			order = append(order, m.Type)
		}
	}
	if len(order) < 2 || order[0] != "game_aborted" || order[1] != "lobby_status" {
		t.Fatalf("want game_aborted before lobby_status, got %v", order)
	}
	ga := r.ofType("game_aborted")[0].Data.(protocol.GameAbortedEvent)
	if ga.LobbyID != "7" || ga.MatchID != "111" {
		t.Fatalf("bad game_aborted payload %+v", ga)
	}
	if b.launchSent {
		t.Fatal("abort must re-arm launch")
	}
	// The GC keeps match_id on the lobby after an abort. Re-reporting it while
	// the lobby sits in UI would undo Node's rollback, so nothing is sent yet.
	if n := len(r.ofType("game_started")); n != 0 {
		t.Fatalf("game_started re-sent %d times while back in the lobby", n)
	}
	// Relaunch that reuses the same match id → re-reported once the launch is underway.
	b.processLobbyUpdate(now, mkLobby(gcccm.CSODOTALobby_READYUP, 111))
	if n := len(r.ofType("game_started")); n != 1 {
		t.Fatalf("relaunch with the same match id must re-send game_started once, got %d", n)
	}
}

func TestResendLobbyStateSkipsAbortedMatchID(t *testing.T) {
	b, r := newTestBot()
	b.activeLobbyID = "7"
	b.lastMatchIDSent = 111
	b.abortedMatchID = 111
	b.lastLobby = mkLobby(gcccm.CSODOTALobby_UI, 111)
	b.ResendLobbyState()
	if n := len(r.ofType("game_started")); n != 0 {
		t.Fatalf("aborted match id must not be replayed, got %d", n)
	}
}

func TestLobbyRunning(t *testing.T) {
	b, _ := newTestBot()
	if b.LobbyRunning() {
		t.Fatal("no lobby → not running")
	}
	b.lastLobby = mkLobby(gcccm.CSODOTALobby_RUN, 1)
	if !b.LobbyRunning() {
		t.Fatal("RUN → running")
	}
}

func TestShouldDestroyStale(t *testing.T) {
	self := uint64(76561198000000009)
	other := uint64(76561198000000001)
	ui := mkLobby(gcccm.CSODOTALobby_UI, 0)
	ui.LeaderId = &self
	if !shouldDestroyStale(ui, self) {
		t.Error("bot leads a UI-state lobby → destroy")
	}
	ui.LeaderId = &other
	if shouldDestroyStale(ui, self) {
		t.Error("someone else leads → just leave")
	}
	run := mkLobby(gcccm.CSODOTALobby_RUN, 5)
	run.LeaderId = &self
	if shouldDestroyStale(run, self) {
		t.Error("never destroy a running game")
	}
}

func TestEnsureAbortReported(t *testing.T) {
	b, r := newTestBot()
	b.activeLobbyID = "7"
	b.lastMatchIDSent = 111
	b.launchSent = true

	// The RUN→UI edge was missed (watcher replaced): report it now.
	b.EnsureAbortReported()
	ga := r.ofType("game_aborted")
	if len(ga) != 1 {
		t.Fatalf("want exactly one game_aborted, got %d", len(ga))
	}
	if ev := ga[0].Data.(protocol.GameAbortedEvent); ev.LobbyID != "7" || ev.MatchID != "111" {
		t.Fatalf("bad game_aborted payload %+v", ev)
	}
	if b.launchSent || b.abortedMatchID != 111 {
		t.Fatalf("want launch re-armed and abortedMatchID=111, got launchSent=%v aborted=%d", b.launchSent, b.abortedMatchID)
	}
	// Second call: already reported.
	b.EnsureAbortReported()
	if n := len(r.ofType("game_aborted")); n != 1 {
		t.Fatalf("repeat call must not re-send, got %d", n)
	}

	// Edge path already reported this abort → nothing to do.
	b2, r2 := newTestBot()
	b2.activeLobbyID = "7"
	b2.lastMatchIDSent = 111
	b2.processLobbyUpdate(mkLobby(gcccm.CSODOTALobby_RUN, 111), mkLobby(gcccm.CSODOTALobby_UI, 111))
	b2.EnsureAbortReported()
	if n := len(r2.ofType("game_aborted")); n != 1 {
		t.Fatalf("abort already reported by the edge path must not repeat, got %d", n)
	}

	// No lobby / no match id → nothing.
	b3, r3 := newTestBot()
	b3.lastMatchIDSent = 111
	b3.EnsureAbortReported()
	b4, r4 := newTestBot()
	b4.activeLobbyID = "7"
	b4.EnsureAbortReported()
	if len(r3.ofType("game_aborted"))+len(r4.ofType("game_aborted")) != 0 {
		t.Fatal("no active lobby or no match id → no game_aborted")
	}
}

func TestRunToNonLobbyStateIsNotAbort(t *testing.T) {
	for _, st := range []gcccm.CSODOTALobby_State{
		gcccm.CSODOTALobby_POSTGAME,
		gcccm.CSODOTALobby_SERVERSETUP,
		gcccm.CSODOTALobby_SERVERASSIGN,
	} {
		b, r := newTestBot()
		b.activeLobbyID = "7"
		b.lastMatchIDSent = 111
		b.launchSent = true
		b.processLobbyUpdate(mkLobby(gcccm.CSODOTALobby_RUN, 111), mkLobby(st, 111))
		if n := len(r.ofType("game_aborted")); n != 0 {
			t.Errorf("RUN→%s: game_aborted sent %d times, want 0", st, n)
		}
		if n := len(r.ofType("game_started")); n != 0 {
			t.Errorf("RUN→%s: extra game_started sent %d times, want 0", st, n)
		}
	}
}

func TestRunToReadyUpIsAbort(t *testing.T) {
	for _, st := range []gcccm.CSODOTALobby_State{gcccm.CSODOTALobby_READYUP, gcccm.CSODOTALobby_NOTREADY} {
		b, r := newTestBot()
		b.activeLobbyID = "7"
		b.lastMatchIDSent = 111
		b.processLobbyUpdate(mkLobby(gcccm.CSODOTALobby_RUN, 111), mkLobby(st, 111))
		if n := len(r.ofType("game_aborted")); n != 1 {
			t.Errorf("RUN→%s: game_aborted sent %d times, want 1", st, n)
		}
	}
}

func TestNoAutoLaunchInAbortUpdate(t *testing.T) {
	b, r := newTestBot()
	// A real but disconnected Dota client: dc() != nil so the auto-launch block
	// is reachable, while LaunchLobby's GC write is a no-op (no connection).
	b.dotaClient = dota2.New(steam.NewClient(), logrus.New())
	b.activeLobbyID = "7"
	b.lastMatchIDSent = 111

	b.processLobbyUpdate(mkLobby(gcccm.CSODOTALobby_RUN, 111), mkLobby(gcccm.CSODOTALobby_UI, 222))

	if n := len(r.ofType("game_aborted")); n != 1 {
		t.Fatalf("want game_aborted, got %d", n)
	}
	gs := r.ofType("game_started")
	if len(gs) != 1 || gs[0].Data.(protocol.GameStartedEvent).MatchID != "222" {
		t.Fatalf("want game_started(222), got %+v", gs)
	}
	if b.launchSent {
		t.Fatal("must not arm/launch in the same update that detected the abort")
	}
	for _, m := range r.ofType("bot_log") {
		msg := m.Data.(protocol.BotLogEvent).Message
		if strings.Contains(msg, "Auto-launching after match ID assigned") || strings.Contains(msg, "ACTION: LaunchLobby") {
			t.Fatalf("unexpected launch: %q", msg)
		}
	}
}

func TestWaitForDraftLobbyGone(t *testing.T) {
	b, _ := newTestBot()
	if got := b.WaitForDraft(context.Background(), time.Minute); got != DraftLobbyGone {
		t.Fatalf("lobby missing from cache → DraftLobbyGone, got %v", got)
	}
}

// WaitForDraft's level check must agree with the edge path (E2): only a return
// to a lobby state is an abort — otherwise EnsureAbortReported would report a
// finished game (seen as POSTGAME after a reconnect gap) as aborted.
func TestWaitForDraftAbortOnlyOnLobbyState(t *testing.T) {
	b, _ := newTestBot()
	b.lastLobby = mkLobby(gcccm.CSODOTALobby_POSTGAME, 111)
	if got := b.WaitForDraft(context.Background(), time.Minute); got != DraftStarted {
		t.Fatalf("POSTGAME → DraftStarted, got %v", got)
	}
	b.lastLobby = mkLobby(gcccm.CSODOTALobby_SERVERSETUP, 111)
	if got := b.WaitForDraft(context.Background(), time.Millisecond); got != DraftWaitExpired {
		t.Fatalf("SERVERSETUP is not an abort → keep waiting until the failsafe, got %v", got)
	}
	b.lastLobby = mkLobby(gcccm.CSODOTALobby_UI, 111)
	if got := b.WaitForDraft(context.Background(), time.Minute); got != DraftAborted {
		t.Fatalf("UI → DraftAborted, got %v", got)
	}
}
