package bot

import (
	"fmt"
	"time"

	"lobbybot/protocol"
	"lobbybot/safe"

	"github.com/paralin/go-dota2"
	gcccm "github.com/paralin/go-dota2/protocol"
)

const (
	// blockedKickInterval rate-limits re-kicking a blocked player who keeps
	// rejoining — the cache updates many times a second while they're in.
	blockedKickInterval = 5 * time.Second
	// kickPollEvery / kickTimeout bound the manual-kick verifier.
	kickPollEvery = 250 * time.Millisecond
	kickTimeout   = 10 * time.Second
	// steamID64Base converts a 64-bit steam id to the 32-bit account id the
	// GC kick APIs take.
	steamID64Base = 76561197960265728
)

// teamLabel maps a GC team to the lobby_status.members team label Node stores.
// Deliberately separate from teamName (used in logs and player_joined).
func teamLabel(team gcccm.DOTA_GC_TEAM) string {
	switch team {
	case gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_GOOD_GUYS:
		return "radiant"
	case gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_BAD_GUYS:
		return "dire"
	case gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_PLAYER_POOL:
		return "pool"
	case gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_NOTEAM:
		return "unassigned"
	case gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_SPECTATOR, gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_BROADCASTER:
		return "spectator"
	default:
		return "other"
	}
}

// lobbyMembers is the full live roster for lobby_status.members, excluding the
// bot itself. nil only when there is no lobby (the field is then omitted); a
// lobby with nobody else in it yields an empty, non-nil slice. Name is always
// "": CSODOTALobbyMember carries no persona name in this go-dota2 build (names
// live on the separate static-lobby SO type, which the bot doesn't watch), so
// Node resolves names from its players table by steam id.
func lobbyMembers(l *gcccm.CSODOTALobby, selfID uint64) []protocol.LobbyMember {
	if l == nil {
		return nil
	}
	out := make([]protocol.LobbyMember, 0, len(l.GetAllMembers()))
	for _, m := range liveMembers(l) {
		if selfID != 0 && m.GetId() == selfID {
			continue
		}
		out = append(out, protocol.LobbyMember{
			SteamID: fmt.Sprintf("%d", m.GetId()),
			Team:    teamLabel(m.GetTeam()),
			Slot:    int(m.GetSlot()),
		})
	}
	return out
}

// blockedToKick picks the live members that are blocked and weren't kicked in
// the last blockedKickInterval.
func blockedToKick(members []*gcccm.CSODOTALobbyMember, blocked map[uint64]struct{}, lastKick map[uint64]time.Time, now time.Time) []uint64 {
	var out []uint64
	for _, m := range members {
		id := m.GetId()
		if _, ok := blocked[id]; !ok {
			continue
		}
		if at, ok := lastKick[id]; ok && now.Sub(at) < blockedKickInterval {
			continue
		}
		out = append(out, id)
	}
	return out
}

// kickVerified reports whether a kick has taken effect in lobby l: for "kick"
// the player is no longer a live member; for "unassign" they're gone or off
// the Radiant/Dire slots.
func kickVerified(l *gcccm.CSODOTALobby, steamID uint64, mode string) bool {
	for _, m := range liveMembers(l) {
		if m.GetId() != steamID {
			continue
		}
		if mode == "unassign" {
			t := m.GetTeam()
			return t != gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_GOOD_GUYS && t != gcccm.DOTA_GC_TEAM_DOTA_GC_TEAM_BAD_GUYS
		}
		return false
	}
	return true
}

// isLiveMember reports whether steamID is currently in lobby l.
func isLiveMember(l *gcccm.CSODOTALobby, steamID uint64) bool {
	for _, m := range liveMembers(l) {
		if m.GetId() == steamID {
			return true
		}
	}
	return false
}

// selfSteamID is the bot's own steam64 id (0 when not connected).
func (b *Bot) selfSteamID() uint64 {
	b.mu.Lock()
	sc := b.steamClient
	b.mu.Unlock()
	if sc == nil {
		return 0
	}
	return sc.SteamId().ToUint64()
}

