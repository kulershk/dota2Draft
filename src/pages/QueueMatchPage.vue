<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ExternalLink, Clock, Trophy, Loader2, ChevronDown, Radio } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import { useDotaConstants } from '@/composables/useDotaConstants'
import { getSocket } from '@/composables/useSocket'
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

// Live realtime snapshot from liveMatchPoller (Steam GetRealtimeStats).
// Updated every 12s while the match is live.
interface LivePlayer {
  account_id: number | null
  team: 'radiant' | 'dire'
  hero_id: number
  level: number
  kills: number
  deaths: number
  assists: number
  last_hits: number
  denies: number
  net_worth: number
  gold: number
  items: number[]
}
interface LiveSnapshot {
  radiant_score: number | null
  dire_score: number | null
  game_time: number | null
  game_state: number | null
  players: LivePlayer[]
  updated_at: number
}
const live = ref<LiveSnapshot | null>(null)
const now = ref(Date.now())
let nowTicker: ReturnType<typeof setInterval> | null = null

const liveStale = computed(() => {
  if (!live.value) return true
  return now.value - live.value.updated_at > 30_000
})

const liveByAccountId = computed<Record<number, LivePlayer>>(() => {
  const map: Record<number, LivePlayer> = {}
  for (const p of (live.value?.players || [])) {
    if (p.account_id) map[p.account_id] = p
  }
  return map
})

function liveForRosterPlayer(rosterPlayer: any): LivePlayer | null {
  // queue_matches.team1_players entries carry steamId (64-bit). The realtime
  // API returns accountid (32-bit). Convert by subtracting the Steam offset.
  const steamId64 = rosterPlayer?.steamId || rosterPlayer?.steam_id
  if (!steamId64) return null
  // BigInt safe — JS Number loses precision past 2^53 but Dota account IDs
  // fit. SteamID64 base = 76561197960265728. Cast via BigInt then back.
  try {
    const accountId = Number(BigInt(steamId64) - 76561197960265728n)
    if (!Number.isFinite(accountId) || accountId <= 0) return null
    return liveByAccountId.value[accountId] || null
  } catch {
    return null
  }
}

function fmtGameTime(seconds: number | null): string {
  if (seconds == null) return '--:--'
  const negative = seconds < 0
  const s = Math.abs(seconds)
  const m = Math.floor(s / 60)
  const ss = s % 60
  const t = `${m}:${ss.toString().padStart(2, '0')}`
  return negative ? `-${t}` : t
}

function gameStateLabel(state: number | null): string {
  // From Dota 2's DOTA_GameState enum — most common values during live play.
  // 4 = pre-game (strategy time, post-pick), 5 = playing.
  switch (state) {
    case 1: return t('liveStateInit')
    case 2: return t('liveStateWaitForPlayers')
    case 3: return t('liveStateHeroSelection')
    case 4: return t('liveStateStrategyTime')
    case 5: return t('liveStatePlaying')
    case 6: return t('liveStatePostGame')
    default: return ''
  }
}

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

function onLiveStats(payload: any) {
  if (!match.value) return
  if (Number(payload?.queueMatchId) !== match.value.id) return
  // The poller broadcasts the same shape the snapshot endpoint returns, plus
  // queueMatchId — strip that and adopt the rest.
  const { queueMatchId: _qmid, ...snap } = payload
  live.value = snap as LiveSnapshot
  now.value = Date.now()
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
    // Live state — only fetch + subscribe while the match is in flight.
    if (match.value?.status === 'live' || match.value?.status === 'lobby_creating' || match.value?.status === 'picking') {
      try {
        const snap = await api.getQueueMatchLive(match.value.id)
        if (snap) live.value = snap
      } catch { /* no live data yet — broadcasts will fill in */ }
      const sock = getSocket()
      // The poller emits to every socket via 'home:liveStats'; we filter by id.
      sock?.on('home:liveStats', onLiveStats)
      // Tick `now` every second so the stale check + live game time stay fresh.
      nowTicker = setInterval(() => { now.value = Date.now() }, 1000)
    }
  } catch (e: any) {
    error.value = e.message || 'Match not found'
  }
  loading.value = false
})

