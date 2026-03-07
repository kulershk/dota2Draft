import { ref, computed, reactive } from 'vue'
import { useApi } from './useApi'
import { getSocket } from './useSocket'

export interface Captain {
  id: number
  name: string
  team: string
  budget: number
  status: string
  password?: string
  mmr: number
  is_admin?: boolean
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

const settings = reactive<Settings>({
  playersPerTeam: 5,
  bidTimer: 30,
  startingBudget: 1000,
  minimumBid: 10,
  bidIncrement: 5,
  maxBid: 0,
  nominationOrder: 'normal',
  requireAllOnline: true,
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

const isAdmin = ref(false)
const currentCaptain = ref<Captain | null>(null)
const onlineCaptainIds = ref<number[]>([])
const readyCaptainIds = ref<number[]>([])
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

const availablePlayers = computed(() => players.value.filter(p => !p.drafted))

const roleCounts = computed(() => {
  const counts = { Carry: 0, Mid: 0, Offlane: 0, Pos4: 0, Pos5: 0 }
  players.value.forEach(p => {
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

    socket.on('auction:error', (data: { message: string }) => {
      error.value = data.message
      setTimeout(() => { error.value = '' }, 4000)
    })

    socket.on('auction:finished', () => {
      auction.status = 'finished'
    })
  }

  function saveAuthState() {
    if (currentCaptain.value) {
      localStorage.setItem('draft_auth', JSON.stringify({ type: 'captain', token: localStorage.getItem('draft_captain_token') }))
    } else if (isAdmin.value) {
      localStorage.setItem('draft_auth', JSON.stringify({ type: 'admin' }))
    } else {
      localStorage.removeItem('draft_auth')
      localStorage.removeItem('draft_captain_token')
    }
  }

  async function restoreAuth() {
    const saved = localStorage.getItem('draft_auth')
    if (!saved) return
    try {
      const auth = JSON.parse(saved)
      if (auth.type === 'captain' && auth.token) {
        const captain = await api.loginWithToken(auth.token)
        currentCaptain.value = captain
        if (captain.is_admin) isAdmin.value = true
        const decoded = atob(auth.token)
        const sep = decoded.indexOf(':')
        const password = sep !== -1 ? decoded.slice(sep + 1) : ''
        getSocket().emit('captain:login', { captainId: captain.id, password })
      } else if (auth.type === 'admin') {
        isAdmin.value = true
        const adminPw = localStorage.getItem('draft_admin_pw')
        if (adminPw) getSocket().emit('auth:admin', adminPw)
      }
    } catch {
      localStorage.removeItem('draft_auth')
      localStorage.removeItem('draft_captain_token')
    }
  }

  async function loginAdmin(password: string) {
    await api.loginAdmin(password)
    isAdmin.value = true
    localStorage.setItem('draft_admin_pw', password)
    getSocket().emit('auth:admin', password)
    saveAuthState()
  }

  async function loginCaptain(name: string, password: string) {
    const captain = await api.loginCaptain(name, password)
    currentCaptain.value = captain
    if (captain.is_admin) isAdmin.value = true
    const token = btoa(`${captain.id}:${password}`)
    localStorage.setItem('draft_captain_token', token)
    getSocket().emit('captain:login', { captainId: captain.id, password })
    saveAuthState()
    return captain
  }

  async function loginWithToken(token: string) {
    const captain = await api.loginWithToken(token)
    currentCaptain.value = captain
    if (captain.is_admin) isAdmin.value = true
    localStorage.setItem('draft_captain_token', token)
    const decoded = atob(token)
    const sep = decoded.indexOf(':')
    const password = sep !== -1 ? decoded.slice(sep + 1) : ''
    getSocket().emit('captain:login', { captainId: captain.id, password })
    saveAuthState()
    return captain
  }

  function logoutCaptain() {
    if (currentCaptain.value?.is_admin) isAdmin.value = false
    currentCaptain.value = null
    getSocket().emit('captain:logout')
    localStorage.removeItem('draft_auth')
    localStorage.removeItem('draft_captain_token')
  }

  function logoutAdmin() {
    isAdmin.value = false
    localStorage.removeItem('draft_auth')
    localStorage.removeItem('draft_admin_pw')
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

  async function addCaptain(data: { name: string; team: string; budget?: number; password?: string }) {
    await api.createCaptain(data)
  }

  async function updateCaptain(id: number, data: Record<string, any>) {
    await api.updateCaptain(id, data)
  }

  async function deleteCaptain(id: number) {
    await api.deleteCaptain(id)
  }

  async function fetchPlayers() {
    players.value = await api.getPlayers()
  }

  async function addPlayer(data: { name: string; roles: string[]; mmr?: number; info?: string }) {
    await api.createPlayer(data)
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
  function setReady(captainId: number) { getSocket().emit('captain:ready', captainId) }
  function setUnready(captainId: number) { getSocket().emit('captain:unready', captainId) }

  // Auction actions via socket
  function startDraft() { getSocket().emit('auction:start') }
  function nominatePlayer(playerId: number, startingBid?: number) { getSocket().emit('auction:nominate', { playerId, startingBid }) }
  function placeBid(captainId: number, amount: number) { getSocket().emit('auction:bid', { captainId, amount }) }
  function pauseAuction() { getSocket().emit('auction:pause') }
  function resumeAuction() { getSocket().emit('auction:resume') }
  function endDraft() { getSocket().emit('auction:end') }
  function undoLast() { getSocket().emit('auction:undo') }
  function resetDraft() { getSocket().emit('auction:reset') }

  return {
    // State
    isAdmin,
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
    loginAdmin,
    loginCaptain,
    loginWithToken,
    logoutCaptain,
    logoutAdmin,
    restoreAuth,
    // Init
    initSocket,
    fetchAll,
    fetchSettings,
    fetchCaptains,
    fetchPlayers,
    // CRUD
    saveSettings,
    addCaptain,
    updateCaptain,
    deleteCaptain,
    addPlayer,
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
