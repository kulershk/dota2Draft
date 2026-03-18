<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { EyeOff, RefreshCw, ChevronDown, ChevronUp, Gamepad2, Play, X, Check, RotateCcw } from 'lucide-vue-next'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import { getSocket } from '@/composables/useSocket'

const { t } = useI18n()
const api = useApi()
const store = useDraftStore()

const props = defineProps<{
  match: any
}>()

const emit = defineEmits<{
  close: []
  save: [data: any]
}>()

const bestOf = computed(() => props.match.best_of || 3)
const games = ref<{ game_number: number; winner_captain_id: number | null; dotabuff_id: string; has_stats?: boolean }[]>([])
const isHidden = ref(false)
const matchStatus = ref('pending')
const scheduledAt = ref('')
const expandedGame = ref<number | null>(null)
const gameStats = ref<Record<number, any[]>>({})
const loadingStats = ref<Record<number, boolean>>({})
const refetchingGame = ref<Record<number, boolean>>({})

onMounted(() => {
  isHidden.value = !!props.match.hidden
  matchStatus.value = props.match.status || 'pending'
  scheduledAt.value = props.match.scheduled_at ? String(props.match.scheduled_at).slice(0, 16) : ''
  const existing = props.match.games || []
  for (let i = 1; i <= bestOf.value; i++) {
    const g = existing.find((e: any) => e.game_number === i)
    games.value.push({
      game_number: i,
      winner_captain_id: g?.winner_captain_id || null,
      dotabuff_id: g?.dotabuff_id || '',
      has_stats: g?.has_stats || false,
    })
  }
})

const score1 = computed(() => games.value.filter(g => g.winner_captain_id === props.match.team1_captain_id).length)
const score2 = computed(() => games.value.filter(g => g.winner_captain_id === props.match.team2_captain_id).length)
const nextGameNumber = computed(() => {
  for (const g of games.value) {
    if (!g.dotabuff_id) return g.game_number
  }
  return null
})
const compId = store.currentCompetitionId

function setGameWinner(idx: number, captainId: number | null) {
  const g = games.value[idx]
  g.winner_captain_id = g.winner_captain_id === captainId ? null : captainId
}

function save() {
  emit('save', {
    score1: score1.value,
    score2: score2.value,
    status: matchStatus.value,
    games: games.value,
    hidden: isHidden.value,
    scheduled_at: scheduledAt.value || null,
  })
}

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

async function refetchStats(gameNumber: number) {
  const cId = compId.value
  if (!cId) return
  refetchingGame.value[gameNumber] = true
  try {
    await api.refetchMatchGameStats(cId, props.match.id, gameNumber)
    // Update has_stats flag
    const g = games.value.find(g => g.game_number === gameNumber)
    if (g) g.has_stats = true
    await loadStats(gameNumber)
  } catch (e: any) {
    console.error('Refetch failed:', e.message)
  } finally {
    refetchingGame.value[gameNumber] = false
  }
}

function getMultiKillCount(multiKills: Record<string, number>, key: string): number {
  return multiKills?.[key] || 0
}

// Lobby management
const lobbyStatuses = ref<Record<number, any>>({})
const creatingLobby = ref<Record<number, boolean>>({})
const confirmForceGame = ref<number | null>(null)
const confirmCreateGame = ref<number | null>(null)
const confirmCancelGame = ref<number | null>(null)
const lobbyError = ref<Record<number, string>>({})

async function createLobby(gameNumber: number) {
  const cId = compId.value
  if (!cId) return
  creatingLobby.value[gameNumber] = true
  try {
    const result = await api.createLobby(cId, props.match.id, gameNumber)
    lobbyStatuses.value[gameNumber] = result
  } catch (e: any) {
    console.error('Create lobby failed:', e.message)
  } finally {
    creatingLobby.value[gameNumber] = false
  }
}

async function forceLaunchLobby(gameNumber: number) {
  const cId = compId.value
  if (!cId) return
  try {
    await api.forceLaunchLobby(cId, props.match.id, gameNumber)
  } catch {}
}

async function cancelLobby(gameNumber: number) {
  const cId = compId.value
  if (!cId) return
  try {
    await api.cancelLobby(cId, props.match.id, gameNumber)
    lobbyStatuses.value[gameNumber] = null
  } catch {}
}

