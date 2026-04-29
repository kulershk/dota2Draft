<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ExternalLink, Clock, Trophy, Loader2, ChevronDown } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import { useDotaConstants } from '@/composables/useDotaConstants'
import GameStatsTable from '@/components/match/GameStatsTable.vue'
import DraftPhaseViewer from '@/components/match/DraftPhaseViewer.vue'
import MatchHeaderCard from '@/components/match/MatchHeaderCard.vue'
import TeamRosterTable from '@/components/match/TeamRosterTable.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const api = useApi()
const dota = useDotaConstants()
dota.loadConstants()

const match = ref<any>(null)
const loading = ref(true)
const error = ref<string | null>(null)

const team1 = computed(() => match.value?.team1_players || [])
const team2 = computed(() => match.value?.team2_players || [])
const games = computed(() => match.value?.games || [])
const season = computed(() => match.value?.season || null)

// Show point columns only when (a) season is attached AND (b) at least one
// player on either team has a recorded delta from this match.
const hasPointChanges = computed(() => {
  if (!season.value) return false
  return [...team1.value, ...team2.value].some((p: any) => Number.isFinite(Number(p?.season_delta)))
})

const team1Wins = computed(() => games.value.filter((g: any) => gameWinnerTeam(g) === 1).length)
const team2Wins = computed(() => games.value.filter((g: any) => gameWinnerTeam(g) === 2).length)
const team1Won = computed(() => team1Wins.value > team2Wins.value)
const team2Won = computed(() => team2Wins.value > team1Wins.value)

function teamAvgMmr(players: any[]): number {
  const valid = (players || []).filter((p: any) => Number(p?.mmr) > 0).map((p: any) => Number(p.mmr))
  if (!valid.length) return 0
  return Math.round(valid.reduce((s, m) => s + m, 0) / valid.length)
}
function teamAvgPoints(players: any[]): number {
  const valid = (players || []).filter((p: any) => Number.isFinite(Number(p?.season_points))).map((p: any) => Number(p.season_points))
  if (!valid.length) return 0
  return Math.round(valid.reduce((s, m) => s + m, 0) / valid.length)
}
function fmtSignedDelta(d: number | null | undefined): string {
  const n = Number(d)
  if (!Number.isFinite(n)) return ''
  const r = Math.round(n * 10) / 10
  return r > 0 ? `+${r}` : String(r)
}

// Game stats
const expandedGame = ref<number | null>(null)
const gameStats = ref<Record<number, any[]>>({})
const gamePicksBans = ref<Record<number, any[]>>({})
const loadingStats = ref<Record<number, boolean>>({})

function statusColor(status: string) {
  switch (status) {
    case 'completed': return 'bg-green-500/10 text-green-500'
    case 'live': return 'bg-amber-500/10 text-amber-500'
    case 'picking': return 'bg-blue-500/10 text-blue-500'
    case 'cancelled': return 'bg-destructive/10 text-destructive'
    default: return 'bg-accent text-muted-foreground'
  }
}

function gameWinnerTeam(game: any): 1 | 2 | null {
  if (!game.winner_captain_id) return null
  if (game.winner_captain_id === match.value?.captain1_player_id) return 1
  if (game.winner_captain_id === match.value?.captain2_player_id) return 2
  return null
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString()
}

async function toggleGame(gameNumber: number) {
  if (expandedGame.value === gameNumber) { expandedGame.value = null; return }
  expandedGame.value = gameNumber
  if (!gameStats.value[gameNumber]) await loadStats(gameNumber)
}

async function loadStats(gameNumber: number) {
  loadingStats.value[gameNumber] = true
  try {
    const data = await api.getQueueMatchGameStats(Number(route.params.id), gameNumber)
    gameStats.value[gameNumber] = data.stats || []
    gamePicksBans.value[gameNumber] = data.picks_bans || []
  } catch {
    gameStats.value[gameNumber] = []
  } finally {
    loadingStats.value[gameNumber] = false
  }
}

function playerDisplayName(p: any): string {
  return p.profile_display_name || p.profile_name || p.player_name || String(p.account_id)
}