// SetBlocked replaces the set of steam ids blocked from the active lobby.
// nil/empty clears it (lobby released). Like expectedTeams, the published set
// is replaced wholesale and never mutated, so processLobbyUpdate can read a
// snapshot; rate-limit/pending state for players no longer blocked is dropped.
func (b *Bot) SetBlocked(steamIDs []string) {
	set := make(map[uint64]struct{}, len(steamIDs))
	for _, s := range steamIDs {
		if sid := parseSteamID(s); sid != 0 {
			set[sid] = struct{}{}
		}
	}
	b.mu.Lock()
	had := len(b.blocked)
	if len(set) == 0 {
		b.blocked = nil
	} else {
		b.blocked = set
	}
	for id := range b.blockedKickAt {
		if _, ok := set[id]; !ok {
			delete(b.blockedKickAt, id)
		}
	}
	for id := range b.blockedPending {
		if _, ok := set[id]; !ok {
			delete(b.blockedPending, id)
		}
	}
	lobbyID := b.activeLobbyID
	b.mu.Unlock()
	if len(set) == 0 {
		if had > 0 {
			b.logCtx("action", lobbyID, "ACTION: SetBlocked cleared")
		}
		return
	}
	b.logCtx("action", lobbyID, fmt.Sprintf("ACTION: SetBlocked(%d players)", len(set)))
}

// enforceBlocked is the blocked-player pass of processLobbyUpdate: it confirms
// earlier auto-kicks that took effect (one kick_result{auto} per removal) and,
// while the lobby is pre-launch, re-kicks blocked players who are in it.
func (b *Bot) enforceBlocked(lobbyID string, l *gcccm.CSODOTALobby, members []*gcccm.CSODOTALobbyMember, dc *dota2.Dota2, selfID uint64) {
	now := time.Now()
	b.mu.Lock()
	var gone []uint64
	for id := range b.blockedPending {
		if kickVerified(l, id, "kick") {
			gone = append(gone, id)
			delete(b.blockedPending, id)
		}
	}
	var kick []uint64
	if dc != nil && l.GetState() == gcccm.CSODOTALobby_UI && len(b.blocked) > 0 {
		for _, id := range blockedToKick(members, b.blocked, b.blockedKickAt, now) {
			if id == selfID {
				continue
			}
			if b.blockedKickAt == nil {
				b.blockedKickAt = make(map[uint64]time.Time)
			}
			if b.blockedPending == nil {
				b.blockedPending = make(map[uint64]struct{})
			}
			b.blockedKickAt[id] = now
			b.blockedPending[id] = struct{}{}
			kick = append(kick, id)
		}
	}
	b.mu.Unlock()

	for _, id := range gone {
		b.logCtx("info", lobbyID, fmt.Sprintf("BLOCK: Blocked player %d is out of the lobby", id))
		b.send("kick_result", protocol.KickResultEvent{
			LobbyID: lobbyID,
			SteamID: fmt.Sprintf("%d", id),
			Mode:    "kick",
			OK:      true,
			Auto:    true,
		})
	}
	for _, id := range kick {
		b.logCtx("action", lobbyID, fmt.Sprintf("BLOCK: Player %d is blocked from this lobby — kicking", id))
		dc.KickLobbyMember(uint32(id - steamID64Base))
	}
}

