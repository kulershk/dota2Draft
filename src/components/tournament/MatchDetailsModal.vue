<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronUp, Check, Gamepad2, X } from 'lucide-vue-next'
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
const noBotAvailable = ref(false)

const myCaptainId = computed(() => store.currentCaptain.value?.id || null)
const isCaptainInMatch = computed(() => {
  if (!myCaptainId.value) return false
  return props.match.team1_captain_id === myCaptainId.value || props.match.team2_captain_id === myCaptainId.value
})
const bothTeamsAssigned = computed(() => !!props.match.team1_captain_id && !!props.match.team2_captain_id)

// Next game that needs to be played (no winner yet, no active lobby)
const nextGameNumber = computed(() => {
  for (const g of allGames.value) {
    if (!g.winner_captain_id) return g.game_number
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

const lobbyTeamIds = ref<Record<number, { radiant: number; dire: number }>>({})

function onLobbyTeamIds(data: any) {
  if (Number(data.matchId) !== Number(props.match.id)) return
  lobbyTeamIds.value = { ...lobbyTeamIds.value, [data.gameNumber]: { radiant: data.radiantTeamId || 0, dire: data.direTeamId || 0 } }
}

function onLaunchReadyState(data: any) {
  if (data.matchId !== props.match.id) return
  launchReadyState.value[data.gameNumber] = data.readyCaptainIds || []
}

// Socket listener for ready state updates
function onReadyState(data: any) {
  if (data.matchId !== props.match.id) return
  matchReadyState.value[data.gameNumber] = data.readyCaptainIds || []
  if (data.noBotAvailable) noBotAvailable.value = true
  else noBotAvailable.value = false
  if (data.lobbyCreated) {
    fetchLobbyStatus(data.gameNumber)
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
    <div class="border-b border-border px-7 py-6">
      <h2 class="text-xl font-semibold text-foreground">{{ t('matchDetails') }}</h2>
      <div class="flex items-center gap-3 mt-2">
        <span class="text-sm font-medium text-foreground">{{ match.team1_name || t('tbd') }}</span>
        <span class="text-lg font-bold text-primary">{{ score1 }}</span>
        <span class="text-muted-foreground">:</span>
        <span class="text-lg font-bold text-primary">{{ score2 }}</span>
        <span class="text-sm font-medium text-foreground">{{ match.team2_name || t('tbd') }}</span>
      </div>
      <div v-if="match.status" class="mt-1">
        <span class="text-xs font-semibold uppercase"
          :class="match.status === 'completed' ? 'text-green-500' : match.status === 'live' ? 'text-amber-500' : 'text-muted-foreground'">
          {{ match.status === 'completed' ? t('matchCompleted') : match.status === 'live' ? t('matchLive') : t('matchPending') }}
        </span>
      </div>
    </div>

    <div class="px-7 py-5 flex flex-col gap-3 max-h-[65vh] overflow-y-auto">
      <!-- Match Ready Section -->
      <div v-if="isCaptainInMatch && bothTeamsAssigned && match.status !== 'completed'" class="flex flex-col gap-3">
        <div v-for="g in allGames" :key="'ready-' + g.game_number" class="flex flex-col gap-2">
          <template v-if="!g.winner_captain_id">
            <div class="flex items-center justify-between p-3 rounded-lg border border-border bg-accent/20">
              <div class="flex items-center gap-3">
                <span class="text-xs font-semibold text-muted-foreground">{{ t('game') }} {{ g.game_number }}</span>
                <div class="flex items-center gap-2">
                  <span class="text-xs px-2 py-0.5 rounded-full font-medium"
                    :class="(matchReadyState[g.game_number] || []).includes(match.team1_captain_id) ? 'bg-green-500/15 text-green-500' : 'bg-accent text-muted-foreground'">
                    {{ match.team1_name || 'Team 1' }}
                  </span>
                  <span class="text-xs px-2 py-0.5 rounded-full font-medium"
                    :class="(matchReadyState[g.game_number] || []).includes(match.team2_captain_id) ? 'bg-green-500/15 text-green-500' : 'bg-accent text-muted-foreground'">
                    {{ match.team2_name || 'Team 2' }}
                  </span>
                </div>
              </div>
              <div class="flex items-center gap-2">
                <!-- Phase 2: Lobby waiting — launch ready -->
                <template v-if="lobbyStatuses[g.game_number]?.status === 'waiting'">
                  <div class="flex items-center gap-2 text-xs">
                    <Gamepad2 class="w-3.5 h-3.5 text-amber-500" />
                    <code class="font-mono bg-accent px-1.5 py-0.5 rounded text-foreground">{{ lobbyStatuses[g.game_number].password }}</code>
                    <span class="text-muted-foreground">
                      {{ (lobbyStatuses[g.game_number].players_joined || []).length }}/{{ (lobbyStatuses[g.game_number].players_expected || []).length }}
                    </span>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <span class="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                      :class="(launchReadyState[g.game_number] || []).includes(match.team1_captain_id) ? 'bg-green-500/15 text-green-500' : 'bg-accent text-muted-foreground'">
                      {{ match.team1_name || 'T1' }}
                    </span>
                    <span class="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                      :class="(launchReadyState[g.game_number] || []).includes(match.team2_captain_id) ? 'bg-green-500/15 text-green-500' : 'bg-accent text-muted-foreground'">
                      {{ match.team2_name || 'T2' }}
                    </span>
                  </div>
                  <button
                    class="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                    :disabled="!allPlayersJoined(g.game_number)"
                    :class="!allPlayersJoined(g.game_number)
                      ? 'bg-accent text-muted-foreground cursor-not-allowed'
                      : isLaunchReady(g.game_number)
                        ? 'bg-green-500 text-white hover:bg-green-600'
                        : 'bg-primary text-primary-foreground hover:bg-primary/90'"
                    @click="toggleLaunchReady(g.game_number)"
                  >
                    <span class="flex items-center gap-1.5">
                      <Check v-if="isLaunchReady(g.game_number)" class="w-3.5 h-3.5" />
                      {{ isLaunchReady(g.game_number) ? t('matchReadyLabel') : t('matchLaunchReady') }}
                    </span>
                  </button>
                </template>
                <!-- Creating / Active -->
                <span v-else-if="lobbyStatuses[g.game_number]?.status === 'creating'" class="text-xs text-muted-foreground">
                  {{ t('lobbyCreating') }}
                </span>
                <span v-else-if="lobbyStatuses[g.game_number]?.status === 'active'" class="text-xs text-green-500">
                  {{ t('lobbyActive') }}
                </span>
                <!-- No bot -->
                <span v-else-if="noBotAvailable && bothCaptainsReady(g.game_number)" class="text-xs text-amber-500">
                  {{ t('noBotAvailable') }}
                </span>
                <!-- Phase 1: Ready to create lobby -->
                <button
                  v-if="!lobbyStatuses[g.game_number] || ['cancelled', 'error', 'completed'].includes(lobbyStatuses[g.game_number]?.status)"
                  class="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                  :class="isReady(g.game_number)
                    ? 'bg-green-500 text-white hover:bg-green-600'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90'"
                  @click="toggleReady(g.game_number)"
                >
                  <span class="flex items-center gap-1.5">
                    <Check v-if="isReady(g.game_number)" class="w-3.5 h-3.5" />
                    {{ isReady(g.game_number) ? t('matchReadyLabel') : t('matchReadyUp') }}
                  </span>
                </button>
              </div>
              <!-- Player join status + team IDs -->
              <div v-if="lobbyStatuses[g.game_number]?.status === 'waiting' && (lobbyStatuses[g.game_number].players_expected || []).length > 0"
                class="border-t border-border/30 px-3 py-2 flex flex-col gap-1.5">
                <div class="flex flex-wrap gap-x-3 gap-y-1">
                  <div v-for="p in getPlayerStatuses(g.game_number)" :key="p.steamId" class="flex items-center gap-1 text-[10px]">
                    <span class="w-1.5 h-1.5 rounded-full" :class="p.joined ? (p.correctTeam ? 'bg-green-500' : 'bg-amber-500') : 'bg-muted-foreground/30'"></span>
                    <span :class="p.joined ? 'text-foreground' : 'text-muted-foreground'">{{ p.name }}</span>
                    <span v-if="p.joined && !p.correctTeam" class="text-amber-500">({{ p.actualTeam }})</span>
                  </div>
                </div>
                <div v-if="lobbyTeamIds[g.game_number] && (lobbyTeamIds[g.game_number].radiant || lobbyTeamIds[g.game_number].dire)" class="flex gap-3 text-[10px]">
                  <span class="flex items-center gap-1">
                    <span class="text-muted-foreground">Radiant:</span>
                    <span :class="match.team1_dota_id && lobbyTeamIds[g.game_number].radiant !== match.team1_dota_id ? 'text-red-500 font-semibold' : 'text-foreground'">
                      {{ lobbyTeamIds[g.game_number].radiant || t('noTeamSet') }}
                    </span>
                    <Check v-if="!match.team1_dota_id || lobbyTeamIds[g.game_number].radiant === match.team1_dota_id" class="w-2.5 h-2.5 text-green-500" />
                    <X v-else class="w-2.5 h-2.5 text-red-500" />
                  </span>
                  <span class="flex items-center gap-1">
                    <span class="text-muted-foreground">Dire:</span>
                    <span :class="match.team2_dota_id && lobbyTeamIds[g.game_number].dire !== match.team2_dota_id ? 'text-red-500 font-semibold' : 'text-foreground'">
                      {{ lobbyTeamIds[g.game_number].dire || t('noTeamSet') }}
                    </span>
                    <Check v-if="!match.team2_dota_id || lobbyTeamIds[g.game_number].dire === match.team2_dota_id" class="w-2.5 h-2.5 text-green-500" />
                    <X v-else class="w-2.5 h-2.5 text-red-500" />
                  </span>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>

      <div v-if="games.length === 0 && !isCaptainInMatch" class="text-sm text-muted-foreground text-center py-6">
        {{ t('noGamesYet') }}
      </div>

      <div v-for="game in games" :key="game.game_number" class="flex flex-col rounded-lg bg-accent/30">
        <div
          class="flex items-center gap-3 p-3 cursor-pointer hover:bg-accent/50 transition-colors"
          @click="toggleStats(game.game_number)"
        >
          <span class="text-xs font-semibold text-muted-foreground w-16">{{ t('game') }} {{ game.game_number }}</span>
          <span v-if="winnerName(game)" class="text-sm font-medium text-foreground flex-1">
            {{ winnerName(game) }}
          </span>
          <span v-else class="text-sm text-muted-foreground flex-1">-</span>
          <span v-if="game.dotabuff_id" class="text-[10px] text-muted-foreground">
            #{{ game.dotabuff_id }}
          </span>
          <component :is="expandedGame === game.game_number ? ChevronUp : ChevronDown" class="w-4 h-4 text-muted-foreground" />
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

    <div class="px-7 py-4 border-t border-border">
      <button class="btn-secondary w-full justify-center" @click="emit('close')">{{ t('close') }}</button>
    </div>
  </ModalOverlay>
</template>
