// Queue matchmaking in-memory state

// poolId -> Map<playerId, { playerId, name, displayName, steamId, avatarUrl, mmr }>
export const poolQueues = new Map()

// queueMatchId -> QueueMatch object (active pick phases)
export const activeQueueMatches = new Map()

// queueMatchId -> timeout (pick timer)
export const queuePickTimers = new Map()

// playerId -> poolId (prevent multi-queue)
export const playerInQueue = new Map()

// playerId -> queueMatchId (prevent queue while in pick/lobby)
export const playerInMatch = new Map()

// readyCheckId -> { id, poolId, players, accepted:Set, declined:Set,
//                   acceptTimerEnd, timeoutHandle, acceptTimerSeconds,
//                   declineBanMinutes }
// Holds matches waiting for all N players to click Accept before picking starts.
export const pendingReadyChecks = new Map()

// playerId -> readyCheckId (third gate alongside playerInQueue / playerInMatch)
export const playerInReadyCheck = new Map()

// playerId -> { poolId, queueMatchId } — set while the player is in the
// referenced queue match and has opted into auto-requeueing for poolId.
// Read by the queue match-end hook in botPool, which only honors the entry
// if queueMatchId matches the just-completed match (so a cancelled match
// followed by a manual queue into a different pool can't trigger a stale
// auto-requeue into the original pool). Perk gating is enforced at the
// socket event boundary, not here. In-memory only.
export const playerWantsRequeue = new Map()

let readyCheckSeq = 0
export function nextReadyCheckId() { return ++readyCheckSeq }

// Pick order: captain 1 picks first, then alternating 1-2-2-1-1-2-2-1
export const PICK_ORDER = [1, 2, 2, 1, 1, 2, 2, 1]

export function getPoolQueue(poolId) {
  if (!poolQueues.has(poolId)) poolQueues.set(poolId, new Map())
  return poolQueues.get(poolId)
}

export function getPoolQueueCount(poolId) {
  return poolQueues.get(poolId)?.size || 0
}

export function getPoolQueuePlayers(poolId) {
  const q = poolQueues.get(poolId)
  return q ? [...q.values()] : []
}

export function clearPickTimer(queueMatchId) {
  const timer = queuePickTimers.get(queueMatchId)
  if (timer) {
    clearTimeout(timer)
    queuePickTimers.delete(queueMatchId)
  }
}
