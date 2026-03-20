<script setup lang="ts">
import { Newspaper, Calendar, Trophy, Users, Swords, User, MessageSquare, Send, Trash2, ChevronDown, ChevronUp, Twitch, Eye, Radio, ArrowRight, Clock } from 'lucide-vue-next'
import RankBadge from '@/components/common/RankBadge.vue'
import { ref, reactive, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import { getSocket } from '@/composables/useSocket'

interface NewsPost {
  id: number
  title: string
  content: string
  image_url: string | null
  created_by_name: string | null
  created_by_avatar: string | null
  created_at: string
}

interface Comment {
  id: number
  news_id: number
  player_id: number
  player_name: string
  player_avatar: string | null
  content: string
  created_at: string
}

const { t } = useI18n()
const api = useApi()
const store = useDraftStore()
const news = ref<NewsPost[]>([])

// Comments state: newsId -> comments array
const commentsMap = reactive<Record<number, Comment[]>>({})
const commentCounts = reactive<Record<number, number>>({})
const expandedComments = reactive<Record<number, boolean>>({})
const newComment = reactive<Record<number, string>>({})
const submittingComment = reactive<Record<number, boolean>>({})

async function fetchNews() {
  news.value = await api.getNews()
  // Fetch comment counts for all posts
  for (const post of news.value) {
    fetchComments(post.id)
  }
}

async function fetchComments(newsId: number) {
  try {
    const comments = await api.getComments(newsId)
    commentsMap[newsId] = comments
    commentCounts[newsId] = comments.length
  } catch {
    commentsMap[newsId] = []
    commentCounts[newsId] = 0
  }
}

function toggleComments(newsId: number) {
  expandedComments[newsId] = !expandedComments[newsId]
}

async function submitComment(newsId: number) {
  const text = (newComment[newsId] || '').trim()
  if (!text) return
  submittingComment[newsId] = true
  try {
    await api.addComment(newsId, text)
    newComment[newsId] = ''
    await fetchComments(newsId)
  } finally {
    submittingComment[newsId] = false
  }
}

async function deleteComment(newsId: number, commentId: number) {
  await api.deleteComment(newsId, commentId)
  await fetchComments(newsId)
}

function canDeleteComment(comment: Comment) {
  if (!store.currentUser.value) return false
  return comment.player_id === store.currentUser.value.id || store.currentUser.value.is_admin
}

onMounted(async () => {
  fetchNews()
  fetchStreamers()
  fetchSiteSettings()
  fetchUpcomingMatches()
  getSocket().on('news:updated', fetchNews)
  getSocket().on('news:commented', ({ newsId }: { newsId: number }) => {
    fetchComments(newsId)
  })
  await store.fetchCompetitions()
})

function formatDate(dateStr: string) {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatCommentDate(dateStr: string) {
  const d = new Date(dateStr)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return t('justNow')
  if (mins < 60) return t('mAgo', { n: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('hAgo', { n: hours })
  const days = Math.floor(hours / 24)
  if (days < 7) return t('dAgo', { n: days })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const statusLabel = computed<Record<string, string>>(() => ({
  draft: t('statusSetup'),
  registration: t('statusRegistrationOpen'),
  active: t('statusInProgress'),
  finished: t('statusCompleted'),
}))

const statusClass: Record<string, string> = {
  draft: 'bg-accent text-muted-foreground',
  registration: 'bg-primary/20 text-primary',
  active: 'bg-color-success/20 text-color-success',
  finished: 'bg-color-success/20 text-color-success',
}

function getCompStatus(comp: any) {
  const auctionStatus = comp.auction_state?.status || 'idle'
  // If auction is actively running, show as active regardless of comp.status
  if (['nominating', 'bidding', 'paused'].includes(auctionStatus)) return 'active'
  // Otherwise use the competition's own status
  return comp.status || 'draft'
}

interface Streamer {
  id: number
  name: string
  avatar_url: string | null
  twitch_username: string
  stream: {
    title: string
    viewer_count: number
    thumbnail_url: string
    started_at: string
  }
}

const streamers = ref<Streamer[]>([])
const siteTitle = ref('')
const siteSubtitle = ref('')
const discordUrl = ref('')
const heroBannerUrl = ref('')

async function fetchSiteSettings() {
  try {
    const data = await api.getSiteSettings()
    siteTitle.value = data.site_title || ''
    siteSubtitle.value = data.site_subtitle || ''
    discordUrl.value = data.site_discord_url || ''
    heroBannerUrl.value = data.site_hero_banner_url || ''
  } catch {}
}

async function fetchStreamers() {
  try {
    streamers.value = await api.getStreamers()
  } catch {
    streamers.value = []
  }
}

const activeCompetitions = computed(() =>
  store.competitions.value.filter(c => {
    const s = c.status || 'draft'
    return s !== 'finished'
  })
)

const upcomingMatches = ref<any[]>([])

async function fetchUpcomingMatches() {
  try {
    upcomingMatches.value = await api.getUpcomingMatches()
  } catch {
    upcomingMatches.value = []
  }
}

function formatMatchDate(dateStr: string) {
  if (!dateStr) return '—'
  const d = new Date(dateStr.replace('Z', ''))
  const now = new Date()
  const diffMs = d.getTime() - now.getTime()
  const diffH = Math.floor(diffMs / 3600000)
  const diffD = Math.floor(diffMs / 86400000)

  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  if (diffMs < 0) return `${date} ${time}`
  if (diffH < 1) return t('startingSoon')
  if (diffD === 0) return `${t('today')} ${time}`
  if (diffD === 1) return `${t('tomorrow')} ${time}`
  return `${date} ${time}`
}

const isLoggedIn = computed(() => !!store.currentUser.value)

// Carousel for upcoming matches
import { useCarousel } from '@/composables/useCarousel'
const carouselRef = ref<HTMLElement | null>(null)
const matchCount = computed(() => upcomingMatches.value.length)
const { isDragging: carouselDragging } = useCarousel(carouselRef, 0.2, matchCount)

const loopedMatches = computed(() => {
  const m = upcomingMatches.value
  if (m.length === 0) return []
  // Repeat enough times to fill the viewport and allow seamless looping
  const copies = Math.max(3, Math.ceil(10 / m.length))
  const result = []
  for (let i = 0; i < copies; i++) result.push(...m)
  return result
})
</script>

<template>
  <div>
    <!-- Hero Banner -->
    <div class="relative overflow-hidden">
      <!-- Background image -->
      <div v-if="heroBannerUrl" class="absolute inset-0">
        <img :src="heroBannerUrl" class="w-full h-full object-cover" />
        <div class="absolute inset-0 bg-gradient-to-b from-background/70 via-background/50 to-background" />
      </div>
      <!-- Content -->
      <div class="relative max-w-[1200px] mx-auto w-full px-6 md:px-10 py-36 md:py-52 flex flex-col items-center text-center gap-6">
        <div>
          <h1 class="text-3xl md:text-4xl font-bold text-foreground">{{ siteTitle || t('heroTitle') }}</h1>
          <p class="text-muted-foreground mt-2 text-sm md:text-base">{{ siteSubtitle || t('heroSubtitle') }}</p>
        </div>
        <!-- Stats row -->
        <div class="flex items-center gap-0">
          <div class="flex flex-col items-center gap-1 px-6 md:px-10 py-3">
            <span class="text-2xl md:text-[28px] font-bold font-mono text-foreground">{{ store.competitions.value.length }}</span>
            <span class="text-[11px] font-semibold font-mono uppercase tracking-[2px] text-text-tertiary">{{ t('competitions') }}</span>
          </div>
          <div class="w-px h-10 bg-border" />
          <div class="flex flex-col items-center gap-1 px-6 md:px-10 py-3">
            <span class="text-2xl md:text-[28px] font-bold font-mono text-foreground">{{ upcomingMatches.length }}</span>
            <span class="text-[11px] font-semibold font-mono uppercase tracking-[2px] text-text-tertiary">{{ t('matches') || 'MATCHES' }}</span>
          </div>
          <div class="w-px h-10 bg-border" />
          <div class="flex flex-col items-center gap-1 px-6 md:px-10 py-3">
            <span class="text-2xl md:text-[28px] font-bold font-mono text-primary">{{ streamers.length }}</span>
            <span class="text-[11px] font-semibold font-mono uppercase tracking-[2px] text-text-tertiary">{{ t('liveStreams') || 'LIVE' }}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="max-w-[1200px] mx-auto w-full px-6 md:px-10 py-8 flex flex-col gap-8">

    <!-- Upcoming Matches (full width, horizontal scroll) -->
    <div v-if="upcomingMatches.length > 0" class="flex flex-col gap-4">
      <div class="flex items-center gap-2.5">
        <Calendar class="w-5 h-5 text-primary" />
        <span class="text-lg font-semibold text-foreground">{{ t('upcomingMatches') }}</span>
        <span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold bg-primary/20 text-primary">{{ upcomingMatches.length }}</span>
      </div>
      <div class="overflow-clip">
      <div ref="carouselRef" class="flex gap-4 select-none w-max" @dragstart.prevent>
        <div
          v-for="(match, idx) in loopedMatches"
          :key="match.id + '-' + idx"
          class="relative group shrink-0 w-[280px]"
        >
          <router-link
            :to="`/c/${match.competition_id}/tournament?match=${match.id}`"
            draggable="false"
            class="flex flex-col justify-between rounded-xl bg-card p-4 w-[280px] h-[160px] hover:bg-card/80 transition-colors"
          >
            <div class="flex items-center justify-between">
              <span class="text-[11px] text-text-tertiary truncate">{{ match.stage_name || match.competition_name || '' }}</span>
              <span :class="match.status === 'live' ? 'badge-success' : 'badge-accent'" class="shrink-0">{{ match.status === 'live' ? 'LIVE' : 'UPCOMING' }}</span>
            </div>
            <div class="flex items-center justify-between">
              <div class="flex flex-col items-center gap-1.5 w-20">
                <div class="w-9 h-9 rounded-full bg-surface overflow-hidden shrink-0">
                  <img v-if="match.team1_banner || match.team1_avatar" :src="match.team1_banner || match.team1_avatar" class="w-full h-full object-cover" />
                </div>
                <span class="text-xs font-semibold text-foreground text-center truncate w-full">{{ match.team1_name || t('tbd') }}</span>
              </div>
              <div class="flex flex-col items-center gap-0.5">
                <span class="text-xl font-bold font-mono text-foreground">{{ match.score1 != null ? match.score1 : 0 }} : {{ match.score2 != null ? match.score2 : 0 }}</span>
                <span class="text-[10px] text-text-tertiary">BO{{ match.best_of || 3 }}</span>
              </div>
              <div class="flex flex-col items-center gap-1.5 w-20">
                <div class="w-9 h-9 rounded-full bg-surface overflow-hidden shrink-0">
                  <img v-if="match.team2_banner || match.team2_avatar" :src="match.team2_banner || match.team2_avatar" class="w-full h-full object-cover" />
                </div>
                <span class="text-xs font-semibold text-foreground text-center truncate w-full">{{ match.team2_name || t('tbd') }}</span>
              </div>
            </div>
            <span class="text-[11px] text-text-muted text-center">{{ formatMatchDate(match.scheduled_at) }}</span>
          </router-link>
          <!-- Roster overlay on hover -->
          <div v-if="match.team1_players?.length || match.team2_players?.length" class="absolute inset-0 rounded-xl bg-card/95 backdrop-blur-sm hidden group-hover:flex items-center p-3 gap-3 z-10 pointer-events-none">
            <div class="flex-1 flex flex-col gap-0.5 min-w-0">
              <span class="text-[9px] font-semibold text-primary uppercase tracking-wider mb-0.5 truncate">{{ match.team1_name || t('tbd') }}</span>
              <div v-for="p in match.team1_players" :key="p.name" class="flex items-center gap-1">
                <span v-if="p.playing_role" class="text-[8px] font-bold text-muted-foreground w-3.5 shrink-0">P{{ p.playing_role }}</span>
                <span v-else class="w-3.5 shrink-0"></span>
                <RankBadge v-if="p.mmr" :mmr="p.mmr" size="sm" class="shrink-0 !w-3.5 !h-3.5" />
                <span class="text-[10px] text-foreground truncate">{{ p.name }}</span>
              </div>
            </div>
            <div class="w-px self-stretch bg-border/50"></div>
            <div class="flex-1 flex flex-col gap-0.5 min-w-0">
              <span class="text-[9px] font-semibold text-primary uppercase tracking-wider mb-0.5 truncate">{{ match.team2_name || t('tbd') }}</span>
              <div v-for="p in match.team2_players" :key="p.name" class="flex items-center gap-1">
                <span v-if="p.playing_role" class="text-[8px] font-bold text-muted-foreground w-3.5 shrink-0">P{{ p.playing_role }}</span>
                <span v-else class="w-3.5 shrink-0"></span>
                <RankBadge v-if="p.mmr" :mmr="p.mmr" size="sm" class="shrink-0 !w-3.5 !h-3.5" />
                <span class="text-[10px] text-foreground truncate">{{ p.name }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      </div>
    </div>

    <div class="flex flex-col lg:flex-row gap-6">
      <!-- Main Content -->
      <div class="flex-1 min-w-0 flex flex-col gap-6">
        <!-- Competitions -->
        <div class="rounded-lg bg-card overflow-hidden">
          <!-- Header -->
          <div class="flex items-center justify-between px-5 py-4">
            <div class="flex items-center gap-2">
              <Trophy class="w-[18px] h-[18px] text-primary" />
              <span class="text-base font-semibold text-foreground">{{ t('competitions') }}</span>
            </div>
            <router-link to="/competitions" class="text-sm font-medium text-primary hover:text-primary/80 transition-colors">
              {{ t('viewAll') }} →
            </router-link>
          </div>
          <!-- Entries -->
          <div v-if="activeCompetitions.length === 0" class="px-5 pb-5 text-sm text-muted-foreground">
            {{ t('noActiveCompetitions') }}
          </div>
          <div v-else class="px-5 pb-5 flex flex-col gap-3">
            <router-link
              v-for="comp in activeCompetitions"
              :key="comp.id"
              :to="`/c/${comp.id}/info`"
              class="flex flex-col gap-2 hover:opacity-80 transition-opacity"
            >
              <div class="flex items-center gap-2.5">
                <span class="text-[15px] font-semibold text-foreground">{{ comp.name }}</span>
                <span class="inline-flex items-center rounded px-2 py-0.5 text-[10px] font-semibold font-mono"
                  :class="statusClass[getCompStatus(comp)] || statusClass.draft">
                  {{ statusLabel[getCompStatus(comp)] || t('statusSetup') }}
                </span>
              </div>
              <span v-if="comp.created_by_name" class="text-xs text-text-tertiary">{{ comp.created_by_name }}</span>
              <span class="text-[11px] text-text-muted">
                {{ comp.registration_start ? formatDate(comp.registration_start) : '' }}{{ comp.registration_end ? ' - ' + formatDate(comp.registration_end) : '' }}
              </span>
            </router-link>
          </div>
        </div>

        <!-- News & Announcements -->
        <div class="rounded-lg bg-card overflow-hidden">
          <!-- Header -->
          <div class="flex items-center gap-2 px-5 py-4">
            <Newspaper class="w-[18px] h-[18px] text-primary" />
            <span class="text-base font-semibold text-foreground">{{ t('newsTitle') }}</span>
          </div>
          <!-- Entries -->
          <div v-if="news.length === 0" class="px-5 pb-5 text-sm text-muted-foreground">
            {{ t('noNewsYet') }}
          </div>
          <div v-else class="px-5 pb-5 flex flex-col gap-0">
            <router-link
              v-for="(post, idx) in news"
              :key="post.id"
              :to="{ name: 'news-post', params: { id: post.id } }"
              class="flex items-center gap-3 py-3 hover:opacity-80 transition-opacity"
              :class="idx < news.length - 1 ? 'border-b border-foreground/10' : ''"
            >
              <!-- Thumbnail -->
              <div class="w-20 h-[60px] rounded-md bg-surface overflow-hidden shrink-0">
                <img v-if="post.image_url" :src="post.image_url" class="w-full h-full object-cover" />
              </div>
              <!-- Info -->
              <div class="flex-1 flex flex-col gap-1 min-w-0">
                <span class="text-sm font-semibold text-foreground truncate">{{ post.title }}</span>
                <div class="flex items-center gap-2">
                  <span class="text-xs text-text-muted">{{ formatDate(post.created_at) }}</span>
                  <span class="text-xs text-text-muted">{{ commentCounts[post.id] || 0 }} {{ (commentCounts[post.id] || 0) === 1 ? t('comment') : t('comments') }}</span>
                </div>
              </div>
            </router-link>
          </div>
        </div>
      </div>

      <!-- Sidebar -->
      <div class="lg:w-[320px] shrink-0">
        <div class="flex flex-col gap-4 lg:sticky lg:top-4">
          <!-- Discord -->
          <div v-if="discordUrl" class="rounded-lg bg-card p-5 flex flex-col gap-3">
            <div class="flex items-center gap-2.5">
              <svg class="w-5 h-5 text-[#5865F2] shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
              <span class="text-base font-semibold text-foreground">{{ t('joinDiscord') }}</span>
            </div>
            <p class="text-sm text-muted-foreground leading-relaxed">{{ t('discordDesc') }}</p>
            <a
              :href="discordUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="flex items-center justify-center gap-2 w-full rounded-md bg-[#5865F2] hover:bg-[#4752C4] px-4 py-2.5 text-sm font-semibold text-white transition-colors"
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              Join Discord Server
            </a>
          </div>

          <!-- Live Streams -->
          <div v-if="streamers.length > 0" class="rounded-lg bg-card overflow-hidden">
            <!-- Header -->
            <div class="flex items-center justify-between px-5 py-4 border-b border-surface">
              <div class="flex items-center gap-2.5">
                <svg class="w-[18px] h-[18px] text-destructive" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                <span class="text-sm font-semibold text-foreground">Live Dota 2 Streams</span>
              </div>
              <span class="inline-flex items-center rounded px-2 py-0.5 text-[9px] font-bold font-mono bg-destructive/20 text-destructive">{{ streamers.length }} LIVE</span>
            </div>
            <!-- Stream rows -->
            <a
              v-for="(streamer, idx) in streamers"
              :key="streamer.id"
              :href="`https://twitch.tv/${streamer.twitch_username}`"
              target="_blank"
              rel="noopener noreferrer"
              class="flex items-center gap-3 px-5 py-3 hover:bg-surface/50 transition-colors"
              :class="idx < streamers.length - 1 ? 'border-b border-surface' : ''"
            >
              <!-- Thumbnail -->
              <div class="w-[100px] h-14 rounded-md overflow-hidden bg-surface shrink-0">
                <img v-if="streamer.stream.thumbnail_url" :src="streamer.stream.thumbnail_url" class="w-full h-full object-cover" />
              </div>
              <!-- Info -->
              <div class="flex-1 flex flex-col gap-1 min-w-0">
                <span class="text-sm font-medium text-foreground truncate">{{ streamer.twitch_username }}</span>
                <span class="text-[11px] text-muted-foreground truncate">{{ streamer.stream.title }}</span>
                <div class="flex items-center gap-1.5">
                  <span class="w-1.5 h-1.5 rounded-full bg-destructive shrink-0"></span>
                  <span class="text-[10px] font-mono text-text-tertiary">{{ streamer.stream.viewer_count.toLocaleString() }} viewers</span>
                </div>
              </div>
            </a>
          </div>
        </div>
      </div>
    </div>
    </div>
  </div>
</template>
