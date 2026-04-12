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
}

const pools = ref<QueuePool[]>([])
const inQueue = ref(false)
const currentPoolId = ref<number | null>(null)
const queueCount = ref(0)
const queuePlayers = ref<QueuePlayer[]>([])

const activeMatch = ref<QueueMatchFound | null>(null)
const pickState = ref<QueuePickState | null>(null)
const teamsFormed = ref<{ team1: QueuePlayer[]; team2: QueuePlayer[] } | null>(null)
const lobbyInfo = ref<{ matchId: number; gameName: string; password: string; expiresAt: number } | null>(null)
const queueError = ref<string | null>(null)
const cancelled = ref<string | null>(null)

const queueHistory = ref<any[]>([])

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

let socketInitialized = false

function initSocket() {
  if (socketInitialized) return
  socketInitialized = true

  const socket = getSocket()

  socket.on('queue:updated', (data: { poolId: number; count: number; players: QueuePlayer[] }) => {
    if (data.poolId === currentPoolId.value) {
      queueCount.value = data.count
      queuePlayers.value = data.players
    }
  })

  socket.on('queue:matchFound', (data: QueueMatchFound) => {
    activeMatch.value = data
    pickState.value = null
    teamsFormed.value = null
    lobbyInfo.value = null
    cancelled.value = null
    inQueue.value = false
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

  socket.on('queue:cancelled', (data: { queueMatchId: number; reason: string }) => {
    cancelled.value = data.reason
    activeMatch.value = null
    pickState.value = null
    teamsFormed.value = null
    lobbyInfo.value = null
  })

  socket.on('queue:error', (data: { message: string }) => {
    queueError.value = data.message
    setTimeout(() => { queueError.value = null }, 5000)
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
    } catch {
      pools.value = []
    }
  }

  function joinQueue(poolId: number) {
    currentPoolId.value = poolId
    cancelled.value = null
    getSocket().emit('queue:join', { poolId })
    inQueue.value = true
  }

  function leaveQueue() {
    const poolId = currentPoolId.value
    getSocket().emit('queue:leave')
    inQueue.value = false
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

  function resetMatchState() {
    activeMatch.value = null
    pickState.value = null
    teamsFormed.value = null
    lobbyInfo.value = null
    cancelled.value = null
  }

  return {
    pools,
    inQueue,
    currentPoolId,
    queueCount,
    queuePlayers,
    activeMatch,
    pickState,
    teamsFormed,
    lobbyInfo,
    queueError,
    cancelled,
    queueHistory,
    chatMessages,
    chatRateLimitedUntil,

    fetchPools,
    joinQueue,
    leaveQueue,
    pickPlayer,
    requestState,
    fetchHistory,
    resetMatchState,
    sendChat,
  }
}
