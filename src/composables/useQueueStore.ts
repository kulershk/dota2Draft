import { ref, computed, watch } from 'vue'
import { getSocket } from './useSocket'
import { useApi } from './useApi'
import { fireMatchFoundAlert, requestMatchNotifyPermission, unlockMatchAudio } from './useMatchAlert'

export interface QueuePlayer {
  playerId: number
  name: string
  steamId: string
  avatarUrl: string
  mmr: number
  /** Current season points; populated when the pool has a season attached */
  seasonPoints?: number | null
  /** Saved role preferences carried from previous matches */
  preferredRoles?: string[]
  /** Custom per-season group ids the player belongs to. Drives the
   * matchmaking rules; the IDs alone are enough for that. */
  groupIds?: number[]
  /** Resolved metadata (name + border_color) for each group the player
   * is in, ordered highest-priority first (captains_drawn_from >
   * min_per_match > id). Used by queue / draft / lobby tile renderers
   * to colour the avatar border. Server includes this with every queue
   * entry so the client doesn't need an extra metadata fetch. */
  groups?: Array<{ id: number; name: string; border_color: string; captains_drawn_from: boolean }>
  /** Uploaded profile banner URL, present only for players whose active
   * subscription grants the profile_banner perk. Set by the server when a
   * draft starts (startQueueMatch) and rendered as a faint background behind
   * the player's tile on the draft board. */
  profileBannerUrl?: string | null
}

export interface QueuePool {
  id: number
  name: string
  enabled: boolean
  is_featured?: boolean
  min_mmr: number
  max_mmr: number
  pick_timer: number
  best_of: number
  team_size?: number
  lobby_server_region: number
  lobby_game_mode: number
  lobby_league_id: number
  queue_count?: number
}

export interface QueuePickState {
  queueMatchId: number
  currentPicker: 1 | 2 | null
  captain1Picks: QueuePlayer[]
  captain2Picks: QueuePlayer[]
  availablePlayers: QueuePlayer[]
  pickTimerEnd: number | null
  pickIndex: number
  status: string
}

export interface QueueMatchFound {
  queueMatchId: number
  poolId: number
  players: QueuePlayer[]
  captain1: QueuePlayer
  captain2: QueuePlayer
  availablePlayers: QueuePlayer[]
  pickOrder: number[]
  pickTimer: number
  rolePreferences?: Record<number, string[]>
}

export const QUEUE_ROLES = ['carry', 'mid', 'offlane', 'support', 'hard_support'] as const
export type QueueRole = typeof QUEUE_ROLES[number]

const pools = ref<QueuePool[]>([])
const inQueue = ref(false)
// Epoch ms when the current search started — set on the rising edge of
// inQueue, cleared when we leave the queue. Used by the right rail to
// show an elapsed "searching for Xs" timer. Client-side clock; close
// enough for a UI counter (server FIFO order is the source of truth for
// actual matchmaking).
const queueStartedAt = ref<number | null>(null)
watch(inQueue, (now, prev) => {
  if (now && !prev) queueStartedAt.value = Date.now()
  else if (!now) queueStartedAt.value = null
})
const currentPoolId = ref<number | null>(null)
const currentPoolName = ref<string | null>(null)
const queueCount = ref(0)
const queuePlayers = ref<QueuePlayer[]>([])

const activeMatch = ref<QueueMatchFound | null>(null)
const pickState = ref<QueuePickState | null>(null)
const teamsFormed = ref<{ team1: QueuePlayer[]; team2: QueuePlayer[] } | null>(null)
// Sides are coin-flipped server-side when picking ends. Set only on the live
// "picks just ended" emit (justFormed flag — never on rehydrate re-emits) so
// the page plays the Radiant/Dire coin-flip reveal exactly once per match.
// `at` lets the page skip the reveal if it mounts long after the flip.
const coinFlip = ref<{ radiant: QueuePlayer; dire: QueuePlayer; at: number } | null>(null)
const lobbyInfo = ref<{ matchId: number; gameName: string; password: string; expiresAt: number } | null>(null)
const lobbyPlayersJoined = ref<string[]>([])
const queueError = ref<string | null>(null)
const cancelled = ref<string | null>(null)

