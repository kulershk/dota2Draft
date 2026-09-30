package bot

import (
	"fmt"

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
