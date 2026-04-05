<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronUp, Check, Gamepad2, X, ArrowLeft, Trophy, ExternalLink, Clock, Calendar, CheckCircle, AlertCircle, RefreshCw, Pencil } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import { getSocket, getServerNow } from '@/composables/useSocket'
import { useDotaConstants } from '@/composables/useDotaConstants'
import UserName from '@/components/common/UserName.vue'
import TeamName from '@/components/common/TeamName.vue'
import PositionIcon from '@/components/common/PositionIcon.vue'
import { fmtDateTime } from '@/utils/format'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const api = useApi()
const store = useDraftStore()
const dota = useDotaConstants()

// Load Dota constants (heroes/items) on mount
dota.loadConstants()

const matchId = computed(() => Number(route.params.matchId))
const compId = store.currentCompetitionId

const match = computed(() => {
  const matches = store.tournamentData.value.matches || []
  return matches.find((m: any) => m.id === matchId.value) || null
})

const loading = ref(true)

// Ensure tournament data is loaded
watch(() => compId.value, async (id) => {
  if (!id) return
  loading.value = true
  await store.fetchTournament()
  loading.value = false
}, { immediate: true })

const bestOf = computed(() => match.value?.best_of || 3)
const allGames = computed(() => {
  if (!match.value) return []
  const existing = match.value.games || []
  const list = []
  for (let i = 1; i <= bestOf.value; i++) {
    const g = existing.find((e: any) => e.game_number === i)
    list.push({ game_number: i, winner_captain_id: g?.winner_captain_id || null, dotabuff_id: g?.dotabuff_id || '', has_stats: g?.has_stats || false, parsed: g?.parsed || false, start_time: g?.start_time || null, duration_seconds: g?.duration_seconds || null })
  }
  return list
})

const score1 = computed(() => !match.value ? 0 : (match.value.games || []).filter((g: any) => g.winner_captain_id === match.value.team1_captain_id).length)
const score2 = computed(() => !match.value ? 0 : (match.value.games || []).filter((g: any) => g.winner_captain_id === match.value.team2_captain_id).length)

const expandedGame = ref<number | null>(null)
const gameStats = ref<Record<number, any[]>>({})
const gamePicksBans = ref<Record<number, any[]>>({})
const loadingStats = ref<Record<number, boolean>>({})

// Match ready state
const matchReadyState = ref<Record<number, number[]>>({})
const lobbyStatuses = ref<Record<number, any>>({})
const noBotAvailable = ref<Record<number, boolean>>({})
const lobbyCreateError = ref<Record<number, string | null>>({})

// Lobby countdown timer
const lobbyTimeoutMs = computed(() => {
  return ((store.settings as any)?.lobbyTimeoutMinutes || 10) * 60 * 1000
})
const now = ref(getServerNow())
let tickInterval: ReturnType<typeof setInterval> | null = null

function getLobbyTimeLeft(gameNumber: number): number | null {
  const lobby = lobbyStatuses.value[gameNumber]
  if (!lobby || !lobby.created_at) return null
  if (!['waiting', 'creating'].includes(lobby.status)) return null
  // Ensure UTC parsing: pg TIMESTAMP may lack 'Z' suffix
  const createdStr = String(lobby.created_at)
  const created = new Date(createdStr.endsWith('Z') ? createdStr : createdStr + 'Z').getTime()
  const remaining = (created + lobbyTimeoutMs) - Date.now()
  return Math.max(0, remaining)
}