// Snapshot of the just-finished inhouse match, kept around after
// queue:gameStarted clears activeMatch/teamsFormed so the player still has
// a UI surface for filing toxic / grief reports during the report window.
// Cleared when a new match begins or the user dismisses it.
export interface PostMatchSnapshot {
  queueMatchId: number
  poolId: number
  team1: QueuePlayer[]
  team2: QueuePlayer[]
  captain1Id: number
  captain2Id: number
  snapshotAt: number
}
const postMatch = ref<PostMatchSnapshot | null>(null)

export interface QueueReadyCheck {
  readyCheckId: number
  poolId: number
  players: QueuePlayer[]
  acceptTimerEnd: number
  acceptTimerSeconds: number
  expectedCount: number
  acceptedIds: number[]
  declinedIds: number[]
  myStatus: 'pending' | 'accepted' | 'declined'
}
const readyCheck = ref<QueueReadyCheck | null>(null)
const readyCheckFailed = ref<{ reason: 'declined' | 'timeout'; requeued: boolean; banMinutes: number } | null>(null)

// playerId → ordered array of role keys for the active queue match
const rolePreferences = ref<Record<number, string[]>>({})

const queueHistory = ref<any[]>([])

export interface QueueBanInfo {
  bannedUntil: string | null
  reason: string | null
  bannedBy: string | null
}
const myBan = ref<QueueBanInfo | null>(null)

export interface QueueChatMessage {
  id: number
  poolId: number
  playerId: number
  name: string
  avatarUrl: string | null
  mmrVerifiedAt?: string | null
  text: string
  ts: number
}
const chatMessages = ref<QueueChatMessage[]>([])
const chatRateLimitedUntil = ref(0)

export interface QueuePlayerStats { wins: number; losses: number }
const playerStats = ref<Record<number, QueuePlayerStats>>({})

// Per-pool queue size, broadcast by the server on every change so tab badges
// stay in sync even for pools the user hasn't selected.
const poolCounts = ref<Record<number, number>>({})

let socketInitialized = false

// The Go bot reports `playersJoined` as `LobbyPlayer` objects ({steamId, name, team}),
// but older code paths (and a future server change) may send plain steamId strings.
// Normalize to a flat string[] of steamIds so isInLobby(steamId) works either way.
function normalizeJoined(list: Array<string | { steamId: string }> | undefined | null): string[] {
  if (!Array.isArray(list)) return []
  return list
    .map(p => (typeof p === 'string' ? p : (p && typeof p.steamId === 'string' ? p.steamId : '')))
    .filter(Boolean)
}

