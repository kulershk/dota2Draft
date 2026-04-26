<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Trophy, Play, Users, Radio, Eye, Flame, ChevronRight, Calendar, Snowflake, BadgeCheck, UserPlus, Swords, Tv, Gift, Check } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import { useDotaConstants } from '@/composables/useDotaConstants'
import { formatRelativeTime, fmtDateOnly } from '@/utils/format'

interface NewsCard {
  id: number
  title: string
  image_url: string | null
  created_at: string
  tag?: string | null
}
interface LiveMatch {
  id: number
  pool_name: string | null
  best_of: number | null
  team1_kills: number | null
  team2_kills: number | null
  team1_players: any[] | null
  team2_players: any[] | null
  captain1_display_name: string | null
  captain2_display_name: string | null
  captain1_avatar: string | null
  captain2_avatar: string | null
  status: string
  created_at: string
}
interface TopPlayer {
  id: number
  name: string
  avatar_url: string | null
  mmr: number
  mmr_verified_at: string | null
  points: number | null
  games_played: number | null
  streak: { count: number; won: boolean } | null
  win_rate: number | null
}
interface Sponsor { id: number; logo_url: string; alt: string; link: string }

const { t } = useI18n()
const api = useApi()
const store = useDraftStore()
const dota = useDotaConstants()
dota.loadConstants()

const isLoggedIn = computed(() => !!store.currentUser.value)

// All home data is loaded in parallel onMount
const stats = ref<{ active_players: number; live_matches: number; active_tournaments: number } | null>(null)
const liveMatches = ref<LiveMatch[]>([])
const featured = ref<any | null>(null)
const news = ref<NewsCard[]>([])
const topPlayers = ref<{ players: TopPlayer[]; season: { id: number; name: string; slug: string } | null }>({ players: [], season: null })
const heroPickRate = ref<{ days: number; heroes: { hero_id: number; picks: number; pick_rate: string }[] }>({ days: 7, heroes: [] })
const upcomingNext = ref<any | null>(null)
const sponsors = ref<Sponsor[]>([])
const heroTitle = ref('Latvian Dota 2 League')
const heroSubtitle = ref('')
const heroParagraph = ref('')

// Daily check-in
const daily = ref<{ claimed_today: boolean; streak: number; next_xp: number } | null>(null)
const dailyClaiming = ref(false)
async function loadDaily() {
  if (!isLoggedIn.value) { daily.value = null; return }
  try { daily.value = await api.getDailyStatus() } catch { daily.value = null }
}
async function claimDaily() {
  if (!daily.value || daily.value.claimed_today) return
  dailyClaiming.value = true
  try {
    await api.claimDaily()
    await loadDaily()
  } catch (e: any) {
    /* swallow — server returns 400 if already claimed today */
  } finally {
    dailyClaiming.value = false
  }
}

const liveCards = computed(() => liveMatches.value.slice(0, 3))
const newsCards = computed(() => news.value.slice(0, 4))

let pollInterval: ReturnType<typeof setInterval> | null = null

async function loadAll() {
  const [s, history, feat, n, top, pickRate, upcoming, settings] = await Promise.all([
    api.getHomeStats().catch(() => null),
    api.getQueueHistory({ limit: 6 }).catch(() => []),
    api.getFeaturedTournament().catch(() => null),
    api.getNews().catch(() => []),
    api.getHomeTopPlayers(5).catch(() => ({ players: [], season: null })),
    api.getHomeHeroPickRate(7, 3).catch(() => ({ days: 7, heroes: [] })),
    api.getUpcomingMatches().catch(() => []),
    api.getSiteSettings().catch(() => null),
  ])
  stats.value = s
  liveMatches.value = (history as any[]).filter(m => m.status === 'live')
  featured.value = feat
  news.value = (n as any[]).slice(0, 4)
  topPlayers.value = top
  heroPickRate.value = pickRate
  upcomingNext.value = (upcoming as any[])[0] || null
  if (settings) {
    sponsors.value = settings.site_sponsors || []
    if (settings.site_title) heroTitle.value = settings.site_title
    if (settings.site_subtitle) heroSubtitle.value = settings.site_subtitle
    if (settings.site_hero_paragraph) heroParagraph.value = settings.site_hero_paragraph
  }
  loadDaily()
}

