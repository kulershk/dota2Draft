<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronUp, Check, Gamepad2, X } from 'lucide-vue-next'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import { useRouter } from 'vue-router'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import { getSocket } from '@/composables/useSocket'

const { t } = useI18n()
const router = useRouter()
const api = useApi()
const store = useDraftStore()

const props = defineProps<{
  match: any
}>()

const emit = defineEmits<{
  close: []
}>()

const compId = store.currentCompetitionId
const bestOf = computed(() => props.match.best_of || 3)
const allGames = computed(() => {
  const existing = props.match.games || []
  const list = []
  for (let i = 1; i <= bestOf.value; i++) {
    const g = existing.find((e: any) => e.game_number === i)
    list.push({ game_number: i, winner_captain_id: g?.winner_captain_id || null, dotabuff_id: g?.dotabuff_id || '', has_stats: g?.has_stats || false })
  }
  return list
})
const games = computed(() => allGames.value.filter(g => g.winner_captain_id || g.dotabuff_id))

const score1 = computed(() => (props.match.games || []).filter((g: any) => g.winner_captain_id === props.match.team1_captain_id).length)
const score2 = computed(() => (props.match.games || []).filter((g: any) => g.winner_captain_id === props.match.team2_captain_id).length)

const expandedGame = ref<number | null>(null)
const gameStats = ref<Record<number, any[]>>({})
const loadingStats = ref<Record<number, boolean>>({})

// Match ready state
const matchReadyState = ref<Record<number, number[]>>({}) // gameNumber -> readyCaptainIds
const lobbyStatuses = ref<Record<number, any>>({})
const noBotAvailable = ref<Record<number, boolean>>({})
const lobbyCreateError = ref<Record<number, string | null>>({})

const myCaptainId = computed(() => store.currentCaptain.value?.id || null)
const isCaptainInMatch = computed(() => {
  if (!myCaptainId.value) return false
  return props.match.team1_captain_id === myCaptainId.value || props.match.team2_captain_id === myCaptainId.value
})
const bothTeamsAssigned = computed(() => !!props.match.team1_captain_id && !!props.match.team2_captain_id)

// Next game that needs to be played (no winner yet, no active lobby)
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
  const ids = matchReadyState.value[gameNumber] || []
  return ids.includes(props.match.team1_captain_id) && ids.includes(props.match.team2_captain_id)
}

function toggleReady(gameNumber: number) {
  if (isReady(gameNumber)) {
    store.matchUnready(props.match.id, gameNumber)
  } else {
    store.matchReady(props.match.id, gameNumber)
  }
}

// Launch ready (phase 2 - lobby is waiting)
const launchReadyState = ref<Record<number, number[]>>({})

function isLaunchReady(gameNumber: number) {
  return myCaptainId.value && (launchReadyState.value[gameNumber] || []).includes(myCaptainId.value)
}

function allPlayersJoined(gameNumber: number) {
  const lobby = lobbyStatuses.value[gameNumber]
  if (!lobby) return false
  const expected = (lobby.players_expected || []).length
  const joined = (lobby.players_joined || []).length
  if (expected === 0 || joined < expected) return false
  // Both teams must have a Dota team selected
  const teamIds = lobbyTeamIds.value[gameNumber]
  if (!teamIds || !teamIds.radiant || !teamIds.dire) return false
  // If saved team IDs exist, they must match
  if (props.match.team1_dota_id && teamIds.radiant !== props.match.team1_dota_id) return false
  if (props.match.team2_dota_id && teamIds.dire !== props.match.team2_dota_id) return false
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
  if (isLaunchReady(gameNumber)) {
    store.matchLaunchUnready(props.match.id, gameNumber)
  } else {
    store.matchLaunchReady(props.match.id, gameNumber)
  }
}

const lobbyTeamIds = ref<Record<number, { radiant: number; dire: number; radiantName: string; direName: string }>>({})

