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
  rules_title?: string
  rules_content?: string
  competition_type?: string
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

export interface FantasyRoleScoring {
  kill: number; death: number; assist: number; lastHit: number; deny: number
  gpm: number; xpm: number; heroDamage: number; towerDamage: number; heroHealing: number
  obsPlaced: number; senPlaced: number; obsKilled: number; senKilled: number
  campsStacked: number; stuns: number; teamfight: number; towerKill: number
  roshanKill: number; firstBlood: number; runePickup: number
  tripleKill: number; ultraKill: number; rampage: number; courierKill: number
}

export interface FantasyScoring {
  carry: FantasyRoleScoring
  mid: FantasyRoleScoring
  offlane: FantasyRoleScoring
  pos4: FantasyRoleScoring
  pos5: FantasyRoleScoring
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
  biddingType: string
  blindTopBidders: number
  blindBidTimer: number
  autoFinish: boolean
  fantasyEnabled: boolean
  fantasyScoring: FantasyScoring
  fantasyRepeatPenalty: number
  lobbyGameMode: number
  lobbyServerRegion: number
  lobbyAutoAssignTeams: boolean
  lobbyLeagueId: number
  lobbyDotaTvDelay: number
}

export interface RevealedBid {
  captainId: number
  captainName: string
  amount: number
  qualified: boolean
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
  blindPhase: boolean
  blindBidCount: number
  topBidderIds: number[]
  revealedBids: RevealedBid[] | null
}