// Position estimation
const playerPositions = computed(() => {
  const positions: Record<string, Record<number, number>> = {}
  for (const [gn, stats] of Object.entries(gameStats.value)) {
    if (!stats?.length) continue
    const gp: Record<number, number> = {}
    for (const side of [true, false]) {
      const team = stats.filter((p: any) => p.is_radiant === side).sort((a: any, b: any) => b.net_worth - a.net_worth)
      if (team.length < 5) { team.forEach((p: any, i: number) => { gp[p.account_id] = i + 1 }); continue }
      const cores = team.slice(0, 3), supports = team.slice(3)
      const assigned = new Set<number>(), cp: Record<number, number> = {}
      const mid = cores.find((p: any) => p.lane_role === 2)
      if (mid) { cp[mid.account_id] = 2; assigned.add(mid.account_id) }
      const safe = cores.find((p: any) => p.lane_role === 1 && !assigned.has(p.account_id))
      if (safe) { cp[safe.account_id] = 1; assigned.add(safe.account_id) }
      const off = cores.find((p: any) => p.lane_role === 3 && !assigned.has(p.account_id))
      if (off) { cp[off.account_id] = 3; assigned.add(off.account_id) }
      const un = [1, 2, 3].filter(pos => !Object.values(cp).includes(pos))
      let ui = 0
      for (const p of cores) { if (!assigned.has(p.account_id)) { cp[p.account_id] = un[ui++]; assigned.add(p.account_id) } }
      for (const [a, pos] of Object.entries(cp)) gp[Number(a)] = pos
      gp[supports[0].account_id] = 4
      gp[supports[1].account_id] = 5
    }
    positions[gn] = gp
  }
  return positions
})

function getGameDuration(gameNumber: number): string {
  const stats = gameStats.value[gameNumber]
  if (!stats?.length) return ''
  const dur = stats[0]?.duration_seconds
  if (!dur) return ''
  return `${Math.floor(dur / 60)}:${(dur % 60).toString().padStart(2, '0')}`
}

function getDraftPhases(gameNumber: number) {
  const pbs = (gamePicksBans.value[gameNumber] || []).slice().sort((a: any, b: any) => a.order - b.order)
  if (!pbs.length) return []
  const phases: { type: string; label: string; items: any[] }[] = []
  let currentType: string | null = null
  const count = { ban: 0, pick: 0 }
  for (const pb of pbs) {
    const type = pb.is_pick ? 'pick' : 'ban'
    if (type !== currentType) { currentType = type; count[type as 'ban'|'pick']++; phases.push({ type, label: `${type === 'ban' ? 'Ban' : 'Pick'} ${count[type as 'ban'|'pick']}`, items: [] }) }
    phases[phases.length - 1].items.push(pb)
  }
  return phases
}

onMounted(async () => {
  try {
    match.value = await api.getQueueMatch(Number(route.params.id))
    // Auto-expand the first game with stats so the user lands directly on detail.
    const firstWithStats = (match.value?.games || []).find((g: any) => g.has_stats || g.dotabuff_id)
    if (firstWithStats) {
      expandedGame.value = firstWithStats.game_number
      loadStats(firstWithStats.game_number)
    }
  } catch (e: any) {
    error.value = e.message || 'Match not found'
  }
  loading.value = false
})
</script>

