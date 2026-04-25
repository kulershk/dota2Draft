<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ArrowLeft, ExternalLink, Clock, Trophy, Swords, Loader2, ChevronDown, Shield, Medal, Users } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import { useDotaConstants } from '@/composables/useDotaConstants'
import PositionIcon from '@/components/common/PositionIcon.vue'
import UserName from '@/components/common/UserName.vue'

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

function teamWon(gameNumber: number, isRadiant: boolean): boolean {
  return !!(gameStats.value[gameNumber] || []).find((s: any) => s.is_radiant === isRadiant && s.win)
}

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

        <!-- Breadcrumb -->
        <button
          class="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors mb-3"
          @click="router.push('/queue')"
        >
          <ArrowLeft class="w-3.5 h-3.5 text-primary" />
          <span class="text-primary font-semibold">{{ t('queueBackToMatches') }}</span>
          <span v-if="match.pool_name || match.created_at" class="text-muted-foreground">·</span>
          <span v-if="match.pool_name" class="text-muted-foreground">{{ match.pool_name }}</span>
          <span v-if="match.pool_name && match.created_at" class="text-muted-foreground/50">·</span>
          <span v-if="match.created_at" class="text-muted-foreground/80 font-mono">{{ formatDate(match.created_at) }}</span>
        </button>

        <!-- Hero card -->
        <div class="card p-7 mb-5 flex flex-col gap-6">
          <!-- Meta row -->
          <div class="flex items-center justify-between flex-wrap gap-3">
            <div class="flex items-center gap-3">
              <Swords class="w-5 h-5 text-primary" />
              <h1 class="text-lg font-bold">{{ t('queueMatchHash') }}{{ match.id }}</h1>
              <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded" :class="statusColor(match.status)">
                {{ match.status === 'completed' ? t('matchCompleted') : match.status === 'live' ? t('matchLive') : match.status }}
              </span>
              <router-link
                v-if="season"
                :to="{ name: 'season-leaderboard', params: { slug: season.slug } }"
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-400 text-[11px] font-bold hover:bg-amber-500/25 transition-colors"
              >
                <Medal class="w-3 h-3" />
                {{ season.name }}
              </router-link>
            </div>
            <div class="flex items-center gap-4 text-[11px] text-muted-foreground font-mono">
              <span class="flex items-center gap-1.5">
                <Users class="w-3.5 h-3.5" /> {{ team1.length + team2.length }}
              </span>
              <span v-if="games.length" class="flex items-center gap-1.5">
                <Clock class="w-3.5 h-3.5" /> {{ games.length }}{{ games.length === 1 ? ' game' : ' games' }}
              </span>
            </div>
          </div>

          <!-- Score row -->
          <div class="grid grid-cols-[1fr_auto_1fr] items-center gap-6">
            <div class="flex items-center gap-3 min-w-0">
              <div class="w-10 h-10 rounded-lg bg-green-500/15 border border-green-500/30 flex items-center justify-center shrink-0">
                <Shield class="w-5 h-5 text-green-500" />
              </div>
              <div class="min-w-0">
                <router-link :to="{ name: 'player-profile', params: { id: match.captain1_player_id } }" class="font-bold truncate block hover:text-primary transition-colors">
                  {{ match.captain1_display_name || match.captain1_name }}
                </router-link>
                <div class="text-[10px] font-mono text-muted-foreground tabular-nums">
                  <span class="text-green-400 font-bold">{{ t('queueRadiant').toUpperCase() }}</span>
                  <span class="mx-1.5">·</span>
                  <span>{{ teamAvgMmr(team1) }} MMR</span>
                  <template v-if="hasPointChanges">
                    <span class="mx-1.5">·</span>
                    <span>{{ teamAvgPoints(team1) }} {{ t('seasonPoints').toUpperCase() }}</span>
                  </template>
                </div>
              </div>
            </div>
            <div class="flex items-center gap-4 px-5 py-3 rounded-2xl bg-[#0A0F1C] border border-border/40">
              <span class="text-4xl font-bold tabular-nums" :class="team1Won ? 'text-green-400' : 'text-foreground/70'">{{ team1Wins }}</span>
              <span class="text-muted-foreground/40 text-2xl font-bold">·</span>
              <span class="text-4xl font-bold tabular-nums" :class="team2Won ? 'text-red-400' : 'text-foreground/70'">{{ team2Wins }}</span>
            </div>
            <div class="flex items-center gap-3 min-w-0 justify-end">
              <div class="min-w-0 text-right">
                <router-link :to="{ name: 'player-profile', params: { id: match.captain2_player_id } }" class="font-bold truncate block hover:text-primary transition-colors">
                  {{ match.captain2_display_name || match.captain2_name }}
                </router-link>
                <div class="text-[10px] font-mono text-muted-foreground tabular-nums">
                  <template v-if="hasPointChanges">
                    <span>{{ teamAvgPoints(team2) }} {{ t('seasonPoints').toUpperCase() }}</span>
                    <span class="mx-1.5">·</span>
                  </template>
                  <span>{{ teamAvgMmr(team2) }} MMR</span>
                  <span class="mx-1.5">·</span>
                  <span class="text-red-400 font-bold">{{ t('queueDire').toUpperCase() }}</span>
                </div>
              </div>
              <div class="w-10 h-10 rounded-lg bg-red-500/15 border border-red-500/30 flex items-center justify-center shrink-0">
                <Shield class="w-5 h-5 text-red-500" />
              </div>
            </div>
          </div>
        </div>

        <!-- Two team result cards -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <!-- Radiant -->
          <div class="card overflow-hidden border-green-500/40">
            <div class="flex items-center justify-between px-5 py-4 bg-green-500/10 border-b border-green-500/30">
              <div class="flex items-center gap-2">
                <Shield class="w-4 h-4 text-green-500" />
                <span class="font-bold text-sm">{{ match.captain1_display_name || match.captain1_name }}</span>
                <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ml-1"
                      :class="team1Won ? 'bg-green-500/15 text-green-500' : 'bg-muted/40 text-muted-foreground'">
                  {{ team1Won ? t('queueResultVictory') : (team2Won ? t('queueResultDefeat') : t('matchLive')) }}
                </span>
              </div>
            </div>
            <div class="px-5 py-2.5 grid items-center text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border/30"
                 :style="hasPointChanges ? 'grid-template-columns: 1fr 80px 90px 80px;' : 'grid-template-columns: 1fr 100px;'">
              <span>{{ t('player') }}</span>
              <span class="text-right">MMR</span>
              <template v-if="hasPointChanges">
                <span class="text-right">{{ t('seasonPoints') }}</span>
                <span class="text-right">{{ t('seasonChange') }}</span>
              </template>
            </div>
            <div>
              <div v-for="(p, idx) in team1" :key="p.playerId || idx"
                   class="px-5 py-2.5 grid items-center border-b border-border/20 last:border-b-0 hover:bg-accent/15 transition-colors"
                   :style="hasPointChanges ? 'grid-template-columns: 1fr 80px 90px 80px;' : 'grid-template-columns: 1fr 100px;'">
                <div class="flex items-center gap-2 min-w-0">
                  <UserName :id="p.playerId" :name="p.name" :avatar-url="p.avatarUrl" :verified="p.mmr_verified_at" size="md" class="min-w-0" />
                  <span v-if="idx === 0" class="text-[9px] font-bold text-green-400 bg-green-500/10 px-1.5 py-0.5 rounded shrink-0">CPT</span>
                </div>
                <span class="text-right text-xs font-mono text-muted-foreground tabular-nums">{{ p.mmr }}</span>
                <template v-if="hasPointChanges">
                  <span class="text-right text-xs font-mono font-bold tabular-nums">
                    <template v-if="Number.isFinite(Number(p.points_after))">{{ Math.round(Number(p.points_after)) }}</template>
                    <template v-else>—</template>
                  </span>
                  <span class="text-right text-xs font-mono font-bold tabular-nums"
                        :class="Number(p.season_delta) > 0 ? 'text-green-500' : (Number(p.season_delta) < 0 ? 'text-red-500' : 'text-muted-foreground')">
                    {{ fmtSignedDelta(p.season_delta) || '—' }}
                  </span>
                </template>
              </div>
            </div>
          </div>

          <!-- Dire -->
          <div class="card overflow-hidden border-red-500/40">
            <div class="flex items-center justify-between px-5 py-4 bg-red-500/10 border-b border-red-500/30">
              <div class="flex items-center gap-2">
                <Shield class="w-4 h-4 text-red-500" />
                <span class="font-bold text-sm">{{ match.captain2_display_name || match.captain2_name }}</span>
                <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ml-1"
                      :class="team2Won ? 'bg-green-500/15 text-green-500' : 'bg-muted/40 text-muted-foreground'">
                  {{ team2Won ? t('queueResultVictory') : (team1Won ? t('queueResultDefeat') : t('matchLive')) }}
                </span>
              </div>
            </div>
            <div class="px-5 py-2.5 grid items-center text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border/30"
                 :style="hasPointChanges ? 'grid-template-columns: 1fr 80px 90px 80px;' : 'grid-template-columns: 1fr 100px;'">
              <span>{{ t('player') }}</span>
              <span class="text-right">MMR</span>
              <template v-if="hasPointChanges">
                <span class="text-right">{{ t('seasonPoints') }}</span>
                <span class="text-right">{{ t('seasonChange') }}</span>
              </template>
            </div>
            <div>
              <div v-for="(p, idx) in team2" :key="p.playerId || idx"
                   class="px-5 py-2.5 grid items-center border-b border-border/20 last:border-b-0 hover:bg-accent/15 transition-colors"
                   :style="hasPointChanges ? 'grid-template-columns: 1fr 80px 90px 80px;' : 'grid-template-columns: 1fr 100px;'">
                <div class="flex items-center gap-2 min-w-0">
                  <UserName :id="p.playerId" :name="p.name" :avatar-url="p.avatarUrl" :verified="p.mmr_verified_at" size="md" class="min-w-0" />
                  <span v-if="idx === 0" class="text-[9px] font-bold text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded shrink-0">CPT</span>
                </div>
                <span class="text-right text-xs font-mono text-muted-foreground tabular-nums">{{ p.mmr }}</span>
                <template v-if="hasPointChanges">
                  <span class="text-right text-xs font-mono font-bold tabular-nums">
                    <template v-if="Number.isFinite(Number(p.points_after))">{{ Math.round(Number(p.points_after)) }}</template>
                    <template v-else>—</template>
                  </span>
                  <span class="text-right text-xs font-mono font-bold tabular-nums"
                        :class="Number(p.season_delta) > 0 ? 'text-green-500' : (Number(p.season_delta) < 0 ? 'text-red-500' : 'text-muted-foreground')">
                    {{ fmtSignedDelta(p.season_delta) || '—' }}
                  </span>
                </template>
              </div>
            </div>
          </div>
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
                  <div class="overflow-x-auto">
                    <table class="w-full text-xs">
                      <thead>
                        <tr class="text-muted-foreground border-b border-border/20">
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
                        <template v-for="side in [true, false]" :key="side">
                          <!-- Team header -->
                          <tr :class="side ? 'bg-green-500/10' : 'bg-red-500/10'">
                            <td class="py-2 px-3 sticky left-0 z-10" :class="side ? 'bg-green-500/10 border-l-4 border-green-500' : 'bg-red-500/10 border-l-4 border-red-500'" :colspan="1">
                              <div class="flex items-center gap-2">
                                <span class="text-sm font-bold" :class="side ? 'text-green-500' : 'text-red-400'">{{ side ? t('queueRadiant') : t('queueDire') }}</span>
                                <Trophy v-if="teamWon(game.game_number, side)" class="w-4 h-4 text-amber-500" />
                              </div>
                            </td>
                            <td :colspan="9" class="py-2 px-3 text-right" :class="side ? 'bg-green-500/10' : 'bg-red-500/10'">
                              <span class="text-xs font-mono text-muted-foreground">{{ teamTotalKills(game.game_number, side) }} kills</span>
                              <span class="text-xs font-mono text-amber-500 ml-3">{{ teamTotalNW(game.game_number, side) }}</span>
                            </td>
                          </tr>
                          <!-- Player rows -->
                          <tr v-for="p in sortedTeamStats(game.game_number, side)" :key="p.account_id" class="border-b border-border/10 hover:bg-accent/20">
                            <!-- Hero + Name -->
                            <td class="py-1.5 px-1.5 sticky left-0 bg-card z-10">
                              <div class="flex items-center gap-2">
                                <div class="relative shrink-0">
                                  <img v-if="dota.heroImg(p.hero_id)" :src="dota.heroImg(p.hero_id)" class="w-[60px] h-[42px] rounded object-cover border" />
                                  <span class="absolute -bottom-1 -right-1 text-[9px] font-bold bg-surface text-foreground rounded-full w-5 h-5 flex items-center justify-center border border-border/50">{{ p.level }}</span>
                                </div>
                                <div class="flex flex-col min-w-0">
                                  <router-link v-if="p.profile_id" :to="{ name: 'player-profile', params: { id: p.profile_id } }" class="font-semibold truncate text-xs leading-tight hover:underline" :class="p.win ? 'text-foreground' : 'text-muted-foreground'">
                                    {{ playerDisplayName(p) }}
                                  </router-link>
                                  <span v-else class="font-semibold truncate text-xs leading-tight" :class="p.win ? 'text-foreground' : 'text-muted-foreground'">{{ playerDisplayName(p) }}</span>
                                  <span class="text-[10px] text-muted-foreground/70 leading-tight">{{ dota.heroName(p.hero_id) }}</span>
                                </div>
                              </div>
                            </td>
                            <!-- Position -->
                            <td class="text-center px-0.5">
                              <PositionIcon v-if="playerPositions[game.game_number]?.[p.account_id]" :position="playerPositions[game.game_number][p.account_id]" />
                            </td>
                            <!-- KDA -->
                            <td class="text-center px-1.5 font-mono font-medium whitespace-nowrap">
                              <span class="text-green-500">{{ p.kills }}</span><span class="text-muted-foreground">/</span><span class="text-red-400">{{ p.deaths }}</span><span class="text-muted-foreground">/</span><span>{{ p.assists }}</span>
                            </td>
                            <!-- LH/DN -->
                            <td class="text-center px-1 font-mono whitespace-nowrap">{{ p.last_hits }}<span class="text-muted-foreground">/</span>{{ p.denies }}</td>
                            <!-- NW -->
                            <td class="text-center px-1 font-mono font-medium text-amber-500">{{ (p.net_worth / 1000).toFixed(1) }}k</td>
                            <!-- GPM/XPM -->
                            <td class="text-center px-1 font-mono whitespace-nowrap">{{ p.gpm }}<span class="text-muted-foreground">/</span>{{ p.xpm }}</td>
                            <!-- Items -->
                            <td class="py-1 px-1.5 whitespace-nowrap">
                              <div class="inline-flex flex-col gap-px">
                                <div class="flex gap-px">
                                  <template v-for="(itemId, idx) in [p.item_0, p.item_1, p.item_2]" :key="'t-' + idx">
                                    <img v-if="itemId && dota.itemImg(itemId)" :src="dota.itemImg(itemId)" :title="dota.itemName(itemId)" class="w-[36px] h-[27px] rounded-[2px] object-cover border border-border/20" />
                                    <div v-else class="w-[36px] h-[27px] rounded-[2px] bg-surface/60 border border-border/10"></div>
                                  </template>
                                  <img v-if="p.item_neutral && dota.itemImg(p.item_neutral)" :src="dota.itemImg(p.item_neutral)" :title="dota.itemName(p.item_neutral)" class="w-[27px] h-[27px] rounded-full object-cover border border-amber-500/30 ml-1" />
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
                            <!-- HD -->
                            <td class="text-center px-1 font-mono">{{ (p.hero_damage / 1000).toFixed(1) }}k</td>
                            <!-- TD -->
                            <td class="text-center px-1 font-mono">{{ (p.tower_damage / 1000).toFixed(1) }}k</td>
                            <!-- HH -->
                            <td class="text-center px-1 font-mono">{{ (p.hero_healing / 1000).toFixed(1) }}k</td>
                          </tr>
                        </template>
                      </tbody>
                    </table>
                  </div>

                  <!-- Draft -->
                  <div v-if="gamePicksBans[game.game_number]?.length" class="px-5 py-3 border-t border-border/20">
                    <p class="text-sm font-bold text-foreground mb-2">{{ t('draft') || 'Draft' }}</p>
                    <div class="flex flex-wrap gap-2">
                      <div v-for="phase in getDraftPhases(game.game_number)" :key="phase.label" class="rounded-lg bg-surface/80 px-3 py-2">
                        <span class="text-[10px] font-medium text-muted-foreground mb-1.5 block">{{ phase.label }}</span>
                        <div v-for="teamSide in [1, 0]" :key="teamSide" class="flex items-center gap-0.5 mb-0.5">
                          <template v-for="pb in phase.items.filter((p: any) => p.team === teamSide)" :key="pb.order">
                            <div class="relative overflow-hidden rounded-sm" :title="dota.heroName(pb.hero_id)" style="width: 44px; height: 24px;">
                              <img v-if="dota.heroImg(pb.hero_id)" :src="dota.heroImg(pb.hero_id)" class="w-full h-full object-cover" :class="!pb.is_pick ? 'opacity-40' : ''" />
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