function teamAvatars(players: any[] | null | undefined, fallback: string | null) {
  const list = (players?.length ? players : (fallback ? [{ avatarUrl: fallback }] : [])).slice(0, 5)
  return list
}

function streakLabel(s: TopPlayer['streak']): string {
  if (!s || !s.count) return '—'
  return (s.won ? 'W' : 'L') + s.count
}
function streakColor(s: TopPlayer['streak']): string {
  if (!s || !s.count) return 'text-muted-foreground'
  return s.won ? 'text-emerald-400' : 'text-red-400'
}

function winrateColor(wr: number | null): string {
  if (wr == null) return 'text-muted-foreground'
  if (wr >= 60) return 'text-emerald-400'
  if (wr >= 50) return 'text-amber-400'
  return 'text-red-400'
}

function rankColor(idx: number): string {
  if (idx === 0) return 'text-amber-400'
  return 'text-muted-foreground'
}

function fmtRange(a: string | null, b: string | null): string {
  if (!a && !b) return '—'
  const f = (s: string | null) => s ? new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '?'
  return `${f(a)} → ${f(b)}`
}

onMounted(() => {
  loadAll()
  // Live stats refresh every 30s — keeps the hero chips honest without spamming.
  pollInterval = setInterval(() => {
    api.getHomeStats().then(s => { stats.value = s }).catch(() => {})
  }, 30000)
})
onUnmounted(() => { if (pollInterval) clearInterval(pollInterval) })
</script>

