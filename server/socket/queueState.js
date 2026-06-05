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

// Queue-ordering grace window. Joins landing in the same bucket are treated as
// equal in line, so reaction-time — and, crucially, scripts that emit
// queue:join the instant a match ends — can't jump ahead of a human who clicks
// a second or two later. Order inside a bucket is decided by a stored random
// tiebreak, never by who emitted first.
export const QUEUE_PRIORITY_BUCKET_MS = 3000

// Canonical queue ordering, shared by the displayed waiting list and ready-check
// selection so the two never disagree. Compound key, each layer breaking only
// the ties left by the one above:
//   1) Time bucket — earlier bucket first. Keeps players already waiting ahead
//      of anyone re-queuing out of a freshly-ended match.
//   2) Priority tier — perk auto-requeue (0) ahead of manual joins (1), but
//      only among players sharing a bucket, so the perk keeps its edge over
//      post-match clickers without leapfrogging earlier waiters.
//   3) Random tiebreak — fair coin among everyone still tied; a scripted
//      instant-join shares the bucket and tier of a slightly-later human click,
//      so being faster buys nothing.
export function compareQueueOrder(a, b) {
  const bucketA = Math.floor((a.enqueuedAt ?? 0) / QUEUE_PRIORITY_BUCKET_MS)
  const bucketB = Math.floor((b.enqueuedAt ?? 0) / QUEUE_PRIORITY_BUCKET_MS)
  if (bucketA !== bucketB) return bucketA - bucketB
  const tierD = (a.priorityTier ?? 1) - (b.priorityTier ?? 1)
  if (tierD !== 0) return tierD
  return (a.tiebreak ?? 0) - (b.tiebreak ?? 0)
}

export function getPoolQueuePlayers(poolId) {
  const q = poolQueues.get(poolId)
  if (!q) return []
  return [...q.values()].sort(compareQueueOrder)
}

export function clearPickTimer(queueMatchId) {
  const timer = queuePickTimers.get(queueMatchId)
  if (timer) {
    clearTimeout(timer)
    queuePickTimers.delete(queueMatchId)
  }
}