function onLobbyTeamIds(data: any) {
  if (Number(data.matchId) !== Number(props.match.id)) return
  lobbyTeamIds.value = { ...lobbyTeamIds.value, [data.gameNumber]: {
    radiant: data.radiantTeamId || 0,
    dire: data.direTeamId || 0,
    radiantName: data.radiantTeamName || '',
    direName: data.direTeamName || '',
  } }
}

function onLaunchReadyState(data: any) {
  if (data.matchId !== props.match.id) return
  launchReadyState.value[data.gameNumber] = data.readyCaptainIds || []
}

// Socket listener for ready state updates
function onReadyState(data: any) {
  if (data.matchId !== props.match.id) return
  matchReadyState.value[data.gameNumber] = data.readyCaptainIds || []
  noBotAvailable.value = { ...noBotAvailable.value, [data.gameNumber]: !!data.noBotAvailable }
  if (data.lobbyCreateError) {
    lobbyCreateError.value = { ...lobbyCreateError.value, [data.gameNumber]: data.lobbyCreateError }
  } else if (data.lobbyCreated || !data.noBotAvailable) {
    lobbyCreateError.value = { ...lobbyCreateError.value, [data.gameNumber]: null }
  }
  if (data.lobbyCreated) {
    fetchLobbyStatus(data.gameNumber)
    // Auto-redirect to match room page
    if (compId.value) {
      emit('close')
      router.push({ name: 'comp-match', params: { compId: compId.value, matchId: props.match.id } })
    }
  }
}

function onLobbyStatusUpdate(data: any) {
  if (Number(data.matchId) !== Number(props.match.id)) return
  if (!data.status) {
    const copy = { ...lobbyStatuses.value }
    delete copy[data.gameNumber]
    lobbyStatuses.value = copy
  } else {
    lobbyStatuses.value = { ...lobbyStatuses.value, [data.gameNumber]: { ...(lobbyStatuses.value[data.gameNumber] || {}), status: data.status, ...(data.playersJoined ? { players_joined: data.playersJoined } : {}) } }
    if (data.status !== 'waiting') {
      launchReadyState.value = { ...launchReadyState.value, [data.gameNumber]: [] }
    }
  }
}

async function fetchLobbyStatus(gameNumber: number) {
  const cId = compId.value
  if (!cId) return
  try {
    const data = await api.getLobbyStatus(cId, props.match.id, gameNumber)
    if (data.lobby) lobbyStatuses.value[gameNumber] = data.lobby
  } catch {}
}

const sock = getSocket()
onMounted(() => {
  // Auto-expand first game with stats
  const firstWithStats = games.value.find((g: any) => g.has_stats)
  if (firstWithStats) toggleStats(firstWithStats.game_number)

  sock.on('match:readyState', onReadyState)
  sock.on('match:launchReadyState', onLaunchReadyState)
  sock.on('lobby:statusUpdate', onLobbyStatusUpdate)
  sock.on('lobby:teamIds', onLobbyTeamIds)

  // Fetch ready state and lobby status for all games
  for (const g of allGames.value) {
    store.getMatchReadyState(props.match.id, g.game_number)
    fetchLobbyStatus(g.game_number)
  }
})