onBeforeUnmount(() => {
  const sock = getSocket()
  sock?.off('home:liveStats', onLiveStats)
  if (nowTicker) clearInterval(nowTicker)
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

        <!-- Live banner: realtime poll from Steam GetRealtimeStats. Only renders
             while we have a snapshot (poller running). Fades to muted after 30s
             of no updates so a stale snapshot is visually obvious. -->
        <div v-if="live" class="card overflow-hidden mb-5 transition-opacity" :class="liveStale ? 'opacity-60' : 'opacity-100'">
          <div class="px-5 py-3 flex items-center gap-3 border-b border-border/30 bg-gradient-to-r from-red-500/10 via-transparent to-transparent">
            <span class="flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
                  :class="liveStale ? 'bg-muted/40 text-muted-foreground' : 'bg-red-500/15 text-red-400'">
              <Radio class="w-3 h-3" :class="!liveStale && 'animate-pulse'" />
              {{ liveStale ? t('liveStale') : t('matchLive') }}
            </span>
            <span v-if="gameStateLabel(live.game_state)" class="text-xs text-muted-foreground">{{ gameStateLabel(live.game_state) }}</span>
            <span class="ml-auto flex items-center gap-1 font-mono text-sm tabular-nums">
              <Clock class="w-3.5 h-3.5 text-muted-foreground" />
              {{ fmtGameTime(live.game_time) }}
            </span>
          </div>
          <div class="px-5 py-4 flex items-center justify-center gap-6">
            <div class="text-right">
              <div class="text-[10px] uppercase tracking-wider font-bold text-green-400">{{ t('queueRadiant') }}</div>
              <div class="text-3xl font-bold tabular-nums leading-none mt-1">{{ live.radiant_score ?? '–' }}</div>
            </div>
            <div class="text-xs text-muted-foreground/40 font-bold">VS</div>
            <div class="text-left">
              <div class="text-[10px] uppercase tracking-wider font-bold text-red-400">{{ t('queueDire') }}</div>
              <div class="text-3xl font-bold tabular-nums leading-none mt-1">{{ live.dire_score ?? '–' }}</div>
            </div>
          </div>
          <!-- Per-player live cards (hero portrait + level + KDA + NW). Match by
               steamId → accountid; rosters that don't yet have a hero picked
               just show the placeholder via heroImg falling back to ''. -->
          <div class="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border/30 border-t border-border/30">
            <div class="flex flex-col">
              <div v-for="p in team1" :key="`r-${p.playerId || p.steamId}`"
                class="flex items-center gap-2.5 px-4 py-2 hover:bg-accent/20 transition-colors">
                <img v-if="liveForRosterPlayer(p) && dota.heroImg(liveForRosterPlayer(p)!.hero_id)"
                  :src="dota.heroImg(liveForRosterPlayer(p)!.hero_id)"
                  class="w-10 h-6 rounded object-cover shrink-0"
                  :title="dota.heroName(liveForRosterPlayer(p)!.hero_id)" />
                <div v-else class="w-10 h-6 rounded bg-muted/40 shrink-0" />
                <span class="text-xs font-medium truncate flex-1 min-w-0">{{ p.name }}</span>
                <span v-if="liveForRosterPlayer(p)" class="text-[10px] tabular-nums text-amber-400 font-semibold">
                  {{ liveForRosterPlayer(p)!.level }}
                </span>
                <span v-if="liveForRosterPlayer(p)" class="text-[11px] tabular-nums font-mono">
                  {{ liveForRosterPlayer(p)!.kills }}/{{ liveForRosterPlayer(p)!.deaths }}/{{ liveForRosterPlayer(p)!.assists }}
                </span>
                <span v-if="liveForRosterPlayer(p)" class="text-[10px] tabular-nums text-muted-foreground w-12 text-right">
                  {{ Math.round(liveForRosterPlayer(p)!.net_worth / 100) / 10 }}k
                </span>
              </div>
            </div>
            <div class="flex flex-col">
              <div v-for="p in team2" :key="`d-${p.playerId || p.steamId}`"
                class="flex items-center gap-2.5 px-4 py-2 hover:bg-accent/20 transition-colors">
                <img v-if="liveForRosterPlayer(p) && dota.heroImg(liveForRosterPlayer(p)!.hero_id)"
                  :src="dota.heroImg(liveForRosterPlayer(p)!.hero_id)"
                  class="w-10 h-6 rounded object-cover shrink-0"
                  :title="dota.heroName(liveForRosterPlayer(p)!.hero_id)" />
                <div v-else class="w-10 h-6 rounded bg-muted/40 shrink-0" />
                <span class="text-xs font-medium truncate flex-1 min-w-0">{{ p.name }}</span>
                <span v-if="liveForRosterPlayer(p)" class="text-[10px] tabular-nums text-amber-400 font-semibold">
                  {{ liveForRosterPlayer(p)!.level }}
                </span>
                <span v-if="liveForRosterPlayer(p)" class="text-[11px] tabular-nums font-mono">
                  {{ liveForRosterPlayer(p)!.kills }}/{{ liveForRosterPlayer(p)!.deaths }}/{{ liveForRosterPlayer(p)!.assists }}
                </span>
                <span v-if="liveForRosterPlayer(p)" class="text-[10px] tabular-nums text-muted-foreground w-12 text-right">
                  {{ Math.round(liveForRosterPlayer(p)!.net_worth / 100) / 10 }}k
                </span>
              </div>
            </div>
          </div>
        </div>

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
