<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronUp, Check, Gamepad2, X, ArrowLeft, Trophy } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import { getSocket } from '@/composables/useSocket'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const api = useApi()
const store = useDraftStore()

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
    list.push({ game_number: i, winner_captain_id: g?.winner_captain_id || null, dotabuff_id: g?.dotabuff_id || '', has_stats: g?.has_stats || false })
  }
  return list
})

const score1 = computed(() => !match.value ? 0 : (match.value.games || []).filter((g: any) => g.winner_captain_id === match.value.team1_captain_id).length)
const score2 = computed(() => !match.value ? 0 : (match.value.games || []).filter((g: any) => g.winner_captain_id === match.value.team2_captain_id).length)

const expandedGame = ref<number | null>(null)
const gameStats = ref<Record<number, any[]>>({})
const loadingStats = ref<Record<number, boolean>>({})

// Match ready state
const matchReadyState = ref<Record<number, number[]>>({})
const lobbyStatuses = ref<Record<number, any>>({})
const noBotAvailable = ref<Record<number, boolean>>({})
const lobbyCreateError = ref<Record<number, string | null>>({})

// Lobby countdown timer (5 min from lobby creation)
const LOBBY_TIMEOUT_MS = 5 * 60 * 1000
const now = ref(Date.now())
let tickInterval: ReturnType<typeof setInterval> | null = null

function getLobbyTimeLeft(gameNumber: number): number | null {
  const lobby = lobbyStatuses.value[gameNumber]
  if (!lobby || !lobby.created_at) return null
  if (!['waiting', 'creating'].includes(lobby.status)) return null
  const created = new Date(lobby.created_at).getTime()
  const remaining = (created + LOBBY_TIMEOUT_MS) - now.value
  return Math.max(0, remaining)
}