function initSocket() {
  if (socketInitialized) return
  socketInitialized = true

  const socket = getSocket()

  socket.on('queue:updated', (data: { poolId: number; count: number; players: QueuePlayer[] }) => {
    poolCounts.value = { ...poolCounts.value, [data.poolId]: data.count }
    if (data.poolId === currentPoolId.value) {
      queueCount.value = data.count
      queuePlayers.value = data.players
    }
  })

  socket.on('queue:poolCounts', (counts: Record<number, number>) => {
    poolCounts.value = counts || {}
  })

  socket.on('queue:matchFound', (data: QueueMatchFound) => {
    activeMatch.value = data
    pickState.value = null
    teamsFormed.value = null
    coinFlip.value = null
    lobbyInfo.value = null
    cancelled.value = null
    readyCheck.value = null
    readyCheckFailed.value = null
    rolePreferences.value = data.rolePreferences || {}
    inQueue.value = false
    // New match supersedes any prior post-match snapshot.
    postMatch.value = null
  })

  socket.on('queue:rolePreferencesUpdate', (data: { queueMatchId: number; playerId: number; roles: string[] }) => {
    if (!activeMatch.value || activeMatch.value.queueMatchId !== data.queueMatchId) return
    rolePreferences.value = { ...rolePreferences.value, [data.playerId]: data.roles }
  })

  socket.on('queue:readyCheck', (data: {
    readyCheckId: number
    poolId: number
    players: QueuePlayer[]
    acceptTimerEnd: number
    acceptTimerSeconds: number
    expectedCount: number
  }) => {
    readyCheck.value = {
      readyCheckId: data.readyCheckId,
      poolId: data.poolId,
      players: data.players,
      acceptTimerEnd: data.acceptTimerEnd,
      acceptTimerSeconds: data.acceptTimerSeconds,
      expectedCount: data.expectedCount,
      acceptedIds: [],
      declinedIds: [],
      myStatus: 'pending',
    }
    readyCheckFailed.value = null
    inQueue.value = false
    cancelled.value = null
    // Desktop notification (when the tab isn't focused) + sound cue so a player
    // who tabbed away doesn't miss the ~20s accept window. Deduped per ready
    // check so a reconnect-rehydrate doesn't double-alert.
    fireMatchFoundAlert(data.readyCheckId)
  })

  socket.on('queue:readyCheckUpdate', (data: {
    readyCheckId: number
    acceptedIds: number[]
    declinedIds: number[]
    expectedCount: number
  }) => {
    if (!readyCheck.value || readyCheck.value.readyCheckId !== data.readyCheckId) return
    readyCheck.value = {
      ...readyCheck.value,
      acceptedIds: data.acceptedIds,
      declinedIds: data.declinedIds,
      expectedCount: data.expectedCount,
    }
  })

  socket.on('queue:readyCheckPassed', (_data: { readyCheckId: number }) => {
    // Clear the ready-check modal — queue:matchFound will arrive next and
    // take over with the pick-phase UI.
    readyCheck.value = null
  })

  socket.on('queue:readyCheckFailed', (data: {
    readyCheckId: number
    reason: 'declined' | 'timeout'
    requeued: boolean
    banMinutes: number
  }) => {
    readyCheck.value = null
    readyCheckFailed.value = {
      reason: data.reason,
      requeued: data.requeued,
      banMinutes: data.banMinutes,
    }
    // Auto-hide the failed banner after a few seconds
    setTimeout(() => { readyCheckFailed.value = null }, 6000)
    // readyCheck arrival had set inQueue=false. On requeue the server put us
    // back at the front of the same pool, so flip it back to true.
    if (data.requeued) {
      inQueue.value = true
    } else {
      inQueue.value = false
      currentPoolName.value = null
    }
  })

  socket.on('queue:pickState', (data: QueuePickState) => {
    pickState.value = data
  })

  socket.on('queue:pickMade', (data: { queueMatchId: number; captainNum: number; pickedPlayer: QueuePlayer }) => {
    if (!pickState.value || pickState.value.queueMatchId !== data.queueMatchId) return
    if (data.captainNum === 1) {
      pickState.value.captain1Picks = [...pickState.value.captain1Picks, data.pickedPlayer]
    } else {
      pickState.value.captain2Picks = [...pickState.value.captain2Picks, data.pickedPlayer]
    }
    pickState.value.availablePlayers = pickState.value.availablePlayers.filter(
      p => p.playerId !== data.pickedPlayer.playerId
    )
  })

  socket.on('queue:teamsFormed', (data: { queueMatchId: number; team1: QueuePlayer[]; team2: QueuePlayer[]; justFormed?: boolean }) => {
    // A fresh matchup (e.g. admin recreate) supersedes any prior cancellation —
    // clear it so the cancelled banner doesn't mask the new teams/lobby UI.
    cancelled.value = null
    teamsFormed.value = { team1: data.team1, team2: data.team2 }
    // Live "picks just ended" emit → play the coin-flip reveal.
    // team1 is always Radiant, team2 always Dire.
    if (data.justFormed && data.team1[0] && data.team2[0]) {
      coinFlip.value = { radiant: data.team1[0], dire: data.team2[0], at: Date.now() }
    }
  })

  socket.on('queue:lobbyCreated', (data: { queueMatchId: number; matchId: number; lobbyInfo: { gameName: string; password: string }; lobbyExpiresAt?: number; playersJoined?: Array<string | { steamId: string }> }) => {
    // The new lobby (and its password) supersedes any prior cancellation banner.
    cancelled.value = null
    lobbyInfo.value = { matchId: data.matchId, gameName: data.lobbyInfo.gameName, password: data.lobbyInfo.password, expiresAt: data.lobbyExpiresAt || 0 }
    lobbyPlayersJoined.value = normalizeJoined(data.playersJoined)
  })

  socket.on('lobby:statusUpdate', (data: { matchId: number; gameNumber: number; status: string; playersJoined?: Array<string | { steamId: string }> }) => {
    if (!lobbyInfo.value || lobbyInfo.value.matchId !== data.matchId) return
    if (Array.isArray(data.playersJoined)) {
      lobbyPlayersJoined.value = normalizeJoined(data.playersJoined)
    }
  })

  socket.on('queue:lobbyRetrying', (data: { matchId: number; gameNumber: number; attempt: number; maxAttempts: number; lobbyInfo: { gameName: string; password: string } }) => {
    // Update visible lobby info so players see the new password from the
    // retry bot, and surface a transient notice about the attempt count.
    lobbyInfo.value = {
      matchId: data.matchId,
      gameName: data.lobbyInfo.gameName,
      password: data.lobbyInfo.password,
      expiresAt: lobbyInfo.value?.expiresAt || 0,
    }
    queueError.value = `Lobby creation failed — retrying with a different bot (${data.attempt}/${data.maxAttempts})...`
    setTimeout(() => { if (queueError.value?.startsWith('Lobby creation failed')) queueError.value = null }, 6000)
  })

  socket.on('queue:cancelled', (data: { queueMatchId: number; reason: string }) => {
    cancelled.value = data.reason
    activeMatch.value = null
    pickState.value = null
    teamsFormed.value = null
    coinFlip.value = null
    lobbyInfo.value = null
    lobbyPlayersJoined.value = []
  })

  socket.on('queue:kicked', (data: { poolId: number; reason: string }) => {
    inQueue.value = false
    currentPoolName.value = null
    queueCount.value = 0
    queuePlayers.value = []
    queueError.value = data.reason || 'Removed from queue by admin'
    setTimeout(() => { queueError.value = null }, 5000)
  })

  socket.on('queue:error', (data: { message: string }) => {
    queueError.value = data.message
    setTimeout(() => { queueError.value = null }, 5000)
    // Don't clobber local queue state — errors like "Already in a queue" /
    // "Already in an active match" mean nothing changed server-side, and
    // wiping queueCount made the UI flash 0 even when the pool was still
    // populated. Re-sync from server truth instead.
    requestMyState()
  })

  socket.on('queue:myState', (data: {
    inQueue: boolean
    poolId: number | null
    poolName: string | null
    inMatch: boolean
    queueMatchId: number | null
    count: number
    players: QueuePlayer[]
    ban?: QueueBanInfo | null
  }) => {
    inQueue.value = data.inQueue
    myBan.value = data.ban || null
    if (data.inQueue && data.poolId) {
      currentPoolId.value = data.poolId
      currentPoolName.value = data.poolName
      queueCount.value = data.count
      queuePlayers.value = data.players
    }
    // Server is authoritative — if it says we're not queued and not in a
    // match, any stale ready-check / active-match state on the client is
    // bogus and must be cleared so the modal + overlay don't linger.
    if (!data.inQueue && !data.inMatch) {
      readyCheck.value = null
      activeMatch.value = null
    }
    // Don't clear queueCount/queuePlayers when idle: those reflect the
    // currently-viewed pool (owned by the queue:updated path triggered by
    // selectPool → requestState), not the player's own queue membership.
    // Clearing them here raced with QueuePage's requestState on reload,
    // wiping the just-arrived player list.
  })

  socket.on('queue:gameStarted', (_data: { queueMatchId: number; dotaMatchId: string }) => {
    // Snapshot the just-started match BEFORE clearing the active-match
    // state so the QueuePage can keep showing the rosters with Report
    // buttons during the post-match window.
    const am = activeMatch.value
    const tf = teamsFormed.value
    if (am && tf) {
      postMatch.value = {
        queueMatchId: am.queueMatchId,
        poolId: am.poolId,
        team1: tf.team1,
        team2: tf.team2,
        captain1Id: am.captain1.playerId,
        captain2Id: am.captain2.playerId,
        snapshotAt: Date.now(),
      }
    }
    activeMatch.value = null
    pickState.value = null
    teamsFormed.value = null
    coinFlip.value = null
    lobbyInfo.value = null
    cancelled.value = null
  })

  socket.on('queue:chatHistory', (data: { poolId: number; messages: QueueChatMessage[] }) => {
    if (data.poolId !== currentPoolId.value) return
    chatMessages.value = data.messages
  })

  socket.on('queue:chatMessage', (msg: QueueChatMessage) => {
    if (msg.poolId !== currentPoolId.value) return
    chatMessages.value = [...chatMessages.value, msg].slice(-50)
  })

  socket.on('queue:chatRateLimited', (data: { retryAfterMs: number }) => {
    chatRateLimitedUntil.value = Date.now() + (data?.retryAfterMs || 1000)
  })
}