<template>
  <div class="bg-[#0A0F1C] text-foreground">
    <!-- ─── Hero ─── -->
    <section
      class="relative overflow-hidden"
      style="background: linear-gradient(160deg, #0A0F1C 0%, #0E1A33 50%, #1A0E1F 100%);"
    >
      <div class="max-w-[1200px] mx-auto px-4 md:px-8 lg:px-20 py-12 lg:py-16 grid lg:grid-cols-[1fr_auto] gap-12 items-center">
        <!-- Hero left -->
        <div class="flex flex-col gap-6 max-w-[680px]">
          <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#1A2B4A] border border-[#22D3EE] text-[11px] font-bold font-mono tracking-widest text-cyan-400 self-start">
            <span class="w-2 h-2 rounded-full bg-cyan-400" />
            {{ t('homeHeroSeasonTag') }}
          </div>
          <h1 class="text-4xl md:text-5xl lg:text-6xl font-extrabold text-foreground tracking-tight leading-[1.05]">
            {{ heroTitle }}
          </h1>
          <p class="text-xl md:text-2xl font-semibold text-amber-500 leading-tight">
            {{ heroSubtitle || t('homeHeroSubtitle') }}
          </p>
          <p class="text-base text-muted-foreground leading-relaxed whitespace-pre-line">
            {{ heroParagraph || t('homeHeroParagraph') }}
          </p>
          <div class="flex flex-wrap items-center gap-3 mt-2">
            <router-link
              to="/competitions"
              class="inline-flex items-center gap-2 h-12 px-7 rounded-[10px] font-bold text-[#0A0F1C] text-sm transition-all hover:brightness-110"
              style="background: linear-gradient(135deg, #22D3EE 0%, #0891B2 100%); box-shadow: 0 8px 24px #22D3EE40;"
            >
              <Trophy class="w-4 h-4" />
              {{ t('homeHeroCtaPrimary') }}
            </router-link>
            <a
              v-if="liveMatches.length > 0"
              :href="liveMatches[0]?.id ? '/queue/match/' + liveMatches[0].id : '/matches'"
              class="inline-flex items-center gap-2 h-12 px-6 rounded-[10px] font-semibold text-foreground text-sm border border-[#334155] hover:bg-white/5 transition-colors"
            >
              <Play class="w-4 h-4" />
              {{ t('homeHeroCtaSecondary') }}
            </a>
          </div>
        </div>

        <!-- Hero visual -->
        <div class="relative w-[360px] h-[420px] hidden lg:block shrink-0">
          <!-- glow / ring background -->
          <div class="absolute inset-0 rounded-full blur-3xl opacity-50"
            style="background: radial-gradient(circle, #22D3EE40 0%, transparent 70%);" />
          <div class="absolute inset-8 rounded-full border-[6px] border-cyan-400/40" />
          <div class="absolute inset-16 rounded-full border-[5px] border-amber-500/50" />
          <Swords class="absolute inset-0 m-auto w-24 h-24 text-cyan-400/90" />

          <!-- floating chips -->
          <div class="absolute top-12 left-0 flex items-center gap-3 h-16 px-4 rounded-xl bg-[#0F1A2E]/85 border border-[#1F2937] shadow-2xl">
            <div class="w-9 h-9 rounded-lg bg-cyan-500/20 flex items-center justify-center">
              <Users class="w-4 h-4 text-cyan-400" />
            </div>
            <div class="flex flex-col">
              <span class="text-base font-bold font-mono text-foreground tabular-nums">{{ stats?.active_players?.toLocaleString() ?? '—' }}</span>
              <span class="text-[11px] text-muted-foreground">{{ t('homeStatActivePlayers') }}</span>
            </div>
          </div>

          <div class="absolute top-0 right-0 flex items-center gap-3 h-16 px-4 rounded-xl bg-[#0F1A2E]/85 border border-red-500/40 shadow-2xl">
            <div class="w-9 h-9 rounded-lg bg-red-500/20 flex items-center justify-center">
              <Radio class="w-4 h-4 text-red-500" />
            </div>
            <div class="flex flex-col">
              <span class="text-base font-bold font-mono text-foreground tabular-nums">{{ stats?.live_matches ?? 0 }} {{ t('homeStatLiveSuffix') }}</span>
              <span class="text-[11px] text-muted-foreground">{{ t('homeStatLiveMatches') }}</span>
            </div>
          </div>

          <div class="absolute bottom-0 left-12 flex items-center gap-3 h-16 px-4 rounded-xl bg-[#0F1A2E]/85 border border-amber-500/40 shadow-2xl">
            <div class="w-9 h-9 rounded-lg bg-amber-500/20 flex items-center justify-center">
              <Trophy class="w-4 h-4 text-amber-500" />
            </div>
            <div class="flex flex-col">
              <span class="text-base font-bold font-mono text-amber-500 tabular-nums">{{ stats?.active_tournaments ?? 0 }}</span>
              <span class="text-[11px] text-muted-foreground">{{ t('homeStatActiveTournaments') }}</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ─── Live Now ─── -->
    <section v-if="liveCards.length > 0" class="bg-[#0A0F1C]">
      <div class="max-w-[1200px] mx-auto px-4 md:px-8 lg:px-20 py-12">
        <div class="flex items-center justify-between mb-6">
          <div class="flex items-center gap-3">
            <span class="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <h2 class="text-xl font-bold">{{ t('homeLiveTitle') }}</h2>
          </div>
          <router-link to="/matches" class="inline-flex items-center gap-1 text-sm text-cyan-400 hover:underline font-semibold">
            {{ t('viewAll') }} <ChevronRight class="w-4 h-4" />
          </router-link>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-5">
          <router-link
            v-for="m in liveCards" :key="m.id"
            :to="{ name: 'queue-match', params: { id: m.id } }"
            class="rounded-[14px] bg-[#0F1A2E] border border-[#1F2937] hover:border-cyan-500/50 transition-colors overflow-hidden"
          >
            <div class="flex items-center justify-between h-10 px-4 bg-[#0B1220]">
              <div class="flex items-center gap-2">
                <span class="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                <span class="text-[10px] font-bold font-mono tracking-widest text-red-500">
                  {{ t('matchLive').toUpperCase() }}<span v-if="m.best_of && m.best_of > 1"> · BO{{ m.best_of }}</span>
                </span>
              </div>
              <div class="flex items-center gap-1.5 text-[11px] text-muted-foreground font-mono">
                <Eye class="w-3 h-3" />
                <span>{{ formatRelativeTime(m.created_at) }}</span>
              </div>
            </div>
            <div class="p-5 flex flex-col gap-4">
              <div class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-2 min-w-0 flex-1">
                  <img v-if="m.captain1_avatar" :src="m.captain1_avatar" class="w-8 h-8 rounded-full ring-2 ring-emerald-500/30" />
                  <div v-else class="w-8 h-8 rounded-full bg-emerald-500/15" />
                  <span class="text-sm font-semibold truncate">{{ m.captain1_display_name || '?' }}</span>
                </div>
                <div class="flex items-center gap-2 font-mono font-bold text-base shrink-0">
                  <span class="text-emerald-400">{{ m.team1_kills ?? '–' }}</span>
                  <span class="text-muted-foreground/40">·</span>
                  <span class="text-red-400">{{ m.team2_kills ?? '–' }}</span>
                </div>
                <div class="flex items-center gap-2 min-w-0 flex-1 justify-end">
                  <span class="text-sm font-semibold truncate text-right">{{ m.captain2_display_name || '?' }}</span>
                  <img v-if="m.captain2_avatar" :src="m.captain2_avatar" class="w-8 h-8 rounded-full ring-2 ring-red-500/30" />
                  <div v-else class="w-8 h-8 rounded-full bg-red-500/15" />
                </div>
              </div>
              <div class="h-10 rounded-lg bg-cyan-400 hover:brightness-110 transition-all flex items-center justify-center gap-2 text-[#0A0F1C] font-bold text-sm">
                <Play class="w-3.5 h-3.5" />
                {{ t('homeLiveWatch') }}
              </div>
            </div>
          </router-link>
        </div>
      </div>
    </section>

    <!-- ─── Featured Tournament ─── -->
    <section v-if="featured" class="bg-[#0A0F1C]">
      <div class="max-w-[1200px] mx-auto px-4 md:px-8 lg:px-20 py-8">
        <div
          class="rounded-2xl overflow-hidden border border-[#1F2937] grid grid-cols-1 lg:grid-cols-2"
          style="background: linear-gradient(135deg, #0F1A2E 0%, #1A1632 100%); box-shadow: 0 12px 32px #00000060;"
        >
          <!-- Left -->
          <div class="p-10 flex flex-col gap-5">
            <div class="inline-flex items-center gap-2 self-start px-3 py-1 rounded-full bg-amber-500/20 border border-amber-500 text-[11px] font-bold font-mono tracking-widest text-amber-500">
              <Flame class="w-3 h-3" />
              {{ t('homeFeaturedBadge') }}
            </div>
            <h2 class="text-3xl md:text-4xl font-extrabold tracking-tight leading-tight">{{ featured.name }}</h2>
            <p v-if="featured.description" class="text-sm text-muted-foreground leading-relaxed line-clamp-3">{{ featured.description.replace(/<[^>]+>/g, '') }}</p>
            <div class="flex flex-wrap gap-8 mt-2">
              <div class="flex flex-col gap-1">
                <span class="text-2xl font-bold font-mono text-cyan-400">{{ featured.captain_count || 0 }}</span>
                <span class="text-xs text-muted-foreground">{{ t('homeFeaturedTeams') }}</span>
              </div>
              <div class="flex flex-col gap-1">
                <span class="text-lg font-bold font-mono text-foreground">{{ fmtRange(featured.starts_at, featured.registration_end) }}</span>
                <span class="text-xs text-muted-foreground">{{ t('homeFeaturedDates') }}</span>
              </div>
              <div v-if="featured.competition_type" class="flex flex-col gap-1">
                <span class="text-lg font-bold font-mono text-foreground capitalize">{{ featured.competition_type }}</span>
                <span class="text-xs text-muted-foreground">{{ t('homeFeaturedFormat') }}</span>
              </div>
            </div>
            <div class="flex items-center gap-3 mt-4">
              <router-link
                :to="{ name: 'comp-info', params: { compId: featured.id } }"
                class="inline-flex items-center gap-2 h-12 px-6 rounded-lg bg-amber-500 text-[#0A0F1C] font-bold text-sm hover:brightness-110 transition-all"
              >
                <UserPlus class="w-4 h-4" />
                {{ t('homeFeaturedCtaPrimary') }}
              </router-link>
              <router-link
                :to="{ name: 'comp-info', params: { compId: featured.id } }"
                class="inline-flex items-center h-12 px-5 rounded-lg border border-[#334155] text-foreground text-sm font-semibold hover:bg-white/5 transition-colors"
              >
                {{ t('homeFeaturedCtaSecondary') }}
              </router-link>
            </div>
          </div>

          <!-- Right: Bracket Preview -->
          <div class="p-8 border-t lg:border-t-0 lg:border-l border-[#1F2937]"
               style="background: linear-gradient(135deg, #0A1224 0%, #160A24 100%);">
            <div class="flex items-center justify-between mb-4">
              <span class="text-sm font-bold">{{ t('homeFeaturedBracket') }}</span>
              <span class="text-xs font-mono font-semibold text-cyan-400">
                {{ featured.bracket?.[0]?.stage_name || t('homeFeaturedBracketStage') }}
              </span>
            </div>
            <div v-if="featured.bracket?.length" class="grid grid-cols-3 gap-4 items-center">
              <!-- Column 1: first 4 matches -->
              <div class="flex flex-col gap-3">
                <div v-for="m in featured.bracket.slice(0, 4)" :key="m.id"
                     class="rounded-md bg-[#0F1A2E] border border-[#1F2937] overflow-hidden text-[11px]">
                  <div class="px-2.5 py-1.5 truncate text-muted-foreground">{{ m.team1 || '—' }}</div>
                  <div class="h-px bg-border/40" />
                  <div class="px-2.5 py-1.5 truncate text-muted-foreground">{{ m.team2 || '—' }}</div>
                </div>
              </div>
              <!-- Column 2: 2 semis -->
              <div class="flex flex-col gap-6 justify-center py-6">
                <div v-for="m in featured.bracket.slice(4, 6)" :key="m.id"
                     class="rounded-md bg-[#0F1A2E] border border-cyan-500/40 overflow-hidden text-[11px]">
                  <div class="px-2.5 py-1.5 truncate text-muted-foreground">{{ m.team1 || '—' }}</div>
                  <div class="h-px bg-border/40" />
                  <div class="px-2.5 py-1.5 truncate text-muted-foreground">{{ m.team2 || '—' }}</div>
                </div>
              </div>
              <!-- Column 3: trophy -->
              <div class="flex flex-col items-center gap-2 justify-center py-12">
                <div class="w-14 h-14 rounded-2xl flex items-center justify-center"
                     style="background: linear-gradient(135deg, #F59E0B 0%, #B45309 100%);">
                  <Trophy class="w-7 h-7 text-[#0A0F1C]" />
                </div>
                <span class="text-[11px] font-bold font-mono tracking-widest text-amber-500">{{ t('homeFeaturedFinal') }}</span>
              </div>
            </div>
            <div v-else class="text-center text-sm text-muted-foreground py-12">
              {{ t('homeFeaturedNoBracket') }}
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ─── Latest News ─── -->
    <section v-if="newsCards.length > 0" class="bg-[#0A0F1C]">
      <div class="max-w-[1200px] mx-auto px-4 md:px-8 lg:px-20 py-8">
        <div class="flex items-center justify-between mb-6">
          <div>
            <h2 class="text-xl font-bold">{{ t('homeNewsTitle') }}</h2>
            <p class="text-xs text-muted-foreground mt-1">{{ t('homeNewsSubtitle') }}</p>
          </div>
          <router-link to="/news" class="inline-flex items-center gap-1 text-sm text-cyan-400 hover:underline font-semibold">
            {{ t('viewAll') }} <ChevronRight class="w-4 h-4" />
          </router-link>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          <router-link
            v-for="(n, i) in newsCards" :key="n.id"
            :to="{ name: 'news-post', params: { id: n.id } }"
            class="rounded-[14px] bg-[#0F1A2E] border border-[#1F2937] hover:border-cyan-500/50 transition-colors overflow-hidden flex flex-col"
          >
            <div class="h-40 flex items-center justify-center"
                 :style="`background: linear-gradient(135deg, ${i % 4 === 0 ? '#22D3EE' : i % 4 === 1 ? '#A855F7' : i % 4 === 2 ? '#F59E0B' : '#10B981'} 0%, #0E1A33 100%);`">
              <img v-if="n.image_url" :src="n.image_url" class="w-full h-full object-cover" />
              <Trophy v-else class="w-12 h-12 text-[#0A0F1C] opacity-40" />
            </div>
            <div class="p-4 flex flex-col gap-2.5 flex-1">
              <span class="self-start px-2 py-0.5 rounded bg-cyan-500/20 text-[9px] font-bold font-mono tracking-widest text-cyan-400 uppercase">
                {{ n.tag || t('newsNav') }}
              </span>
              <p class="text-sm font-bold leading-snug line-clamp-3 flex-1">{{ n.title }}</p>
              <div class="flex items-center gap-1.5 text-[11px] text-muted-foreground font-mono">
                <Calendar class="w-3 h-3" />
                <span>{{ fmtDateOnly(new Date(n.created_at)) }}</span>
              </div>
            </div>
          </router-link>
        </div>
      </div>
    </section>

    <!-- ─── Leaderboard + Side Stats ─── -->
    <section class="bg-[#0A0F1C]">
      <div class="max-w-[1200px] mx-auto px-4 md:px-8 lg:px-20 py-8 grid grid-cols-1 lg:grid-cols-[760px_1fr] gap-5">
        <!-- Top players -->
        <div class="rounded-[14px] bg-[#0F1A2E] border border-[#1F2937] overflow-hidden">
          <div class="flex items-center justify-between px-6 py-4 bg-[#0B1220]">
            <div class="flex items-center gap-2.5">
              <div class="w-8 h-8 rounded-lg bg-amber-500/20 flex items-center justify-center">
                <Trophy class="w-4 h-4 text-amber-500" />
              </div>
              <span class="text-base font-bold">
                {{ topPlayers.season ? t('homeTopPlayersWithSeason', { name: topPlayers.season.name }) : t('homeTopPlayersTitle') }}
              </span>
            </div>
            <div class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#0F1A2E] border border-[#1F2937] text-xs font-semibold text-muted-foreground">
              {{ topPlayers.season ? t('homeTopPlayersByPoints') : t('homeTopPlayersByMmr') }}
            </div>
          </div>
          <div class="grid grid-cols-[32px_1fr_90px_120px_80px] items-center px-6 py-2.5 bg-[#0B1220] border-b border-[#1F2937] text-[10px] font-bold font-mono tracking-widest text-muted-foreground">
            <span>#</span>
            <span>{{ t('player').toUpperCase() }}</span>
            <span class="text-right">{{ topPlayers.season ? t('seasonPoints').toUpperCase() : 'MMR' }}</span>
            <span class="text-right">{{ t('homeTopPlayersWinRate') }}</span>
            <span class="text-right">{{ t('homeTopPlayersStreak') }}</span>
          </div>
          <div v-if="topPlayers.players.length === 0" class="text-sm text-muted-foreground text-center py-10">
            {{ t('homeTopPlayersEmpty') }}
          </div>
          <router-link
            v-for="(p, idx) in topPlayers.players" :key="p.id"
            :to="{ name: 'player-profile', params: { id: p.id } }"
            class="grid grid-cols-[32px_1fr_90px_120px_80px] items-center px-6 h-16 border-b border-[#1F2937] hover:bg-accent/15 transition-colors"
            :class="idx === 0 ? 'bg-amber-500/[0.03]' : 'bg-[#0F1A2E]'"
          >
            <span class="font-mono font-extrabold text-lg" :class="rankColor(idx)">{{ idx + 1 }}</span>
            <div class="flex items-center gap-3 min-w-0">
              <img v-if="p.avatar_url" :src="p.avatar_url" class="w-9 h-9 rounded-full object-cover ring-2 ring-amber-500/30" />
              <div v-else class="w-9 h-9 rounded-full bg-accent" />
              <div class="min-w-0 flex flex-col">
                <span class="text-sm font-semibold truncate flex items-center gap-1">
                  {{ p.name }}
                  <BadgeCheck v-if="p.mmr_verified_at" class="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                </span>
              </div>
            </div>
            <span class="text-right font-mono font-bold text-cyan-400 tabular-nums">
              {{ topPlayers.season ? (p.points != null ? p.points.toLocaleString() : '—') : p.mmr.toLocaleString() }}
            </span>
            <div class="flex items-center justify-end gap-2">
              <div class="w-[60px] h-1.5 rounded-full bg-[#1F2937] overflow-hidden">
                <div class="h-full rounded-full bg-emerald-500" :style="{ width: (p.win_rate ?? 0) + '%' }" />
              </div>
              <span class="font-mono font-bold text-xs tabular-nums" :class="winrateColor(p.win_rate)">
                {{ p.win_rate != null ? p.win_rate + '%' : '—' }}
              </span>
            </div>
            <div class="flex items-center justify-end gap-1">
              <component :is="p.streak?.won ? Flame : (p.streak ? Snowflake : Flame)"
                class="w-3 h-3"
                :class="p.streak?.won ? 'text-red-500' : (p.streak ? 'text-cyan-400' : 'text-muted-foreground/40')" />
              <span class="text-xs font-mono font-bold" :class="streakColor(p.streak)">{{ streakLabel(p.streak) }}</span>
            </div>
          </router-link>
        </div>

        <!-- Side stats -->
        <div class="flex flex-col gap-5">
          <!-- Daily check-in (logged-in only) -->
          <div v-if="isLoggedIn && daily" class="rounded-[14px] border p-5 flex flex-col gap-3"
               :class="daily.claimed_today
                 ? 'border-emerald-500/40 bg-gradient-to-br from-emerald-500/[0.08] to-[#0F1A2E]'
                 : 'border-amber-500/50 bg-gradient-to-br from-amber-500/[0.10] to-[#0F1A2E]'">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2.5">
                <div class="w-8 h-8 rounded-lg flex items-center justify-center"
                     :class="daily.claimed_today ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'">
                  <Gift class="w-4 h-4" />
                </div>
                <span class="text-sm font-bold">{{ t('homeDailyTitle') }}</span>
              </div>
              <span v-if="daily.streak > 0" class="px-2 py-0.5 rounded bg-amber-500/15 text-amber-400 text-[10px] font-bold font-mono">
                <Flame class="w-3 h-3 inline -mt-0.5 mr-0.5" />{{ daily.streak }}
              </span>
            </div>
            <p class="text-xs text-muted-foreground leading-relaxed">
              <template v-if="daily.claimed_today">{{ t('homeDailyClaimed', { xp: daily.next_xp }) }}</template>
              <template v-else>{{ t('homeDailyAvailable', { xp: daily.next_xp }) }}</template>
            </p>
            <button
              v-if="!daily.claimed_today"
              type="button"
              :disabled="dailyClaiming"
              class="h-10 rounded-lg flex items-center justify-center gap-2 text-xs font-bold transition-all disabled:opacity-40"
              style="background: linear-gradient(135deg, #F59E0B 0%, #D97706 100%); color: #0A0F1C;"
              @click="claimDaily"
            >
              <Gift class="w-3.5 h-3.5" />
              {{ dailyClaiming ? `${t('saving')}…` : t('homeDailyClaim', { xp: daily.next_xp }) }}
            </button>
            <div v-else class="h-10 rounded-lg flex items-center justify-center gap-2 text-xs font-bold bg-emerald-500/15 text-emerald-400">
              <Check class="w-3.5 h-3.5" />
              {{ t('homeDailyDone') }}
            </div>
          </div>

          <!-- Hero pick rate -->
          <div class="rounded-[14px] border border-[#1F2937] p-6 flex flex-col gap-4"
               style="background: linear-gradient(135deg, #0F1A2E 0%, #1A1632 100%);">
            <div class="flex items-center justify-between">
              <span class="text-sm font-bold">{{ t('homeHeroPickRateTitle') }}</span>
              <span class="text-[10px] font-mono font-semibold text-muted-foreground">{{ t('homeHeroPickRateRange') }}</span>
            </div>
            <div v-if="heroPickRate.heroes.length === 0" class="text-xs text-muted-foreground">{{ t('homeHeroPickRateEmpty') }}</div>
            <div v-for="(h, i) in heroPickRate.heroes" :key="h.hero_id" class="flex items-center gap-2.5">
              <div class="w-8 h-8 rounded-lg overflow-hidden bg-accent flex items-center justify-center"
                   :style="`background: ${i === 0 ? '#EF4444' : i === 1 ? '#22D3EE' : '#A855F7'}`">
                <img v-if="dota.heroImg(h.hero_id)" :src="dota.heroImg(h.hero_id)" class="w-full h-full object-cover" />
              </div>
              <div class="flex-1 min-w-0 flex flex-col">
                <span class="text-xs font-semibold truncate">{{ dota.heroName(h.hero_id) || '#' + h.hero_id }}</span>
                <span class="text-[10px] text-muted-foreground font-mono">{{ h.picks }} {{ t('homeHeroPickRatePicks') }}</span>
              </div>
              <span class="text-xs font-mono font-bold tabular-nums"
                    :class="i === 0 ? 'text-red-500' : i === 1 ? 'text-cyan-400' : 'text-purple-400'">
                {{ h.pick_rate }}%
              </span>
            </div>
          </div>

          <!-- Next match -->
          <div v-if="upcomingNext" class="rounded-[14px] border border-[#1F2937] p-6 flex flex-col gap-4 bg-[#0F1A2E]">
            <div class="flex items-center justify-between">
              <span class="text-sm font-bold">{{ t('homeNextMatchTitle') }}</span>
              <span class="px-2 py-0.5 rounded bg-cyan-500/20 text-[10px] font-bold font-mono tracking-widest text-cyan-400">
                {{ formatRelativeTime(upcomingNext.scheduled_at || upcomingNext.created_at) }}
              </span>
            </div>
            <div class="flex items-center justify-between gap-3">
              <div class="flex items-center gap-2 min-w-0 flex-1">
                <img v-if="upcomingNext.captain1_avatar" :src="upcomingNext.captain1_avatar" class="w-8 h-8 rounded-full" />
                <div v-else class="w-8 h-8 rounded-full bg-accent" />
                <span class="text-sm font-semibold truncate">{{ upcomingNext.captain1_display_name || upcomingNext.captain1_name || 'TBD' }}</span>
              </div>
              <span class="font-mono font-extrabold text-base text-muted-foreground/60 tracking-widest">VS</span>
              <div class="flex items-center gap-2 min-w-0 flex-1 justify-end">
                <span class="text-sm font-semibold truncate text-right">{{ upcomingNext.captain2_display_name || upcomingNext.captain2_name || 'TBD' }}</span>
                <img v-if="upcomingNext.captain2_avatar" :src="upcomingNext.captain2_avatar" class="w-8 h-8 rounded-full" />
                <div v-else class="w-8 h-8 rounded-full bg-accent" />
              </div>
            </div>
            <router-link
              :to="upcomingNext.competition_id ? { name: 'comp-match', params: { compId: upcomingNext.competition_id, matchId: upcomingNext.id } } : '/matches'"
              class="h-10 rounded-lg border border-cyan-400 text-cyan-400 hover:bg-cyan-500/10 transition-colors flex items-center justify-center gap-2 text-xs font-semibold"
            >
              <Tv class="w-3.5 h-3.5" />
              {{ t('homeNextMatchView') }}
            </router-link>
          </div>
        </div>
      </div>
    </section>

    <!-- ─── Sponsors ─── -->
    <section v-if="sponsors.length > 0" class="bg-[#0A0F1C] border-t border-[#1F2937]">
      <div class="max-w-[1200px] mx-auto px-4 md:px-8 lg:px-20 py-10">
        <p class="text-center text-[11px] font-bold font-mono tracking-[2px] text-muted-foreground/70 mb-5">
          {{ t('homeSponsorsLabel') }}
        </p>
        <div class="flex flex-wrap items-center justify-center gap-12">
          <component
            :is="s.link ? 'a' : 'div'"
            v-for="s in sponsors" :key="s.id"
            :href="s.link || undefined" target="_blank" rel="noopener"
            class="opacity-70 hover:opacity-100 transition-opacity"
          >
            <img :src="s.logo_url" :alt="s.alt" class="h-8 max-w-[160px] object-contain" />
          </component>
        </div>
      </div>
    </section>
  </div>
</template>
