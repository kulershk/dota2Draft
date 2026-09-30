package bot

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"lobbybot/protocol"

	"github.com/paralin/go-dota2"
	gcccm "github.com/paralin/go-dota2/protocol"
	"github.com/paralin/go-steam"
	"github.com/sirupsen/logrus"
)

const (
	pA = uint64(76561198000000001)
	pB = uint64(76561198000000002)
	pC = uint64(76561198000000003)
)

func kickResults(r *recorder) []protocol.KickResultEvent {
	var out []protocol.KickResultEvent
	for _, m := range r.ofType("kick_result") {
		out = append(out, m.Data.(protocol.KickResultEvent))
	}
	return out
}

// withClients gives the bot a real but disconnected Steam/Dota client: the GC
// writes behind KickLobbyMember* are no-ops, while dc() != nil so the kick
// paths are reachable.
func withClients(b *Bot) {
	sc := steam.NewClient()
	b.steamClient = sc
	b.dotaClient = dota2.New(sc, logrus.New())
}

func TestTeamLabel(t *testing.T) {
	cases := map[gcccm.DOTA_GC_TEAM]string{
		gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_GOOD_GUYS:   "radiant",
		gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_BAD_GUYS:    "dire",
		gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_PLAYER_POOL: "pool",
		gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_NOTEAM:      "unassigned",
		gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_SPECTATOR:   "spectator",
		gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_BROADCASTER: "spectator",
		gcccm.DOTA_GC_TEAM(99):                      "other",
	}
	for team, want := range cases {
		if got := teamLabel(team); got != want {
			t.Errorf("teamLabel(%v) = %q, want %q", team, got, want)
		}
	}
}