async function resetLobby(gameNumber: number) {
  const cId = compId.value
  if (!cId) return
  try {
    await api.resetLobby(cId, props.match.id, gameNumber)
    lobbyStatuses.value = { ...lobbyStatuses.value, [gameNumber]: null }
  } catch {}
}

async function fetchLobbyStatus(gameNumber: number) {
  const cId = compId.value
  if (!cId) return
  try {
    const data = await api.getLobbyStatus(cId, props.match.id, gameNumber)
    if (data.lobby) lobbyStatuses.value[gameNumber] = data.lobby
  } catch {}
}

// Match ready state
const matchReadyState = ref<Record<number, number[]>>({})

function onReadyState(data: any) {
  if (data.matchId !== props.match.id) return
  matchReadyState.value[data.gameNumber] = data.readyCaptainIds || []
  if (data.lobbyCreated) fetchLobbyStatus(data.gameNumber)
}

function isTeamReady(gameNumber: number, captainId: number) {
  return (matchReadyState.value[gameNumber] || []).includes(captainId)
}

const myCaptainId = computed(() => store.currentCaptain.value?.id || null)
const isCaptainInMatch = computed(() => {
  if (!myCaptainId.value) return false
  return props.match.team1_captain_id === myCaptainId.value || props.match.team2_captain_id === myCaptainId.value
})

function isMyReady(gameNumber: number) {
  return myCaptainId.value && (matchReadyState.value[gameNumber] || []).includes(myCaptainId.value)
}

function toggleReady(gameNumber: number) {
  if (isMyReady(gameNumber)) {
    store.matchUnready(props.match.id, gameNumber)
  } else {
    store.matchReady(props.match.id, gameNumber)
  }
}

// Launch ready (phase 2)
const launchReadyState = ref<Record<number, number[]>>({})

function isLaunchTeamReady(gameNumber: number, captainId: number) {
  return (launchReadyState.value[gameNumber] || []).includes(captainId)
}

function isMyLaunchReady(gameNumber: number) {
  return myCaptainId.value && (launchReadyState.value[gameNumber] || []).includes(myCaptainId.value)
}

function toggleLaunchReady(gameNumber: number) {
  if (isMyLaunchReady(gameNumber)) {
    store.matchLaunchUnready(props.match.id, gameNumber)
  } else {
    store.matchLaunchReady(props.match.id, gameNumber)
  }
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
      expectedTeam: p.team, // "radiant" or "dire"
      joined: !!j,
      actualTeam: j?.team || j?.Team || null,
      correctTeam: j ? (j.team || j.Team) === p.team : false,
    }
  })
}

// Detected Dota team IDs from lobby
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

function onLobbyStatusUpdate(data: any) {
  if (Number(data.matchId) !== Number(props.match.id)) return
  if (!data.status) {
    const copy = { ...lobbyStatuses.value }
    delete copy[data.gameNumber]
    lobbyStatuses.value = copy
  } else {
    lobbyStatuses.value = { ...lobbyStatuses.value, [data.gameNumber]: { ...(lobbyStatuses.value[data.gameNumber] || {}), status: data.status, ...(data.playersJoined ? { players_joined: data.playersJoined } : {}) } }
  }
  if (data.status !== 'waiting') {
    launchReadyState.value = { ...launchReadyState.value, [data.gameNumber]: [] }
  }
  // Show/clear error messages
  if (data.errorMessage) {
    lobbyError.value = { ...lobbyError.value, [data.gameNumber]: data.errorMessage }
  } else if (data.status && data.status !== 'waiting') {
    const copy = { ...lobbyError.value }
    delete copy[data.gameNumber]
    lobbyError.value = copy
  }
}

const sock = getSocket()

// Fetch lobby status for all games on mount
onMounted(() => {
  sock.on('match:readyState', onReadyState)
  sock.on('match:launchReadyState', onLaunchReadyState)
  sock.on('lobby:statusUpdate', onLobbyStatusUpdate)
  sock.on('lobby:teamIds', onLobbyTeamIds)
  // Already runs game init above, now also check lobbies and ready state
  for (const g of games.value) {
    fetchLobbyStatus(g.game_number)
    store.getMatchReadyState(props.match.id, g.game_number)
  }
})

