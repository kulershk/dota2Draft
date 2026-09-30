package bot

import (
	"testing"

	"lobbybot/protocol"

	gcccm "github.com/paralin/go-dota2/protocol"
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