// KickPlayer is the admin kick_player action: mode "kick" removes the member
// from the lobby, "unassign" moves them out of their Radiant/Dire slot. The
// outcome is reported as kick_result — immediately for a rejected request,
// otherwise by a verifier that watches the lobby cache for the change.
func (b *Bot) KickPlayer(lobbyID, steamID, mode string) {
	result := func(ok bool, reason string) {
		b.send("kick_result", protocol.KickResultEvent{
			LobbyID: lobbyID,
			SteamID: steamID,
			Mode:    mode,
			OK:      ok,
			Reason:  reason,
		})
	}
	if mode != "kick" && mode != "unassign" {
		b.logCtx("warn", lobbyID, fmt.Sprintf("ACTION: KickPlayer(%s) ignored — unknown mode %q", steamID, mode))
		return
	}

	b.mu.Lock()
	active := b.activeLobbyID
	gcReady := b.gcReady
	dc := b.dotaClient
	sc := b.steamClient
	l := b.lastLobby
	b.mu.Unlock()

	if active != lobbyID {
		b.logCtx("warn", lobbyID, fmt.Sprintf("ACTION: KickPlayer(%s, %s) — bot no longer runs this lobby", steamID, mode))
		result(false, "lobby_gone")
		return
	}
	if !gcReady || dc == nil {
		b.logCtx("warn", lobbyID, fmt.Sprintf("ACTION: KickPlayer(%s, %s) — no GC session", steamID, mode))
		result(false, "no_gc")
		return
	}
	if l == nil {
		b.logCtx("warn", lobbyID, fmt.Sprintf("ACTION: KickPlayer(%s, %s) — lobby not in cache", steamID, mode))
		result(false, "lobby_gone")
		return
	}
	var self uint64
	if sc != nil {
		self = sc.SteamId().ToUint64()
	}
	sid := parseSteamID(steamID)
	// Never target the bot's own account — it isn't in members, so to Node it
	// reads as not in the lobby.
	if sid == 0 || sid == self || !isLiveMember(l, sid) {
		b.logCtx("warn", lobbyID, fmt.Sprintf("ACTION: KickPlayer(%s, %s) — player not in lobby", steamID, mode))
		result(false, "not_in_lobby")
		return
	}

	b.logCtx("action", lobbyID, fmt.Sprintf("ACTION: KickPlayer(%s, %s)", steamID, mode))
	accountID := uint32(sid - steamID64Base)
	if mode == "kick" {
		// Hold off the blocked-player re-kick while this one lands, so a single
		// removal doesn't also produce an auto kick_result.
		b.mu.Lock()
		if b.blockedKickAt == nil {
			b.blockedKickAt = make(map[uint64]time.Time)
		}
		b.blockedKickAt[sid] = time.Now()
		b.mu.Unlock()
		dc.KickLobbyMember(accountID)
	} else {
		dc.KickLobbyMemberFromTeam(accountID)
	}
	go b.verifyKick(lobbyID, sid, mode, result)
}

// verifyKick polls the cached lobby until the kick shows up (ok), the lobby is
// gone (lobby_gone) or the deadline passes (timeout). The GC kick calls are
// fire-and-forget, so this is the only confirmation there is.
func (b *Bot) verifyKick(lobbyID string, sid uint64, mode string, result func(ok bool, reason string)) {
	defer safe.Recover("verifyKick bot " + b.ID)
	every, timeout := kickPollEvery, kickTimeout
	if b.kickPollEvery > 0 {
		every = b.kickPollEvery
	}
	if b.kickTimeout > 0 {
		timeout = b.kickTimeout
	}
	deadline := time.Now().Add(timeout)
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		b.mu.Lock()
		l := b.lastLobby
		active := b.activeLobbyID
		b.mu.Unlock()
		switch {
		case active != lobbyID || l == nil:
			b.logCtx("warn", lobbyID, fmt.Sprintf("KICK: lobby gone before %s of %d was confirmed", mode, sid))
			result(false, "lobby_gone")
			return
		case kickVerified(l, sid, mode):
			b.logCtx("info", lobbyID, fmt.Sprintf("KICK: %s of %d confirmed", mode, sid))
			result(true, "")
			return
		case !time.Now().Before(deadline):
			b.logCtx("warn", lobbyID, fmt.Sprintf("KICK: %s of %d not confirmed within %s", mode, sid, timeout))
			result(false, "timeout")
			return
		}
		<-tick.C
	}
}
