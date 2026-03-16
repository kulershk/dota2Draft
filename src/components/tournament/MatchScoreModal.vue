<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { EyeOff, RefreshCw, ChevronDown, ChevronUp, Gamepad2, Play, X } from 'lucide-vue-next'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'

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
const expandedGame = ref<number | null>(null)
const gameStats = ref<Record<number, any[]>>({})
const loadingStats = ref<Record<number, boolean>>({})
const refetchingGame = ref<Record<number, boolean>>({})

onMounted(() => {
  isHidden.value = !!props.match.hidden
  matchStatus.value = props.match.status || 'pending'
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
    games: games.value.filter(g => g.winner_captain_id || g.dotabuff_id),
    hidden: isHidden.value,
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

async function fetchLobbyStatus(gameNumber: number) {
  const cId = compId.value
  if (!cId) return
  try {
    const data = await api.getLobbyStatus(cId, props.match.id, gameNumber)
    if (data.lobby) lobbyStatuses.value[gameNumber] = data.lobby
  } catch {}
}

// Fetch lobby status for all games on mount
onMounted(() => {
  // Already runs game init above, now also check lobbies
  for (const g of games.value) {
    fetchLobbyStatus(g.game_number)
  }
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
      <div v-for="(game, idx) in games" :key="idx" class="flex flex-col rounded-lg bg-accent/30">
        <div class="flex items-center gap-3 p-3">
          <span class="text-xs font-semibold text-muted-foreground w-16">{{ t('game') }} {{ game.game_number }}</span>

          <!-- Winner buttons -->
          <div class="flex gap-2 flex-1">
            <button
              class="flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
              :class="game.winner_captain_id === match.team1_captain_id
                ? 'bg-primary text-primary-foreground'
                : 'bg-accent text-foreground hover:bg-accent/80'"
              @click="setGameWinner(idx, match.team1_captain_id)"
            >{{ match.team1_name || 'Team 1' }}</button>
            <button
              class="flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
              :class="game.winner_captain_id === match.team2_captain_id
                ? 'bg-primary text-primary-foreground'
                : 'bg-accent text-foreground hover:bg-accent/80'"
              @click="setGameWinner(idx, match.team2_captain_id)"
            >{{ match.team2_name || 'Team 2' }}</button>
          </div>

          <!-- Dotabuff ID -->
          <input
            v-model="game.dotabuff_id"
            class="input-field !h-8 !text-xs w-36"
            :placeholder="t('dotabuffId')"
          />

          <!-- Lobby actions -->
          <template v-if="store.isAdmin && match.team1_captain_id && match.team2_captain_id">
            <button
              v-if="!lobbyStatuses[game.game_number] || lobbyStatuses[game.game_number]?.status === 'cancelled' || lobbyStatuses[game.game_number]?.status === 'error'"
              class="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              :class="{ 'animate-pulse': creatingLobby[game.game_number] }"
              :disabled="creatingLobby[game.game_number]"
              :title="t('createLobby')"
              @click="createLobby(game.game_number)"
            >
              <Gamepad2 class="w-4 h-4" />
            </button>
            <template v-else-if="lobbyStatuses[game.game_number]?.status === 'waiting'">
              <button
                class="p-1.5 rounded-md text-green-500 hover:bg-green-500/10 transition-colors"
                :title="t('forceLaunch')"
                @click="forceLaunchLobby(game.game_number)"
              >
                <Play class="w-4 h-4" />
              </button>
              <button
                class="p-1.5 rounded-md text-red-500 hover:bg-red-500/10 transition-colors"
                :title="t('cancelLobby')"
                @click="cancelLobby(game.game_number)"
              >
                <X class="w-4 h-4" />
              </button>
            </template>
            <span
              v-else-if="lobbyStatuses[game.game_number]"
              class="text-[10px] font-medium px-1.5 py-0.5 rounded"
              :class="lobbyStatuses[game.game_number].status === 'completed' ? 'bg-green-500/10 text-green-500'
                : lobbyStatuses[game.game_number].status === 'active' ? 'bg-amber-500/10 text-amber-500'
                : 'bg-accent text-muted-foreground'"
            >{{ lobbyStatuses[game.game_number].status }}</span>
          </template>

          <!-- Stats actions -->
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

        <!-- Lobby info -->
        <div v-if="lobbyStatuses[game.game_number] && lobbyStatuses[game.game_number].status === 'waiting'" class="border-t border-border/50 px-3 py-2 flex items-center gap-3 text-xs">
          <span class="text-muted-foreground">{{ t('lobbyPassword') }}:</span>
          <code class="text-foreground font-mono bg-accent px-2 py-0.5 rounded">{{ lobbyStatuses[game.game_number].password }}</code>
          <span class="text-muted-foreground ml-auto">
            {{ (lobbyStatuses[game.game_number].players_joined || []).length }}/{{ (lobbyStatuses[game.game_number].players_expected || []).length }}
          </span>
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
</template>
