import { ref, computed, reactive, watch } from 'vue'
import { useApi } from './useApi'
import { getSocket, reconnectSocket } from './useSocket'

export interface Competition {
  id: number
  name: string
  description: string
  starts_at: string | null
  registration_start: string | null
  registration_end: string | null
  status: string
  settings: Settings
  auction_state: Record<string, any>
  created_by: number | null
  created_by_name: string | null
  created_by_avatar: string | null
  created_at: string
}

export interface Captain {
  id: number
  name: string
  team: string
  budget: number
  status: string
  mmr: number
  player_id?: number
  avatar_url?: string
  banner_url?: string | null
  competition_id?: number
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
  roles: string[]
  mmr: number
  info: string
}

export interface CompetitionUser {
  in_pool: boolean
  roles: string[]
  mmr: number
  info: string
  captain: { id: number; team: string; budget: number; status: string } | null
}

const competitions = ref<Competition[]>([])
const currentCompetitionId = ref<number | null>(null)

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
const compUser = ref<CompetitionUser | null>(null)
const loading = ref(false)

// Auth readiness tracking
let authReadyResolve: () => void
const authReady = new Promise<void>(resolve => { authReadyResolve = resolve })
const error = ref('')
const lastSoldMessage = ref('')
const undoMessage = ref('')

export interface LogEntry {
  time: number
  type: 'nomination' | 'bid' | 'sold' | 'undo' | 'pause' | 'resume' | 'start' | 'end' | 'info'
  message: string
}
const activityLog = ref<LogEntry[]>([])

// Derived state
const isAdmin = computed(() => !!currentUser.value?.is_admin)
const currentCaptain = computed<Captain | null>(() => {
  if (!compUser.value?.captain) return null
  return {
    id: compUser.value.captain.id,
    name: currentUser.value?.name || '',
    team: compUser.value.captain.team,
    budget: compUser.value.captain.budget,
    status: compUser.value.captain.status,
    mmr: currentUser.value?.mmr || 0,
  }
})

const currentCompetition = computed(() =>
  competitions.value.find(c => c.id === currentCompetitionId.value) || null
)

const availablePlayers = computed(() =>
  players.value.filter(p => !p.drafted && !p.is_captain)
)

const roleCounts = computed(() => {
  const counts = { Carry: 0, Mid: 0, Offlane: 0, Pos4: 0, Pos5: 0 }
  players.value.forEach(p => {
    if (p.is_captain) return
    p.roles.forEach(r => {
      if (r in counts) counts[r as keyof typeof counts]++
    })
  })
  return counts
})

const onlineCaptainIds = ref<number[]>([])
const readyCaptainIds = ref<number[]>([])

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
      if (data.settings) Object.assign(settings, data.settings)
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

  async function restoreAuth() {
    const token = localStorage.getItem('draft_auth_token')
    if (!token) {
      authReadyResolve()
      return
    }
    try {
      const user = await api.getMe()
      currentUser.value = user
    } catch {
      localStorage.removeItem('draft_auth_token')
      currentUser.value = null
    }
    authReadyResolve()
  }

  function setAuthToken(token: string) {
    localStorage.setItem('draft_auth_token', token)
    socketInitialized = false
    reconnectSocket()
    initSocket()
  }

  async function loginWithAuthToken(token: string) {
    setAuthToken(token)
    await restoreAuth()
    authReadyResolve()
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
    compUser.value = null
    socketInitialized = false
    reconnectSocket()
    initSocket()
  }

  // ─── Competition Management ────────────────────────────

  async function fetchCompetitions() {
    competitions.value = await api.getCompetitions()
  }

  async function joinCompetition(compId: number) {
    currentCompetitionId.value = compId
    // Ensure socket handlers are registered before emitting
    initSocket()
    const socket = getSocket()
    socket.emit('competition:join', { competitionId: compId })
    // Wait for auth to be ready, then fetch competition-specific user data
    await authReady
    if (currentUser.value) {
      try {
        compUser.value = await api.getCompMe(compId)
      } catch {
        compUser.value = null
      }
    }
  }

  async function fetchCompData() {
    const compId = currentCompetitionId.value
    if (!compId) return
    loading.value = true
    try {
      const [comp, caps, plrs] = await Promise.all([
        api.getCompetition(compId),
        api.getCompCaptains(compId),
        api.getCompPlayers(compId),
      ])
      Object.assign(settings, comp.settings)
      captains.value = caps
      players.value = plrs
    } finally {
      loading.value = false
    }
  }

  async function saveSettings() {
    const compId = currentCompetitionId.value
    if (!compId) return
    await api.updateCompetition(compId, { settings: { ...settings } })
  }

  async function fetchCaptains() {
    const compId = currentCompetitionId.value
    if (!compId) return
    captains.value = await api.getCompCaptains(compId)
  }

  async function fetchPlayers() {
    const compId = currentCompetitionId.value
    if (!compId) return
    players.value = await api.getCompPlayers(compId)
  }

  async function promoteToCaptain(playerId: number, team: string) {
    const compId = currentCompetitionId.value
    if (!compId) return
    await api.promoteToCaptain(compId, { playerId, team })
  }

  async function updateCaptain(id: number, data: Record<string, any>) {
    const compId = currentCompetitionId.value
    if (!compId) return
    await api.updateCaptain(compId, id, data)
  }

  async function demoteCaptain(id: number) {
    const compId = currentCompetitionId.value
    if (!compId) return
    await api.demoteCaptain(compId, id)
  }

  async function registerForPool(data: { roles: string[]; mmr?: number; info?: string }) {
    const compId = currentCompetitionId.value
    if (!compId) return
    await api.registerForComp(compId, data)
    if (compUser.value) {
      compUser.value.in_pool = true
    } else {
      compUser.value = { in_pool: true, roles: data.roles, mmr: data.mmr || 0, info: data.info || '', captain: null }
    }
  }

  async function updatePlayer(id: number, data: Record<string, any>) {
    const compId = currentCompetitionId.value
    if (!compId) return
    await api.updateCompPlayer(compId, id, data)
  }

  async function deletePlayer(id: number) {
    const compId = currentCompetitionId.value
    if (!compId) return
    await api.deleteCompPlayer(compId, id)
  }

  async function fetchAll() {
    loading.value = true
    try {
      await fetchCompetitions()
      if (currentCompetitionId.value) {
        await fetchCompData()
      }
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
    compUser,
    currentCaptain,
    currentCompetition,
    currentCompetitionId,
    competitions,
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
    authReady,
    restoreAuth,
    loginWithAuthToken,
    claimAdmin,
    logout,
    setAuthToken,
    // Init
    initSocket,
    fetchAll,
    fetchCompetitions,
    joinCompetition,
    fetchCompData,
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
    // API passthrough
    getCompResults: (compId: number) => useApi().getCompResults(compId),
  }
}
