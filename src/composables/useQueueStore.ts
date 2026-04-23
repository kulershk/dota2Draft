import { ref, computed } from 'vue'
import { getSocket } from './useSocket'
import { useApi } from './useApi'

export interface QueuePlayer {
  playerId: number
  name: string
  steamId: string
  avatarUrl: string
  mmr: number
}

export interface QueuePool {
  id: number
  name: string
  enabled: boolean
  min_mmr: number
  max_mmr: number
  pick_timer: number
  best_of: number
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
const currentPoolId = ref<number | null>(null)
const currentPoolName = ref<string | null>(null)
const queueCount = ref(0)
const queuePlayers = ref<QueuePlayer[]>([])

const activeMatch = ref<QueueMatchFound | null>(null)
const pickState = ref<QueuePickState | null>(null)
const teamsFormed = ref<{ team1: QueuePlayer[]; team2: QueuePlayer[] } | null>(null)
const lobbyInfo = ref<{ matchId: number; gameName: string; password: string; expiresAt: number } | null>(null)
const queueError = ref<string | null>(null)
const cancelled = ref<string | null>(null)

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
    lobbyInfo.value = null
    cancelled.value = null
    readyCheck.value = null
    readyCheckFailed.value = null
    rolePreferences.value = data.rolePreferences || {}
    inQueue.value = false
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

  socket.on('queue:teamsFormed', (data: { queueMatchId: number; team1: QueuePlayer[]; team2: QueuePlayer[] }) => {
    teamsFormed.value = { team1: data.team1, team2: data.team2 }
  })

  socket.on('queue:lobbyCreated', (data: { queueMatchId: number; matchId: number; lobbyInfo: { gameName: string; password: string }; lobbyExpiresAt?: number }) => {
    lobbyInfo.value = { matchId: data.matchId, gameName: data.lobbyInfo.gameName, password: data.lobbyInfo.password, expiresAt: data.lobbyExpiresAt || 0 }
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
    lobbyInfo.value = null
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
    // Roll back optimistic join state — if the server rejected the join,
    // we're not actually in queue.
    inQueue.value = false
    currentPoolName.value = null
    queueCount.value = 0
    queuePlayers.value = []
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
    } else if (!data.inMatch) {
      // Truly idle — clear any stale state
      if (!data.poolId) {
        queueCount.value = 0
        queuePlayers.value = []
      }
    }
  })

  socket.on('queue:gameStarted', (_data: { queueMatchId: number; dotaMatchId: string }) => {
    activeMatch.value = null
    pickState.value = null
    teamsFormed.value = null
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
    currentPoolId.value = poolId
    const p = pools.value.find(x => x.id === poolId)
    if (p) currentPoolName.value = p.name
    cancelled.value = null
    getSocket().emit('queue:join', { poolId })
    inQueue.value = true
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
    lobbyInfo.value = null
    cancelled.value = null
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

  return {
    pools,
    inQueue,
    currentPoolId,
    currentPoolName,
    queueCount,
    queuePlayers,
    activeMatch,
    pickState,
    teamsFormed,
    lobbyInfo,
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
  }
}
