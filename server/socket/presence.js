// Real-time friend presence fan-out.
//
// When a player's presence changes (connects/disconnects, joins/leaves a
// queue, enters/leaves a match) we push their new state to every accepted
// friend's per-user room so the friends sidebar updates without a refetch.
// The 20s presence poll in the client remains as a backstop for the rare
// transitions that aren't instrumented here.

import { query } from '../db.js'
import { getOnlinePlayerIds } from './state.js'
import { playerInQueue, playerInMatch, playerInReadyCheck } from './queueState.js'

let _io = null
export function registerPresenceIo(io) { _io = io }

// Mirror the flag derivation in GET /api/friends. "Searching" covers the
// short ready-check window too, so a friend doesn't flicker back to plain
// "online" between queue pop and match start.
function flagsFor(playerId) {
  return {
    playerId,
    online: getOnlinePlayerIds().includes(playerId),
    in_queue: playerInQueue.has(playerId) || playerInReadyCheck.has(playerId),
    in_match: playerInMatch.has(playerId),
  }
}

// Fire-and-forget; a failed lookup just leaves clients on the poll cadence.
export function broadcastPresence(playerId) {
  if (!_io || !playerId) return
  query(
    `SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS friend_id
       FROM friendships
      WHERE (requester_id = $1 OR addressee_id = $1) AND status = 'accepted'`,
    [playerId],
  ).then(rows => {
    if (!rows || rows.length === 0) return
    const flags = flagsFor(playerId)
    for (const r of rows) _io.to(`user:${r.friend_id}`).emit('friend:presence', flags)
  }).catch(() => {})
}
