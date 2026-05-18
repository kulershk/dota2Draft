<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Trophy, Play, Users, Radio, Eye, Flame, ChevronRight, Calendar, Snowflake, BadgeCheck, UserPlus, Swords, Shield, Tv, Gift, Check, BarChart3, Timer, MessageCircle, Newspaper, Twitch, ExternalLink, ArrowRight, Crown, ChevronDown } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import { useDotaConstants } from '@/composables/useDotaConstants'
import { getSocket } from '@/composables/useSocket'
import { formatRelativeTime, fmtDateOnly } from '@/utils/format'

interface NewsCard {
  id: number
  title: string
  image_url: string | null
  created_at: string
  tag?: string | null
}
interface LiveMatch {
  kind: 'queue' | 'tournament'
  id: number
  /** Where to navigate when the card is clicked */
  to: { name: string; params: Record<string, any> }
  /** Top-left subtitle (pool name for queue, competition name for tournament) */
  context: string | null
  best_of: number | null
  team1_name: string | null
  team2_name: string | null
  team1_avatar: string | null
  team2_avatar: string | null
  /** Queue matches carry kill totals; tournament matches use score (games won) */
  team1_score: number | null
  team2_score: number | null
  show_kills: boolean
  /** Used for ordering newest live first */
  started_at: string
  /** Live game time in seconds (set when a live-stats snapshot arrives) */
  live_game_time: number | null
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
// Hydrate from the SWR site-settings cache synchronously so the hero text
// doesn't flash the i18n fallback before loadAll() resolves.
const _cachedSettings = (() => {
  try { return JSON.parse(localStorage.getItem('draft_site_settings_v1') || 'null') || {} }
  catch { return {} }
})()
const sponsors = ref<Sponsor[]>(_cachedSettings.site_sponsors || [])
const heroTitle = ref(_cachedSettings.site_title || 'Latvian Dota 2 League')
const heroSubtitle = ref(_cachedSettings.site_subtitle || '')
const heroParagraph = ref(_cachedSettings.site_hero_paragraph || '')
const heroBannerUrl = ref<string>(_cachedSettings.site_hero_banner_url || '')
// Hero banner vertical offset as % (0 = top, 50 = center, 100 = bottom).
// Legacy 'top'/'center'/'bottom' strings (older caches/payloads) are normalized.
const heroBannerPosition = ref<number>((() => {
  const raw = _cachedSettings.site_hero_banner_position
  if (raw === 'top') return 0
  if (raw === 'bottom') return 100
  if (raw === 'center') return 50
  const n = typeof raw === 'number' ? raw : parseInt(raw, 10)
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 50
})())

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

const liveCards = computed(() => liveMatches.value.slice(0, 4))
const newsCards = computed(() => news.value.slice(0, 3))
// Pencil newsLayout: one large hero news + up to 4 in the side list
const bigNews = computed(() => news.value[0] || null)
const newsList = computed(() => news.value.slice(1, 5))

// Deterministic gradient for news/stream card thumbnails (matches Pencil palette).
const NEWS_GRADIENTS = [
  'linear-gradient(135deg, #3F0808 0%, #EF4444 50%, #FACC15 100%)',
  'linear-gradient(135deg, #0F2D1F 0%, #22C55E 100%)',
  'linear-gradient(135deg, #1B0036 0%, #A78BFA 100%)',
  'linear-gradient(135deg, #0F2D3A 0%, #22D3EE 100%)',
]
function newsGradient(idx: number): string {
  return NEWS_GRADIENTS[idx % NEWS_GRADIENTS.length]
}

let pollInterval: ReturnType<typeof setInterval> | null = null

async function loadAll() {
  const [s, history, feat, n, top, pickRate, upcoming, settings] = await Promise.all([
    api.getHomeStats().catch(() => null),
    api.getQueueHistory({ limit: 6 }).catch(() => []),
    api.getFeaturedTournament().catch(() => null),
    api.getNews({ limit: 5 }).catch(() => []),
    api.getHomeTopPlayers(5).catch(() => ({ players: [], season: null })),
    api.getHomeHeroPickRate(7, 3).catch(() => ({ days: 7, heroes: [] })),
    api.getUpcomingMatches().catch(() => []),
    api.getSiteSettings().catch(() => null),
  ])
  stats.value = s

  // Merge queue + tournament live matches into a unified card list, newest first.
  const queueLive: LiveMatch[] = (history as any[])
    .filter(m => m.status === 'live')
    .map(m => ({
      kind: 'queue',
      id: m.id,
      to: { name: 'queue-match', params: { id: m.id } },
      context: m.pool_name || null,
      best_of: m.best_of || null,
      team1_name: m.captain1_display_name || m.captain1_name || null,
      team2_name: m.captain2_display_name || m.captain2_name || null,
      team1_avatar: m.captain1_avatar || null,
      team2_avatar: m.captain2_avatar || null,
      team1_score: m.team1_kills,
      team2_score: m.team2_kills,
      show_kills: true,
      started_at: m.created_at,
      live_game_time: null,
    }))
  const tournamentLive: LiveMatch[] = (upcoming as any[])
    .filter(m => m.status === 'live')
    .map(m => ({
      kind: 'tournament',
      id: m.id,
      to: m.competition_id
        ? { name: 'comp-match', params: { compId: m.competition_id, matchId: m.id } }
        : { name: 'home', params: {} },
      context: m.competition_name || null,
      best_of: m.best_of || null,
      team1_name: m.team1_name || null,
      team2_name: m.team2_name || null,
      team1_avatar: m.team1_banner || m.team1_avatar || null,
      team2_avatar: m.team2_banner || m.team2_avatar || null,
      team1_score: m.score1,
      team2_score: m.score2,
      show_kills: false,
      started_at: m.scheduled_at || m.created_at || new Date().toISOString(),
      live_game_time: null,
    }))
  liveMatches.value = [...queueLive, ...tournamentLive]
    .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())

