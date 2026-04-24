<script setup lang="ts">
import { User, Trophy, Swords, Tv, Medal, MessageCircle, Star, ChevronLeft, ChevronRight, Percent, Target, Flame, Clock, Award, Zap, Check, X, Flag } from 'lucide-vue-next'
import { ref, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'
import { useDotaConstants } from '@/composables/useDotaConstants'
import RoleBadge from '@/components/common/RoleBadge.vue'
import MmrDisplay from '@/components/common/MmrDisplay.vue'
import LevelBadge from '@/components/common/LevelBadge.vue'
import XpProgressBar from '@/components/common/XpProgressBar.vue'
import PositionIcon from '@/components/common/PositionIcon.vue'
import { sortedRoles } from '@/utils/roles'
import { fmtDateOnly, fmtDateTime } from '@/utils/format'

const { t } = useI18n()
const route = useRoute()
const api = useApi()
const dota = useDotaConstants()

dota.loadConstants()

const playerId = computed(() => Number(route.params.id))
const profile = ref<any>(null)
const xpLog = ref<any[]>([])
const loading = ref(true)
const error = ref(false)

const PAGE_SIZE = 5
const MATCH_PAGE_SIZE = 10
const xpPage = ref(1)
const compPage = ref(1)
const matchPage = ref(0)
const matchHistory = ref<any[]>([])
const matchTotal = ref(0)
const matchLoading = ref(false)

const xpTotalPages = computed(() => Math.max(1, Math.ceil(xpLog.value.length / PAGE_SIZE)))
const pagedXpLog = computed(() => xpLog.value.slice((xpPage.value - 1) * PAGE_SIZE, xpPage.value * PAGE_SIZE))

const compTotalPages = computed(() => Math.max(1, Math.ceil((profile.value?.competitions?.length || 0) / PAGE_SIZE)))
const pagedCompetitions = computed(() => (profile.value?.competitions || []).slice((compPage.value - 1) * PAGE_SIZE, compPage.value * PAGE_SIZE))

watch(playerId, async (id) => {
  if (!id) return
  loading.value = true
  error.value = false
  xpPage.value = 1
  compPage.value = 1
  try {
    profile.value = await api.getPlayerProfile(id)
    api.getPlayerXpLog(id).then(logs => { xpLog.value = logs }).catch(() => {})
    matchPage.value = 0
    fetchMatches(id)
  } catch {
    error.value = true
    profile.value = null
  } finally {
    loading.value = false
  }
}, { immediate: true })

async function fetchMatches(id?: number) {
  const pid = id || playerId.value
  if (!pid) return
  matchLoading.value = true
  try {
    const data = await api.getPlayerMatches(pid, { limit: MATCH_PAGE_SIZE, offset: matchPage.value * MATCH_PAGE_SIZE })
    matchHistory.value = data.rows
    matchTotal.value = data.total
  } catch { /* ignore */ }
  matchLoading.value = false
}

const matchTotalPages = computed(() => Math.max(1, Math.ceil(matchTotal.value / MATCH_PAGE_SIZE)))

function prevMatchPage() { if (matchPage.value > 0) { matchPage.value--; fetchMatches() } }
function nextMatchPage() { if (matchPage.value + 1 < matchTotalPages.value) { matchPage.value++; fetchMatches() } }

function formatDate(dateStr: string) {
  return fmtDateOnly(new Date(dateStr))
}

function formatRelative(dateStr: string): string {
  const d = new Date(dateStr).getTime()
  if (!d) return '—'
  const diff = Date.now() - d
  const m = Math.floor(diff / 60_000)
  if (m < 1) return t('justNow') as string
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const days = Math.floor(h / 24)
  if (days < 30) return `${days}d ago`
  return fmtDateOnly(new Date(dateStr))
}

function placementLabel(n: number) {
  if (n === 1) return t('placementFirst')
  if (n === 2) return t('placementSecond')
  if (n === 3) return t('placementThird')
  return t('placementN', { n })
}

// Placement colors sourced from Pencil tournament-placements card:
//  1st #FACC15 yellow · 2nd #CBD5E1 silver · 3rd #F47222 orange · rest #64748B muted
function placementRankClass(n: number) {
  if (n === 1) return 'text-[#FACC15]'
  if (n === 2) return 'text-[#CBD5E1]'
  if (n === 3) return 'text-[#F47222]'
  return 'text-[#CBD5E1]'
}

function placementBorderClass(n: number) {
  if (n === 1) return 'border-l-[#FACC15]/30'
  if (n === 2) return 'border-l-[#CBD5E1]/30'
  if (n === 3) return 'border-l-[#F47222]/30'
  return 'border-l-border'
}

function placementBadgeClass(n: number) {
  if (n === 1) return 'bg-[#FACC15]/10 border border-[#FACC15]/30'
  if (n === 2) return 'bg-[#CBD5E1]/10 border border-[#CBD5E1]/30'
  if (n === 3) return 'bg-[#F47222]/10 border border-[#F47222]/30'
  return 'bg-[#64748B]/15 border border-[#64748B]/40'
}

function placementIconClass(n: number) {
  if (n === 1) return 'text-[#FACC15]'
  if (n === 2) return 'text-[#CBD5E1]'
  if (n === 3) return 'text-[#F47222]'
  return 'text-muted-foreground'
}

function formatMonthYear(dateStr: string): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}