onUnmounted(() => {
  sock.off('match:readyState', onReadyState)
  sock.off('match:launchReadyState', onLaunchReadyState)
  sock.off('lobby:statusUpdate', onLobbyStatusUpdate)
  sock.off('lobby:teamIds', onLobbyTeamIds)
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
    const data = await api.getMatchGameStats(cId, props.match.id, gameNumber)
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

function winnerName(game: any) {
  if (game.winner_captain_id === props.match.team1_captain_id) return props.match.team1_name
  if (game.winner_captain_id === props.match.team2_captain_id) return props.match.team2_name
  return null
}
</script>

<template>
  <ModalOverlay :show="true" wide @close="emit('close')">
    <!-- Header + Overview -->
    <div class="px-6 pt-5 pb-3 flex flex-col gap-3">
      <div class="flex items-center gap-2">
        <Gamepad2 class="w-4 h-4 text-text-tertiary" />
        <span class="text-base font-semibold text-foreground">{{ t('matchDetails') }}</span>
      </div>
      <!-- Overview card -->
      <div class="rounded-md bg-surface border border-border px-4 py-3 flex flex-col gap-2">
        <div class="flex items-center justify-center gap-4">
          <div class="flex items-center gap-2">
            <div class="w-7 h-7 rounded bg-card overflow-hidden shrink-0">
              <img v-if="match.team1_banner || match.team1_avatar" :src="match.team1_banner || match.team1_avatar" class="w-full h-full object-cover" />
            </div>
            <span class="text-sm font-semibold text-foreground">{{ match.team1_name || t('tbd') }}</span>
          </div>
          <span class="text-2xl font-bold font-mono text-foreground">{{ score1 }} : {{ score2 }}</span>
          <div class="flex items-center gap-2">
            <span class="text-sm font-semibold text-foreground">{{ match.team2_name || t('tbd') }}</span>
            <div class="w-7 h-7 rounded bg-card overflow-hidden shrink-0">
              <img v-if="match.team2_banner || match.team2_avatar" :src="match.team2_banner || match.team2_avatar" class="w-full h-full object-cover" />
            </div>
          </div>
        </div>
        <div class="flex items-center justify-center gap-2">
          <span class="badge-info">{{ match.status === 'completed' ? t('matchCompleted') : match.status === 'live' ? t('matchLive') : t('matchPending') }}</span>
          <span class="text-xs text-text-tertiary">Best of {{ bestOf }}</span>
        </div>
      </div>
    </div>

    <div class="px-6 pb-3 flex flex-col gap-1 max-h-[55vh] overflow-y-auto">
      <!-- Match Ready Section -->
      <div v-if="isCaptainInMatch && bothTeamsAssigned && match.status !== 'completed'" class="flex flex-col gap-3 mb-2">
        <div v-for="g in allGames" :key="'ready-' + g.game_number">
          <template v-if="!g.dotabuff_id && g.game_number === nextGameNumber">
            <div class="rounded-lg border border-border overflow-hidden">
              <!-- Game header -->
              <div class="flex items-center justify-between px-4 py-3 bg-accent/30 border-b border-border">
                <div class="flex items-center gap-2">
                  <Gamepad2 class="w-4 h-4 text-muted-foreground" />
                  <span class="text-sm font-semibold text-foreground">{{ t('game') }} {{ g.game_number }}</span>
                </div>
                <span v-if="lobbyStatuses[g.game_number]?.status === 'creating'" class="text-xs text-muted-foreground animate-pulse">{{ t('lobbyCreating') }}</span>
                <span v-else-if="lobbyStatuses[g.game_number]?.status === 'active'" class="text-xs font-medium text-green-500">{{ t('lobbyActive') }}</span>
                <span v-else-if="lobbyStatuses[g.game_number]?.status === 'launching'" class="text-xs font-medium text-amber-500">{{ t('lobbyLaunching') }}</span>
                <span v-else-if="lobbyStatuses[g.game_number]?.status === 'cointoss'" class="text-xs font-medium text-amber-500">{{ t('lobbyCoinToss') }}</span>
              </div>

              <!-- Phase 1: Ready check to create lobby -->
              <div v-if="!lobbyStatuses[g.game_number] || ['cancelled', 'error', 'completed'].includes(lobbyStatuses[g.game_number]?.status)" class="p-4 flex flex-col items-center gap-3">
                <!-- Previous lobby error -->
                <div v-if="lobbyStatuses[g.game_number]?.status === 'error'" class="w-full rounded-md bg-red-500/10 border border-red-500/20 px-3 py-2 text-center">
                  <p class="text-xs font-medium text-red-500">{{ t('lobbyError') }}</p>
                  <p v-if="lobbyStatuses[g.game_number].error_message" class="text-[10px] text-red-400 mt-0.5">{{ lobbyStatuses[g.game_number].error_message }}</p>
                  <p class="text-[10px] text-muted-foreground mt-0.5">{{ t('lobbyErrorRetry') }}</p>
                </div>
                <p class="text-xs text-muted-foreground text-center">{{ t('matchReadyDesc') }}</p>
                <div class="flex items-center gap-3">
                  <div class="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium"
                    :class="(matchReadyState[g.game_number] || []).includes(match.team1_captain_id) ? 'bg-green-500/15 text-green-500' : 'bg-accent text-muted-foreground'">
                    <Check v-if="(matchReadyState[g.game_number] || []).includes(match.team1_captain_id)" class="w-3 h-3" />
                    {{ match.team1_name || 'Team 1' }}
                  </div>
                  <span class="text-muted-foreground text-xs">{{ t('vs') }}</span>
                  <div class="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium"
                    :class="(matchReadyState[g.game_number] || []).includes(match.team2_captain_id) ? 'bg-green-500/15 text-green-500' : 'bg-accent text-muted-foreground'">
                    <Check v-if="(matchReadyState[g.game_number] || []).includes(match.team2_captain_id)" class="w-3 h-3" />
                    {{ match.team2_name || 'Team 2' }}
                  </div>
                </div>
                <span v-if="noBotAvailable[g.game_number] && bothCaptainsReady(g.game_number)" class="text-xs text-amber-500">{{ t('noBotAvailable') }}</span>
                <span v-if="lobbyCreateError[g.game_number]" class="text-xs text-red-500">{{ lobbyCreateError[g.game_number] }}</span>
                <button
                  class="w-full max-w-xs px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
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
                <!-- Lobby name + password + player count -->
                <div class="px-4 py-3 flex flex-col gap-1.5 border-b border-border/30">
                  <div v-if="lobbyStatuses[g.game_number].game_name" class="flex items-center gap-2 text-xs">
                    <span class="text-muted-foreground">{{ t('lobbyName') }}:</span>
                    <span class="font-medium text-foreground">{{ lobbyStatuses[g.game_number].game_name }}</span>
                  </div>
                  <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2 text-sm">
                      <span class="text-muted-foreground">{{ t('lobbyPassword') }}:</span>
                      <code class="font-mono font-bold bg-accent px-2 py-0.5 rounded text-foreground">{{ lobbyStatuses[g.game_number].password }}</code>
                    </div>
                    <span class="text-xs font-medium" :class="allPlayersJoined(g.game_number) ? 'text-green-500' : 'text-muted-foreground'">
                      {{ (lobbyStatuses[g.game_number].players_joined || []).length }}/{{ (lobbyStatuses[g.game_number].players_expected || []).length }} {{ t('players') }}
                    </span>
                  </div>
                </div>

                <!-- Player list -->
                <div class="px-4 py-2.5 grid grid-cols-2 gap-x-4 gap-y-1 border-b border-border/30">
                  <div v-for="p in getPlayerStatuses(g.game_number)" :key="p.steamId" class="flex items-center gap-1.5 text-xs py-0.5">
                    <span class="w-2 h-2 rounded-full flex-shrink-0" :class="p.joined ? (p.correctTeam ? 'bg-green-500' : 'bg-amber-500') : 'bg-muted-foreground/30'"></span>
                    <span :class="p.joined ? 'text-foreground' : 'text-muted-foreground'" class="truncate">{{ p.name }}</span>
                    <span class="text-[10px] text-muted-foreground">({{ p.expectedTeam === 'radiant' ? 'R' : 'D' }})</span>
                    <span v-if="p.joined && !p.correctTeam" class="text-amber-500 text-[10px]">wrong side</span>
                  </div>
                </div>

                <!-- Team IDs -->
                <div class="px-4 py-2.5 flex items-center gap-4 border-b border-border/30 text-xs">
                  <div class="flex items-center gap-1.5">
                    <span class="text-muted-foreground">Radiant:</span>
                    <template v-if="lobbyTeamIds[g.game_number]?.radiant">
                      <span :class="match.team1_dota_id && lobbyTeamIds[g.game_number].radiant !== match.team1_dota_id ? 'text-red-500' : 'text-green-500'" class="font-medium">
                        {{ lobbyTeamIds[g.game_number].radiantName || lobbyTeamIds[g.game_number].radiant }}
                      </span>
                      <Check v-if="!match.team1_dota_id || lobbyTeamIds[g.game_number].radiant === match.team1_dota_id" class="w-3 h-3 text-green-500" />
                      <X v-else class="w-3 h-3 text-red-500" />
                    </template>
                    <span v-else class="text-red-500">{{ t('noTeamSet') }}</span>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <span class="text-muted-foreground">Dire:</span>
                    <template v-if="lobbyTeamIds[g.game_number]?.dire">
                      <span :class="match.team2_dota_id && lobbyTeamIds[g.game_number].dire !== match.team2_dota_id ? 'text-red-500' : 'text-green-500'" class="font-medium">
                        {{ lobbyTeamIds[g.game_number].direName || lobbyTeamIds[g.game_number].dire }}
                      </span>
                      <Check v-if="!match.team2_dota_id || lobbyTeamIds[g.game_number].dire === match.team2_dota_id" class="w-3 h-3 text-green-500" />
                      <X v-else class="w-3 h-3 text-red-500" />
                    </template>
                    <span v-else class="text-red-500">{{ t('noTeamSet') }}</span>
                  </div>
                </div>

                <!-- Launch ready + button -->
                <div class="p-4 flex flex-col items-center gap-3">
                  <div class="flex items-center gap-3">
                    <div class="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium"
                      :class="(launchReadyState[g.game_number] || []).includes(match.team1_captain_id) ? 'bg-green-500/15 text-green-500' : 'bg-accent text-muted-foreground'">
                      <Check v-if="(launchReadyState[g.game_number] || []).includes(match.team1_captain_id)" class="w-3 h-3" />
                      {{ match.team1_name || 'T1' }}
                    </div>
                    <span class="text-muted-foreground text-xs">{{ t('vs') }}</span>
                    <div class="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium"
                      :class="(launchReadyState[g.game_number] || []).includes(match.team2_captain_id) ? 'bg-green-500/15 text-green-500' : 'bg-accent text-muted-foreground'">
                      <Check v-if="(launchReadyState[g.game_number] || []).includes(match.team2_captain_id)" class="w-3 h-3" />
                      {{ match.team2_name || 'T2' }}
                    </div>
                  </div>
                  <button
                    class="w-full max-w-xs px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
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

              <!-- Phase 3: In progress (coin toss / launching / active) -->
              <div v-else-if="['cointoss', 'launching', 'active'].includes(lobbyStatuses[g.game_number]?.status)" class="p-4 flex flex-col items-center gap-2">
                <div class="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin"></div>
                <span class="text-sm font-medium text-foreground">
                  {{ lobbyStatuses[g.game_number]?.status === 'cointoss' ? t('lobbyCoinToss') : lobbyStatuses[g.game_number]?.status === 'active' ? t('lobbyActive') : t('lobbyLaunching') }}
                </span>
              </div>
            </div>
          </template>
        </div>
      </div>

      <!-- All games list -->
      <div v-for="game in allGames" :key="game.game_number">
        <button
          class="flex items-center gap-2 w-full py-2 cursor-pointer"
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
        <div v-if="expandedGame === game.game_number" class="border-t border-border/50 p-3">
          <div v-if="loadingStats[game.game_number]" class="text-xs text-muted-foreground text-center py-4">
            {{ t('loading') }}...
          </div>
          <div v-else-if="!gameStats[game.game_number]?.length" class="text-xs text-muted-foreground text-center py-4">
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

    <div class="px-7 py-4 border-t border-border">
      <button class="btn-secondary w-full justify-center" @click="emit('close')">{{ t('close') }}</button>
    </div>
  </ModalOverlay>
</template>