export function useQueueStore() {
  const api = useApi()

  initSocket()

  async function fetchPools() {
    try {
      pools.value = await api.getQueuePools()
      // Seed per-pool counts from the REST snapshot so badges are populated
      // before the first socket broadcast arrives.
      const seeded: Record<number, number> = {}
      for (const p of pools.value) seeded[p.id] = (p as any).queue_count || 0
      poolCounts.value = { ...seeded, ...poolCounts.value }
    } catch {
      pools.value = []
    }
  }

  function joinQueue(poolId: number) {
    // Joining is a user gesture — use it to unlock audio + ask for notification
    // permission so a later ready check can alert even when the tab is unfocused.
    requestMatchNotifyPermission()
    unlockMatchAudio()
    currentPoolId.value = poolId
    const p = pools.value.find(x => x.id === poolId)
    if (p) currentPoolName.value = p.name
    cancelled.value = null
    // No optimistic `inQueue = true` — server confirms via queue:myState
    // (success) or rejects via queue:error + myState reset. Optimism caused
    // the UI to flip to "Searching… Leave" after the server returned
    // "Already in an active match".
    getSocket().emit('queue:join', { poolId })
  }

  function requestMyState() {
    getSocket().emit('queue:getMyState')
  }

  function leaveQueue() {
    const poolId = currentPoolId.value
    getSocket().emit('queue:leave')
    inQueue.value = false
    currentPoolName.value = null
    queueCount.value = 0
    queuePlayers.value = []
    // You can't be in a ready check / active match if you've left the queue.
    // Clearing here keeps the ReadyCheckModal + match-found CTA from
    // persisting after manual leave.
    readyCheck.value = null
    activeMatch.value = null
    // Re-join the pool room so chat keeps working while still browsing this pool
    if (poolId) getSocket().emit('queue:getState', { poolId })
  }

  function pickPlayer(queueMatchId: number, playerId: number) {
    getSocket().emit('queue:pick', { queueMatchId, playerId })
  }

  function requestState(poolId: number) {
    currentPoolId.value = poolId
    chatMessages.value = []
    getSocket().emit('queue:getState', { poolId })
  }

  function sendChat(text: string): boolean {
    if (!currentPoolId.value) return false
    const trimmed = text.trim()
    if (!trimmed) return false
    if (Date.now() < chatRateLimitedUntil.value) return false
    chatRateLimitedUntil.value = Date.now() + 1000
    getSocket().emit('queue:chatSend', { poolId: currentPoolId.value, text: trimmed })
    return true
  }

  async function fetchHistory(poolId?: number) {
    try {
      queueHistory.value = await api.getQueueHistory({ poolId, limit: 20 })
    } catch {
      queueHistory.value = []
    }
  }

  async function fetchPlayerStats(poolId: number, ids: number[]) {
    if (!poolId || ids.length === 0) { playerStats.value = {}; return }
    try {
      const rows = await api.getQueuePlayerStats({ poolId, playerIds: ids, limit: 10 })
      const next: Record<number, QueuePlayerStats> = {}
      for (const r of rows) next[r.playerId] = { wins: r.wins, losses: r.losses }
      playerStats.value = next
    } catch {
      playerStats.value = {}
    }
  }

  function resetMatchState() {
    activeMatch.value = null
    pickState.value = null
    teamsFormed.value = null
    coinFlip.value = null
    lobbyInfo.value = null
    cancelled.value = null
  }

  function dismissCoinFlip() {
    coinFlip.value = null
  }

  function setRolePreferences(roles: string[]) {
    if (!activeMatch.value) return
    getSocket().emit('queue:setRolePreferences', {
      queueMatchId: activeMatch.value.queueMatchId,
      roles,
    })
  }

  function toggleRolePreference(role: string, currentUserId: number | null) {
    if (!currentUserId || !activeMatch.value) return
    const current = rolePreferences.value[currentUserId] || []
    const idx = current.indexOf(role)
    const next = idx >= 0 ? current.filter(r => r !== role) : [...current, role]
    rolePreferences.value = { ...rolePreferences.value, [currentUserId]: next }
    setRolePreferences(next)
  }

  function acceptReadyCheck() {
    const rc = readyCheck.value
    if (!rc || rc.myStatus !== 'pending') return
    readyCheck.value = { ...rc, myStatus: 'accepted' }
    getSocket().emit('queue:accept', { readyCheckId: rc.readyCheckId })
  }

  function declineReadyCheck() {
    const rc = readyCheck.value
    if (!rc || rc.myStatus !== 'pending') return
    readyCheck.value = { ...rc, myStatus: 'declined' }
    getSocket().emit('queue:decline', { readyCheckId: rc.readyCheckId })
  }

  // Auto-requeue (perk-gated). Server validates the perk; client UI hides
  // the toggle for non-subscribers but the gate is enforced server-side.
  function setAutoRequeue(enabled: boolean) {
    getSocket().emit('queue:setAutoRequeue', { enabled })
  }
  // Caller-provided callback for the server's authoritative state echo.
  // Stored in a single slot so re-registering on hot-reload doesn't stack
  // listeners; pages subscribe in setup, useQueueStore re-binds on its own
  // io connect.
  let autoRequeueStateCb: ((enabled: boolean) => void) | null = null
  function onAutoRequeueState(cb: (enabled: boolean) => void) {
    autoRequeueStateCb = cb
  }
  getSocket().on('queue:autoRequeueState', (data: { enabled: boolean }) => {
    if (autoRequeueStateCb) autoRequeueStateCb(!!data?.enabled)
  })

  function dismissPostMatch() {
    postMatch.value = null
  }

  return {
    pools,
    inQueue,
    queueStartedAt,
    currentPoolId,
    currentPoolName,
    queueCount,
    queuePlayers,
    activeMatch,
    pickState,
    teamsFormed,
    coinFlip,
    dismissCoinFlip,
    postMatch,
    dismissPostMatch,
    lobbyInfo,
    lobbyPlayersJoined,
    queueError,
    cancelled,
    queueHistory,
    myBan,
    chatMessages,
    chatRateLimitedUntil,
    playerStats,
    poolCounts,
    readyCheck,
    readyCheckFailed,
    rolePreferences,

    fetchPools,
    joinQueue,
    leaveQueue,
    pickPlayer,
    requestState,
    requestMyState,
    fetchHistory,
    fetchPlayerStats,
    resetMatchState,
    sendChat,
    acceptReadyCheck,
    declineReadyCheck,
    setRolePreferences,
    toggleRolePreference,
    setAutoRequeue,
    onAutoRequeueState,
  }
}
