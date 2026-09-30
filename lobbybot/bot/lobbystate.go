package bot

import (
	"context"
	"fmt"
	"time"

	"lobbybot/protocol"

	gcccm "github.com/paralin/go-dota2/protocol"
)

// liveMembers returns the lobby's current members. Current GC builds keep
// members in all_members and list the live ones in member_indices; entries at
// left_member_indices / free_member_indices are stale (players who left). An
// older payload with no index lists at all means all_members is the roster.
func liveMembers(l *gcccm.CSODOTALobby) []*gcccm.CSODOTALobbyMember {
	all := l.GetAllMembers()
	idx := l.GetMemberIndices()
	if len(idx) == 0 {
		if len(l.GetLeftMemberIndices()) == 0 && len(l.GetFreeMemberIndices()) == 0 {
			return all
		}
		return nil
	}
	out := make([]*gcccm.CSODOTALobbyMember, 0, len(idx))
	for _, i := range idx {
		if int(i) < len(all) {
			out = append(out, all[i])
		}
	}
	return out
}

// lobbyStatusFor maps the GC lobby state to the status Node stores. Only the
// UI state is "waiting" — READYUP/NOTREADY/SERVERASSIGN are a launch in
// progress, and reporting them as "waiting" flipped Node's row back and
// re-triggered queue auto-launch.
func lobbyStatusFor(s gcccm.CSODOTALobby_State) string {
	switch s {
	case gcccm.CSODOTALobby_UI:
		return "waiting"
	case gcccm.CSODOTALobby_SERVERSETUP:
		return "cointoss"
	case gcccm.CSODOTALobby_RUN, gcccm.CSODOTALobby_POSTGAME:
		return "active"
	default:
		return "launching"
	}
}

// isLobbyState reports whether s means the players are sitting in the lobby
// (not yet launched, or dumped back after a failed start).
func isLobbyState(s gcccm.CSODOTALobby_State) bool {
	switch s {
	case gcccm.CSODOTALobby_UI, gcccm.CSODOTALobby_READYUP, gcccm.CSODOTALobby_NOTREADY:
		return true
	}
	return false
}

// slottedPlayers is the Radiant/Dire roster Node uses for "in lobby" badges
// and the queue all-seated auto-launch check.
func slottedPlayers(members []*gcccm.CSODOTALobbyMember) []protocol.LobbyPlayer {
	var out []protocol.LobbyPlayer
	for _, m := range members {
		if team := teamName(m.GetTeam()); team == "radiant" || team == "dire" {
			out = append(out, protocol.LobbyPlayer{SteamID: fmt.Sprintf("%d", m.GetId()), Team: team})
		}
	}
	return out
}

// shouldDestroyStale: a stale lobby (no assignment from Node) that this bot
// leads and that hasn't launched must be destroyed, not just left — leaving
// hands host to a random player who can then launch an unmanaged game.
func shouldDestroyStale(l *gcccm.CSODOTALobby, selfID uint64) bool {
	return l != nil && selfID != 0 && l.GetLeaderId() == selfID && l.GetState() == gcccm.CSODOTALobby_UI
}

type sweepAction int

const (
	sweepNothing sweepAction = iota // lobby already gone — nothing to leave
	sweepDestroy                    // we lead an unlaunched lobby — destroy it
	sweepLeave                      // anything else — just leave
)

// staleSweepAction decides what to do with a stale lobby, judged on the lobby
// as it is now (cur = the latest cache view), not as it was when the sweep
// was scheduled.
func staleSweepAction(cur *gcccm.CSODOTALobby, selfID uint64) sweepAction {
	switch {
	case cur == nil:
		return sweepNothing
	case shouldDestroyStale(cur, selfID):
		return sweepDestroy
	default:
		return sweepLeave
	}
}

// sweepIfUnassigned waits briefly for Node's rejoin_lobby; if none arrives the
// lobby is stale and is torn down. Shared by the startup check and the cache
// Create handler (previously two copies, and both only left the lobby). The
// decision reads the current lobby after the wait: in 5s it may have been
// destroyed, launched, or had its leader change.
func (b *Bot) sweepIfUnassigned(l *gcccm.CSODOTALobby) {
	time.Sleep(5 * time.Second)
	if b.GetActiveLobbyID() != "" {
		b.log("CACHE: Rejoin received — keeping lobby")
		return
	}
	b.mu.Lock()
	var self uint64
	if b.steamClient != nil {
		self = b.steamClient.SteamId().ToUint64()
	}
	cur := b.lastLobby
	b.mu.Unlock()
	switch staleSweepAction(cur, self) {
	case sweepNothing:
		b.log(fmt.Sprintf("CACHE: Stale lobby %d already gone — nothing to leave", l.GetLobbyId()))
		return
	case sweepDestroy:
		b.logAt("warn", "CACHE: No rejoin received — destroying stale lobby we host")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		b.DestroyLobby(ctx)
		cancel()
	default:
		b.logAt("warn", "CACHE: No rejoin received — leaving stale lobby")
	}
	b.LeaveLobby()
}