// Stats formatting helpers
const stats = computed(() => profile.value?.stats || null)
const winRatePct = computed(() => stats.value ? (stats.value.win_rate * 100) : null)

function fmtHours(n: number | null | undefined) {
  if (!n && n !== 0) return '—'
  if (n >= 100) return Math.round(n).toLocaleString()
  return n.toFixed(1)
}

function fmtDuration(seconds: number | null | undefined) {
  if (!seconds) return '—'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

const streakLabel = computed(() => {
  const s = stats.value?.current_streak
  if (!s || !s.type || s.count === 0) return null
  return `${s.count}${s.type}`
})

const streakClass = computed(() => {
  const s = stats.value?.current_streak
  if (!s || !s.type || s.count === 0) return 'text-muted-foreground'
  return s.type === 'W' ? 'text-green-500' : 'text-red-500'
})

const streakBadge = computed(() => {
  const s = stats.value?.current_streak
  if (!s || !s.type || s.count === 0) return null
  if (s.count >= 3) return s.type === 'W' ? t('profileStreakHot') : t('profileStreakCold')
  return null
})
</script>

<template>
  <div class="p-4 md:p-8 flex flex-col gap-5 md:gap-6 max-w-[1200px] mx-auto w-full">
    <div v-if="loading" class="text-center py-12 text-muted-foreground">{{ t('loading') }}</div>
    <div v-else-if="error" class="text-center py-12 text-muted-foreground">{{ t('playerNotFound') }}</div>

    <template v-else-if="profile">
      <!-- Hero strip: avatar + name/bio/mmr blocks -->
      <div class="card p-5 md:p-6 relative overflow-hidden">
        <div class="flex flex-col sm:flex-row items-start sm:items-center gap-5">
          <!-- Gradient-ring avatar -->
          <div class="shrink-0 relative">
            <div class="p-1 rounded-full bg-gradient-to-br from-primary via-primary/60 to-purple-500 shadow-[0_10px_40px_-8px_rgba(34,211,238,0.4)]">
              <img v-if="profile.avatar_url" :src="profile.avatar_url" class="w-24 h-24 md:w-32 md:h-32 rounded-full block" />
              <div v-else class="w-24 h-24 md:w-32 md:h-32 rounded-full bg-background flex items-center justify-center">
                <User class="w-10 h-10 text-primary" />
              </div>
            </div>
          </div>

          <!-- Info column -->
          <div class="flex-1 min-w-0 w-full flex flex-col gap-3">
            <!-- Name row -->
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <h1 class="text-2xl md:text-3xl font-extrabold text-foreground tracking-tight truncate">{{ profile.name }}</h1>
                  <span class="text-xs text-muted-foreground">· {{ t('memberSince') }} {{ formatDate(profile.created_at) }}</span>
                </div>
                <div class="flex flex-wrap items-center gap-2 mt-1.5">
                  <LevelBadge :level="profile.level || 1" size="md" />
                  <span class="text-xs font-semibold text-primary">{{ t('levelN', { n: profile.level || 1 }) }}</span>
                  <div v-if="profile.roles?.length" class="flex flex-wrap gap-1">
                    <RoleBadge v-for="role in sortedRoles(profile.roles)" :key="role" :role="role" />
                  </div>
                </div>
              </div>
              <!-- External links -->
              <div v-if="profile.steam_id" class="flex items-center gap-1.5 shrink-0">
                <a :href="`https://steamcommunity.com/profiles/${profile.steam_id}`"
                  target="_blank" rel="noopener"
                  class="w-8 h-8 rounded-lg bg-accent flex items-center justify-center hover:bg-accent/70 transition-colors"
                  title="Steam"
                >
                  <img src="/icons/steam.svg" class="w-5 h-5" alt="Steam" />
                </a>
                <a :href="`https://www.dotabuff.com/players/${BigInt(profile.steam_id) - 76561197960265728n}`"
                  target="_blank" rel="noopener"
                  class="w-8 h-8 rounded-lg bg-accent flex items-center justify-center hover:bg-accent/70 transition-colors"
                  title="Dotabuff"
                >
                  <img src="/icons/dotabuff.png" class="w-5 h-5 rounded" alt="Dotabuff" />
                </a>
                <a :href="`https://www.opendota.com/players/${BigInt(profile.steam_id) - 76561197960265728n}`"
                  target="_blank" rel="noopener"
                  class="w-8 h-8 rounded-lg bg-accent flex items-center justify-center hover:bg-accent/70 transition-colors"
                  title="OpenDota"
                >
                  <img src="/icons/opendota.png" class="w-5 h-5" alt="OpenDota" />
                </a>
                <a :href="`https://stratz.com/players/${BigInt(profile.steam_id) - 76561197960265728n}`"
                  target="_blank" rel="noopener"
                  class="w-8 h-8 rounded-lg bg-accent flex items-center justify-center hover:bg-accent/70 transition-colors"
                  title="Stratz"
                >
                  <img src="/icons/stratz.ico" class="w-5 h-5" alt="Stratz" />
                </a>
              </div>
            </div>

            <!-- Socials + bio -->
            <div v-if="profile.twitch_username || profile.discord_username" class="flex flex-wrap items-center gap-2">
              <a v-if="profile.twitch_username"
                :href="`https://twitch.tv/${profile.twitch_username}`"
                target="_blank" rel="noopener"
                class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#9146FF]/10 border border-[#9146FF]/20 text-[#9146FF] hover:bg-[#9146FF]/20 transition-colors"
              >
                <Tv class="w-3.5 h-3.5" />
                <span class="text-xs font-medium">{{ profile.twitch_username }}</span>
              </a>
              <span v-if="profile.discord_username"
                class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#5865F2]/10 border border-[#5865F2]/20 text-[#5865F2]"
              >
                <MessageCircle class="w-3.5 h-3.5" />
                <span class="text-xs font-medium">{{ profile.discord_username }}</span>
              </span>
            </div>
            <p v-if="profile.info" class="text-sm text-muted-foreground">{{ profile.info }}</p>

            <!-- MMR / Level / Favorite Role blocks -->
            <div class="flex flex-wrap items-end gap-x-6 gap-y-3 pt-2 border-t border-border/60">
              <div v-if="profile.mmr" class="flex flex-col gap-1">
                <span class="text-[10px] font-mono font-bold tracking-[0.2em] text-muted-foreground">MMR</span>
                <span class="text-2xl md:text-3xl font-extrabold font-mono text-primary leading-none">{{ profile.mmr.toLocaleString() }}</span>
              </div>
              <div class="h-10 w-px bg-border" v-if="profile.mmr"></div>
              <div class="flex flex-col gap-1">
                <span class="text-[10px] font-mono font-bold tracking-[0.2em] text-muted-foreground">LEVEL</span>
                <div class="flex items-baseline gap-2">
                  <span class="text-2xl md:text-3xl font-extrabold font-mono text-foreground leading-none">{{ profile.level || 1 }}</span>
                  <div class="w-20"><XpProgressBar :current="profile.level_progress || 0" /></div>
                </div>
              </div>
              <div v-if="profile.favorite_position" class="h-10 w-px bg-border"></div>
              <div v-if="profile.favorite_position" class="flex flex-col gap-1">
                <span class="text-[10px] font-mono font-bold tracking-[0.2em] text-muted-foreground">{{ t('profileFavRole').toUpperCase() }}</span>
                <div class="flex items-center gap-2">
                  <PositionIcon :position="profile.favorite_position.position" />
                  <span class="text-sm font-bold text-foreground">{{ profile.favorite_position.games }}/{{ profile.favorite_position.total }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Stats strip: 5 mini cards (2→3→5 cols) -->
      <div v-if="stats" class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <!-- Win rate -->
        <div class="card p-4 flex flex-col gap-1.5">
          <div class="flex items-center gap-1.5">
            <Percent class="w-3.5 h-3.5 text-green-500" />
            <span class="text-[10px] font-mono font-bold tracking-[0.2em] text-muted-foreground">{{ t('profileWinRate').toUpperCase() }}</span>
          </div>
          <div class="flex items-baseline gap-1">
            <span class="text-2xl font-extrabold font-mono text-foreground leading-none">{{ winRatePct !== null ? winRatePct.toFixed(1) : '—' }}</span>
            <span class="text-sm font-mono font-bold text-muted-foreground">%</span>
          </div>
          <span class="text-[11px] text-muted-foreground">{{ stats.wins_total }}W · {{ stats.matches_total - stats.wins_total }}L</span>
        </div>

        <!-- Matches -->
        <div class="card p-4 flex flex-col gap-1.5">
          <div class="flex items-center gap-1.5">
            <Swords class="w-3.5 h-3.5 text-orange-500" />
            <span class="text-[10px] font-mono font-bold tracking-[0.2em] text-muted-foreground">{{ t('profileMatches').toUpperCase() }}</span>
          </div>
          <span class="text-2xl font-extrabold font-mono text-foreground leading-none">{{ stats.matches_total.toLocaleString() }}</span>
          <span class="text-[11px] text-muted-foreground">&nbsp;</span>
        </div>

        <!-- KDA last 10 -->
        <div class="card p-4 flex flex-col gap-1.5">
          <div class="flex items-center gap-1.5">
            <Target class="w-3.5 h-3.5 text-purple-400" />
            <span class="text-[10px] font-mono font-bold tracking-[0.2em] text-muted-foreground">{{ t('profileKdaLast10').toUpperCase() }}</span>
          </div>
          <span class="text-2xl font-extrabold font-mono text-foreground leading-none">{{ stats.kda_sample_size > 0 ? stats.avg_kda_last10.toFixed(2) : '—' }}</span>
          <span class="text-[11px] text-muted-foreground truncate">
            {{ stats.kda_sample_size > 0 ? t('profileAvgKdaHint', { k: stats.avg_k_last10, d: stats.avg_d_last10, a: stats.avg_a_last10 }) : '&nbsp;' }}
          </span>
        </div>

        <!-- Streak -->
        <div class="card p-4 flex flex-col gap-1.5">
          <div class="flex items-center gap-1.5">
            <Flame class="w-3.5 h-3.5 text-red-500" />
            <span class="text-[10px] font-mono font-bold tracking-[0.2em] text-muted-foreground">{{ t('profileStreak').toUpperCase() }}</span>
          </div>
          <div class="flex items-baseline gap-2">
            <span class="text-2xl font-extrabold font-mono leading-none" :class="streakClass">{{ streakLabel || t('profileNoStreak') }}</span>
          </div>
          <span v-if="streakBadge" class="text-[11px] font-mono font-bold" :class="streakClass">{{ streakBadge }}</span>
          <span v-else class="text-[11px] text-muted-foreground">&nbsp;</span>
        </div>

        <!-- Time played -->
        <div class="card p-4 flex flex-col gap-1.5">
          <div class="flex items-center gap-1.5">
            <Clock class="w-3.5 h-3.5 text-primary" />
            <span class="text-[10px] font-mono font-bold tracking-[0.2em] text-muted-foreground">{{ t('profileHoursPlayed').toUpperCase() }}</span>
          </div>
          <div class="flex items-baseline gap-1">
            <span class="text-2xl font-extrabold font-mono text-foreground leading-none">{{ fmtHours(stats.hours_played) }}</span>
            <span class="text-sm font-mono font-bold text-muted-foreground">{{ t('profileHoursSuffix') }}</span>
          </div>
          <span class="text-[11px] text-muted-foreground">&nbsp;</span>
        </div>
      </div>

      <!-- Body: 2-col grid with 420px right sidebar -->
      <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-5 md:gap-6">
        <!-- Main column: match history + XP + comp history -->
        <div class="flex flex-col gap-5 md:gap-6 min-w-0">
          <!-- Match History -->
          <div class="card flex flex-col">
            <div class="flex items-center gap-2 px-5 py-4 border-b border-border">
              <Swords class="w-5 h-5 text-primary" />
              <span class="text-sm font-bold text-foreground">{{ t('matchHistory') }}</span>
              <span class="text-xs font-mono text-muted-foreground">· {{ matchTotal }} {{ t('matches') }}</span>
            </div>
            <div v-if="matchLoading && matchHistory.length === 0" class="p-6 text-center text-sm text-muted-foreground">{{ t('loading') }}</div>
            <div v-else-if="matchHistory.length === 0" class="p-6 text-center text-sm text-muted-foreground">{{ t('noMatches') }}</div>
            <div v-else class="p-3">
              <!-- Column headers -->
              <div class="hidden lg:grid px-3.5 py-2 gap-3 text-[10px] font-mono font-bold tracking-[0.2em] text-muted-foreground/60"
                   style="grid-template-columns: 72px 180px 100px 100px minmax(0,1fr) 80px 90px">
                <span>{{ t('profileResult').toUpperCase() }}</span>
                <span>{{ t('profileHero').toUpperCase() }}</span>
                <span class="text-center">{{ t('profileKdaShort') }}</span>
                <span class="text-center">{{ t('profileScoreShort').toUpperCase() }}</span>
                <span>{{ t('profileModeShort').toUpperCase() }}</span>
                <span class="text-right">{{ t('profileDurationShort').toUpperCase() }}</span>
                <span class="text-right">{{ t('profileDateShort').toUpperCase() }}</span>
              </div>

              <!-- Rows -->
              <div class="flex flex-col gap-1">
                <component
                  :is="g.type === 'queue' && g.queueMatchId ? 'router-link' : g.type === 'competition' && g.competitionId ? 'router-link' : 'div'"
                  v-for="g in matchHistory"
                  :key="g.gameId"
                  :to="g.type === 'queue' ? { name: 'queue-match', params: { id: g.queueMatchId } } : { name: 'comp-match', params: { compId: g.competitionId, matchId: g.matchId } }"
                  class="flex flex-wrap lg:grid items-center gap-3 px-3.5 py-2.5 rounded-lg border-l-[3px] bg-muted hover:bg-accent transition-colors"
                  :class="g.won ? 'border-l-green-500/60' : 'border-l-red-500/60'"
                  style="grid-template-columns: 72px 180px 100px 100px minmax(0,1fr) 80px 90px"
                >
                  <!-- 1. Result chip -->
                  <span class="inline-flex items-center justify-center gap-1.5 w-[72px] px-2.5 py-1 rounded-md text-[11px] font-mono font-extrabold tracking-wider"
                        :class="g.won ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'">
                    <Check v-if="g.won" class="w-3 h-3" />
                    <X v-else class="w-3 h-3" />
                    {{ g.won ? t('profileWin') : t('profileLoss') }}
                  </span>

                  <!-- 2. Hero block (180px): square portrait + name + subtitle -->
                  <div class="flex items-center gap-2.5 min-w-0 lg:w-[180px]">
                    <img v-if="g.heroId && dota.heroImg(g.heroId)"
                         :src="dota.heroImg(g.heroId)"
                         :alt="dota.heroName(g.heroId)"
                         class="w-8 h-8 rounded object-cover border border-primary/40 shrink-0" />
                    <div v-else class="w-8 h-8 rounded bg-accent/50 border border-border/40 shrink-0 flex items-center justify-center">
                      <Swords class="w-3.5 h-3.5 text-muted-foreground" />
                    </div>
                    <div class="flex flex-col min-w-0 gap-0.5">
                      <span v-if="g.heroId" class="text-xs font-bold text-foreground truncate leading-tight">{{ dota.heroName(g.heroId) }}</span>
                      <span v-else class="text-xs font-bold text-muted-foreground truncate leading-tight">{{ t('profileNoStats') }}</span>
                      <span class="text-[10px] text-muted-foreground truncate leading-tight font-mono">
                        {{ g.isRadiant ? 'Radiant' : 'Dire' }}
                      </span>
                    </div>
                  </div>

                  <!-- 3. KDA (100px center) -->
                  <span class="text-xs font-mono font-bold text-foreground text-center tabular-nums lg:w-[100px]">
                    {{ g.kills }} / {{ g.deaths }} / {{ g.assists }}
                  </span>

                  <!-- 4. Score (100px center) — player's side on the left -->
                  <span class="text-xs font-mono font-bold text-center tabular-nums lg:w-[100px]">
                    <span :class="g.won ? 'text-foreground' : 'text-muted-foreground'">{{ g.isRadiant ? g.radiantKills : g.direKills }}</span>
                    <span class="opacity-50 mx-1">–</span>
                    <span :class="!g.won ? 'text-foreground' : 'text-muted-foreground'">{{ g.isRadiant ? g.direKills : g.radiantKills }}</span>
                  </span>

                  <!-- 5. Mode (fill) -->
                  <span class="text-xs text-muted-foreground truncate">
                    <span v-if="g.type === 'queue'">{{ g.poolName || t('queueTitle') }}</span>
                    <span v-else>{{ g.competitionName }}</span>
                  </span>

                  <!-- 6. Duration (80px right) -->
                  <span class="text-xs font-mono font-semibold text-muted-foreground text-right tabular-nums lg:w-[80px]">{{ fmtDuration(g.duration) }}</span>

                  <!-- 7. Date (90px right, relative) -->
                  <span class="text-xs font-mono font-semibold text-muted-foreground/70 text-right tabular-nums lg:w-[90px]">{{ formatRelative(g.date) }}</span>
                </component>
              </div>
            </div>
            <!-- Pagination -->
            <div v-if="matchTotalPages > 1" class="flex items-center justify-between px-5 py-3 border-t border-border">
              <span class="text-xs text-muted-foreground">{{ t('showingNofM', { n: Math.min(matchHistory.length, MATCH_PAGE_SIZE), m: matchTotal }) }}</span>
              <div class="flex items-center gap-2">
                <button class="p-1 rounded hover:bg-accent disabled:opacity-30" :disabled="matchPage <= 0" @click="prevMatchPage">
                  <ChevronLeft class="w-4 h-4 text-muted-foreground" />
                </button>
                <span class="text-xs text-muted-foreground font-mono">{{ matchPage + 1 }} / {{ matchTotalPages }}</span>
                <button class="p-1 rounded hover:bg-accent disabled:opacity-30" :disabled="matchPage + 1 >= matchTotalPages" @click="nextMatchPage">
                  <ChevronRight class="w-4 h-4 text-muted-foreground" />
                </button>
              </div>
            </div>
          </div>

          <!-- XP History + Competition History -->
          <div class="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <!-- XP History -->
            <div v-if="xpLog.length > 0" class="card flex flex-col">
              <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
                <Zap class="w-5 h-5 text-purple-400" />
                <span class="text-sm font-semibold text-foreground">{{ t('xpHistory') }}</span>
                <span class="text-xs font-mono text-muted-foreground ml-auto">{{ t('xpTotal') }}: {{ (profile.total_xp || 0).toLocaleString() }}</span>
              </div>
              <div class="divide-y divide-border flex-1">
                <div v-for="log in pagedXpLog" :key="log.created_at" class="flex items-center gap-3 px-4 py-2.5">
                  <span class="text-sm font-bold font-mono text-primary shrink-0">+{{ log.amount }}</span>
                  <div class="flex-1 min-w-0">
                    <p class="text-sm text-foreground truncate">{{ t(`xpReason_${log.reason}`) }}</p>
                    <p v-if="log.detail" class="text-xs text-muted-foreground truncate">{{ log.detail }}</p>
                  </div>
                  <div class="text-right shrink-0">
                    <p v-if="log.competition_name" class="text-xs text-muted-foreground truncate max-w-[140px]">{{ log.competition_name }}</p>
                    <p class="text-[10px] text-text-tertiary">{{ fmtDateTime(new Date(log.created_at)) }}</p>
                  </div>
                </div>
              </div>
              <div v-if="xpTotalPages > 1" class="flex items-center justify-between px-4 py-2 border-t border-border">
                <button class="p-1 rounded hover:bg-accent disabled:opacity-30" :disabled="xpPage <= 1" @click="xpPage--">
                  <ChevronLeft class="w-4 h-4 text-muted-foreground" />
                </button>
                <span class="text-xs text-muted-foreground font-mono">{{ xpPage }} / {{ xpTotalPages }}</span>
                <button class="p-1 rounded hover:bg-accent disabled:opacity-30" :disabled="xpPage >= xpTotalPages" @click="xpPage++">
                  <ChevronRight class="w-4 h-4 text-muted-foreground" />
                </button>
              </div>
            </div>

            <!-- Competition history -->
            <div class="card flex flex-col">
              <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
                <Award class="w-5 h-5 text-yellow-500" />
                <span class="text-sm font-semibold text-foreground">{{ t('competitionHistory') }}</span>
                <span class="text-xs font-mono text-muted-foreground ml-auto">{{ profile.competitions.length }}</span>
              </div>
              <div v-if="profile.competitions.length === 0" class="p-6 text-center text-sm text-muted-foreground flex-1 flex items-center justify-center">
                {{ t('noCompetitions') }}
              </div>
              <div v-else class="divide-y divide-border flex-1">
                <div v-for="comp in pagedCompetitions" :key="comp.competition_id" class="flex items-center gap-3 px-4 py-3">
                  <div class="flex-1 min-w-0">
                    <router-link
                      :to="{ name: 'comp-info', params: { compId: comp.competition_id } }"
                      class="text-sm font-medium text-foreground hover:text-primary transition-colors truncate block"
                    >{{ comp.competition_name }}</router-link>
                    <div class="flex flex-wrap items-center gap-2 mt-1">
                      <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                        :class="comp.was_captain ? 'bg-primary/10 text-primary' : 'bg-accent text-muted-foreground'">
                        <Trophy v-if="comp.was_captain" class="w-3 h-3 mr-0.5" />
                        {{ comp.was_captain ? t('wasCaptain') : t('wasPlayer') }}
                      </span>
                      <span v-if="comp.captain_team" class="text-xs text-muted-foreground">{{ comp.captain_team }}</span>
                      <span v-if="comp.drafted && comp.drafted_by_team" class="text-xs text-muted-foreground">
                        {{ t('draftedBy') }} {{ comp.drafted_by_team }}
                      </span>
                      <span v-if="comp.draft_price" class="text-xs font-mono text-primary font-semibold">{{ comp.draft_price }}g</span>
                    </div>
                  </div>
                  <div class="shrink-0">
                    <MmrDisplay v-if="comp.mmr" :mmr="comp.mmr" size="sm" />
                  </div>
                </div>
              </div>
              <div v-if="compTotalPages > 1" class="flex items-center justify-between px-4 py-2 border-t border-border">
                <button class="p-1 rounded hover:bg-accent disabled:opacity-30" :disabled="compPage <= 1" @click="compPage--">
                  <ChevronLeft class="w-4 h-4 text-muted-foreground" />
                </button>
                <span class="text-xs text-muted-foreground font-mono">{{ compPage }} / {{ compTotalPages }}</span>
                <button class="p-1 rounded hover:bg-accent disabled:opacity-30" :disabled="compPage >= compTotalPages" @click="compPage++">
                  <ChevronRight class="w-4 h-4 text-muted-foreground" />
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Right sidebar: top heroes + tournaments (420px) -->
        <div class="flex flex-col gap-5 md:gap-6">
          <!-- Top heroes -->
          <div v-if="profile.top_heroes?.length" class="card">
            <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
              <Star class="w-4 h-4 text-yellow-500" />
              <span class="text-sm font-bold text-foreground">{{ t('topHeroes') }}</span>
            </div>
            <div class="p-2 flex flex-col gap-1">
              <div v-for="(hero, idx) in profile.top_heroes" :key="hero.hero_id" class="flex items-center gap-2.5 px-2 py-1.5 rounded-md bg-muted border border-border/50">
                <span class="w-4 h-4 rounded flex items-center justify-center text-[9px] font-mono font-bold bg-yellow-500/10 border border-yellow-500/30 text-yellow-500 shrink-0">{{ idx + 1 }}</span>
                <img v-if="dota.heroImg(hero.hero_id)" :src="dota.heroImg(hero.hero_id)" :alt="dota.heroName(hero.hero_id)"
                  class="w-8 h-8 rounded object-cover border border-primary/30 shrink-0" />
                <div class="min-w-0 flex-1">
                  <p class="text-xs font-semibold text-foreground truncate leading-tight">{{ dota.heroName(hero.hero_id) || `Hero #${hero.hero_id}` }}</p>
                  <div class="flex items-center gap-1.5 mt-1">
                    <div class="flex-1 h-1 rounded-full bg-border/50 overflow-hidden">
                      <div class="h-full rounded-full bg-green-500" :style="{ width: `${hero.games > 0 ? (hero.wins / hero.games * 100) : 0}%` }"></div>
                    </div>
                    <span class="text-[9px] font-mono text-muted-foreground shrink-0">{{ hero.games }}g</span>
                  </div>
                </div>
                <div class="flex items-baseline gap-1 shrink-0 font-mono text-[10px] font-bold">
                  <span class="text-green-500">{{ hero.wins }}W</span>
                  <span class="text-muted-foreground">· {{ hero.games - hero.wins }}L</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Tournament placements -->
          <div v-if="profile.tournament_results?.length > 0" class="card">
            <div class="flex items-center gap-3 px-5 py-4 border-b border-border">
              <Trophy class="w-4 h-4 text-primary" />
              <span class="text-sm font-bold text-foreground">{{ t('tournamentPlacements') }}</span>
              <span class="flex-1"></span>
              <span class="inline-flex items-center rounded px-2 py-0.5 text-[11px] font-mono font-bold bg-primary/10 text-cyan-300">
                {{ profile.tournament_results.length }} {{ t('eventsLabel') }}
              </span>
            </div>
            <div class="p-3 flex flex-col gap-2">
              <div
                v-for="(result, idx) in profile.tournament_results" :key="idx"
                class="flex items-center gap-3 rounded-[10px] bg-muted border-l-[3px] px-3.5 py-3"
                :class="placementBorderClass(result.placement)"
              >
                <!-- 36px rounded-square badge -->
                <div class="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                     :class="placementBadgeClass(result.placement)">
                  <Award v-if="result.placement === 1" class="w-[18px] h-[18px]" :class="placementIconClass(result.placement)" />
                  <Medal v-else-if="result.placement === 2 || result.placement === 3" class="w-[18px] h-[18px]" :class="placementIconClass(result.placement)" />
                  <Flag v-else class="w-[18px] h-[18px]" :class="placementIconClass(result.placement)" />
                </div>
                <!-- Info -->
                <div class="min-w-0 flex-1 flex flex-col gap-0.5">
                  <p class="text-[13px] font-bold text-foreground truncate leading-tight">{{ result.competition_name }}</p>
                  <p class="text-[11px] font-medium text-muted-foreground truncate leading-tight">
                    {{ result.team }} · {{ result.stage_name }}<template v-if="result.competition_created_at"> · {{ formatMonthYear(result.competition_created_at) }}</template>
                  </p>
                </div>
                <!-- Right rank -->
                <div class="shrink-0 text-right">
                  <span class="text-base font-mono font-extrabold tabular-nums leading-none" :class="placementRankClass(result.placement)">
                    {{ placementLabel(result.placement) }}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