<template>
  <div>
    <div class="max-w-[1100px] mx-auto px-4 md:px-8 py-6">
      <!-- Loading -->
      <div v-if="loading" class="card px-8 py-16 text-center">
        <Loader2 class="w-8 h-8 text-primary mx-auto animate-spin" />
      </div>

      <!-- Error -->
      <div v-else-if="error" class="card px-8 py-16 text-center">
        <p class="text-destructive font-semibold">{{ error }}</p>
        <button class="btn-outline mt-4" @click="router.push('/queue')">{{ t('queueBackToQueue') }}</button>
      </div>

      <template v-else-if="match">

        <MatchHeaderCard
          class="mb-5"
          :back="{
            onClick: () => router.push('/queue'),
            label: t('queueBackToMatches'),
            subtitle: [match.pool_name, match.created_at && formatDate(match.created_at)].filter(Boolean).join(' · '),
          }"
          :match-id="match.id"
          :match-id-prefix="t('queueMatchHash')"
          :status="match.status"
          :status-label="match.status === 'completed' ? t('matchCompleted') : match.status === 'live' ? t('matchLive') : match.status"
          :season="season"
          :player-count="team1.length + team2.length"
          :game-count="games.length || null"
          :left="{
            id: match.captain1_player_id,
            name: match.captain1_display_name || match.captain1_name,
            type: 'player',
            mmr: teamAvgMmr(team1),
            points: hasPointChanges ? teamAvgPoints(team1) : undefined,
          }"
          :right="{
            id: match.captain2_player_id,
            name: match.captain2_display_name || match.captain2_name,
            type: 'player',
            mmr: teamAvgMmr(team2),
            points: hasPointChanges ? teamAvgPoints(team2) : undefined,
          }"
          :score-left="team1Wins"
          :score-right="team2Wins"
          :left-won="team1Won"
          :right-won="team2Won"
          :has-points="hasPointChanges"
        />

        <!-- Two team result cards -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <TeamRosterTable
            team-color="green"
            :team-name="match.captain1_display_name || match.captain1_name"
            :team-result-label="team1Won ? t('queueResultVictory') : (team2Won ? t('queueResultDefeat') : t('matchLive'))"
            :team-won="team1Won"
            :has-point-changes="hasPointChanges"
            :players="team1.map((p: any) => ({
              id: p.playerId,
              name: p.name,
              avatarUrl: p.avatarUrl,
              mmr: p.mmr,
              pointsAfter: p.points_after,
              seasonDelta: p.season_delta,
              verified: p.mmr_verified_at,
            }))"
          />
          <TeamRosterTable
            team-color="red"
            :team-name="match.captain2_display_name || match.captain2_name"
            :team-result-label="team2Won ? t('queueResultVictory') : (team1Won ? t('queueResultDefeat') : t('matchLive'))"
            :team-won="team2Won"
            :has-point-changes="hasPointChanges"
            :players="team2.map((p: any) => ({
              id: p.playerId,
              name: p.name,
              avatarUrl: p.avatarUrl,
              mmr: p.mmr,
              pointsAfter: p.points_after,
              seasonDelta: p.season_delta,
              verified: p.mmr_verified_at,
            }))"
          />
        </div>

        <!-- Games -->
        <div v-if="games.length > 0">
          <h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">{{ t('queueGames') }}</h2>
          <div class="flex flex-col gap-3">
            <div v-for="game in games" :key="game.id" class="card overflow-hidden">
              <!-- Game header (clickable) -->
              <button class="w-full px-5 py-4 flex items-center justify-between hover:bg-accent/20 transition-colors" @click="toggleGame(game.game_number)">
                <div class="flex items-center gap-3">
                  <span class="text-sm font-bold">{{ t('queueGameNumber', { n: game.game_number }) }}</span>
                  <template v-if="gameWinnerTeam(game)">
                    <Trophy class="w-4 h-4" :class="gameWinnerTeam(game) === 1 ? 'text-green-400' : 'text-red-400'" />
                    <span class="text-xs font-semibold" :class="gameWinnerTeam(game) === 1 ? 'text-green-400' : 'text-red-400'">
                      {{ gameWinnerTeam(game) === 1 ? (match.captain1_display_name || match.captain1_name) : (match.captain2_display_name || match.captain2_name) }}
                    </span>
                  </template>
                  <span v-else class="text-xs text-muted-foreground">{{ t('queueGamePending') }}</span>
                </div>
                <div class="flex items-center gap-4">
                  <span v-if="game.duration_minutes" class="text-xs text-muted-foreground flex items-center gap-1">
                    <Clock class="w-3 h-3" /> {{ game.duration_minutes }}m
                  </span>
                  <a v-if="game.dotabuff_id"
                    :href="`https://www.opendota.com/matches/${game.dotabuff_id}`"
                    target="_blank" @click.stop
                    class="flex items-center gap-1 text-xs text-primary hover:underline">
                    OpenDota <ExternalLink class="w-3 h-3" />
                  </a>
                  <ChevronDown v-if="game.has_stats || game.dotabuff_id" class="w-4 h-4 text-muted-foreground transition-transform" :class="expandedGame === game.game_number ? 'rotate-180' : ''" />
                </div>
              </button>

              <!-- Expanded stats -->
              <div v-if="expandedGame === game.game_number" class="border-t border-border/30">
                <div v-if="loadingStats[game.game_number]" class="py-8 text-center">
                  <Loader2 class="w-6 h-6 text-primary mx-auto animate-spin" />
                </div>
                <div v-else-if="!gameStats[game.game_number]?.length" class="py-6 text-center text-sm text-muted-foreground">
                  {{ t('queueGamePending') }}
                </div>
                <template v-else>
                  <!-- Duration -->
                  <div v-if="getGameDuration(game.game_number)" class="px-5 py-2 text-xs text-muted-foreground border-b border-border/20">
                    Duration: {{ getGameDuration(game.game_number) }}
                  </div>

                  <!-- Stats table -->
                  <GameStatsTable
                    :stats="gameStats[game.game_number]"
                    :player-positions="playerPositions[game.game_number]"
                    :team1-name="t('queueRadiant')"
                    :team2-name="t('queueDire')"
                    :dota="dota"
                  />

                  <!-- Draft -->
                  <div v-if="gamePicksBans[game.game_number]?.length" class="px-5 py-3 border-t border-border/20">
                    <DraftPhaseViewer :phases="getDraftPhases(game.game_number)" :dota="dota" />
                  </div>
                </template>
              </div>
            </div>
          </div>
        </div>

        <!-- No games -->
        <div v-else class="card px-6 py-8 text-center">
          <p class="text-sm text-muted-foreground">{{ t('queueNoGamesYet') }}</p>
        </div>

      </template>
    </div>
  </div>
</template>
