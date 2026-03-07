import { ref, computed, reactive } from 'vue'
import { useApi } from './useApi'
import { getSocket, reconnectSocket } from './useSocket'

export interface Captain {
  id: number
  name: string
  team: string
  budget: number
  status: string
  mmr: number
  player_id?: number
  avatar_url?: string
}

export interface Player {
  id: number
  name: string
  roles: string[]
  mmr: number
  info: string
  drafted: boolean
  drafted_by?: number | null
  draft_price?: number | null
  draft_round?: number | null
  steam_id?: string | null
  avatar_url?: string | null
  is_admin?: boolean
  is_captain?: boolean
  in_pool?: boolean
}

export interface BidEntry {
  id: number
  round: number
  player_id: number
  captain_id: number
  captain_name: string
  amount: number
}

export interface Settings {
  playersPerTeam: number
  bidTimer: number
  startingBudget: number
  minimumBid: number
  bidIncrement: number
  maxBid: number
  nominationOrder: string
  requireAllOnline: boolean
  allowSteamRegistration: boolean
}

export interface AuctionState {
  status: string
  currentRound: number
  totalRounds: number
  nominator: { id: number; name: string; team: string } | null
  nominatedPlayer: Player | null
  currentBid: number
  currentBidder: { id: number; name: string; team: string } | null
  bidTimerEnd: number
  bidHistory: BidEntry[]
}

export interface CurrentUser {
  id: number
  name: string
  steam_id: string
  avatar_url: string
  is_admin: boolean
  in_pool: boolean
  roles: string[]
  mmr: number
  info: string
  captain: { id: number; team: string; budget: number; status: string } | null
}

const settings = reactive<Settings>({
  playersPerTeam: 5,
  bidTimer: 30,
  startingBudget: 1000,
  minimumBid: 10,
  bidIncrement: 5,
  maxBid: 0,
  nominationOrder: 'normal',
  requireAllOnline: true,
  allowSteamRegistration: true,
})

const captains = ref<Captain[]>([])
const players = ref<Player[]>([])
const auction = reactive<AuctionState>({
  status: 'idle',
  currentRound: 0,
  totalRounds: 0,
  nominator: null,
  nominatedPlayer: null,
  currentBid: 0,
  currentBidder: null,
  bidTimerEnd: 0,
  bidHistory: [],
})

const currentUser = ref<CurrentUser | null>(null)
const loading = ref(false)
const error = ref('')
const lastSoldMessage = ref('')
const undoMessage = ref('')

export interface LogEntry {
  time: number
  type: 'nomination' | 'bid' | 'sold' | 'undo' | 'pause' | 'resume' | 'start' | 'end' | 'info'
  message: string
}
const activityLog = ref<LogEntry[]>([])

// Derived state for backward compatibility
const isAdmin = computed(() => !!currentUser.value?.is_admin)
const currentCaptain = computed<Captain | null>(() => {
  if (!currentUser.value?.captain) return null
  return {
    id: currentUser.value.captain.id,
    name: currentUser.value.name,
    team: currentUser.value.captain.team,
    budget: currentUser.value.captain.budget,
    status: currentUser.value.captain.status,
    mmr: currentUser.value.mmr || 0,
  }
})

const availablePlayers = computed(() =>
  players.value.filter(p => !p.drafted && !p.is_captain)
)

const roleCounts = computed(() => {
  const counts = { Carry: 0, Mid: 0, Offlane: 0, Pos4: 0, Pos5: 0 }
  players.value.forEach(p => {
    if (p.is_captain) return // exclude captains from role counts
    p.roles.forEach(r => {
      if (r in counts) counts[r as keyof typeof counts]++
    })
  })
  return counts
})

let socketInitialized = false