function formatCountdown(ms: number): string {
  const totalSec = Math.ceil(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${sec.toString().padStart(2, '0')}`
}

const canManageMatch = computed(() => canManageMatch || store.hasPerm('manage_competitions') || store.hasPerm('manage_own_competitions'))

const myCaptainId = computed(() => store.currentCaptain.value?.id || null)
const isCaptainInMatch = computed(() => {
  if (!myCaptainId.value || !match.value) return false
  return match.value.team1_captain_id === myCaptainId.value || match.value.team2_captain_id === myCaptainId.value
})
const isTeamMember = computed(() => {
  if (isCaptainInMatch.value) return true
  if (!match.value || !store.currentUser.value) return false
  const myId = store.currentUser.value.id
  const players = (store.players.value || []) as any[]
  const me = players.find((p: any) => p.id === myId)
  if (!me || !me.drafted_by) return false
  return me.drafted_by === match.value.team1_captain_id || me.drafted_by === match.value.team2_captain_id
})
const bothTeamsAssigned = computed(() => !!match.value?.team1_captain_id && !!match.value?.team2_captain_id)

const nextGameNumber = computed(() => {
  for (const g of allGames.value) {
    if (!g.dotabuff_id) return g.game_number
  }
  return null
})

function isReady(gameNumber: number) {
  return myCaptainId.value && (matchReadyState.value[gameNumber] || []).includes(myCaptainId.value)
}

function bothCaptainsReady(gameNumber: number) {
  if (!match.value) return false
  const ids = matchReadyState.value[gameNumber] || []
  return ids.includes(match.value.team1_captain_id) && ids.includes(match.value.team2_captain_id)
}

function toggleReady(gameNumber: number) {
  if (!match.value) return
  if (isReady(gameNumber)) {
    store.matchUnready(match.value.id, gameNumber)
  } else {
    store.matchReady(match.value.id, gameNumber)
  }
}

// Launch ready (phase 2)
const launchReadyState = ref<Record<number, number[]>>({})

function isLaunchReady(gameNumber: number) {
  return myCaptainId.value && (launchReadyState.value[gameNumber] || []).includes(myCaptainId.value)
}

function allPlayersJoined(gameNumber: number) {
  if (!match.value) return false
  const lobby = lobbyStatuses.value[gameNumber]
  if (!lobby) return false
  const expected = (lobby.players_expected || []).length
  const joined = (lobby.players_joined || []).length
  if (expected === 0 || joined < expected) return false
  const teamIds = lobbyTeamIds.value[gameNumber]
  if (!teamIds || !teamIds.radiant || !teamIds.dire) return false
  if (match.value.team1_dota_id && teamIds.radiant !== match.value.team1_dota_id) return false
  if (match.value.team2_dota_id && teamIds.dire !== match.value.team2_dota_id) return false
  return true
}

function getPlayerStatuses(gameNumber: number) {
  const lobby = lobbyStatuses.value[gameNumber]
  if (!lobby) return []
  const expected = lobby.players_expected || []
  const joined = lobby.players_joined || []
  return expected.map((p: any) => {
    const j = joined.find((j: any) => j.steamId === p.steam_id || j.SteamID === p.steam_id)
    return {
      name: p.name,
      steamId: p.steam_id,
      expectedTeam: p.team,
      joined: !!j,
      actualTeam: j?.team || j?.Team || null,
      correctTeam: j ? (j.team || j.Team) === p.team : false,
    }
  })
}

function getTeamPlayerStatuses(gameNumber: number, team: 'radiant' | 'dire') {
  return getPlayerStatuses(gameNumber).filter(p => p.expectedTeam === team)
}

function getLobbyTeamName(gameNumber: number, side: 'radiant' | 'dire'): string {
  const teamIds = lobbyTeamIds.value[gameNumber]
  if (!match.value) return ''
  // Figure out which draft team maps to this side
  const radiantId = teamIds?.radiant || 0
  const direId = teamIds?.dire || 0
  if (side === 'radiant') {
    if (match.value.team1_dota_id && radiantId === match.value.team1_dota_id) return match.value.team1_name || ''
    if (match.value.team2_dota_id && radiantId === match.value.team2_dota_id) return match.value.team2_name || ''
    // Fallback: use team name from lobby team IDs
    return teamIds?.radiantName || ''
  } else {
    if (match.value.team1_dota_id && direId === match.value.team1_dota_id) return match.value.team1_name || ''
    if (match.value.team2_dota_id && direId === match.value.team2_dota_id) return match.value.team2_name || ''
    return teamIds?.direName || ''
  }
}

function toggleLaunchReady(gameNumber: number) {
  if (!match.value) return
  if (isLaunchReady(gameNumber)) {
    store.matchLaunchUnready(match.value.id, gameNumber)
  } else {
    store.matchLaunchReady(match.value.id, gameNumber)
  }
}

const lobbyTeamIds = ref<Record<number, { radiant: number; dire: number; radiantName: string; direName: string }>>({})

function onLobbyTeamIds(data: any) {
  if (Number(data.matchId) !== matchId.value) return
  lobbyTeamIds.value = { ...lobbyTeamIds.value, [data.gameNumber]: {
    radiant: data.radiantTeamId || 0,
    dire: data.direTeamId || 0,
    radiantName: data.radiantTeamName || '',
    direName: data.direTeamName || '',
  } }
}

function onLaunchReadyState(data: any) {
  if (data.matchId !== matchId.value) return
  launchReadyState.value[data.gameNumber] = data.readyCaptainIds || []
}

function onReadyState(data: any) {
  if (data.matchId !== matchId.value) return
  matchReadyState.value[data.gameNumber] = data.readyCaptainIds || []
  noBotAvailable.value = { ...noBotAvailable.value, [data.gameNumber]: !!data.noBotAvailable }
  if (data.lobbyCreateError) {
    lobbyCreateError.value = { ...lobbyCreateError.value, [data.gameNumber]: data.lobbyCreateError }
  } else if (data.lobbyCreated || !data.noBotAvailable) {
    lobbyCreateError.value = { ...lobbyCreateError.value, [data.gameNumber]: null }
  }
  if (data.lobbyCreated) {
    fetchLobbyStatus(data.gameNumber)
  }
}

function onLobbyStatusUpdate(data: any) {
  if (Number(data.matchId) !== matchId.value) return
  if (!data.status) {
    const copy = { ...lobbyStatuses.value }
    delete copy[data.gameNumber]
    lobbyStatuses.value = copy
  } else {
    lobbyStatuses.value = {
      ...lobbyStatuses.value,
      [data.gameNumber]: {
        ...(lobbyStatuses.value[data.gameNumber] || {}),
        status: data.status,
        ...(data.playersJoined ? { players_joined: data.playersJoined } : {}),
        ...(data.errorMessage ? { error_message: data.errorMessage } : {}),
      },
    }
    if (data.status !== 'waiting') {
      launchReadyState.value = { ...launchReadyState.value, [data.gameNumber]: [] }
    }
  }
}

async function fetchLobbyStatus(gameNumber: number) {
  const cId = compId.value
  if (!cId) return
  try {
    const data = await api.getLobbyStatus(cId, matchId.value, gameNumber)
    if (data.lobby) {
      lobbyStatuses.value[gameNumber] = data.lobby
      // Restore team IDs from persisted data on page refresh
      if (data.lobby.team_ids && !lobbyTeamIds.value[gameNumber]) {
        const t = data.lobby.team_ids
        lobbyTeamIds.value = { ...lobbyTeamIds.value, [gameNumber]: {
          radiant: t.radiant || 0,
          dire: t.dire || 0,
          radiantName: t.radiantName || '',
          direName: t.direName || '',
        }}
      }
    }
  } catch {}
}

// Track previous match status to detect transitions
const prevMatchStatus = ref<string | null>(null)
const matchJustCompleted = ref(false)

function onTournamentUpdated() {
  // Tournament data is re-fetched by the store globally.
  // Re-fetch lobby statuses for all games since game states may have changed.
  for (const g of allGames.value) {
    fetchLobbyStatus(g.game_number)
    store.getMatchReadyState(matchId.value, g.game_number)
  }
}

const sock = getSocket()
onMounted(() => {
  sock.emit('match:joinRoom', { matchId: matchId.value })
  sock.on('match:readyState', onReadyState)
  sock.on('match:launchReadyState', onLaunchReadyState)
  sock.on('lobby:statusUpdate', onLobbyStatusUpdate)
  sock.on('lobby:teamIds', onLobbyTeamIds)
  sock.on('tournament:updated', onTournamentUpdated)
  tickInterval = setInterval(() => { now.value = getServerNow() }, 1000)
})

// Once match data is available, fetch ready states and lobby statuses
watch(match, (m, oldM) => {
  if (!m) return
  // Auto-expand first game with stats
  const games = (m.games || []).filter((g: any) => g.has_stats)
  if (games.length > 0 && expandedGame.value === null) toggleStats(games[0].game_number)

  // Fetch team rosters once
  if (!oldM && m) { fetchTeamRosters(); fetchStandins() }

  // Detect status transition to completed
  const oldStatus = oldM?.status || prevMatchStatus.value
  if (m.status === 'completed' && oldStatus && oldStatus !== 'completed') {
    matchJustCompleted.value = true
  }
  prevMatchStatus.value = m.status

  for (const g of allGames.value) {
    store.getMatchReadyState(m.id, g.game_number)
    fetchLobbyStatus(g.game_number)
    if (g.has_stats && !gameStats.value[g.game_number]) loadStats(g.game_number)
  }
}, { immediate: true })

onUnmounted(() => {
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null }
  sock.emit('match:leaveRoom', { matchId: matchId.value })
  sock.off('match:readyState', onReadyState)
  sock.off('match:launchReadyState', onLaunchReadyState)
  sock.off('lobby:statusUpdate', onLobbyStatusUpdate)
  sock.off('lobby:teamIds', onLobbyTeamIds)
  sock.off('tournament:updated', onTournamentUpdated)
})

async function toggleStats(gameNumber: number) {
  if (expandedGame.value === gameNumber) {
    expandedGame.value = null
    return
  }
  expandedGame.value = gameNumber
  if (!gameStats.value[gameNumber]) {
    await loadStats(gameNumber)
  }
}

async function loadStats(gameNumber: number) {
  const cId = compId.value
  if (!cId) return
  loadingStats.value[gameNumber] = true
  try {
    const data = await api.getMatchGameStats(cId, matchId.value, gameNumber)
    gameStats.value[gameNumber] = data.stats || []
    gamePicksBans.value[gameNumber] = data.picks_bans || []
  } catch {
    gameStats.value[gameNumber] = []
  } finally {
    loadingStats.value[gameNumber] = false
  }
}

function getMultiKillCount(multiKills: Record<string, number>, key: string): number {
  return multiKills?.[key] || 0
}

// Team rosters
const teamRosters = ref<{ team1: any[]; team2: any[] }>({ team1: [], team2: [] })

async function fetchTeamRosters() {
  const cId = compId.value
  if (!cId || !match.value) return
  try {
    const results = await api.getCompResults(cId)
    const t1 = results.find((r: any) => r.id === match.value.team1_captain_id)
    const t2 = results.find((r: any) => r.id === match.value.team2_captain_id)
    teamRosters.value = {
      team1: t1?.players || [],
      team2: t2?.players || [],
    }
  } catch {}
}

const matchWinnerName = computed(() => {
  if (!match.value || !match.value.winner_captain_id) return null
  if (match.value.winner_captain_id === match.value.team1_captain_id) return match.value.team1_name
  if (match.value.winner_captain_id === match.value.team2_captain_id) return match.value.team2_name
  return null
})

function winnerName(game: any) {
  if (!match.value) return null
  if (game.winner_captain_id === match.value.team1_captain_id) return match.value.team1_name
  if (game.winner_captain_id === match.value.team2_captain_id) return match.value.team2_name
  return null
}

function playerDisplayName(p: any): string {
  return p.profile_display_name || p.profile_name || p.player_name || String(p.account_id)
}

function getPlayerItems(p: any): number[] {
  return [p.item_0, p.item_1, p.item_2, p.item_3, p.item_4, p.item_5].filter((id: number) => id > 0)
}

function getPlayerBackpack(p: any): number[] {
  return [p.backpack_0, p.backpack_1, p.backpack_2].filter((id: number) => id > 0)
}

function isPartialStats(gameNumber: number): boolean {
  const game = allGames.value.find(g => g.game_number === gameNumber)
  if (!game || !game.has_stats) return false
  return !game.parsed
}

function getGameDuration(gameNumber: number): string {
  const stats = gameStats.value[gameNumber]
  if (!stats?.length) return ''
  const dur = stats[0]?.duration_seconds
  if (!dur) return ''
  const min = Math.floor(dur / 60)
  const sec = dur % 60
  return `${min}:${sec.toString().padStart(2, '0')}`
}

const refetchingGame = ref<Record<number, boolean>>({})

async function refetchStats(gameNumber: number) {
  const cId = compId.value
  if (!cId || !match.value) return
  refetchingGame.value[gameNumber] = true
  try {
    await api.refetchMatchGameStats(cId, match.value.id, gameNumber)
    await loadStats(gameNumber)
    await store.fetchTournament()
  } catch {} finally {
    refetchingGame.value[gameNumber] = false
  }
}

// Estimate position (1-5) from lane_role + net_worth within team
const playerPositions = computed(() => {
  const positions: Record<string, Record<number, number>> = {} // gameNumber -> accountId -> position
  for (const [gn, stats] of Object.entries(gameStats.value)) {
    if (!stats?.length) continue
    const gamePositions: Record<number, number> = {}
    for (const side of [true, false]) {
      const team = stats.filter((p: any) => p.is_radiant === side).sort((a: any, b: any) => b.net_worth - a.net_worth)
      if (team.length < 5) {
        // Fallback: just rank by NW
        team.forEach((p: any, i: number) => { gamePositions[p.account_id] = i + 1 })
        continue
      }
      const cores = team.slice(0, 3)
      const supports = team.slice(3)
      // Assign cores by lane: mid=2, safe=1, off=3
      const assigned = new Set<number>()
      const corePositions: Record<number, number> = {}
      // Mid first (most reliable)
      const midPlayer = cores.find((p: any) => p.lane_role === 2)
      if (midPlayer) { corePositions[midPlayer.account_id] = 2; assigned.add(midPlayer.account_id) }
      // Safe lane core = pos 1
      const safePlayer = cores.find((p: any) => p.lane_role === 1 && !assigned.has(p.account_id))
      if (safePlayer) { corePositions[safePlayer.account_id] = 1; assigned.add(safePlayer.account_id) }
      // Off lane core = pos 3
      const offPlayer = cores.find((p: any) => p.lane_role === 3 && !assigned.has(p.account_id))
      if (offPlayer) { corePositions[offPlayer.account_id] = 3; assigned.add(offPlayer.account_id) }
      // Fill remaining cores by NW rank
      const unassigned = [1, 2, 3].filter(pos => !Object.values(corePositions).includes(pos))
      let ui = 0
      for (const p of cores) {
        if (!assigned.has(p.account_id)) {
          corePositions[p.account_id] = unassigned[ui++]
          assigned.add(p.account_id)
        }
      }
      for (const [accId, pos] of Object.entries(corePositions)) gamePositions[Number(accId)] = pos
      // Supports: higher NW = pos 4, lower NW = pos 5
      gamePositions[supports[0].account_id] = 4
      gamePositions[supports[1].account_id] = 5
    }
    positions[gn] = gamePositions
  }
  return positions
})

function sortedTeamStats(gameNumber: number, isRadiant: boolean) {
  const stats = gameStats.value[gameNumber]?.filter((s: any) => s.is_radiant === isRadiant) || []
  const positions = playerPositions.value[gameNumber]
  if (!positions) return stats
  return [...stats].sort((a: any, b: any) => (positions[a.account_id] || 9) - (positions[b.account_id] || 9))
}

function teamTotalKills(gameNumber: number, isRadiant: boolean): number {
  return (gameStats.value[gameNumber] || []).filter((s: any) => s.is_radiant === isRadiant).reduce((sum: number, p: any) => sum + (p.kills || 0), 0)
}

function teamTotalNW(gameNumber: number, isRadiant: boolean): string {
  const total = (gameStats.value[gameNumber] || []).filter((s: any) => s.is_radiant === isRadiant).reduce((sum: number, p: any) => sum + (p.net_worth || 0), 0)
  return (total / 1000).toFixed(1) + 'k'
}

function sideTeamName(gameNumber: number, isRadiant: boolean): string {
  const stats = gameStats.value[gameNumber]
  if (!stats?.length || !match.value) return isRadiant ? 'Radiant' : 'Dire'
  // Match players from team rosters to stats by profile_id
  const sidePlayers = stats.filter((s: any) => s.is_radiant === isRadiant)
  const t1Players = new Set((teamRosters.value.team1 || []).map((p: any) => p.id))
  const t2Players = new Set((teamRosters.value.team2 || []).map((p: any) => p.id))
  let t1Count = 0, t2Count = 0
  for (const p of sidePlayers) {
    if (p.profile_id && t1Players.has(p.profile_id)) t1Count++
    if (p.profile_id && t2Players.has(p.profile_id)) t2Count++
  }
  if (t1Count > t2Count) return match.value.team1_name || 'Radiant'
  if (t2Count > t1Count) return match.value.team2_name || 'Dire'
  return isRadiant ? 'Radiant' : 'Dire'
}

function teamWon(gameNumber: number, isRadiant: boolean): boolean {
  return !!(gameStats.value[gameNumber] || []).find((s: any) => s.is_radiant === isRadiant && s.win)
}

// Group draft into ban/pick phases
function getDraftPhases(gameNumber: number) {
  const pbs = (gamePicksBans.value[gameNumber] || []).slice().sort((a: any, b: any) => a.order - b.order)
  if (!pbs.length) return []
  const phases: { type: string; label: string; items: any[] }[] = []
  let currentType: string | null = null
  let count = { ban: 0, pick: 0 }
  for (const pb of pbs) {
    const type = pb.is_pick ? 'pick' : 'ban'
    if (type !== currentType) {
      currentType = type
      count[type]++
      phases.push({ type, label: `${type === 'ban' ? 'Ban' : 'Pick'} ${count[type]}`, items: [] })
    }
    phases[phases.length - 1].items.push(pb)
  }
  return phases
}

// Per-game penalty settings (local state, sent when lobby is created)
const gamePenalties = reactive<Record<number, { radiant: number; dire: number }>>({})

function getGamePenalty(gameNumber: number, side: 'radiant' | 'dire'): number {
  if (gamePenalties[gameNumber]) return gamePenalties[gameNumber][side]
  return side === 'radiant' ? (match.value?.penalty_radiant ?? 0) : (match.value?.penalty_dire ?? 0)
}

function setGamePenalty(gameNumber: number, side: 'radiant' | 'dire', value: number) {
  if (!gamePenalties[gameNumber]) gamePenalties[gameNumber] = { radiant: 0, dire: 0 }
  gamePenalties[gameNumber][side] = value
  // Also persist to match for defaults
  const cId = compId.value
  if (cId) {
    api.updateMatchPenalties(cId, matchId.value, {
      penalty_radiant: side === 'radiant' ? (value || null) : (match.value?.penalty_radiant ?? null),
      penalty_dire: side === 'dire' ? (value || null) : (match.value?.penalty_dire ?? null),
    }).catch(() => {})
  }
}

async function updateGameMatchId(gameNumber: number, dotabuffId: string) {
  const cId = compId.value
  if (!cId || !match.value) return
  await api.updateMatchScore(cId, matchId.value, {
    games: [{ game_number: gameNumber, dotabuff_id: dotabuffId || null }],
  })
  await store.fetchTournament()
}

// Admin panel toggle
const showAdminPanel = ref(false)

// Standins
const standins = ref<any[]>([])
const standinSearch = ref('')
const standinResults = ref<any[]>([])
const addingStandin = ref<{ team: 'team1' | 'team2'; originalPlayerId: number; captainId: number } | null>(null)

async function fetchStandins() {
  const cId = compId.value
  if (!cId || !matchId.value) return
  try { standins.value = await api.getMatchStandins(cId, matchId.value) } catch { standins.value = [] }
}

async function searchStandinPlayer(q: string) {
  if (!q || q.length < 2) { standinResults.value = []; return }
  try {
    const all = await api.getUsers()
    standinResults.value = all.filter((p: any) =>
      p.steam_id && (
        (p.name || '').toLowerCase().includes(q.toLowerCase()) ||
        (p.display_name || '').toLowerCase().includes(q.toLowerCase())
      )
    ).slice(0, 10)
  } catch { standinResults.value = [] }
}

async function addStandin(standinPlayerId: number) {
  const cId = compId.value
  if (!cId || !addingStandin.value) return
  await api.addMatchStandin(cId, matchId.value, {
    original_player_id: addingStandin.value.originalPlayerId,
    standin_player_id: standinPlayerId,
    captain_id: addingStandin.value.captainId,
  })
  addingStandin.value = null
  standinSearch.value = ''
  standinResults.value = []
  await fetchStandins()
}

async function removeStandin(id: number) {
  const cId = compId.value
  if (!cId) return
  await api.removeMatchStandin(cId, matchId.value, id)
  await fetchStandins()
}

function goBack() {
  const cId = compId.value
  if (cId) {
    router.push({ name: 'comp-tournament', params: { compId: cId } })
  } else {
    router.back()
  }
}
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-0 max-w-[1200px] mx-auto w-full">
    <!-- Back button -->
    <button class="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4 self-start" @click="goBack">
      <ArrowLeft class="w-4 h-4" />
      {{ t('backToTournament') }}
    </button>

    <!-- Loading -->
    <div v-if="loading" class="text-center text-muted-foreground py-12">{{ t('loading') }}</div>

    <!-- Match not found -->
    <div v-else-if="!match" class="card px-6 py-12 text-center">
      <Gamepad2 class="w-12 h-12 text-muted-foreground/40 mx-auto mb-3" />
      <p class="text-muted-foreground">{{ t('matchNotFound') }}</p>
    </div>

    <template v-else>
      <!-- Match Overview Card -->
      <div class="card px-6 py-5 flex flex-col gap-3 mb-6">
        <div class="flex items-center gap-2 mb-1">
          <Gamepad2 class="w-5 h-5 text-primary" />
          <span class="text-lg font-semibold text-foreground">{{ t('matchRoom') }}</span>
          <button v-if="canManageMatch && match.status !== 'completed'" class="ml-auto p-1.5 rounded-md hover:bg-accent transition-colors" :class="showAdminPanel ? 'bg-accent text-primary' : 'text-muted-foreground'" @click="showAdminPanel = !showAdminPanel" :title="'Edit match settings'">
            <Pencil class="w-4 h-4" />
          </button>
        </div>
        <div class="flex items-center gap-4">
          <div class="flex-1 flex items-center justify-end min-w-0">
            <router-link v-if="match.team1_captain_id" :to="{ name: 'team-profile', params: { id: match.team1_captain_id } }" class="text-base font-semibold text-foreground hover:text-primary transition-colors truncate">
              {{ match.team1_name || t('tbd') }}
            </router-link>
            <span v-else class="text-base font-semibold text-muted-foreground">{{ t('tbd') }}</span>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <div class="w-10 h-10 rounded-lg bg-accent overflow-hidden shrink-0">
              <img v-if="match.team1_banner || match.team1_avatar" :src="match.team1_banner || match.team1_avatar" class="w-full h-full object-cover" />
            </div>
            <span class="text-3xl font-bold font-mono text-foreground">{{ score1 }} : {{ score2 }}</span>
            <div class="w-10 h-10 rounded-lg bg-accent overflow-hidden shrink-0">
              <img v-if="match.team2_banner || match.team2_avatar" :src="match.team2_banner || match.team2_avatar" class="w-full h-full object-cover" />
            </div>
          </div>
          <div class="flex-1 flex items-center justify-start min-w-0">
            <router-link v-if="match.team2_captain_id" :to="{ name: 'team-profile', params: { id: match.team2_captain_id } }" class="text-base font-semibold text-foreground hover:text-primary transition-colors truncate">
              {{ match.team2_name || t('tbd') }}
            </router-link>
            <span v-else class="text-base font-semibold text-muted-foreground">{{ t('tbd') }}</span>
          </div>
        </div>
        <div class="flex items-center gap-4">
          <div class="flex-1"></div>
          <div class="flex items-center gap-2 shrink-0">
            <span class="badge-info">{{ match.status === 'completed' ? t('matchCompleted') : match.status === 'live' ? t('matchLive') : t('matchPending') }}</span>
            <span class="text-xs text-text-tertiary">Best of {{ bestOf }}</span>
          </div>
          <div class="flex-1"></div>
        </div>
      </div>

      <!-- Team Rosters -->
      <div v-if="teamRosters.team1.length || teamRosters.team2.length" class="grid grid-cols-2 gap-4 mb-6">
        <template v-for="(teamKey, idx) in ['team1', 'team2'] as const" :key="teamKey">
          <div class="card px-4 py-3 flex flex-col gap-2">
            <!-- Team name + penalty -->
            <div class="flex items-center gap-2 mb-1">
              <TeamName v-if="teamKey === 'team1' && match.team1_captain_id" :id="match.team1_captain_id" :name="match.team1_name || t('tbd')" :banner-url="match.team1_banner" :avatar-url="match.team1_avatar" />
              <TeamName v-else-if="teamKey === 'team2' && match.team2_captain_id" :id="match.team2_captain_id" :name="match.team2_name || t('tbd')" :banner-url="match.team2_banner" :avatar-url="match.team2_avatar" />
              <span v-else class="text-sm font-semibold text-muted-foreground truncate">{{ t('tbd') }}</span>
              <!-- Penalty: dropdown in edit mode, red text otherwise -->
              <select
                v-if="showAdminPanel"
                class="input-field text-[10px] py-0.5 px-1.5 w-auto ml-auto"
                :value="(teamKey === 'team1' ? match.penalty_radiant : match.penalty_dire) ?? 0"
                @change="api.updateMatchPenalties(compId!, matchId, {
                  penalty_radiant: teamKey === 'team1' ? (Number(($event.target as HTMLSelectElement).value) || null) : (match.penalty_radiant ?? null),
                  penalty_dire: teamKey === 'team2' ? (Number(($event.target as HTMLSelectElement).value) || null) : (match.penalty_dire ?? null),
                })"
              >
                <option :value="0">{{ t('penaltyNone') }}</option>
                <option :value="1">{{ t('penaltyLevel', { n: 1 }) }}</option>
                <option :value="2">{{ t('penaltyLevel', { n: 2 }) }}</option>
                <option :value="3">{{ t('penaltyLevel', { n: 3 }) }}</option>
              </select>
              <span v-else-if="(teamKey === 'team1' ? match.penalty_radiant : match.penalty_dire)" class="text-[10px] font-semibold text-destructive">
                Penalty {{ t('penaltyLevel', { n: teamKey === 'team1' ? match.penalty_radiant : match.penalty_dire }) }}
              </span>
            </div>
            <!-- Players -->
            <div v-for="p in teamRosters[teamKey]" :key="p.id" class="flex items-center gap-2 py-0.5">
              <!-- Check if this player has a standin -->
              <template v-if="standins.find((s: any) => s.original_player_id === p.id)">
                <div class="flex items-center gap-1.5 min-w-0 line-through opacity-50">
                  <UserName :id="p.id" :name="p.name" :avatar-url="p.avatar_url" size="sm" no-link />
                </div>
                <span class="text-muted-foreground text-xs">→</span>
                <UserName :id="standins.find((s: any) => s.original_player_id === p.id)!.standin_player_id" :name="standins.find((s: any) => s.original_player_id === p.id)!.standin_display_name" :avatar-url="standins.find((s: any) => s.original_player_id === p.id)!.standin_avatar" size="sm" />
                <button v-if="showAdminPanel" class="ml-auto text-destructive hover:text-destructive/80" @click="removeStandin(standins.find((s: any) => s.original_player_id === p.id)!.id)">
                  <X class="w-3 h-3" />
                </button>
              </template>
              <template v-else>
                <UserName :id="p.id" :name="p.name" :avatar-url="p.avatar_url" size="sm" />
                <span v-if="p.is_captain" class="text-[10px] font-medium text-primary bg-primary/10 px-1.5 py-0.5 rounded">C</span>
                <span v-if="p.mmr && !showAdminPanel" class="text-[10px] text-muted-foreground ml-auto">{{ p.mmr }}</span>
                <!-- Standin button (edit mode) -->
                <button
                  v-if="showAdminPanel"
                  class="ml-auto text-[10px] text-muted-foreground hover:text-primary transition-colors px-1.5 py-0.5 rounded hover:bg-accent"
                  @click="addingStandin = { team: teamKey, originalPlayerId: p.id, captainId: teamKey === 'team1' ? match.team1_captain_id : match.team2_captain_id }"
                >standin</button>
              </template>
            </div>
            <!-- Standin search (inline when selecting for this team) -->
            <div v-if="showAdminPanel && addingStandin?.team === teamKey" class="flex flex-col gap-1.5 mt-1 pt-2 border-t border-border/30">
              <div class="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span>Replacing <strong class="text-foreground">{{ teamRosters[teamKey].find((p: any) => p.id === addingStandin!.originalPlayerId)?.name }}</strong></span>
                <button class="text-destructive hover:underline" @click="addingStandin = null; standinSearch = ''; standinResults = []">{{ t('cancel') }}</button>
              </div>
              <input
                type="text"
                class="input-field text-xs py-1"
                placeholder="Search player..."
                v-model="standinSearch"
                @input="searchStandinPlayer(standinSearch)"
              />
              <div v-if="standinResults.length" class="flex flex-col gap-0.5 max-h-32 overflow-y-auto">
                <button
                  v-for="sp in standinResults"
                  :key="sp.id"
                  class="flex items-center gap-2 px-2 py-1 rounded text-xs hover:bg-accent transition-colors text-left"
                  @click="addStandin(sp.id)"
                >
                  <img v-if="sp.avatar_url" :src="sp.avatar_url" class="w-4 h-4 rounded-full" />
                  <span class="font-medium text-foreground">{{ sp.display_name || sp.name }}</span>
                </button>
              </div>
            </div>
          </div>
        </template>
      </div>

      <!-- Match Completed Banner -->
      <div v-if="match.status === 'completed' && matchWinnerName" class="card px-6 py-5 mb-6 flex flex-col items-center gap-2 bg-green-500/5 border-green-500/20">
        <Trophy class="w-8 h-8 text-green-500" />
        <span class="text-lg font-bold text-foreground">{{ t('matchWinner', { team: matchWinnerName }) }}</span>
        <span class="text-sm text-muted-foreground">{{ score1 }} : {{ score2 }}</span>
      </div>

      <!-- Match Ready Section (captain interactions) -->
      <div v-if="isCaptainInMatch && bothTeamsAssigned && match.status !== 'completed'" class="flex flex-col gap-4 mb-6">
        <div v-for="g in allGames" :key="'ready-' + g.game_number">
          <template v-if="!g.dotabuff_id && g.game_number === nextGameNumber">
            <div class="card overflow-hidden">
              <!-- Game header -->
              <div class="flex items-center justify-between px-5 py-3.5 bg-accent/30 border-b border-border">
                <div class="flex items-center gap-2">
                  <Gamepad2 class="w-4 h-4 text-muted-foreground" />
                  <span class="text-sm font-semibold text-foreground">{{ t('game') }} {{ g.game_number }}</span>
                </div>
                <span v-if="lobbyStatuses[g.game_number]?.status === 'creating'" class="text-xs text-muted-foreground animate-pulse">{{ t('lobbyCreating') }}</span>
                <span v-else-if="lobbyStatuses[g.game_number]?.status === 'active'" class="text-xs font-medium text-green-500">{{ t('lobbyActive') }}</span>
                <span v-else-if="lobbyStatuses[g.game_number]?.status === 'launching'" class="text-xs font-medium text-amber-500">{{ t('lobbyLaunching') }}</span>
                <span v-else-if="lobbyStatuses[g.game_number]?.status === 'cointoss'" class="text-xs font-medium text-amber-500">{{ t('lobbyCoinToss') }}</span>
              </div>

              <!-- Phase 1: Ready check -->
              <div v-if="!lobbyStatuses[g.game_number] || ['cancelled', 'error', 'completed'].includes(lobbyStatuses[g.game_number]?.status)" class="p-5 flex flex-col items-center gap-4">
                <!-- Previous lobby error -->
                <div v-if="lobbyStatuses[g.game_number]?.status === 'error'" class="w-full rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-3 text-center">
                  <p class="text-sm font-medium text-red-500">{{ t('lobbyError') }}</p>
                  <p v-if="lobbyStatuses[g.game_number].error_message" class="text-xs text-red-400 mt-1">{{ lobbyStatuses[g.game_number].error_message }}</p>
                  <p class="text-xs text-muted-foreground mt-1">{{ t('lobbyErrorRetry') }}</p>
                </div>
                <p class="text-sm text-muted-foreground text-center">{{ t('matchReadyDesc') }}</p>
                <div class="flex items-center gap-4">
                  <div class="flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium"
                    :class="(matchReadyState[g.game_number] || []).includes(match.team1_captain_id) ? 'bg-green-500/15 text-green-500' : 'bg-accent text-muted-foreground'">
                    <Check v-if="(matchReadyState[g.game_number] || []).includes(match.team1_captain_id)" class="w-3.5 h-3.5" />
                    {{ match.team1_name || 'Team 1' }}
                  </div>
                  <span class="text-muted-foreground text-sm">{{ t('vs') }}</span>
                  <div class="flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium"
                    :class="(matchReadyState[g.game_number] || []).includes(match.team2_captain_id) ? 'bg-green-500/15 text-green-500' : 'bg-accent text-muted-foreground'">
                    <Check v-if="(matchReadyState[g.game_number] || []).includes(match.team2_captain_id)" class="w-3.5 h-3.5" />
                    {{ match.team2_name || 'Team 2' }}
                  </div>
                </div>
                <span v-if="noBotAvailable[g.game_number] && bothCaptainsReady(g.game_number)" class="text-sm text-amber-500">{{ t('noBotAvailable') }}</span>
                <span v-if="lobbyCreateError[g.game_number]" class="text-sm text-red-500">{{ lobbyCreateError[g.game_number] }}</span>
                <button
                  class="w-full max-w-sm px-5 py-3 rounded-lg text-sm font-medium transition-colors"
                  :class="isReady(g.game_number)
                    ? 'bg-green-500 text-white hover:bg-green-600'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90'"
                  @click="toggleReady(g.game_number)"
                >
                  <span class="flex items-center justify-center gap-2">
                    <Check v-if="isReady(g.game_number)" class="w-4 h-4" />
                    {{ isReady(g.game_number) ? t('matchReadyLabel') : t('matchReadyUp') }}
                  </span>
                </button>
              </div>

              <!-- Phase 2: Lobby active — waiting for players + launch -->
              <div v-else-if="lobbyStatuses[g.game_number]?.status === 'waiting'" class="flex flex-col">
                <!-- Lobby countdown timer -->
                <div v-if="getLobbyTimeLeft(g.game_number) != null" class="px-5 py-2.5 flex items-center justify-center gap-2 border-b border-border/30"
                  :class="getLobbyTimeLeft(g.game_number)! < 60000 ? 'bg-red-500/10' : 'bg-amber-500/5'">
                  <span class="text-xs text-muted-foreground">{{ t('lobbyExpiresIn') }}</span>
                  <span class="text-sm font-bold font-mono" :class="getLobbyTimeLeft(g.game_number)! < 60000 ? 'text-red-500' : 'text-amber-500'">
                    {{ formatCountdown(getLobbyTimeLeft(g.game_number)!) }}
                  </span>
                </div>
                <!-- Lobby name + password + player count -->
                <div class="px-5 py-3.5 flex flex-col gap-2 border-b border-border/30">
                  <div v-if="lobbyStatuses[g.game_number].game_name" class="flex items-center gap-2 text-sm">
                    <span class="text-muted-foreground">{{ t('lobbyName') }}:</span>
                    <span class="font-medium text-foreground">{{ lobbyStatuses[g.game_number].game_name }}</span>
                  </div>
                  <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2 text-sm">
                      <span class="text-muted-foreground">{{ t('lobbyPassword') }}:</span>
                      <code class="font-mono font-bold bg-accent px-2.5 py-1 rounded text-foreground text-base">{{ lobbyStatuses[g.game_number].password }}</code>
                    </div>
                    <span class="text-sm font-medium" :class="allPlayersJoined(g.game_number) ? 'text-green-500' : 'text-muted-foreground'">
                      {{ (lobbyStatuses[g.game_number].players_joined || []).length }}/{{ (lobbyStatuses[g.game_number].players_expected || []).length }} {{ t('players') }}
                    </span>
                  </div>
                </div>

                <!-- Player list grouped by team -->
                <div class="px-5 py-3 grid grid-cols-2 gap-x-6 border-b border-border/30">
                  <!-- Radiant -->
                  <div class="flex flex-col gap-1.5">
                    <div class="flex items-center gap-1.5 text-xs font-semibold text-green-500/80 pb-1 border-b border-border/20">
                      <span>Radiant</span>
                      <span v-if="getLobbyTeamName(g.game_number, 'radiant')" class="text-muted-foreground font-normal">— {{ getLobbyTeamName(g.game_number, 'radiant') }}</span>
                    </div>
                    <div v-for="p in getTeamPlayerStatuses(g.game_number, 'radiant')" :key="p.steamId" class="flex items-center gap-2 text-sm py-1">
                      <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" :class="p.joined ? (p.correctTeam ? 'bg-green-500' : 'bg-amber-500') : 'bg-red-500/60'"></span>
                      <span :class="p.joined ? 'text-foreground' : 'text-muted-foreground'" class="truncate">{{ p.name }}</span>
                      <span v-if="p.joined && !p.correctTeam" class="text-amber-500 text-[10px] ml-auto whitespace-nowrap">{{ t('wrongSide') }}</span>
                    </div>
                  </div>
                  <!-- Dire -->
                  <div class="flex flex-col gap-1.5">
                    <div class="flex items-center gap-1.5 text-xs font-semibold text-red-500/80 pb-1 border-b border-border/20">
                      <span>Dire</span>
                      <span v-if="getLobbyTeamName(g.game_number, 'dire')" class="text-muted-foreground font-normal">— {{ getLobbyTeamName(g.game_number, 'dire') }}</span>
                    </div>
                    <div v-for="p in getTeamPlayerStatuses(g.game_number, 'dire')" :key="p.steamId" class="flex items-center gap-2 text-sm py-1">
                      <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" :class="p.joined ? (p.correctTeam ? 'bg-green-500' : 'bg-amber-500') : 'bg-red-500/60'"></span>
                      <span :class="p.joined ? 'text-foreground' : 'text-muted-foreground'" class="truncate">{{ p.name }}</span>
                      <span v-if="p.joined && !p.correctTeam" class="text-amber-500 text-[10px] ml-auto whitespace-nowrap">{{ t('wrongSide') }}</span>
                    </div>
                  </div>
                </div>

                <!-- Team IDs -->
                <div class="px-5 py-3 flex items-center gap-6 border-b border-border/30 text-sm">
                  <div class="flex items-center gap-1.5">
                    <span class="text-muted-foreground">Radiant:</span>
                    <template v-if="lobbyTeamIds[g.game_number]?.radiant">
                      <span :class="match.team1_dota_id && lobbyTeamIds[g.game_number].radiant !== match.team1_dota_id ? 'text-red-500' : 'text-green-500'" class="font-medium">
                        {{ lobbyTeamIds[g.game_number].radiantName || lobbyTeamIds[g.game_number].radiant }}
                      </span>
                      <Check v-if="!match.team1_dota_id || lobbyTeamIds[g.game_number].radiant === match.team1_dota_id" class="w-3.5 h-3.5 text-green-500" />
                      <X v-else class="w-3.5 h-3.5 text-red-500" />
                    </template>
                    <span v-else class="text-red-500">{{ t('noTeamSet') }}</span>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <span class="text-muted-foreground">Dire:</span>
                    <template v-if="lobbyTeamIds[g.game_number]?.dire">
                      <span :class="match.team2_dota_id && lobbyTeamIds[g.game_number].dire !== match.team2_dota_id ? 'text-red-500' : 'text-green-500'" class="font-medium">
                        {{ lobbyTeamIds[g.game_number].direName || lobbyTeamIds[g.game_number].dire }}
                      </span>
                      <Check v-if="!match.team2_dota_id || lobbyTeamIds[g.game_number].dire === match.team2_dota_id" class="w-3.5 h-3.5 text-green-500" />
                      <X v-else class="w-3.5 h-3.5 text-red-500" />
                    </template>
                    <span v-else class="text-red-500">{{ t('noTeamSet') }}</span>
                  </div>
                </div>

                <!-- Launch ready + button -->
                <div class="p-5 flex flex-col items-center gap-4">
                  <div class="flex items-center gap-4">
                    <div class="flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium"
                      :class="(launchReadyState[g.game_number] || []).includes(match.team1_captain_id) ? 'bg-green-500/15 text-green-500' : 'bg-accent text-muted-foreground'">
                      <Check v-if="(launchReadyState[g.game_number] || []).includes(match.team1_captain_id)" class="w-3.5 h-3.5" />
                      {{ match.team1_name || 'T1' }}
                    </div>
                    <span class="text-muted-foreground text-sm">{{ t('vs') }}</span>
                    <div class="flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium"
                      :class="(launchReadyState[g.game_number] || []).includes(match.team2_captain_id) ? 'bg-green-500/15 text-green-500' : 'bg-accent text-muted-foreground'">
                      <Check v-if="(launchReadyState[g.game_number] || []).includes(match.team2_captain_id)" class="w-3.5 h-3.5" />
                      {{ match.team2_name || 'T2' }}
                    </div>
                  </div>
                  <button
                    class="w-full max-w-sm px-5 py-3 rounded-lg text-sm font-medium transition-colors"
                    :disabled="!allPlayersJoined(g.game_number)"
                    :class="!allPlayersJoined(g.game_number)
                      ? 'bg-accent text-muted-foreground cursor-not-allowed'
                      : isLaunchReady(g.game_number)
                        ? 'bg-green-500 text-white hover:bg-green-600'
                        : 'bg-primary text-primary-foreground hover:bg-primary/90'"
                    @click="toggleLaunchReady(g.game_number)"
                  >
                    <span class="flex items-center justify-center gap-2">
                      <Check v-if="isLaunchReady(g.game_number)" class="w-4 h-4" />
                      {{ isLaunchReady(g.game_number) ? t('matchReadyLabel') : t('matchLaunchReady') }}
                    </span>
                  </button>
                </div>
              </div>

              <!-- Phase 3: In progress -->
              <div v-else-if="['cointoss', 'launching', 'active'].includes(lobbyStatuses[g.game_number]?.status)" class="p-6 flex flex-col items-center gap-3">
                <div class="w-10 h-10 rounded-full border-2 border-primary border-t-transparent animate-spin"></div>
                <span class="text-base font-medium text-foreground">
                  {{ lobbyStatuses[g.game_number]?.status === 'cointoss' ? t('lobbyCoinToss') : lobbyStatuses[g.game_number]?.status === 'active' ? t('lobbyActive') : t('lobbyLaunching') }}
                </span>
              </div>
            </div>
          </template>
        </div>
      </div>

      <!-- Spectator view: show lobby status for non-captains (admins + team members) -->
      <div v-else-if="(canManageMatch || isTeamMember) && bothTeamsAssigned && match.status !== 'completed'" class="flex flex-col gap-4 mb-6">
        <div v-for="g in allGames" :key="'spec-' + g.game_number">
          <template v-if="!g.dotabuff_id && g.game_number === nextGameNumber">
            <div class="card overflow-hidden">
              <div class="flex items-center justify-between px-5 py-3.5 bg-accent/30 border-b border-border">
                <div class="flex items-center gap-2">
                  <Gamepad2 class="w-4 h-4 text-muted-foreground" />
                  <span class="text-sm font-semibold text-foreground">{{ t('game') }} {{ g.game_number }}</span>
                </div>
                <span v-if="lobbyStatuses[g.game_number]?.status === 'creating'" class="text-xs text-muted-foreground animate-pulse">{{ t('lobbyCreating') }}</span>
                <span v-else-if="lobbyStatuses[g.game_number]?.status === 'active'" class="text-xs font-medium text-green-500">{{ t('lobbyActive') }}</span>
                <span v-else-if="lobbyStatuses[g.game_number]?.status === 'launching'" class="text-xs font-medium text-amber-500">{{ t('lobbyLaunching') }}</span>
                <span v-else-if="lobbyStatuses[g.game_number]?.status === 'cointoss'" class="text-xs font-medium text-amber-500">{{ t('lobbyCoinToss') }}</span>
              </div>

              <div class="p-5 flex flex-col items-center gap-3">
                <!-- Previous lobby error -->
                <div v-if="lobbyStatuses[g.game_number]?.status === 'error'" class="w-full rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-3 text-center">
                  <p class="text-sm font-medium text-red-500">{{ t('lobbyError') }}</p>
                  <p v-if="lobbyStatuses[g.game_number].error_message" class="text-xs text-red-400 mt-1">{{ lobbyStatuses[g.game_number].error_message }}</p>
                  <p class="text-xs text-muted-foreground mt-1">{{ t('lobbyErrorRetry') }}</p>
                </div>
                <!-- Show ready states -->
                <div class="flex items-center gap-4">
                  <div class="flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium"
                    :class="(matchReadyState[g.game_number] || []).includes(match.team1_captain_id) ? 'bg-green-500/15 text-green-500' : 'bg-accent text-muted-foreground'">
                    <Check v-if="(matchReadyState[g.game_number] || []).includes(match.team1_captain_id)" class="w-3.5 h-3.5" />
                    {{ match.team1_name || 'Team 1' }}
                  </div>
                  <span class="text-muted-foreground text-sm">{{ t('vs') }}</span>
                  <div class="flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium"
                    :class="(matchReadyState[g.game_number] || []).includes(match.team2_captain_id) ? 'bg-green-500/15 text-green-500' : 'bg-accent text-muted-foreground'">
                    <Check v-if="(matchReadyState[g.game_number] || []).includes(match.team2_captain_id)" class="w-3.5 h-3.5" />
                    {{ match.team2_name || 'Team 2' }}
                  </div>
                </div>
                <p class="text-sm text-muted-foreground">{{ t('matchReadyDesc') }}</p>

                <span v-if="noBotAvailable[g.game_number] && bothCaptainsReady(g.game_number)" class="text-sm text-amber-500">{{ t('noBotAvailable') }}</span>
                <span v-if="lobbyCreateError[g.game_number]" class="text-sm text-red-500">{{ lobbyCreateError[g.game_number] }}</span>

                <!-- If lobby is waiting, show timer + player statuses -->
                <template v-if="lobbyStatuses[g.game_number]?.status === 'waiting'">
                  <!-- Countdown timer -->
                  <div v-if="getLobbyTimeLeft(g.game_number) != null" class="flex items-center justify-center gap-2 mt-1">
                    <span class="text-xs text-muted-foreground">{{ t('lobbyExpiresIn') }}</span>
                    <span class="text-sm font-bold font-mono" :class="getLobbyTimeLeft(g.game_number)! < 60000 ? 'text-red-500' : 'text-amber-500'">
                      {{ formatCountdown(getLobbyTimeLeft(g.game_number)!) }}
                    </span>
                  </div>
                  <div class="w-full border-t border-border/30 pt-3 mt-1">
                    <div v-if="isTeamMember && lobbyStatuses[g.game_number].game_name" class="flex items-center gap-2 text-sm mb-2">
                      <span class="text-muted-foreground">{{ t('lobbyName') }}:</span>
                      <span class="font-medium text-foreground">{{ lobbyStatuses[g.game_number].game_name }}</span>
                    </div>
                    <div class="flex items-center justify-between mb-2">
                      <div class="flex items-center gap-2 text-sm">
                        <span class="text-muted-foreground">{{ t('lobbyPassword') }}:</span>
                        <code v-if="isTeamMember" class="font-mono font-bold bg-accent px-2.5 py-1 rounded text-foreground text-base">{{ lobbyStatuses[g.game_number].password }}</code>
                      </div>
                      <span class="text-sm font-medium" :class="allPlayersJoined(g.game_number) ? 'text-green-500' : 'text-muted-foreground'">
                        {{ (lobbyStatuses[g.game_number].players_joined || []).length }}/{{ (lobbyStatuses[g.game_number].players_expected || []).length }} {{ t('players') }}
                      </span>
                    </div>
                    <div class="grid grid-cols-2 gap-x-6">
                      <!-- Radiant -->
                      <div class="flex flex-col gap-1">
                        <div class="flex items-center gap-1.5 text-xs font-semibold text-green-500/80 pb-1 border-b border-border/20">
                          <span>Radiant</span>
                          <span v-if="getLobbyTeamName(g.game_number, 'radiant')" class="text-muted-foreground font-normal">— {{ getLobbyTeamName(g.game_number, 'radiant') }}</span>
                        </div>
                        <div v-for="p in getTeamPlayerStatuses(g.game_number, 'radiant')" :key="p.steamId" class="flex items-center gap-2 text-sm py-0.5">
                          <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" :class="p.joined ? (p.correctTeam ? 'bg-green-500' : 'bg-amber-500') : 'bg-red-500/60'"></span>
                          <span :class="p.joined ? 'text-foreground' : 'text-muted-foreground'" class="truncate">{{ p.name }}</span>
                          <span v-if="p.joined && !p.correctTeam" class="text-amber-500 text-[10px] ml-auto whitespace-nowrap">{{ t('wrongSide') }}</span>
                        </div>
                      </div>
                      <!-- Dire -->
                      <div class="flex flex-col gap-1">
                        <div class="flex items-center gap-1.5 text-xs font-semibold text-red-500/80 pb-1 border-b border-border/20">
                          <span>Dire</span>
                          <span v-if="getLobbyTeamName(g.game_number, 'dire')" class="text-muted-foreground font-normal">— {{ getLobbyTeamName(g.game_number, 'dire') }}</span>
                        </div>
                        <div v-for="p in getTeamPlayerStatuses(g.game_number, 'dire')" :key="p.steamId" class="flex items-center gap-2 text-sm py-0.5">
                          <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" :class="p.joined ? (p.correctTeam ? 'bg-green-500' : 'bg-amber-500') : 'bg-red-500/60'"></span>
                          <span :class="p.joined ? 'text-foreground' : 'text-muted-foreground'" class="truncate">{{ p.name }}</span>
                          <span v-if="p.joined && !p.correctTeam" class="text-amber-500 text-[10px] ml-auto whitespace-nowrap">{{ t('wrongSide') }}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </template>

                <!-- In progress spinner -->
                <template v-if="['cointoss', 'launching', 'active'].includes(lobbyStatuses[g.game_number]?.status)">
                  <div class="w-10 h-10 rounded-full border-2 border-primary border-t-transparent animate-spin mt-2"></div>
                  <span class="text-base font-medium text-foreground">
                    {{ lobbyStatuses[g.game_number]?.status === 'cointoss' ? t('lobbyCoinToss') : lobbyStatuses[g.game_number]?.status === 'active' ? t('lobbyActive') : t('lobbyLaunching') }}
                  </span>
                </template>
              </div>
            </div>
          </template>
        </div>
      </div>

      <!-- Games with inline stats -->
      <div v-for="game in allGames" :key="game.game_number" class="card overflow-hidden mb-4">
        <!-- Game header -->
        <div class="flex items-center gap-2 px-5 py-3 border-b border-border/50 bg-accent/20">
          <Gamepad2 class="w-4 h-4 text-primary" />
          <span class="text-sm font-semibold text-foreground">{{ t('game') }} {{ game.game_number }}</span>
          <CheckCircle v-if="game.has_stats && game.parsed" class="w-3.5 h-3.5 text-green-500" :title="t('statsParsed')" />
          <AlertCircle v-else-if="game.has_stats && !game.parsed" class="w-3.5 h-3.5 text-amber-500" :title="t('statsPartial')" />
          <span class="w-2 h-2 rounded-full"
            :class="game.winner_captain_id ? 'bg-color-success' : 'bg-text-tertiary'" />
          <span v-if="winnerName(game)" class="text-xs text-muted-foreground ml-1">{{ winnerName(game) }}</span>
          <span v-else class="text-xs text-text-tertiary ml-1">—</span>
          <div class="ml-auto flex items-center gap-1">
            <button
              v-if="canManageMatch && game.dotabuff_id && game.has_stats && !game.parsed"
              class="p-1 rounded-md text-amber-500 hover:text-amber-400 hover:bg-accent transition-colors"
              :disabled="refetchingGame[game.game_number]"
              :title="t('refetchStats')"
              @click.stop="refetchStats(game.game_number)"
            >
              <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': refetchingGame[game.game_number] }" />
            </button>
            <template v-if="showAdminPanel">
              <input
                type="text"
                class="input-field text-[10px] font-mono py-0.5 px-1.5 w-28"
                :value="game.dotabuff_id"
                placeholder="Match ID"
                @change="updateGameMatchId(game.game_number, ($event.target as HTMLInputElement).value)"
              />
            </template>
            <span v-else-if="game.dotabuff_id" class="text-[10px] font-mono text-text-tertiary">#{{ game.dotabuff_id }}</span>
          </div>
        </div>

        <!-- Stats (always visible when available) -->
        <div v-if="loadingStats[game.game_number]" class="px-5 py-6 text-sm text-muted-foreground text-center">
          {{ t('loading') }}...
        </div>
        <div v-else-if="gameStats[game.game_number]?.length" class="px-5 py-4">
            <div class="flex flex-col gap-4">
              <!-- Game info bar: date + duration + external links -->
              <div class="flex items-center justify-between flex-wrap gap-2">
                <div class="flex items-center gap-3 text-sm text-muted-foreground">
                  <div v-if="game.start_time" class="flex items-center gap-1.5">
                    <Calendar class="w-3.5 h-3.5" />
                    <span class="text-xs font-mono">{{ fmtDateTime(new Date(game.start_time * 1000)) }}</span>
                  </div>
                  <div v-if="getGameDuration(game.game_number)" class="flex items-center gap-1.5">
                    <Clock class="w-3.5 h-3.5" />
                    <span>{{ getGameDuration(game.game_number) }}</span>
                  </div>
                </div>
                <div v-if="game.dotabuff_id" class="flex items-center gap-2">
                  <a :href="`https://www.dotabuff.com/matches/${game.dotabuff_id}`" target="_blank" rel="noopener noreferrer"
                    class="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-accent hover:bg-accent/80 text-foreground transition-colors">
                    <ExternalLink class="w-3 h-3" />
                    Dotabuff
                  </a>
                  <a :href="`https://www.opendota.com/matches/${game.dotabuff_id}`" target="_blank" rel="noopener noreferrer"
                    class="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-accent hover:bg-accent/80 text-foreground transition-colors">
                    <ExternalLink class="w-3 h-3" />
                    OpenDota
                  </a>
                  <a :href="`https://stratz.com/matches/${game.dotabuff_id}`" target="_blank" rel="noopener noreferrer"
                    class="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-accent hover:bg-accent/80 text-foreground transition-colors">
                    <ExternalLink class="w-3 h-3" />
                    Stratz
                  </a>
                </div>
              </div>

              <!-- Partial stats warning -->
              <div v-if="isPartialStats(game.game_number)" class="rounded-md bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-xs text-amber-500">
                {{ t('partialStats') }}
              </div>

              <!-- Dota 2 Post-Game Scoreboard -->
              <div class="overflow-x-auto rounded-lg">
                <table class="w-full text-xs" style="border-collapse: separate; border-spacing: 0;">
                  <thead>
                    <tr class="text-[10px] text-muted-foreground">
                      <th class="text-left py-1 px-1.5 min-w-[200px] sticky left-0 bg-card z-10"></th>
                      <th class="text-center px-1 w-5"></th>
                      <th class="text-center px-1.5">K/D/A</th>
                      <th class="text-center px-1">LH/DN</th>
                      <th class="text-center px-1">NET</th>
                      <th class="text-center px-1">GPM/XPM</th>
                      <th class="text-left px-1.5">{{ t('items') }}</th>
                      <th class="text-center px-1">HD</th>
                      <th class="text-center px-1">TD</th>
                      <th class="text-center px-1">HH</th>
                    </tr>
                  </thead>
                  <tbody>
                    <template v-for="(side, sideIdx) in [true, false]" :key="sideIdx">
                      <!-- Team header row -->
                      <tr :class="side ? 'bg-green-500/10' : 'bg-red-500/10'">
                        <td class="py-2 px-3 sticky left-0 z-10" :class="side ? 'bg-green-500/10 border-l-4 border-green-500' : 'bg-red-500/10 border-l-4 border-red-500'" :colspan="1">
                          <div class="flex items-center gap-2">
                            <span class="text-sm font-bold" :class="side ? 'text-green-500' : 'text-red-400'">{{ sideTeamName(game.game_number, side) }}</span>
                            <Trophy v-if="teamWon(game.game_number, side)" class="w-4 h-4 text-amber-500" />
                          </div>
                        </td>
                        <td :colspan="10" class="py-2 px-3 text-right" :class="side ? 'bg-green-500/10' : 'bg-red-500/10'">
                          <span class="text-xs font-mono text-muted-foreground">{{ teamTotalKills(game.game_number, side) }} kills</span>
                          <span class="text-xs font-mono text-amber-500 ml-3">{{ teamTotalNW(game.game_number, side) }}</span>
                        </td>
                      </tr>
                      <!-- Player rows -->
                      <tr
                        v-for="p in sortedTeamStats(game.game_number, side)"
                        :key="p.account_id"
                        class="hover:bg-accent/30 transition-colors border-b"
                        :class="side ? 'border-green-500/5' : 'border-red-500/5'"
                      >
                        <td class="py-1.5 px-1.5 sticky left-0 bg-card z-10">
                          <div class="flex items-center gap-2">
                            <div class="relative shrink-0">
                              <img v-if="dota.heroImg(p.hero_id)" :src="dota.heroImg(p.hero_id)"
                                class="w-[60px] h-[42px] rounded object-cover border" :class="side ? 'border-green-500/30' : 'border-red-500/30'" />
                              <span class="absolute -bottom-1 -right-1 text-[9px] font-bold bg-surface text-foreground rounded-full w-5 h-5 flex items-center justify-center border border-border/50">{{ p.level }}</span>
                            </div>
                            <div class="flex flex-col min-w-0">
                              <router-link v-if="p.profile_id" :to="{ name: 'player-profile', params: { id: p.profile_id } }"
                                class="font-semibold truncate text-xs leading-tight hover:text-primary transition-colors" :class="p.win ? 'text-foreground' : 'text-muted-foreground'">
                                {{ playerDisplayName(p) }}
                              </router-link>
                              <span v-else class="font-semibold truncate text-xs leading-tight" :class="p.win ? 'text-foreground' : 'text-muted-foreground'">{{ playerDisplayName(p) }}</span>
                              <span class="text-[10px] text-muted-foreground/70 leading-tight">{{ dota.heroName(p.hero_id) }}</span>
                            </div>
                          </div>
                        </td>
                        <td class="text-center px-0.5">
                          <PositionIcon v-if="playerPositions[game.game_number]?.[p.account_id]" :position="playerPositions[game.game_number][p.account_id]" />
                        </td>
                        <td class="text-center px-1.5 font-mono font-medium whitespace-nowrap">
                          <span class="text-green-500">{{ p.kills }}</span><span class="text-muted-foreground">/</span><span class="text-red-400">{{ p.deaths }}</span><span class="text-muted-foreground">/</span><span>{{ p.assists }}</span>
                        </td>
                        <td class="text-center px-1 font-mono whitespace-nowrap">{{ p.last_hits }}<span class="text-muted-foreground">/</span>{{ p.denies }}</td>
                        <td class="text-center px-1 font-mono font-medium text-amber-500">{{ (p.net_worth / 1000).toFixed(1) }}k</td>
                        <td class="text-center px-1 font-mono whitespace-nowrap">{{ p.gpm }}<span class="text-muted-foreground">/</span>{{ p.xpm }}</td>
                        <td class="py-1 px-1.5 whitespace-nowrap">
                          <div class="inline-flex flex-col gap-px">
                            <div class="flex gap-px">
                              <template v-for="(itemId, idx) in [p.item_0, p.item_1, p.item_2]" :key="'t-' + idx">
                                <img v-if="itemId && dota.itemImg(itemId)" :src="dota.itemImg(itemId)" :title="dota.itemName(itemId)" class="w-[36px] h-[27px] rounded-[2px] object-cover border border-border/20" />
                                <div v-else class="w-[36px] h-[27px] rounded-[2px] bg-surface/60 border border-border/10"></div>
                              </template>
                              <img v-if="p.item_neutral && dota.itemImg(p.item_neutral)" :src="dota.itemImg(p.item_neutral)" :title="dota.itemName(p.item_neutral)"
                                class="w-[27px] h-[27px] rounded-full object-cover border border-amber-500/30 ml-1" />
                            </div>
                            <div class="flex gap-px">
                              <template v-for="(itemId, idx) in [p.item_3, p.item_4, p.item_5]" :key="'b-' + idx">
                                <img v-if="itemId && dota.itemImg(itemId)" :src="dota.itemImg(itemId)" :title="dota.itemName(itemId)" class="w-[36px] h-[27px] rounded-[2px] object-cover border border-border/20" />
                                <div v-else class="w-[36px] h-[27px] rounded-[2px] bg-surface/60 border border-border/10"></div>
                              </template>
                              <template v-for="(itemId, idx) in [p.backpack_0, p.backpack_1, p.backpack_2]" :key="'bp-' + idx">
                                <img v-if="itemId && dota.itemImg(itemId)" :src="dota.itemImg(itemId)" :title="dota.itemName(itemId)" class="w-[27px] h-[21px] rounded-[1px] object-cover border border-border/10 opacity-40 ml-px" />
                              </template>
                            </div>
                          </div>
                        </td>
                        <td class="text-center px-1 font-mono">{{ (p.hero_damage / 1000).toFixed(1) }}k</td>
                        <td class="text-center px-1 font-mono">{{ (p.tower_damage / 1000).toFixed(1) }}k</td>
                        <td class="text-center px-1 font-mono">{{ (p.hero_healing / 1000).toFixed(1) }}k</td>
                      </tr>
                    </template>
                  </tbody>
                </table>
              </div>


              <!-- Draft: Stratz-style phases -->
              <div v-if="gamePicksBans[game.game_number]?.length" class="mt-3">
                <p class="text-sm font-bold text-foreground mb-2">{{ t('draft') || 'Draft' }}</p>
                <div class="flex flex-wrap gap-2">
                  <div v-for="phase in getDraftPhases(game.game_number)" :key="phase.label" class="rounded-lg bg-surface/80 px-3 py-2">
                    <span class="text-[10px] font-medium text-muted-foreground mb-1.5 block">{{ phase.label }}</span>
                    <!-- Row 1: Dire (team 1) -->
                    <div class="flex items-center gap-0.5 mb-1">
                      <template v-for="pb in phase.items.filter((p: any) => p.team === 1)" :key="pb.order">
                        <div class="relative overflow-hidden rounded-sm" :title="dota.heroName(pb.hero_id)" style="width: 44px; height: 24px;">
                          <img v-if="dota.heroImg(pb.hero_id)" :src="dota.heroImg(pb.hero_id)"
                            class="w-full h-full object-cover"
                            :class="!pb.is_pick ? 'opacity-40' : ''" />
                          <svg v-if="!pb.is_pick" class="absolute inset-0 w-full h-full" viewBox="0 0 44 24" preserveAspectRatio="none">
                            <line x1="0" y1="0" x2="44" y2="24" stroke="rgb(239 68 68)" stroke-width="2.5" />
                          </svg>
                        </div>
                        <span class="text-[10px] font-mono font-bold text-muted-foreground mr-1.5">{{ pb.order + 1 }}</span>
                      </template>
                    </div>
                    <!-- Row 2: Radiant (team 0) -->
                    <div class="flex items-center gap-0.5">
                      <template v-for="pb in phase.items.filter((p: any) => p.team === 0)" :key="pb.order">
                        <div class="relative overflow-hidden rounded-sm" :title="dota.heroName(pb.hero_id)" style="width: 44px; height: 24px;">
                          <img v-if="dota.heroImg(pb.hero_id)" :src="dota.heroImg(pb.hero_id)"
                            class="w-full h-full object-cover"
                            :class="!pb.is_pick ? 'opacity-40' : ''" />
                          <svg v-if="!pb.is_pick" class="absolute inset-0 w-full h-full" viewBox="0 0 44 24" preserveAspectRatio="none">
                            <line x1="0" y1="0" x2="44" y2="24" stroke="rgb(239 68 68)" stroke-width="2.5" />
                          </svg>
                        </div>
                        <span class="text-[10px] font-mono font-bold text-muted-foreground mr-1.5">{{ pb.order + 1 }}</span>
                      </template>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
      </div>
    </template>
  </div>
</template>