function formatCountdown(ms: number): string {
  const totalSec = Math.ceil(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${sec.toString().padStart(2, '0')}`
}

const myCaptainId = computed(() => store.currentCaptain.value?.id || null)
const isCaptainInMatch = computed(() => {
  if (!myCaptainId.value || !match.value) return false
  return match.value.team1_captain_id === myCaptainId.value || match.value.team2_captain_id === myCaptainId.value
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
    if (data.lobby) lobbyStatuses.value[gameNumber] = data.lobby
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
  tickInterval = setInterval(() => { now.value = Date.now() }, 1000)
})

// Once match data is available, fetch ready states and lobby statuses
watch(match, (m, oldM) => {
  if (!m) return
  // Auto-expand first game with stats
  const games = (m.games || []).filter((g: any) => g.has_stats)
  if (games.length > 0 && expandedGame.value === null) toggleStats(games[0].game_number)

  // Fetch team rosters once
  if (!oldM && m) fetchTeamRosters()

  // Detect status transition to completed
  const oldStatus = oldM?.status || prevMatchStatus.value
  if (m.status === 'completed' && oldStatus && oldStatus !== 'completed') {
    matchJustCompleted.value = true
  }
  prevMatchStatus.value = m.status

  for (const g of allGames.value) {
    store.getMatchReadyState(m.id, g.game_number)
    fetchLobbyStatus(g.game_number)
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
  <div class="p-4 md:p-8 flex flex-col gap-0 max-w-[900px] mx-auto w-full">
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
        </div>
        <div class="flex items-center justify-center gap-6">
          <router-link v-if="match.team1_captain_id" :to="{ name: 'team-profile', params: { id: match.team1_captain_id } }" class="flex items-center gap-3 hover:opacity-80 transition-opacity">
            <div class="w-10 h-10 rounded-lg bg-accent overflow-hidden shrink-0">
              <img v-if="match.team1_banner || match.team1_avatar" :src="match.team1_banner || match.team1_avatar" class="w-full h-full object-cover" />
            </div>
            <span class="text-base font-semibold text-foreground hover:text-primary transition-colors">{{ match.team1_name || t('tbd') }}</span>
          </router-link>
          <div v-else class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-lg bg-accent overflow-hidden shrink-0"></div>
            <span class="text-base font-semibold text-muted-foreground">{{ t('tbd') }}</span>
          </div>
          <span class="text-3xl font-bold font-mono text-foreground">{{ score1 }} : {{ score2 }}</span>
          <router-link v-if="match.team2_captain_id" :to="{ name: 'team-profile', params: { id: match.team2_captain_id } }" class="flex items-center gap-3 hover:opacity-80 transition-opacity">
            <span class="text-base font-semibold text-foreground hover:text-primary transition-colors">{{ match.team2_name || t('tbd') }}</span>
            <div class="w-10 h-10 rounded-lg bg-accent overflow-hidden shrink-0">
              <img v-if="match.team2_banner || match.team2_avatar" :src="match.team2_banner || match.team2_avatar" class="w-full h-full object-cover" />
            </div>
          </router-link>
          <div v-else class="flex items-center gap-3">
            <span class="text-base font-semibold text-muted-foreground">{{ t('tbd') }}</span>
            <div class="w-10 h-10 rounded-lg bg-accent overflow-hidden shrink-0"></div>
          </div>
        </div>
        <div class="flex items-center justify-center gap-2">
          <span class="badge-info">{{ match.status === 'completed' ? t('matchCompleted') : match.status === 'live' ? t('matchLive') : t('matchPending') }}</span>
          <span class="text-xs text-text-tertiary">Best of {{ bestOf }}</span>
        </div>
      </div>

      <!-- Team Rosters -->
      <div v-if="teamRosters.team1.length || teamRosters.team2.length" class="grid grid-cols-2 gap-4 mb-6">
        <!-- Team 1 -->
        <div class="card px-4 py-3 flex flex-col gap-2">
          <router-link v-if="match.team1_captain_id" :to="{ name: 'team-profile', params: { id: match.team1_captain_id } }" class="flex items-center gap-2 mb-1 hover:opacity-80 transition-opacity">
            <div class="w-6 h-6 rounded bg-accent overflow-hidden shrink-0">
              <img v-if="match.team1_banner || match.team1_avatar" :src="match.team1_banner || match.team1_avatar" class="w-full h-full object-cover" />
            </div>
            <span class="text-sm font-semibold text-foreground truncate hover:text-primary transition-colors">{{ match.team1_name || t('tbd') }}</span>
          </router-link>
          <div v-else class="flex items-center gap-2 mb-1">
            <div class="w-6 h-6 rounded bg-accent overflow-hidden shrink-0"></div>
            <span class="text-sm font-semibold text-muted-foreground truncate">{{ t('tbd') }}</span>
          </div>
          <div v-for="p in teamRosters.team1" :key="p.id" class="flex items-center gap-2 py-0.5">
            <div class="w-5 h-5 rounded-full bg-accent overflow-hidden shrink-0">
              <img v-if="p.avatar_url" :src="p.avatar_url" class="w-full h-full object-cover" />
            </div>
            <span class="text-sm text-foreground truncate">{{ p.name }}</span>
            <span v-if="p.is_captain" class="text-[10px] font-medium text-primary bg-primary/10 px-1.5 py-0.5 rounded">C</span>
            <span v-if="p.mmr" class="text-[10px] text-muted-foreground ml-auto">{{ p.mmr }}</span>
          </div>
        </div>
        <!-- Team 2 -->
        <div class="card px-4 py-3 flex flex-col gap-2">
          <router-link v-if="match.team2_captain_id" :to="{ name: 'team-profile', params: { id: match.team2_captain_id } }" class="flex items-center gap-2 mb-1 hover:opacity-80 transition-opacity">
            <div class="w-6 h-6 rounded bg-accent overflow-hidden shrink-0">
              <img v-if="match.team2_banner || match.team2_avatar" :src="match.team2_banner || match.team2_avatar" class="w-full h-full object-cover" />
            </div>
            <span class="text-sm font-semibold text-foreground truncate hover:text-primary transition-colors">{{ match.team2_name || t('tbd') }}</span>
          </router-link>
          <div v-else class="flex items-center gap-2 mb-1">
            <div class="w-6 h-6 rounded bg-accent overflow-hidden shrink-0"></div>
            <span class="text-sm font-semibold text-muted-foreground truncate">{{ t('tbd') }}</span>
          </div>
          <div v-for="p in teamRosters.team2" :key="p.id" class="flex items-center gap-2 py-0.5">
            <div class="w-5 h-5 rounded-full bg-accent overflow-hidden shrink-0">
              <img v-if="p.avatar_url" :src="p.avatar_url" class="w-full h-full object-cover" />
            </div>
            <span class="text-sm text-foreground truncate">{{ p.name }}</span>
            <span v-if="p.is_captain" class="text-[10px] font-medium text-primary bg-primary/10 px-1.5 py-0.5 rounded">C</span>
            <span v-if="p.mmr" class="text-[10px] text-muted-foreground ml-auto">{{ p.mmr }}</span>
          </div>
        </div>
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

                <!-- Player list -->
                <div class="px-5 py-3 grid grid-cols-2 gap-x-6 gap-y-1.5 border-b border-border/30">
                  <div v-for="p in getPlayerStatuses(g.game_number)" :key="p.steamId" class="flex items-center gap-2 text-sm py-1">
                    <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" :class="p.joined ? (p.correctTeam ? 'bg-green-500' : 'bg-amber-500') : 'bg-muted-foreground/30'"></span>
                    <span :class="p.joined ? 'text-foreground' : 'text-muted-foreground'" class="truncate">{{ p.name }}</span>
                    <span class="text-xs text-muted-foreground">({{ p.expectedTeam === 'radiant' ? 'R' : 'D' }})</span>
                    <span v-if="p.joined && !p.correctTeam" class="text-amber-500 text-xs">wrong side</span>
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

      <!-- Spectator view: show lobby status for non-captains -->
      <div v-else-if="bothTeamsAssigned && match.status !== 'completed'" class="flex flex-col gap-4 mb-6">
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
                    <div class="flex items-center justify-between mb-2">
                      <span class="text-sm text-muted-foreground">{{ t('lobbyPassword') }}:</span>
                      <span class="text-sm font-medium" :class="allPlayersJoined(g.game_number) ? 'text-green-500' : 'text-muted-foreground'">
                        {{ (lobbyStatuses[g.game_number].players_joined || []).length }}/{{ (lobbyStatuses[g.game_number].players_expected || []).length }} {{ t('players') }}
                      </span>
                    </div>
                    <div class="grid grid-cols-2 gap-x-6 gap-y-1.5">
                      <div v-for="p in getPlayerStatuses(g.game_number)" :key="p.steamId" class="flex items-center gap-2 text-sm py-0.5">
                        <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" :class="p.joined ? (p.correctTeam ? 'bg-green-500' : 'bg-amber-500') : 'bg-muted-foreground/30'"></span>
                        <span :class="p.joined ? 'text-foreground' : 'text-muted-foreground'" class="truncate">{{ p.name }}</span>
                        <span class="text-xs text-muted-foreground">({{ p.expectedTeam === 'radiant' ? 'R' : 'D' }})</span>
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

      <!-- Games list with stats -->
      <div class="card overflow-hidden">
        <div v-for="game in allGames" :key="game.game_number" class="border-b border-border/50 last:border-0">
          <button
            class="flex items-center gap-2 w-full px-5 py-3.5 cursor-pointer hover:bg-accent/30 transition-colors"
            @click="game.has_stats || game.winner_captain_id ? toggleStats(game.game_number) : null"
          >
            <Gamepad2 class="w-4 h-4 text-primary" />
            <span class="text-sm font-semibold text-foreground">{{ t('game') }} {{ game.game_number }}</span>
            <span class="w-2 h-2 rounded-full"
              :class="game.winner_captain_id ? 'bg-color-success' : 'bg-text-tertiary'" />
            <span v-if="winnerName(game)" class="text-xs text-muted-foreground ml-1">{{ winnerName(game) }}</span>
            <span v-else class="text-xs text-text-tertiary ml-1">—</span>
            <div class="ml-auto flex items-center gap-1">
              <span v-if="game.dotabuff_id" class="text-[10px] font-mono text-text-tertiary">#{{ game.dotabuff_id }}</span>
              <component v-if="game.has_stats || game.winner_captain_id" :is="expandedGame === game.game_number ? ChevronUp : ChevronDown" class="w-4 h-4 text-text-tertiary" />
            </div>
          </button>

          <!-- Stats panel -->
          <div v-if="expandedGame === game.game_number" class="border-t border-border/50 px-5 py-4">
            <div v-if="loadingStats[game.game_number]" class="text-sm text-muted-foreground text-center py-6">
              {{ t('loading') }}...
            </div>
            <div v-else-if="!gameStats[game.game_number]?.length" class="text-sm text-muted-foreground text-center py-6">
              {{ t('noStatsYet') }}
            </div>
            <div v-else class="overflow-x-auto">
              <table class="w-full text-xs">
                <thead>
                  <tr class="text-muted-foreground border-b border-border/30">
                    <th class="text-left py-1.5 px-1.5">{{ t('playerCol') }}</th>
                    <th class="text-center px-1">K</th>
                    <th class="text-center px-1">D</th>
                    <th class="text-center px-1">A</th>
                    <th class="text-center px-1">LH</th>
                    <th class="text-center px-1">DN</th>
                    <th class="text-center px-1">GPM</th>
                    <th class="text-center px-1">XPM</th>
                    <th class="text-center px-1" :title="t('heroDamage')">HD</th>
                    <th class="text-center px-1" :title="t('towerDamage')">TD</th>
                    <th class="text-center px-1" :title="t('heroHealing')">HH</th>
                    <th class="text-center px-1" :title="t('obsPlaced')">OW</th>
                    <th class="text-center px-1" :title="t('senPlaced')">SW</th>
                    <th class="text-center px-1" :title="t('obsKilled')">OK</th>
                    <th class="text-center px-1" :title="t('senKilled')">SK</th>
                    <th class="text-center px-1" :title="t('campsStacked')">CS</th>
                    <th class="text-center px-1" :title="t('tripleKills')">3K</th>
                    <th class="text-center px-1" :title="t('ultraKills')">4K</th>
                    <th class="text-center px-1" :title="t('rampages')">R</th>
                  </tr>
                </thead>
                <tbody>
                  <template v-for="(side, sideIdx) in [true, false]" :key="sideIdx">
                    <tr v-if="sideIdx > 0" class="h-1"><td :colspan="19" class="border-t border-border/30"></td></tr>
                    <tr class="text-[10px] text-muted-foreground">
                      <td :colspan="19" class="py-1 px-1.5 font-semibold">
                        {{ side ? 'Radiant' : 'Dire' }}
                      </td>
                    </tr>
                    <tr
                      v-for="p in gameStats[game.game_number]?.filter((s: any) => s.is_radiant === side)"
                      :key="p.account_id"
                      class="hover:bg-accent/40"
                      :class="p.win ? 'text-foreground' : 'text-muted-foreground'"
                    >
                      <td class="py-1 px-1.5 font-medium truncate max-w-[120px]">{{ p.player_name || p.account_id }}</td>
                      <td class="text-center px-1">{{ p.kills }}</td>
                      <td class="text-center px-1">{{ p.deaths }}</td>
                      <td class="text-center px-1">{{ p.assists }}</td>
                      <td class="text-center px-1">{{ p.last_hits }}</td>
                      <td class="text-center px-1">{{ p.denies }}</td>
                      <td class="text-center px-1">{{ p.gpm }}</td>
                      <td class="text-center px-1">{{ p.xpm }}</td>
                      <td class="text-center px-1">{{ (p.hero_damage / 1000).toFixed(1) }}k</td>
                      <td class="text-center px-1">{{ (p.tower_damage / 1000).toFixed(1) }}k</td>
                      <td class="text-center px-1">{{ (p.hero_healing / 1000).toFixed(1) }}k</td>
                      <td class="text-center px-1">{{ p.obs_placed }}</td>
                      <td class="text-center px-1">{{ p.sen_placed }}</td>
                      <td class="text-center px-1">{{ p.observer_kills }}</td>
                      <td class="text-center px-1">{{ p.sentry_kills }}</td>
                      <td class="text-center px-1">{{ p.camps_stacked }}</td>
                      <td class="text-center px-1">{{ getMultiKillCount(p.multi_kills, '3') || '-' }}</td>
                      <td class="text-center px-1">{{ getMultiKillCount(p.multi_kills, '4') || '-' }}</td>
                      <td class="text-center px-1">{{ getMultiKillCount(p.multi_kills, '5') || '-' }}</td>
                    </tr>
                  </template>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