func TestLobbyMembersExcludesSelfAndLeft(t *testing.T) {
	self := uint64(76561198000000009)
	a := mkMember(pA, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_GOOD_GUYS)
	slot := uint32(3)
	a.Slot = &slot
	left := mkMember(pB, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_BAD_GUYS)
	bot := mkMember(self, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_PLAYER_POOL)
	pool := mkMember(pC, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_PLAYER_POOL)
	l := mkLobby(gcccm.CSODOTALobby_UI, 0, a, left, bot, pool)
	l.MemberIndices = []uint32{0, 2, 3}
	l.LeftMemberIndices = []uint32{1}

	got := lobbyMembers(l, self)
	want := []protocol.LobbyMember{
		{SteamID: "76561198000000001", Team: "radiant", Slot: 3},
		{SteamID: "76561198000000003", Team: "pool", Slot: 0},
	}
	if len(got) != len(want) {
		t.Fatalf("lobbyMembers = %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("member %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

// members must be [] (not omitted) for a known lobby with nobody else in it,
// and omitted only when there's no lobby — Node tells old/new bot builds and
// "no roster observation" apart by the field's presence.
func TestLobbyMembersJSONShape(t *testing.T) {
	self := uint64(76561198000000009)
	empty := lobbyMembers(mkLobby(gcccm.CSODOTALobby_UI, 0, mkMember(self, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_PLAYER_POOL)), self)
	raw, _ := json.Marshal(protocol.LobbyStatusEvent{LobbyID: "7", Status: "waiting", Members: empty})
	if !strings.Contains(string(raw), `"members":[]`) {
		t.Fatalf("known empty lobby must send members:[], got %s", raw)
	}
	raw, _ = json.Marshal(protocol.LobbyStatusEvent{LobbyID: "7", Status: "cancelled", Members: lobbyMembers(nil, self)})
	if strings.Contains(string(raw), `"members"`) {
		t.Fatalf("no lobby → members omitted, got %s", raw)
	}
}

func TestBlockedToKick(t *testing.T) {
	now := time.Now()
	members := []*gcccm.CSODOTALobbyMember{
		mkMember(pA, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_GOOD_GUYS),
		mkMember(pB, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_PLAYER_POOL),
		mkMember(pC, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_SPECTATOR),
	}
	blocked := map[uint64]struct{}{pA: {}, pB: {}, pC: {}}
	lastKick := map[uint64]time.Time{
		pA: now.Add(-2 * time.Second), // kicked recently → wait
		pB: now.Add(-6 * time.Second), // interval elapsed → kick again
	}
	got := blockedToKick(members, blocked, lastKick, now)
	if len(got) != 2 || got[0] != pB || got[1] != pC {
		t.Fatalf("blockedToKick = %v, want [%d %d]", got, pB, pC)
	}
	if got := blockedToKick(members, nil, nil, now); len(got) != 0 {
		t.Fatalf("nothing blocked → nothing to kick, got %v", got)
	}
}

func TestKickVerified(t *testing.T) {
	radiant := mkLobby(gcccm.CSODOTALobby_UI, 0, mkMember(pA, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_GOOD_GUYS))
	pool := mkLobby(gcccm.CSODOTALobby_UI, 0, mkMember(pA, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_PLAYER_POOL))
	gone := mkLobby(gcccm.CSODOTALobby_UI, 0, mkMember(pB, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_GOOD_GUYS))
	cases := []struct {
		name string
		l    *gcccm.CSODOTALobby
		mode string
		want bool
	}{
		{"kick: still slotted", radiant, "kick", false},
		{"kick: in pool is still in lobby", pool, "kick", false},
		{"kick: gone", gone, "kick", true},
		{"unassign: still slotted", radiant, "unassign", false},
		{"unassign: moved to pool", pool, "unassign", true},
		{"unassign: left entirely", gone, "unassign", true},
	}
	for _, c := range cases {
		if got := kickVerified(c.l, pA, c.mode); got != c.want {
			t.Errorf("%s: kickVerified = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestSetBlockedReplacesAndClears(t *testing.T) {
	b, _ := newTestBot()
	b.SetBlocked([]string{"76561198000000001", "76561198000000002", "junk"})
	if len(b.blocked) != 2 {
		t.Fatalf("blocked = %v, want 2 ids", b.blocked)
	}
	b.blockedKickAt = map[uint64]time.Time{pA: time.Now(), pB: time.Now()}
	b.blockedPending = map[uint64]struct{}{pA: {}, pB: {}}
	b.SetBlocked([]string{"76561198000000002"})
	if _, ok := b.blocked[pA]; ok || len(b.blocked) != 1 {
		t.Fatalf("unblocked id must be dropped, got %v", b.blocked)
	}
	if _, ok := b.blockedKickAt[pA]; ok {
		t.Fatal("rate-limit state for an unblocked player must be dropped")
	}
	if _, ok := b.blockedPending[pA]; ok {
		t.Fatal("pending auto-kick for an unblocked player must be dropped")
	}
	b.SetBlocked(nil)
	if b.blocked != nil || len(b.blockedKickAt) != 0 || len(b.blockedPending) != 0 {
		t.Fatal("SetBlocked(nil) must clear everything")
	}
}

func TestProcessLobbyUpdateSendsMembers(t *testing.T) {
	b, r := newTestBot()
	b.activeLobbyID = "7"
	l := mkLobby(gcccm.CSODOTALobby_UI, 0,
		mkMember(pA, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_GOOD_GUYS),
		mkMember(pB, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_PLAYER_POOL))
	b.processLobbyUpdate(nil, l)
	st := r.ofType("lobby_status")
	if len(st) != 1 {
		t.Fatalf("want one lobby_status, got %d", len(st))
	}
	ev := st[0].Data.(protocol.LobbyStatusEvent)
	if len(ev.Members) != 2 || ev.Members[1].Team != "pool" {
		t.Fatalf("members = %+v, want both live members", ev.Members)
	}
	if len(ev.PlayersJoined) != 1 {
		t.Fatalf("playersJoined must stay slotted-only, got %+v", ev.PlayersJoined)
	}
}

// A blocked player is re-kicked at most once per interval, and the auto
// kick_result is sent once — when they're observed gone — not per retry.
func TestEnforceBlockedKicksAndConfirmsOnce(t *testing.T) {
	b, r := newTestBot()
	withClients(b)
	b.activeLobbyID = "7"
	b.SetBlocked([]string{"76561198000000002"})

	in := mkLobby(gcccm.CSODOTALobby_UI, 0,
		mkMember(pA, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_GOOD_GUYS),
		mkMember(pB, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_PLAYER_POOL))
	b.processLobbyUpdate(nil, in)
	b.processLobbyUpdate(in, in) // within the interval → no second kick
	kicks := 0
	for _, m := range r.ofType("bot_log") {
		if strings.Contains(m.Data.(protocol.BotLogEvent).Message, "BLOCK: Player 76561198000000002 is blocked") {
			kicks++
		}
	}
	if kicks != 1 {
		t.Fatalf("kicks = %d, want 1 (rate-limited)", kicks)
	}
	if n := len(kickResults(r)); n != 0 {
		t.Fatalf("no kick_result until the player is gone, got %d", n)
	}

	out := mkLobby(gcccm.CSODOTALobby_UI, 0, mkMember(pA, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_GOOD_GUYS))
	b.processLobbyUpdate(in, out)
	b.processLobbyUpdate(out, out)
	res := kickResults(r)
	if len(res) != 1 {
		t.Fatalf("want exactly one auto kick_result, got %+v", res)
	}
	want := protocol.KickResultEvent{LobbyID: "7", SteamID: "76561198000000002", Mode: "kick", OK: true, Auto: true}
	if res[0] != want {
		t.Fatalf("kick_result = %+v, want %+v", res[0], want)
	}
}

func TestEnforceBlockedOnlyPreLaunch(t *testing.T) {
	b, r := newTestBot()
	withClients(b)
	b.activeLobbyID = "7"
	b.SetBlocked([]string{"76561198000000002"})
	l := mkLobby(gcccm.CSODOTALobby_READYUP, 0, mkMember(pB, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_GOOD_GUYS))
	b.processLobbyUpdate(nil, l)
	for _, m := range r.ofType("bot_log") {
		if strings.Contains(m.Data.(protocol.BotLogEvent).Message, "BLOCK:") {
			t.Fatalf("must not kick outside the UI state: %q", m.Data.(protocol.BotLogEvent).Message)
		}
	}
}

func TestKickPlayerRejections(t *testing.T) {
	inLobby := mkLobby(gcccm.CSODOTALobby_UI, 0, mkMember(pA, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_GOOD_GUYS))
	cases := []struct {
		name   string
		setup  func(b *Bot)
		lobby  string
		steam  string
		reason string
	}{
		{"no GC", func(b *Bot) { withClients(b); b.lastLobby = inLobby }, "7", "76561198000000001", "no_gc"},
		{"other lobby", func(b *Bot) { withClients(b); b.gcReady = true; b.lastLobby = inLobby }, "8", "76561198000000001", "lobby_gone"},
		{"no lobby in cache", func(b *Bot) { withClients(b); b.gcReady = true }, "7", "76561198000000001", "lobby_gone"},
		{"not a member", func(b *Bot) { withClients(b); b.gcReady = true; b.lastLobby = inLobby }, "7", "76561198000000002", "not_in_lobby"},
	}
	for _, c := range cases {
		b, r := newTestBot()
		b.activeLobbyID = "7"
		c.setup(b)
		b.KickPlayer(c.lobby, c.steam, "kick")
		res := kickResults(r)
		if len(res) != 1 || res[0].OK || res[0].Reason != c.reason || res[0].LobbyID != c.lobby || res[0].Mode != "kick" {
			t.Errorf("%s: kick_result = %+v, want ok=false reason=%q", c.name, res, c.reason)
		}
	}
}

func waitKickResult(t *testing.T, r *recorder) protocol.KickResultEvent {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if res := kickResults(r); len(res) > 0 {
			return res[0]
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("no kick_result within 2s")
	return protocol.KickResultEvent{}
}

func newKickBot(l *gcccm.CSODOTALobby) (*Bot, *recorder) {
	b, r := newTestBot()
	withClients(b)
	b.gcReady = true
	b.activeLobbyID = "7"
	b.lastLobby = l
	b.kickPollEvery = 5 * time.Millisecond
	b.kickTimeout = 200 * time.Millisecond
	return b, r
}

func TestKickPlayerVerifiesUnassign(t *testing.T) {
	b, r := newKickBot(mkLobby(gcccm.CSODOTALobby_UI, 0, mkMember(pA, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_BAD_GUYS)))
	b.KickPlayer("7", "76561198000000001", "unassign")
	b.setLastLobby(mkLobby(gcccm.CSODOTALobby_UI, 0, mkMember(pA, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_PLAYER_POOL)))
	res := waitKickResult(t, r)
	if !res.OK || res.Reason != "" || res.Mode != "unassign" || res.Auto {
		t.Fatalf("kick_result = %+v, want ok unassign", res)
	}
}

func TestKickPlayerVerifiesKick(t *testing.T) {
	b, r := newKickBot(mkLobby(gcccm.CSODOTALobby_UI, 0, mkMember(pA, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_PLAYER_POOL)))
	b.KickPlayer("7", "76561198000000001", "kick")
	b.setLastLobby(mkLobby(gcccm.CSODOTALobby_UI, 0))
	if res := waitKickResult(t, r); !res.OK || res.Mode != "kick" {
		t.Fatalf("kick_result = %+v, want ok kick", res)
	}
}

func TestKickPlayerTimeout(t *testing.T) {
	b, r := newKickBot(mkLobby(gcccm.CSODOTALobby_UI, 0, mkMember(pA, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_PLAYER_POOL)))
	b.KickPlayer("7", "76561198000000001", "kick")
	if res := waitKickResult(t, r); res.OK || res.Reason != "timeout" {
		t.Fatalf("kick_result = %+v, want timeout", res)
	}
}

func TestKickPlayerLobbyGoneDuringVerify(t *testing.T) {
	b, r := newKickBot(mkLobby(gcccm.CSODOTALobby_UI, 0, mkMember(pA, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_PLAYER_POOL)))
	b.KickPlayer("7", "76561198000000001", "kick")
	b.setLastLobby(nil)
	if res := waitKickResult(t, r); res.OK || res.Reason != "lobby_gone" {
		t.Fatalf("kick_result = %+v, want lobby_gone", res)
	}
}