onUnmounted(() => {
  sock.off('match:readyState', onReadyState)
  sock.off('match:launchReadyState', onLaunchReadyState)
  sock.off('lobby:statusUpdate', onLobbyStatusUpdate)
  sock.off('lobby:teamIds', onLobbyTeamIds)
})
</script>

<template>
  <ModalOverlay :show="true" wide @close="emit('close')">
    <div class="border-b border-border px-7 py-6">
      <h2 class="text-xl font-semibold text-foreground">{{ t('matchScore') }}</h2>
      <div class="flex items-center gap-3 mt-2">
        <span class="text-sm font-medium text-foreground">{{ match.team1_name || t('tbd') }}</span>
        <span class="text-lg font-bold text-primary">{{ score1 }}</span>
        <span class="text-muted-foreground">:</span>
        <span class="text-lg font-bold text-primary">{{ score2 }}</span>
        <span class="text-sm font-medium text-foreground">{{ match.team2_name || t('tbd') }}</span>
      </div>
    </div>

    <div class="px-7 py-5 flex flex-col gap-4 max-h-[60vh] overflow-y-auto">
      <div v-for="(game, idx) in games" :key="idx" class="rounded-lg border border-border overflow-hidden">
        <!-- Game header -->
        <div class="flex items-center justify-between px-4 py-3 bg-accent/30 border-b border-border">
          <div class="flex items-center gap-2">
            <Gamepad2 class="w-4 h-4 text-muted-foreground" />
            <span class="text-sm font-semibold text-foreground">{{ t('game') }} {{ game.game_number }}</span>
          </div>
          <div class="flex items-center gap-2">
            <!-- Lobby status badge -->
            <template v-if="lobbyStatuses[game.game_number] && game.game_number === nextGameNumber">
              <span v-if="lobbyStatuses[game.game_number].status === 'cointoss'" class="text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500">{{ t('lobbyCoinToss') }}</span>
              <span v-else-if="lobbyStatuses[game.game_number].status === 'launching'" class="text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500">{{ t('lobbyLaunching') }}</span>
              <span v-else-if="lobbyStatuses[game.game_number].status === 'active'" class="text-[10px] font-medium px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">{{ t('lobbyActive') }}</span>
              <span v-else-if="lobbyStatuses[game.game_number].status === 'completed'" class="text-[10px] font-medium px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">{{ t('matchCompleted') }}</span>
            </template>
            <!-- Stats toggle -->
            <button
              v-if="game.has_stats || (gameStats[game.game_number]?.length)"
              class="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              :title="t('viewStats')"
              @click="toggleStats(game.game_number)"
            >
              <component :is="expandedGame === game.game_number ? ChevronUp : ChevronDown" class="w-4 h-4" />
            </button>
            <button
              v-if="game.dotabuff_id && store.isAdmin"
              class="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              :class="{ 'animate-spin': refetchingGame[game.game_number] }"
              :disabled="refetchingGame[game.game_number]"
              :title="t('refetchStats')"
              @click="refetchStats(game.game_number)"
            >
              <RefreshCw class="w-4 h-4" />
            </button>
          </div>
        </div>

        <!-- Winner + Match ID row -->
        <div class="px-4 py-3 flex items-center gap-3 border-b border-border/30">
          <div class="flex gap-2 flex-1">
            <button
              class="flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-colors"
              :class="game.winner_captain_id === match.team1_captain_id
                ? 'bg-primary text-primary-foreground'
                : 'bg-accent text-foreground hover:bg-accent/80'"
              @click="setGameWinner(idx, match.team1_captain_id)"
            >{{ match.team1_name || 'Team 1' }}</button>
            <button
              class="flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-colors"
              :class="game.winner_captain_id === match.team2_captain_id
                ? 'bg-primary text-primary-foreground'
                : 'bg-accent text-foreground hover:bg-accent/80'"
              @click="setGameWinner(idx, match.team2_captain_id)"
            >{{ match.team2_name || 'Team 2' }}</button>
          </div>
          <input
            v-model="game.dotabuff_id"
            class="input-field !h-9 !text-xs w-36"
            :placeholder="t('dotabuffId')"
          />
        </div>

        <!-- Admin lobby actions -->
        <template v-if="store.isAdmin && match.team1_captain_id && match.team2_captain_id && game.game_number === nextGameNumber">
          <div v-if="!lobbyStatuses[game.game_number] || ['cancelled', 'error'].includes(lobbyStatuses[game.game_number]?.status)"
            class="px-4 py-3 flex items-center justify-between border-b border-border/30">
            <div class="flex items-center gap-3">
              <span class="text-xs text-muted-foreground">{{ t('matchReadyUp') }}:</span>
              <span class="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
                :class="isTeamReady(game.game_number, match.team1_captain_id) ? 'bg-green-500/15 text-green-500' : 'bg-accent text-muted-foreground'">
                <Check v-if="isTeamReady(game.game_number, match.team1_captain_id)" class="w-3 h-3" />
                {{ match.team1_name || 'T1' }}
              </span>
              <span class="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
                :class="isTeamReady(game.game_number, match.team2_captain_id) ? 'bg-green-500/15 text-green-500' : 'bg-accent text-muted-foreground'">
                <Check v-if="isTeamReady(game.game_number, match.team2_captain_id)" class="w-3 h-3" />
                {{ match.team2_name || 'T2' }}
              </span>
            </div>
            <div class="flex items-center gap-1.5">
              <button
                v-if="isCaptainInMatch"
                class="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                :class="isMyReady(game.game_number) ? 'bg-green-500 text-white hover:bg-green-600' : 'bg-primary text-primary-foreground hover:bg-primary/90'"
                @click="toggleReady(game.game_number)"
              >
                <span class="flex items-center gap-1">
                  <Check v-if="isMyReady(game.game_number)" class="w-3 h-3" />
                  {{ isMyReady(game.game_number) ? t('matchReadyLabel') : t('matchReadyUp') }}
                </span>
              </button>
              <button
                class="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                :class="{ 'animate-pulse': creatingLobby[game.game_number] }"
                :disabled="creatingLobby[game.game_number]"
                :title="t('createLobby')"
                @click="confirmCreateGame = game.game_number"
              >
                <Gamepad2 class="w-4 h-4" />
              </button>
            </div>
          </div>

          <!-- Lobby waiting: password + players + launch -->
          <template v-else-if="lobbyStatuses[game.game_number]?.status === 'waiting'">
            <div class="px-4 py-3 flex items-center justify-between border-b border-border/30">
              <div class="flex items-center gap-2 text-sm">
                <span class="text-muted-foreground">{{ t('lobbyPassword') }}:</span>
                <code class="font-mono font-bold bg-accent px-2 py-0.5 rounded text-foreground">{{ lobbyStatuses[game.game_number].password }}</code>
              </div>
              <div class="flex items-center gap-2">
                <span class="text-xs font-medium" :class="allPlayersJoined(game.game_number) ? 'text-green-500' : 'text-muted-foreground'">
                  {{ (lobbyStatuses[game.game_number].players_joined || []).length }}/{{ (lobbyStatuses[game.game_number].players_expected || []).length }} {{ t('players') }}
                </span>
                <button class="p-1.5 rounded-md text-green-500 hover:bg-green-500/10 transition-colors" :title="t('forceLaunch')" @click="confirmForceGame = game.game_number">
                  <Play class="w-4 h-4" />
                </button>
                <button class="p-1.5 rounded-md text-red-500 hover:bg-red-500/10 transition-colors" :title="t('cancelLobby')" @click="confirmCancelGame = game.game_number">
                  <X class="w-4 h-4" />
                </button>
              </div>
            </div>
            <!-- Player list -->
            <div class="px-4 py-2.5 grid grid-cols-2 gap-x-4 gap-y-1 border-b border-border/30">
              <div v-for="p in getPlayerStatuses(game.game_number)" :key="p.steamId" class="flex items-center gap-1.5 text-xs py-0.5">
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
                <template v-if="lobbyTeamIds[game.game_number]?.radiant">
                  <span :class="match.team1_dota_id && lobbyTeamIds[game.game_number].radiant !== match.team1_dota_id ? 'text-red-500' : 'text-green-500'" class="font-medium">
                    {{ lobbyTeamIds[game.game_number].radiantName || lobbyTeamIds[game.game_number].radiant }}
                  </span>
                  <Check v-if="!match.team1_dota_id || lobbyTeamIds[game.game_number].radiant === match.team1_dota_id" class="w-3 h-3 text-green-500" />
                  <X v-else class="w-3 h-3 text-red-500" />
                </template>
                <span v-else class="text-red-500">{{ t('noTeamSet') }}</span>
              </div>
              <div class="flex items-center gap-1.5">
                <span class="text-muted-foreground">Dire:</span>
                <template v-if="lobbyTeamIds[game.game_number]?.dire">
                  <span :class="match.team2_dota_id && lobbyTeamIds[game.game_number].dire !== match.team2_dota_id ? 'text-red-500' : 'text-green-500'" class="font-medium">
                    {{ lobbyTeamIds[game.game_number].direName || lobbyTeamIds[game.game_number].dire }}
                  </span>
                  <Check v-if="!match.team2_dota_id || lobbyTeamIds[game.game_number].dire === match.team2_dota_id" class="w-3 h-3 text-green-500" />
                  <X v-else class="w-3 h-3 text-red-500" />
                </template>
                <span v-else class="text-red-500">{{ t('noTeamSet') }}</span>
              </div>
            </div>
            <!-- Launch ready -->
            <div class="px-4 py-3 flex items-center justify-between">
              <div class="flex items-center gap-2">
                <span class="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
                  :class="isLaunchTeamReady(game.game_number, match.team1_captain_id) ? 'bg-green-500/15 text-green-500' : 'bg-accent text-muted-foreground'">
                  <Check v-if="isLaunchTeamReady(game.game_number, match.team1_captain_id)" class="w-3 h-3" />
                  {{ match.team1_name || 'T1' }}
                </span>
                <span class="text-muted-foreground text-xs">{{ t('vs') }}</span>
                <span class="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
                  :class="isLaunchTeamReady(game.game_number, match.team2_captain_id) ? 'bg-green-500/15 text-green-500' : 'bg-accent text-muted-foreground'">
                  <Check v-if="isLaunchTeamReady(game.game_number, match.team2_captain_id)" class="w-3 h-3" />
                  {{ match.team2_name || 'T2' }}
                </span>
              </div>
              <button
                v-if="isCaptainInMatch"
                class="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                :disabled="!allPlayersJoined(game.game_number)"
                :class="!allPlayersJoined(game.game_number)
                  ? 'bg-accent text-muted-foreground cursor-not-allowed'
                  : isMyLaunchReady(game.game_number)
                    ? 'bg-green-500 text-white hover:bg-green-600'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90'"
                @click="toggleLaunchReady(game.game_number)"
              >
                <span class="flex items-center gap-1">
                  <Check v-if="isMyLaunchReady(game.game_number)" class="w-3 h-3" />
                  {{ isMyLaunchReady(game.game_number) ? t('matchReadyLabel') : t('matchLaunchReady') }}
                </span>
              </button>
            </div>
          </template>

          <!-- Lobby completed/active with reset -->
          <div v-else-if="lobbyStatuses[game.game_number]" class="px-4 py-3 flex items-center justify-end gap-2">
            <button class="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors" :title="t('resetLobby')" @click="resetLobby(game.game_number)">
              <RotateCcw class="w-3.5 h-3.5" />
            </button>
          </div>
        </template>

        <!-- Lobby error -->
        <div v-if="lobbyError[game.game_number]" class="px-4 py-2 text-xs text-red-500 border-b border-border/30">
          {{ lobbyError[game.game_number] }}
        </div>

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

    <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
      <div class="flex items-center gap-3">
        <label class="text-sm text-foreground font-medium">{{ t('statusCol') }}</label>
        <select class="input-field flex-1" v-model="matchStatus">
          <option value="pending">{{ t('matchPending') }}</option>
          <option value="live">{{ t('matchLive') }}</option>
          <option value="completed">{{ t('matchCompleted') }}</option>
        </select>
      </div>
      <div class="flex items-center gap-3">
        <label class="text-sm text-foreground font-medium whitespace-nowrap">{{ t('scheduledTime') }}</label>
        <input type="datetime-local" class="input-field flex-1" v-model="scheduledAt" />
      </div>
      <label class="flex items-center gap-2 cursor-pointer py-1">
        <input type="checkbox" class="w-4 h-4 accent-primary" v-model="isHidden" />
        <EyeOff class="w-4 h-4 text-muted-foreground" />
        <span class="text-sm text-foreground">{{ t('hideMatch') }}</span>
        <span class="text-xs text-muted-foreground">{{ t('hideMatchHint') }}</span>
      </label>
      <button class="btn-primary w-full justify-center" @click="save">
        {{ t('updateScore') }}
      </button>
      <button class="btn-secondary w-full justify-center" @click="emit('close')">{{ t('cancel') }}</button>
    </div>
  </ModalOverlay>

  <!-- Force Launch Confirmation -->
  <ModalOverlay :show="confirmForceGame !== null" @close="confirmForceGame = null">
    <div class="px-7 py-6">
      <h2 class="text-xl font-semibold text-foreground">{{ t('forceLaunch') }}</h2>
      <p class="text-sm text-muted-foreground mt-2">{{ t('forceLaunchConfirm') }}</p>
      <div v-if="confirmForceGame !== null" class="mt-3 flex flex-col gap-1.5 text-xs">
        <div class="flex items-center gap-2">
          <span class="text-muted-foreground">{{ t('players') }}:</span>
          <span :class="allPlayersJoined(confirmForceGame) ? 'text-green-500' : 'text-amber-500'">
            {{ (lobbyStatuses[confirmForceGame]?.players_joined || []).length }}/{{ (lobbyStatuses[confirmForceGame]?.players_expected || []).length }}
          </span>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-muted-foreground">Radiant:</span>
          <span :class="lobbyTeamIds[confirmForceGame]?.radiant ? 'text-green-500' : 'text-red-500'">
            {{ lobbyTeamIds[confirmForceGame]?.radiantName || lobbyTeamIds[confirmForceGame]?.radiant || t('noTeamSet') }}
          </span>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-muted-foreground">Dire:</span>
          <span :class="lobbyTeamIds[confirmForceGame]?.dire ? 'text-green-500' : 'text-red-500'">
            {{ lobbyTeamIds[confirmForceGame]?.direName || lobbyTeamIds[confirmForceGame]?.dire || t('noTeamSet') }}
          </span>
        </div>
      </div>
    </div>
    <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
      <button class="btn-destructive w-full justify-center" @click="forceLaunchLobby(confirmForceGame!); confirmForceGame = null">
        {{ t('forceLaunch') }}
      </button>
      <button class="btn-secondary w-full justify-center" @click="confirmForceGame = null">{{ t('cancel') }}</button>
    </div>
  </ModalOverlay>

  <!-- Create Lobby Confirmation -->
  <ModalOverlay :show="confirmCreateGame !== null" @close="confirmCreateGame = null">
    <div class="px-7 py-6">
      <h2 class="text-xl font-semibold text-foreground">{{ t('createLobby') }}</h2>
      <p class="text-sm text-muted-foreground mt-2">{{ t('createLobbyConfirm') }}</p>
    </div>
    <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
      <button class="btn-primary w-full justify-center" @click="createLobby(confirmCreateGame!); confirmCreateGame = null">
        {{ t('createLobby') }}
      </button>
      <button class="btn-secondary w-full justify-center" @click="confirmCreateGame = null">{{ t('cancel') }}</button>
    </div>
  </ModalOverlay>

  <!-- Cancel Lobby Confirmation -->
  <ModalOverlay :show="confirmCancelGame !== null" @close="confirmCancelGame = null">
    <div class="px-7 py-6">
      <h2 class="text-xl font-semibold text-foreground">{{ t('cancelLobby') }}</h2>
      <p class="text-sm text-muted-foreground mt-2">{{ t('cancelLobbyConfirm') }}</p>
    </div>
    <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
      <button class="btn-destructive w-full justify-center" @click="cancelLobby(confirmCancelGame!); confirmCancelGame = null">
        {{ t('cancelLobby') }}
      </button>
      <button class="btn-secondary w-full justify-center" @click="confirmCancelGame = null">{{ t('cancel') }}</button>
    </div>
  </ModalOverlay>
</template>