export interface CurrentUser {
  id: number
  name: string
  display_name: string | null
  steam_name: string
  steam_id: string
  avatar_url: string
  is_admin: boolean
  permissions: string[]
  roles: string[]
  mmr: number
  mmr_verified_at: string | null
  info: string
  total_xp: number
  twitch_username: string | null
  discord_username: string | null
  is_banned: boolean
  banned_at: string | null
  banned_by_name: string | null
  banned_reason: string | null
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
  biddingType: 'default',
  blindTopBidders: 3,
  blindBidTimer: 30,
  autoFinish: true,
  fantasyEnabled: false,
  fantasyScoring: {} as any,
  fantasyRepeatPenalty: 0.15,
  lobbyGameMode: 2,
  lobbyServerRegion: 3,
  lobbyAutoAssignTeams: true,
  lobbyLeagueId: 0,
  lobbyDotaTvDelay: 1,
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
  blindPhase: false,
  blindBidCount: 0,
  topBidderIds: [],
  revealedBids: null,
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
const myBlindBid = ref<number | null>(null)

// Derived state
const isAdmin = computed(() => !!currentUser.value?.is_admin)

function hasPerm(permission: string): boolean {
  if (!currentUser.value) return false
  if (currentUser.value.is_admin) return true
  return currentUser.value.permissions?.includes(permission) ?? false
}

const canAccessAdmin = computed(() =>
  isAdmin.value || (currentUser.value?.permissions?.length ?? 0) > 0
)
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

const tournamentData = ref<{ tournament_state: any; matches: any[]; rosters: Record<number, any[]> }>({ tournament_state: {}, matches: [], rosters: {} })
const fantasyData = ref<{ stages: any[]; myPicks: Record<number, Record<string, number>>; myRepeats: Record<number, number[]>; lockedPicks: Record<number, Record<string, boolean>>; repeatPenalty: number; enforceRoles: boolean }>({ stages: [], myPicks: {}, myRepeats: {}, lockedPicks: {}, repeatPenalty: 0, enforceRoles: false })

const onlineCaptainIds = ref<number[]>([])
const readyCaptainIds = ref<number[]>([])

let socketInitialized = false

export function useDraftStore() {
  const api = useApi()

  function initSocket() {
    if (socketInitialized) return
    socketInitialized = true

    const socket = getSocket()

    // Rejoin competition room on reconnect
    socket.on('connect', () => {
      if (currentCompetitionId.value) {
        socket.emit('competition:join', { competitionId: currentCompetitionId.value })
      }
    })

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
      if (data.status !== 'bidding' || !data.blindPhase) myBlindBid.value = null
      auction.blindPhase = !!data.blindPhase
      auction.blindBidCount = data.blindBidCount || 0
      auction.topBidderIds = data.topBidderIds || []
      auction.revealedBids = data.revealedBids || null
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

    socket.on('auction:blind-bid-confirmed', (data: { amount: number }) => {
      myBlindBid.value = data.amount
    })

    socket.on('auction:error', (data: { message: string }) => {
      error.value = data.message
      setTimeout(() => { error.value = '' }, 4000)
    })

    socket.on('auction:finished', () => {
      auction.status = 'finished'
    })

    socket.on('tournament:updated', () => {
      if (currentCompetitionId.value) {
        api.getTournament(currentCompetitionId.value).then(data => {
          tournamentData.value = data
        }).catch(() => {})
      }
    })

    socket.on('fantasy:updated', () => {
      if (currentCompetitionId.value) {
        api.getFantasy(currentCompetitionId.value).then(data => {
          fantasyData.value = data
        }).catch(() => {})
      }
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
      // Ensure competition is in the list so currentCompetition resolves
      const idx = competitions.value.findIndex(c => c.id === comp.id)
      if (idx >= 0) competitions.value[idx] = comp
      else competitions.value.push(comp)
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

  async function fetchTournament() {
    const compId = currentCompetitionId.value
    if (!compId) return
    try {
      tournamentData.value = await api.getTournament(compId)
    } catch {
      tournamentData.value = { tournament_state: {}, matches: [], rosters: {} }
    }
  }

  async function fetchFantasy() {
    const compId = currentCompetitionId.value
    if (!compId) return
    try {
      fantasyData.value = await api.getFantasy(compId)
    } catch {
      fantasyData.value = { stages: [], myPicks: {}, myRepeats: {}, lockedPicks: {}, repeatPenalty: 0, enforceRoles: false }
    }
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

  // Ready up (auction)
  function setReady() { getSocket().emit('captain:ready') }
  function setUnready() { getSocket().emit('captain:unready') }

  // Match ready
  function matchReady(matchId: number, gameNumber: number) { getSocket().emit('match:ready', { matchId, gameNumber }) }
  function matchUnready(matchId: number, gameNumber: number) { getSocket().emit('match:unready', { matchId, gameNumber }) }
  function matchLaunchReady(matchId: number, gameNumber: number) { getSocket().emit('match:launchReady', { matchId, gameNumber }) }
  function matchLaunchUnready(matchId: number, gameNumber: number) { getSocket().emit('match:launchUnready', { matchId, gameNumber }) }
  function getMatchReadyState(matchId: number, gameNumber: number) { getSocket().emit('match:getReadyState', { matchId, gameNumber }) }

  // Auction actions via socket
  function startDraft() { getSocket().emit('auction:start') }
  function nominatePlayer(playerId: number, startingBid?: number) { getSocket().emit('auction:nominate', { playerId, startingBid }) }
  function placeBid(amount: number) { getSocket().emit('auction:bid', { amount }) }
  function submitBlindBid(amount: number) { getSocket().emit('auction:blind-bid', { amount }) }
  function pauseAuction() { getSocket().emit('auction:pause') }
  function resumeAuction() { getSocket().emit('auction:resume') }
  function endDraft() { getSocket().emit('auction:end') }
  function undoLast() { getSocket().emit('auction:undo') }
  function resetDraft() { getSocket().emit('auction:reset') }
  function recheckOrder() { getSocket().emit('auction:recheck-order') }
  function setNominator(captainId: number) { getSocket().emit('auction:set-nominator', { captainId }) }

  return {
    // State
    isAdmin,
    canAccessAdmin,
    hasPerm,
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
    myBlindBid,
    tournamentData,
    fantasyData,
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
    fetchTournament,
    fetchFantasy,
    // Ready
    setReady,
    setUnready,
    matchReady,
    matchUnready,
    matchLaunchReady,
    matchLaunchUnready,
    getMatchReadyState,
    // Auction
    startDraft,
    nominatePlayer,
    placeBid,
    submitBlindBid,
    pauseAuction,
    resumeAuction,
    endDraft,
    undoLast,
    resetDraft,
    recheckOrder,
    setNominator,
    // API passthrough
    getCompResults: (compId: number) => useApi().getCompResults(compId),
  }
}