export function useDraftStore() {
  const api = useApi()

  function initSocket() {
    if (socketInitialized) return
    socketInitialized = true

    const socket = getSocket()

    socket.on('settings:updated', (data: Settings) => {
      Object.assign(settings, data)
    })

    socket.on('captains:updated', (data: Captain[]) => {
      captains.value = data
      // Refresh current user's captain status
      if (currentUser.value) {
        const myCaptain = data.find(c => c.player_id === currentUser.value!.id)
        currentUser.value.captain = myCaptain
          ? { id: myCaptain.id, team: myCaptain.team, budget: myCaptain.budget, status: myCaptain.status }
          : null
      }
    })

    socket.on('players:updated', (data: Player[]) => {
      players.value = data
    })

    socket.on('captains:online', (ids: number[]) => {
      onlineCaptainIds.value = ids
    })

    socket.on('captains:ready', (ids: number[]) => {
      readyCaptainIds.value = ids
    })

    socket.on('auction:stateChanged', (data: any) => {
      auction.status = data.status || 'idle'
      auction.currentRound = data.currentRound || 0
      auction.totalRounds = data.totalRounds || 0
      auction.nominator = data.nominator || null
      auction.nominatedPlayer = data.nominatedPlayer || null
      auction.currentBid = data.currentBid || 0
      auction.currentBidder = data.currentBidder || null
      auction.bidTimerEnd = data.bidTimerEnd || 0
      auction.bidHistory = data.bidHistory || []
      if (data.captains) captains.value = data.captains
      if (data.players) players.value = data.players
    })

    socket.on('auction:timerUpdate', (data: { bidTimerEnd: number }) => {
      auction.bidTimerEnd = data.bidTimerEnd
    })

    socket.on('auction:sold', (data: { playerName: string; captainName: string; amount: number }) => {
      lastSoldMessage.value = `${data.playerName} sold to ${data.captainName} for ${data.amount}g!`
      setTimeout(() => { lastSoldMessage.value = '' }, 5000)
    })

    socket.on('auction:undone', (data: { message: string }) => {
      undoMessage.value = data.message
      setTimeout(() => { undoMessage.value = '' }, 5000)
    })

    socket.on('auction:log', (entry: { type: LogEntry['type']; message: string }) => {
      activityLog.value.unshift({ time: Date.now(), ...entry })
    })

    socket.on('auction:logHistory', (entries: LogEntry[]) => {
      activityLog.value = entries
    })

    socket.on('auction:error', (data: { message: string }) => {
      error.value = data.message
      setTimeout(() => { error.value = '' }, 4000)
    })

    socket.on('auction:finished', () => {
      auction.status = 'finished'
    })
  }

  const onlineCaptainIds = ref<number[]>([])
  const readyCaptainIds = ref<number[]>([])

  async function restoreAuth() {
    const token = localStorage.getItem('draft_auth_token')
    if (!token) return
    try {
      const user = await api.getMe()
      currentUser.value = user
    } catch {
      localStorage.removeItem('draft_auth_token')
      currentUser.value = null
    }
  }

  function setAuthToken(token: string) {
    localStorage.setItem('draft_auth_token', token)
    // Reconnect socket with new auth token
    socketInitialized = false
    reconnectSocket()
    initSocket()
  }

  async function loginWithAuthToken(token: string) {
    setAuthToken(token)
    await restoreAuth()
  }

  async function claimAdmin(password: string) {
    await api.claimAdmin(password)
    if (currentUser.value) {
      currentUser.value.is_admin = true
    }
  }

  function logout() {
    api.logout().catch(() => {})
    localStorage.removeItem('draft_auth_token')
    currentUser.value = null
    socketInitialized = false
    reconnectSocket()
    initSocket()
  }

  async function fetchSettings() {
    const data = await api.getSettings()
    Object.assign(settings, data)
  }

  async function saveSettings() {
    await api.updateSettings(settings)
  }

  async function fetchCaptains() {
    captains.value = await api.getCaptains()
  }

  async function promoteToCaptain(playerId: number, team: string) {
    await api.promoteToCaptain({ playerId, team })
  }

  async function updateCaptain(id: number, data: Record<string, any>) {
    await api.updateCaptain(id, data)
  }

  async function demoteCaptain(id: number) {
    await api.demoteCaptain(id)
  }

  async function registerForPool(data: { roles: string[]; mmr?: number; info?: string }) {
    await api.registerPlayer(data)
    if (currentUser.value) {
      currentUser.value.in_pool = true
    }
  }

  async function fetchPlayers() {
    players.value = await api.getPlayers()
  }

  async function updatePlayer(id: number, data: Record<string, any>) {
    await api.updatePlayer(id, data)
  }

  async function deletePlayer(id: number) {
    await api.deletePlayer(id)
  }

  async function fetchAll() {
    loading.value = true
    try {
      await Promise.all([fetchSettings(), fetchCaptains(), fetchPlayers()])
    } finally {
      loading.value = false
    }
  }

  // Ready up
  function setReady() { getSocket().emit('captain:ready') }
  function setUnready() { getSocket().emit('captain:unready') }

  // Auction actions via socket
  function startDraft() { getSocket().emit('auction:start') }
  function nominatePlayer(playerId: number, startingBid?: number) { getSocket().emit('auction:nominate', { playerId, startingBid }) }
  function placeBid(amount: number) { getSocket().emit('auction:bid', { amount }) }
  function pauseAuction() { getSocket().emit('auction:pause') }
  function resumeAuction() { getSocket().emit('auction:resume') }
  function endDraft() { getSocket().emit('auction:end') }
  function undoLast() { getSocket().emit('auction:undo') }
  function resetDraft() { getSocket().emit('auction:reset') }

  return {
    // State
    isAdmin,
    currentUser,
    currentCaptain,
    onlineCaptainIds,
    readyCaptainIds,
    settings,
    captains,
    players,
    auction,
    loading,
    error,
    lastSoldMessage,
    undoMessage,
    activityLog,
    availablePlayers,
    roleCounts,
    // Auth
    restoreAuth,
    loginWithAuthToken,
    claimAdmin,
    logout,
    setAuthToken,
    // Init
    initSocket,
    fetchAll,
    fetchSettings,
    fetchCaptains,
    fetchPlayers,
    // CRUD
    saveSettings,
    promoteToCaptain,
    updateCaptain,
    demoteCaptain,
    registerForPool,
    updatePlayer,
    deletePlayer,
    // Ready
    setReady,
    setUnready,
    // Auction
    startDraft,
    nominatePlayer,
    placeBid,
    pauseAuction,
    resumeAuction,
    endDraft,
    undoLast,
    resetDraft,
    // API
    getResults: api.getResults,
  }
}