  featured.value = feat
  news.value = (n as any[]).slice(0, 5)
  topPlayers.value = top
  heroPickRate.value = pickRate
  upcomingNext.value = (upcoming as any[])[0] || null
  if (settings) {
    sponsors.value = settings.site_sponsors || []
    if (settings.site_title) heroTitle.value = settings.site_title
    if (settings.site_subtitle) heroSubtitle.value = settings.site_subtitle
    if (settings.site_hero_paragraph) heroParagraph.value = settings.site_hero_paragraph
    heroBannerUrl.value = settings.site_hero_banner_url || ''
    if (typeof settings.site_hero_banner_position === 'number') {
      heroBannerPosition.value = settings.site_hero_banner_position
    }
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

// Featured tournament CTA — text + variant depend on competition status.
function featuredCta(status: string | null | undefined): { key: string; show: boolean } {
  switch (status) {
    case 'registration':        return { key: 'homeFeaturedCtaRegister',   show: true }
    case 'registration_closed': return { key: 'homeFeaturedCtaView',       show: true }
    case 'active':              return { key: 'homeFeaturedCtaJoin',       show: true }
    case 'finished':            return { key: 'homeFeaturedCtaResults',    show: true }
    default:                    return { key: 'homeFeaturedCtaView',       show: false }
  }
}

function fmtMatchTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// Realtime score updates pushed by the server while a match is live. The
// poller sends payload.matchId for both queue and tournament matches; queue
// cards historically matched by queueMatchId, but matching by the canonical
// matchId means tournament cards get live updates too.
function onLiveStats(payload: any) {
  if (!payload) return
  const card = liveMatches.value.find(m =>
    m.kind === 'queue'
      ? (payload.queueMatchId != null && m.id === Number(payload.queueMatchId))
      : (payload.matchId != null && m.id === Number(payload.matchId))
  )
  if (!card) return
  // Steam returns radiant/dire — team1 is treated as radiant by convention
  if (Number.isFinite(Number(payload.radiant_score))) card.team1_score = Number(payload.radiant_score)
  if (Number.isFinite(Number(payload.dire_score)))    card.team2_score = Number(payload.dire_score)
  if (Number.isFinite(Number(payload.game_time)))     card.live_game_time = Number(payload.game_time)
}

function fmtGameTime(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return ''
  const m = Math.floor(sec / 60)
  const s = Math.abs(sec % 60).toString().padStart(2, '0')
  // Steam gives negative values during pre-game/horn — show 00:00 there
  if (sec < 0) return '00:00'
  return `${m}:${s}`
}

onMounted(() => {
  loadAll()
  // Live stats refresh every 30s — keeps the hero chips honest without spamming.
  pollInterval = setInterval(() => {
    api.getHomeStats().then(s => { stats.value = s }).catch(() => {})
  }, 30000)
  const sock = getSocket()
  sock?.on('home:liveStats', onLiveStats)
})
onUnmounted(() => {
  if (pollInterval) clearInterval(pollInterval)
  const sock = getSocket()
  sock?.off('home:liveStats', onLiveStats)
})
</script>

<template>
  <div class="bg-[#0A0F1C] text-foreground">
    <!-- ─── Hero (decorative banner, matches Pencil Ux64u; grows when settings text is set) ─── -->
    <section
      class="relative overflow-hidden border-b border-[#1E293B] min-h-[330px]"
      style="background:
        radial-gradient(circle at 25% 60%, #A21CAF55 0%, transparent 45%),
        radial-gradient(circle at 75% 55%, #22D3EE55 0%, transparent 45%),
        radial-gradient(circle at 50% 0%, #1E0B3A 0%, transparent 60%),
        linear-gradient(180deg, #0A0F1C 0%, #0F172A 50%, #0A0F1C 100%);"
    >
      <!-- Optional admin-uploaded banner image sits behind decoration. Vertical offset (0-100%) driven by site_hero_banner_position setting. -->
      <img v-if="heroBannerUrl" :src="heroBannerUrl" class="absolute inset-0 w-full h-full object-cover opacity-60" alt=""
           :style="{ objectPosition: `center ${heroBannerPosition}%` }" />

      <!-- Grid pattern overlay -->
      <div class="absolute inset-0 opacity-30"
           style="background-image:
             linear-gradient(to right, #FFFFFF0A 1px, transparent 1px),
             linear-gradient(to bottom, #FFFFFF0A 1px, transparent 1px);
             background-size: 40px 40px;" />

      <!-- Glow left (cyan) -->
      <div class="absolute rounded-full pointer-events-none"
           style="left: -200px; top: -180px; width: 520px; height: 520px;
                  background: radial-gradient(circle, #22D3EE60 0%, transparent 70%);" />
      <!-- Glow right (magenta) -->
      <div class="absolute rounded-full pointer-events-none"
           style="right: -200px; top: -160px; width: 560px; height: 560px;
                  background: radial-gradient(circle, #A21CAF60 0%, transparent 70%);" />

      <!-- Faint decorative icons (swords left/right, shield centered) -->
      <Swords class="absolute pointer-events-none" style="left: 80px; top: 50px; width: 120px; height: 120px; color: #22D3EE15;" />
      <Shield class="absolute left-1/2 -translate-x-1/2 pointer-events-none" style="top: 30px; width: 160px; height: 160px; color: #FFFFFF08;" />
      <Swords class="absolute pointer-events-none" style="right: 80px; top: 30px; width: 160px; height: 160px; color: #A21CAF15; transform: rotate(180deg);" />

      <!-- Bottom fade into page bg -->
      <div class="absolute left-0 right-0 bottom-0 h-20 pointer-events-none"
           style="background: linear-gradient(180deg, transparent 0%, #0A0F1C 100%);" />

      <!-- Settings-driven text overlay. Each line is independent: delete a field in admin → it disappears. Section keeps its 220px min when all are empty. -->
      <div v-if="heroTitle || heroSubtitle || heroParagraph"
           class="relative max-w-[1200px] mx-auto px-4 md:px-8 lg:px-10 py-12 flex flex-col items-center text-center gap-3">
        <h1 v-if="heroTitle" class="text-3xl md:text-5xl lg:text-6xl font-extrabold text-foreground tracking-tight leading-[1.05]">
          {{ heroTitle }}
        </h1>
        <p v-if="heroSubtitle" class="text-lg md:text-2xl font-semibold text-amber-500 leading-tight">
          {{ heroSubtitle }}
        </p>
        <p v-if="heroParagraph" class="text-sm md:text-base text-muted-foreground leading-relaxed whitespace-pre-line max-w-[680px]">
          {{ heroParagraph }}
        </p>
      </div>
    </section>

    <!-- ─── Live Now (Pencil featSection / aIew3 — 4-up card grid) ─── -->
    <section v-if="liveCards.length > 0" class="bg-[#0A0F1C]">
      <div class="max-w-[1300px] mx-auto px-4 md:px-8 lg:px-10 py-7">
        <!-- Section header: trophy icon + title + LIVE count pill | View all → -->
        <div class="flex items-center justify-between mb-4">
          <div class="flex items-center gap-3">
            <Trophy class="w-[18px] h-[18px] text-cyan-400 shrink-0" />
            <span class="text-[18px] font-bold text-[#F1F5F9]">{{ t('homeLiveTitle') }}</span>
            <span class="inline-flex items-center gap-1.5 px-2 py-[3px] rounded bg-[#7F1D1D]">
              <span class="w-1.5 h-1.5 rounded-[3px] bg-red-500" />
              <span class="text-[10px] font-bold tracking-[0.5px] text-[#F1F5F9]">{{ liveCards.length }} {{ t('matchLive').toUpperCase() }}</span>
            </span>
          </div>
          <router-link to="/matches" class="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-medium text-cyan-400 hover:underline">
            {{ t('viewAll') }}
            <ChevronRight class="w-3 h-3" />
          </router-link>
        </div>

        <!-- 4-up card grid -->
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <router-link
            v-for="m in liveCards" :key="m.kind + '-' + m.id"
            :to="m.to"
            class="flex flex-col rounded-[10px] bg-[#0F172A] border border-[#1E293B] overflow-hidden hover:border-cyan-500/40 transition-colors"
          >
            <!-- Card header: league/context name + LIVE pill -->
            <div class="flex items-center justify-between gap-2 px-3.5 py-2.5 bg-[#0B1220] border-b border-[#1E293B]">
              <div class="flex items-center gap-2 min-w-0">
                <div class="w-[18px] h-[18px] rounded bg-[#1E3A5F] shrink-0" />
                <span class="text-[11px] font-semibold text-[#94A3B8] truncate">{{ m.context || '—' }}</span>
              </div>
              <span class="inline-flex items-center gap-1.5 px-1.5 py-[3px] rounded bg-[#7F1D1D] shrink-0">
                <span class="w-1.5 h-1.5 rounded-[3px] bg-red-500 animate-pulse" />
                <span class="text-[9px] font-bold tracking-[0.5px] text-[#F1F5F9]">{{ t('matchLive').toUpperCase() }}</span>
              </span>
            </div>

            <!-- Card body: teams row + meta row -->
            <div class="flex flex-col gap-2.5 p-3.5 flex-1">
              <!-- Teams + score -->
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-2.5 min-w-0 flex-1">
                  <img v-if="m.team1_avatar" :src="m.team1_avatar" class="w-7 h-7 rounded object-cover bg-[#1E293B] shrink-0" />
                  <div v-else class="w-7 h-7 rounded bg-[#1E293B] shrink-0" />
                  <span class="text-[13px] font-medium text-white truncate">{{ m.team1_name || '?' }}</span>
                </div>
                <div class="flex items-center gap-1.5 font-mono font-bold text-[15px] shrink-0">
                  <span class="text-emerald-500 tabular-nums">{{ m.team1_score ?? '–' }}</span>
                  <span class="text-[#64748B] font-normal">:</span>
                  <span class="text-red-500 tabular-nums">{{ m.team2_score ?? '–' }}</span>
                </div>
                <div class="flex items-center gap-2.5 min-w-0 flex-1 justify-end">
                  <span class="text-[13px] font-medium text-white truncate text-right">{{ m.team2_name || '?' }}</span>
                  <img v-if="m.team2_avatar" :src="m.team2_avatar" class="w-7 h-7 rounded object-cover bg-[#1E293B] shrink-0" />
                  <div v-else class="w-7 h-7 rounded bg-[#1E293B] shrink-0" />
                </div>
              </div>
              <!-- Meta: best-of on left, game time on right -->
              <div class="flex items-center justify-between gap-2">
                <span class="text-[11px] font-medium text-[#64748B]">
                  {{ m.best_of ? `BO${m.best_of}` : '—' }}
                </span>
                <span class="text-[11px] font-medium font-mono text-[#94A3B8] tabular-nums">
                  <template v-if="m.live_game_time != null">{{ fmtGameTime(m.live_game_time) }}</template>
                  <template v-else>{{ formatRelativeTime(m.started_at) }}</template>
                </span>
              </div>
            </div>

            <!-- Card footer: watch button strip -->
            <div class="flex items-center justify-center gap-2 px-3.5 py-2.5 bg-[#0B1A2E] border-t border-[#1E293B]">
              <Play class="w-3.5 h-3.5 text-cyan-400" />
              <span class="text-[12px] font-semibold text-cyan-400">{{ t('homeHeroCtaSecondary') }}</span>
            </div>
          </router-link>
        </div>
      </div>
    </section>

    <!-- ─── News Layout (Pencil G4cD8B): Featured Tournament + Big News (left) | Latest News (center) | Live Streams (right) ─── -->
    <section class="bg-[#0A0F1C]">
      <div class="max-w-[1300px] mx-auto px-4 md:px-8 lg:px-10 py-7 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_295px_295px] gap-5">
        <!-- ── Left column: Featured Tournament + Big News ── -->
        <div class="flex flex-col gap-5 min-w-0">
          <!-- Featured Tournament card -->
          <router-link
            v-if="featured"
            :to="{ name: 'comp-info', params: { compId: featured.id } }"
            class="rounded-[14px] overflow-hidden bg-[#0F172A] border border-[#FB923C] block"
          >
            <!-- Header image with gradient bg, badge + title + description. Falls back to the design's amber→dark gradient if no image uploaded. -->
            <div class="flex flex-col justify-end gap-3.5 h-[240px] p-7"
                 :style="featured.image_url
                   ? `background: linear-gradient(180deg, rgba(15,23,42,0.15) 0%, rgba(15,23,42,0.75) 80%, rgba(15,23,42,0.9) 100%), url(${featured.image_url}) center/cover;`
                   : 'background: linear-gradient(135deg, #3A1F00 0%, #7C2D12 50%, #0F172A 100%);'">
              <span class="inline-flex items-center gap-1.5 self-start px-2.5 py-1 rounded-[5px] bg-[#FB923C]">
                <Trophy class="w-[11px] h-[11px] text-[#0A0F1C]" />
                <span class="text-[10px] font-black tracking-[1.2px] text-[#0A0F1C]">{{ t('homeFeaturedBadge').toUpperCase() }}</span>
              </span>
              <h3 class="text-[32px] font-black text-[#F1F5F9] leading-[1.1]">{{ featured.name }}</h3>
              <p v-if="featured.description" class="text-[14px] text-[#CBD5E1] leading-[1.4] line-clamp-2">
                {{ featured.description.replace(/<[^>]+>/g, '') }}
              </p>
            </div>
            <!-- Body: stats | buttons -->
            <div class="flex items-center justify-between gap-4 px-7 py-5">
              <div class="flex items-center gap-6">
                <div class="flex flex-col gap-0.5">
                  <span class="text-[28px] font-black font-mono text-[#F1F5F9] leading-none">{{ featured.captain_count || 0 }}</span>
                  <span class="text-[11px] font-bold tracking-[0.8px] text-[#64748B]">{{ t('homeFeaturedTeams') }}</span>
                </div>
                <div v-if="featured.competition_type" class="w-px h-10 bg-[#1E293B]" />
                <div v-if="featured.competition_type" class="flex flex-col gap-0.5">
                  <span class="text-[18px] font-black tracking-[0.5px] text-[#FB923C] uppercase">{{ featured.competition_type }}</span>
                  <span class="text-[11px] font-bold tracking-[0.8px] text-[#64748B]">{{ t('homeFeaturedFormat') }}</span>
                </div>
              </div>
              <div class="flex items-center gap-2.5">
                <span class="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#FB923C]">
                  <BarChart3 class="w-[13px] h-[13px] text-[#0A0F1C]" />
                  <span class="text-[13px] font-extrabold text-[#0A0F1C]">{{ t(featuredCta(featured.status).key) }}</span>
                </span>
                <span class="inline-flex items-center px-4 py-2.5 rounded-lg border border-[#1E293B] text-[13px] font-bold text-[#CBD5E1]">
                  {{ t('homeFeaturedCtaSecondary') }}
                </span>
              </div>
            </div>
          </router-link>

          <!-- Big News card (latest news) -->
          <router-link
            v-if="bigNews"
            :to="{ name: 'news-post', params: { id: bigNews.id } }"
            class="rounded-[14px] overflow-hidden bg-[#0F172A] border border-[#1E293B] flex"
          >
            <!-- Left: gradient/image panel 240w with badges -->
            <div class="relative flex flex-col justify-between p-4 w-[240px] h-[200px] shrink-0"
                 :style="bigNews.image_url
                   ? `background: linear-gradient(135deg, rgba(15,45,58,0.6) 0%, rgba(34,211,238,0.4) 50%, rgba(162,28,175,0.5) 100%), url(${bigNews.image_url}) center/cover;`
                   : 'background: linear-gradient(135deg, #0F2D3A 0%, #22D3EE 50%, #A21CAF 100%);'">
              <span class="inline-flex items-center gap-1.5 self-start px-2.5 py-[3px] rounded-[5px] bg-[#22D3EE]">
                <span class="w-[5px] h-[5px] rounded-full bg-[#0A0F1C]" />
                <span class="text-[9px] font-black tracking-[1px] text-[#0A0F1C]">{{ t('homeNewsJustPosted').toUpperCase() }}</span>
              </span>
              <span class="inline-flex items-center gap-1.5 self-start px-2 py-[3px] rounded-[5px]" style="background: rgba(10,15,28,0.67);">
                <Timer class="w-2.5 h-2.5 text-cyan-400" />
                <span class="text-[10px] font-bold text-cyan-400">{{ formatRelativeTime(bigNews.created_at) }}</span>
              </span>
            </div>
            <!-- Right: meta + title + footer (author placeholder + Read article CTA) -->
            <div class="flex flex-col justify-between gap-3.5 p-[22px] flex-1 min-w-0 h-[200px]">
              <div class="flex flex-col gap-2 min-w-0">
                <div class="flex items-center gap-2.5">
                  <span v-if="bigNews.tag" class="px-2 py-[2px] rounded bg-[#1B0036] text-[9px] font-extrabold tracking-[0.8px] text-[#A78BFA] uppercase">
                    {{ bigNews.tag }}
                  </span>
                </div>
                <h3 class="text-[18px] font-extrabold text-[#F1F5F9] leading-[1.2] line-clamp-2">{{ bigNews.title }}</h3>
              </div>
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                  <Calendar class="w-2.5 h-2.5 text-[#64748B]" />
                  <span class="text-[11px] text-[#64748B]">{{ fmtDateOnly(new Date(bigNews.created_at)) }}</span>
                </div>
                <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[7px] bg-[#22D3EE]">
                  <span class="text-[11px] font-extrabold text-[#0A0F1C]">{{ t('homeNewsReadArticle') }}</span>
                  <ArrowRight class="w-2.5 h-2.5 text-[#0A0F1C]" />
                </span>
              </div>
            </div>
          </router-link>
        </div>

        <!-- ── Center column: Latest News list ── -->
        <div class="flex flex-col gap-3.5 min-w-0">
          <!-- Header: NEWSPAPER icon + LATEST NEWS | View all -->
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-1.5">
              <Newspaper class="w-[13px] h-[13px] text-cyan-400" />
              <span class="text-[10px] font-extrabold tracking-[1.2px] text-[#475569]">{{ t('homeNewsTitle').toUpperCase() }}</span>
            </div>
            <router-link to="/news" class="text-[11px] font-bold text-cyan-400 hover:underline">{{ t('viewAll') }} →</router-link>
          </div>
          <!-- News cards (4 items) -->
          <router-link
            v-for="(n, i) in newsList" :key="n.id"
            :to="{ name: 'news-post', params: { id: n.id } }"
            class="flex items-center gap-3 p-3 rounded-[10px] bg-[#0F172A] border border-[#1E293B] hover:border-cyan-500/40 transition-colors"
          >
            <!-- Thumbnail (84×84) with category badge overlay -->
            <div class="relative w-[84px] h-[84px] rounded-lg overflow-hidden shrink-0"
                 :style="n.image_url
                   ? `background: url(${n.image_url}) center/cover;`
                   : `background: ${newsGradient(i)};`">
              <span v-if="n.tag" class="absolute top-1.5 left-1.5 px-1.5 py-[1px] rounded text-[8px] font-extrabold tracking-[0.5px] text-[#FACC15]" style="background: rgba(10,15,28,0.67);">
                {{ n.tag.toUpperCase() }}
              </span>
            </div>
            <div class="flex flex-col justify-between gap-1 flex-1 min-w-0 h-[84px]">
              <h4 class="text-[13px] font-bold text-[#F1F5F9] leading-[1.3] line-clamp-3">{{ n.title }}</h4>
              <div class="flex items-center gap-1.5">
                <Calendar class="w-2.5 h-2.5 text-[#64748B] shrink-0" />
                <span class="text-[10px] text-[#64748B] truncate">{{ fmtDateOnly(new Date(n.created_at)) }}</span>
              </div>
            </div>
          </router-link>
          <!-- View all news button -->
          <router-link to="/news" class="flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-lg border border-[#1E293B] hover:bg-[#0F172A] transition-colors">
            <span class="text-[12px] font-bold text-[#CBD5E1]">{{ t('homeNewsViewAll') }}</span>
            <ArrowRight class="w-3 h-3 text-cyan-400" />
          </router-link>
        </div>

        <!-- ── Right column: Live Streams (Twitch) ── -->
        <div class="flex flex-col gap-3.5 min-w-0">
          <!-- Header: Twitch chip + LIVE STREAMS + count pill -->
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="inline-flex items-center justify-center w-[22px] h-[22px] rounded-[5px] bg-[#9146FF]">
                <Twitch class="w-3 h-3 text-white" />
              </span>
              <span class="text-[10px] font-extrabold tracking-[1.2px] text-[#475569]">{{ t('homeStreamsTitle').toUpperCase() }}</span>
              <span class="inline-flex items-center gap-1 px-1.5 py-[2px] rounded bg-[#3F1D1D]">
                <span class="w-[5px] h-[5px] rounded-full bg-red-500" />
                <span class="text-[10px] font-extrabold text-[#FCA5A5]">0</span>
              </span>
            </div>
          </div>
          <!-- Empty state — no Twitch stream API wired yet, structure preserved -->
          <div class="flex flex-col items-center justify-center gap-2 p-8 rounded-[10px] bg-[#0F172A] border border-[#9146FF]/60 text-center">
            <Twitch class="w-6 h-6 text-[#9146FF]" />
            <p class="text-[12px] text-[#64748B] leading-relaxed">{{ t('homeStreamsEmpty') }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- ─── Community Section (Pencil nwteQ): Top Players leaderboard | Daily Bonus + Hero Pick Rate sidebar ─── -->
    <section class="bg-[#0A0F1C] border-b border-[#1E293B]">
      <div class="max-w-[1300px] mx-auto px-4 md:px-8 lg:px-10 py-7 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-5">
        <!-- ── Left: Top Players Card ── -->
        <div class="rounded-[14px] bg-[#0F172A] border border-[#1E293B] p-6 flex flex-col gap-3.5 min-w-0">
          <!-- Header -->
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2.5">
              <div class="w-8 h-8 rounded-lg bg-[#1B1F3A] flex items-center justify-center">
                <Crown class="w-4 h-4 text-[#FACC15]" />
              </div>
              <div class="flex flex-col gap-0.5">
                <span class="text-[16px] font-extrabold text-[#F1F5F9] leading-none">
                  {{ topPlayers.season ? t('homeTopPlayersWithSeason', { name: topPlayers.season.name }) : t('homeTopPlayersTitle') }}
                </span>
                <span class="text-[11px] text-[#64748B]">{{ t('homeTopPlayersSubtitle') }}</span>
              </div>
            </div>
            <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[7px] bg-[#0B1A2E] border border-[#1E3A5F]">
              <span class="text-[12px] font-bold text-cyan-400">{{ topPlayers.season ? t('homeTopPlayersByPoints') : t('homeTopPlayersByMmr') }}</span>
              <ChevronDown class="w-[11px] h-[11px] text-cyan-400" />
            </span>
          </div>

          <!-- Column headers -->
          <div class="grid grid-cols-[32px_minmax(0,1fr)_80px_140px_70px] items-center gap-3 px-3 py-2 rounded-lg bg-[#0B1220]">
            <span class="text-[10px] font-extrabold tracking-[1px] text-[#475569]">#</span>
            <span class="text-[10px] font-extrabold tracking-[1px] text-[#475569]">{{ t('player').toUpperCase() }}</span>
            <span class="text-[10px] font-extrabold tracking-[1px] text-[#475569] text-right">
              {{ topPlayers.season ? t('seasonPoints').toUpperCase() : 'MMR' }}
            </span>
            <span class="text-[10px] font-extrabold tracking-[1px] text-[#475569] text-center">{{ t('homeTopPlayersWinRate') }}</span>
            <span class="text-[10px] font-extrabold tracking-[1px] text-[#475569] text-right">{{ t('homeTopPlayersStreak') }}</span>
          </div>

          <!-- Empty state -->
          <div v-if="topPlayers.players.length === 0" class="text-sm text-muted-foreground text-center py-10">
            {{ t('homeTopPlayersEmpty') }}
          </div>

          <!-- Rows -->
          <div class="flex flex-col">
            <router-link
              v-for="(p, idx) in topPlayers.players" :key="p.id"
              :to="{ name: 'player-profile', params: { id: p.id } }"
              class="grid grid-cols-[32px_minmax(0,1fr)_80px_140px_70px] items-center gap-3 px-3 py-3.5 border-b border-[#1E293B] hover:bg-white/[0.02] transition-colors last:border-b-0"
            >
              <span class="font-mono font-extrabold text-[18px] tabular-nums text-center"
                    :class="idx === 0 ? 'text-[#FACC15]' : idx === 1 ? 'text-[#CBD5E1]' : idx === 2 ? 'text-[#92400E]' : 'text-[#64748B]'">
                {{ idx + 1 }}
              </span>
              <div class="flex items-center gap-3 min-w-0">
                <img v-if="p.avatar_url" :src="p.avatar_url" class="w-9 h-9 rounded-lg object-cover bg-[#1E293B]" />
                <div v-else class="w-9 h-9 rounded-lg bg-[#1E293B]" />
                <div class="flex items-center gap-1.5 min-w-0">
                  <span class="text-[13px] font-semibold text-[#F1F5F9] truncate">{{ p.name }}</span>
                  <BadgeCheck v-if="p.mmr_verified_at" class="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                </div>
              </div>
              <span class="text-right font-mono font-extrabold text-[14px] text-cyan-400 tabular-nums">
                {{ topPlayers.season ? (p.points != null ? p.points.toLocaleString() : '—') : p.mmr.toLocaleString() }}
              </span>
              <div class="flex items-center justify-end gap-2">
                <div class="w-[90px] h-[5px] rounded-[2px] bg-[#1E293B] overflow-hidden">
                  <div class="h-full rounded-[2px] bg-emerald-500" :style="{ width: (p.win_rate ?? 0) + '%' }" />
                </div>
                <span class="font-mono font-bold text-[12px] tabular-nums w-9 text-right" :class="winrateColor(p.win_rate)">
                  {{ p.win_rate != null ? p.win_rate + '%' : '—' }}
                </span>
              </div>
              <div class="flex items-center justify-end gap-1.5">
                <component :is="p.streak?.won ? Flame : (p.streak ? Snowflake : Flame)"
                  class="w-3 h-3"
                  :class="p.streak?.won ? 'text-[#FB923C]' : (p.streak ? 'text-[#3B82F6]' : 'text-[#475569]')" />
                <span class="text-[12px] font-extrabold" :class="p.streak?.won ? 'text-[#FB923C]' : (p.streak ? 'text-[#3B82F6]' : 'text-[#475569]')">
                  {{ streakLabel(p.streak) }}
                </span>
              </div>
            </router-link>
          </div>

          <!-- View full ladder -->
          <router-link
            :to="topPlayers.season ? { name: 'season-leaderboard', params: { slug: topPlayers.season.slug } } : { name: 'seasons' }"
            class="flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-lg border border-[#1E293B] hover:bg-white/[0.02] transition-colors"
          >
            <span class="text-[12px] font-bold text-[#CBD5E1]">{{ t('homeTopPlayersViewFull') }}</span>
            <ArrowRight class="w-3 h-3 text-cyan-400" />
          </router-link>
        </div>

        <!-- ── Right: Side cards (Daily Bonus + Hero Pick Rate) ── -->
        <div class="flex flex-col gap-5">
          <!-- Daily Bonus (logged-in only) -->
          <div v-if="isLoggedIn && daily" class="rounded-[14px] bg-[#0F172A] border border-[#1E293B] p-5 flex flex-col gap-3">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2">
                <div class="w-7 h-7 rounded-[7px] bg-[#3A2A00] flex items-center justify-center">
                  <Gift class="w-3.5 h-3.5 text-amber-400" />
                </div>
                <span class="text-[14px] font-extrabold text-[#F1F5F9]">{{ t('homeDailyTitle') }}</span>
              </div>
              <span v-if="daily.streak > 0" class="inline-flex items-center gap-1 px-2 py-[2px] rounded-[5px] bg-[#3A1F00]">
                <Flame class="w-2.5 h-2.5 text-[#FB923C]" />
                <span class="text-[10px] font-extrabold text-[#FB923C]">{{ daily.streak }}</span>
              </span>
            </div>
            <p class="text-[12px] text-[#94A3B8] leading-[1.5]">
              <template v-if="daily.claimed_today">{{ t('homeDailyClaimed', { xp: daily.next_xp }) }}</template>
              <template v-else>{{ t('homeDailyAvailable', { xp: daily.next_xp }) }}</template>
            </p>
            <button
              v-if="!daily.claimed_today"
              type="button"
              :disabled="dailyClaiming"
              class="h-10 rounded-lg flex items-center justify-center gap-2 text-[12px] font-extrabold transition-all disabled:opacity-40"
              style="background: linear-gradient(135deg, #F59E0B 0%, #D97706 100%); color: #0A0F1C;"
              @click="claimDaily"
            >
              <Gift class="w-3.5 h-3.5" />
              {{ dailyClaiming ? `${t('saving')}…` : t('homeDailyClaim', { xp: daily.next_xp }) }}
            </button>
            <div v-else class="h-10 rounded-lg flex items-center justify-center gap-2 bg-[#052E1B] border border-[#22C55E]">
              <Check class="w-3 h-3 text-[#22C55E]" />
              <span class="text-[12px] font-extrabold text-[#22C55E]">{{ t('homeDailyDone') }}</span>
            </div>
          </div>

          <!-- Hero Pick Rate -->
          <div class="rounded-[14px] bg-[#0F172A] border border-[#1E293B] p-5 flex flex-col gap-3">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2">
                <div class="w-7 h-7 rounded-[7px] bg-[#1B1F3A] flex items-center justify-center">
                  <BarChart3 class="w-3.5 h-3.5 text-cyan-400" />
                </div>
                <span class="text-[14px] font-extrabold text-[#F1F5F9]">{{ t('homeHeroPickRateTitle') }}</span>
              </div>
              <span class="text-[11px] text-[#64748B]">{{ t('homeHeroPickRateRange') }}</span>
            </div>
            <div v-if="heroPickRate.heroes.length === 0" class="text-[12px] text-[#64748B]">
              {{ t('homeHeroPickRateEmpty') }}
            </div>
            <div v-for="(h, i) in heroPickRate.heroes" :key="h.hero_id" class="flex items-center gap-2.5 p-2 rounded-[7px]">
              <div class="w-9 h-9 rounded-[7px] overflow-hidden flex items-center justify-center shrink-0"
                   :style="`background: ${i === 0 ? 'linear-gradient(135deg, #1B0036 0%, #A78BFA 100%)' : i === 1 ? 'linear-gradient(135deg, #0F2D3A 0%, #22D3EE 100%)' : 'linear-gradient(135deg, #3F0808 0%, #FB923C 100%)'}`">
                <img v-if="dota.heroImg(h.hero_id)" :src="dota.heroImg(h.hero_id)" class="w-full h-full object-cover" />
                <span v-else class="text-[14px] font-extrabold text-white">{{ (dota.heroName(h.hero_id) || '?').charAt(0) }}</span>
              </div>
              <div class="flex flex-col gap-0.5 flex-1 min-w-0">
                <span class="text-[13px] font-bold text-[#F1F5F9] truncate">{{ dota.heroName(h.hero_id) || '#' + h.hero_id }}</span>
                <span class="text-[11px] text-[#64748B]">{{ h.picks }} {{ t('homeHeroPickRatePicks') }}</span>
              </div>
              <span class="font-mono font-extrabold text-[13px] text-[#EF4444] tabular-nums">{{ h.pick_rate }}%</span>
            </div>
            <router-link :to="{ name: 'seasons' }" class="flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-lg border border-[#1E293B] hover:bg-white/[0.02] transition-colors">
              <span class="text-[12px] font-bold text-[#CBD5E1]">{{ t('homeHeroPickRateViewAll') }}</span>
              <ArrowRight class="w-3 h-3 text-cyan-400" />
            </router-link>
          </div>
        </div>
      </div>
    </section>

    <template v-if="false">

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
              <div v-if="featured.competition_type" class="flex flex-col gap-1">
                <span class="text-lg font-bold font-mono text-foreground capitalize">{{ featured.competition_type }}</span>
                <span class="text-xs text-muted-foreground">{{ t('homeFeaturedFormat') }}</span>
              </div>
            </div>
            <div class="flex items-center gap-3 mt-4">
              <router-link
                v-if="featuredCta(featured.status).show"
                :to="{ name: 'comp-info', params: { compId: featured.id } }"
                class="inline-flex items-center gap-2 h-12 px-6 rounded-lg bg-amber-500 text-[#0A0F1C] font-bold text-sm hover:brightness-110 transition-all"
              >
                <UserPlus class="w-4 h-4" />
                {{ t(featuredCta(featured.status).key) }}
              </router-link>
              <router-link
                :to="{ name: 'comp-info', params: { compId: featured.id } }"
                class="inline-flex items-center h-12 px-5 rounded-lg border border-[#334155] text-foreground text-sm font-semibold hover:bg-white/5 transition-colors"
              >
                {{ t('homeFeaturedCtaSecondary') }}
              </router-link>
            </div>
          </div>

          <!-- Right: Upcoming Matches -->
          <div class="p-8 border-t lg:border-t-0 lg:border-l border-[#1F2937]"
               style="background: linear-gradient(135deg, #0A1224 0%, #160A24 100%);">
            <div class="flex items-center justify-between mb-4">
              <span class="text-sm font-bold">{{ t('homeFeaturedUpcoming') }}</span>
              <router-link :to="{ name: 'comp-matches', params: { compId: featured.id } }"
                           class="inline-flex items-center gap-1 text-xs text-cyan-400 hover:underline font-semibold">
                {{ t('viewAll') }} <ChevronRight class="w-3 h-3" />
              </router-link>
            </div>
            <div v-if="featured.upcoming_matches?.length" class="flex flex-col gap-3">
              <router-link
                v-for="m in featured.upcoming_matches" :key="m.id"
                :to="{ name: 'comp-match', params: { compId: featured.id, matchId: m.id } }"
                class="rounded-lg bg-[#0F1A2E] border border-[#1F2937] hover:border-cyan-500/40 transition-colors p-3 flex flex-col gap-2"
              >
                <div class="flex items-center justify-between text-[10px] font-bold font-mono tracking-widest">
                  <span :class="m.status === 'live' ? 'text-red-500' : 'text-muted-foreground'">
                    <span v-if="m.status === 'live'" class="inline-block w-1.5 h-1.5 rounded-full bg-red-500 mr-1 animate-pulse" />
                    <template v-if="m.status === 'live'">{{ t('matchLive').toUpperCase() }}</template>
                    <template v-else-if="m.group_name">{{ m.group_name }}</template>
                    <template v-else-if="m.round">R{{ m.round }}</template>
                    <template v-else>{{ t('matchScheduled').toUpperCase() }}</template>
                  </span>
                  <span v-if="m.scheduled_at && m.status !== 'live'" class="text-muted-foreground/70">{{ fmtMatchTime(m.scheduled_at) }}</span>
                </div>
                <div class="flex items-center justify-between gap-2 text-xs">
                  <div class="flex items-center gap-1.5 min-w-0 flex-1">
                    <img v-if="m.team1_banner" :src="m.team1_banner" class="w-5 h-5 rounded object-cover shrink-0" />
                    <div v-else class="w-5 h-5 rounded bg-accent shrink-0" />
                    <span class="font-semibold truncate">{{ m.team1 }}</span>
                  </div>
                  <span class="font-mono text-muted-foreground/60 shrink-0">vs</span>
                  <div class="flex items-center gap-1.5 min-w-0 flex-1 justify-end">
                    <span class="font-semibold truncate text-right">{{ m.team2 }}</span>
                    <img v-if="m.team2_banner" :src="m.team2_banner" class="w-5 h-5 rounded object-cover shrink-0" />
                    <div v-else class="w-5 h-5 rounded bg-accent shrink-0" />
                  </div>
                </div>
              </router-link>
            </div>
            <div v-else class="text-center text-sm text-muted-foreground py-12">
              {{ t('homeFeaturedNoUpcoming') }}
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
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          <router-link
            v-for="(n, i) in newsCards" :key="n.id"
            :to="{ name: 'news-post', params: { id: n.id } }"
            class="rounded-[14px] bg-[#0F1A2E] border border-[#1F2937] hover:border-cyan-500/50 transition-colors overflow-hidden flex flex-col"
          >
            <div class="h-40 flex items-center justify-center"
                 :style="`background: linear-gradient(135deg, ${i % 3 === 0 ? '#22D3EE' : i % 3 === 1 ? '#A855F7' : '#F59E0B'} 0%, #0E1A33 100%);`">
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
      <div class="max-w-[1200px] mx-auto px-4 md:px-8 lg:px-20 py-8 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-5">
        <!-- Top players -->
        <div class="rounded-[14px] bg-[#0F1A2E] border border-[#1F2937] overflow-hidden min-w-0">
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
          <div class="grid grid-cols-[32px_minmax(0,1fr)_90px_120px_80px] items-center px-6 py-2.5 bg-[#0B1220] border-b border-[#1F2937] text-[10px] font-bold font-mono tracking-widest text-muted-foreground">
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
            class="grid grid-cols-[32px_minmax(0,1fr)_90px_120px_80px] items-center px-6 h-16 border-b border-[#1F2937] hover:bg-accent/15 transition-colors"
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
                <img v-if="upcomingNext.team1_banner || upcomingNext.team1_avatar"
                     :src="upcomingNext.team1_banner || upcomingNext.team1_avatar"
                     class="w-8 h-8 rounded-full object-cover" />
                <div v-else class="w-8 h-8 rounded-full bg-accent" />
                <span class="text-sm font-semibold truncate">{{ upcomingNext.team1_name || t('tbd') }}</span>
              </div>
              <span class="font-mono font-extrabold text-base text-muted-foreground/60 tracking-widest">VS</span>
              <div class="flex items-center gap-2 min-w-0 flex-1 justify-end">
                <span class="text-sm font-semibold truncate text-right">{{ upcomingNext.team2_name || t('tbd') }}</span>
                <img v-if="upcomingNext.team2_banner || upcomingNext.team2_avatar"
                     :src="upcomingNext.team2_banner || upcomingNext.team2_avatar"
                     class="w-8 h-8 rounded-full object-cover" />
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
            <img :src="s.logo_url" :alt="s.alt" class="h-16 max-w-[320px] object-contain" />
          </component>
        </div>
      </div>
    </section>
    </template>
  </div>
</template>
