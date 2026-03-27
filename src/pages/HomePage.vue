<script setup lang="ts">
import { Newspaper, Trophy, Users, Swords, User, MessageSquare, Send, Trash2, ChevronDown, ChevronUp, Twitch, Eye, Radio, ArrowRight, Clock } from 'lucide-vue-next'
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
  return formatDateUtil(dateStr)
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
  registration_closed: t('statusRegistrationClosed'),
  active: t('statusInProgress'),
  finished: t('statusCompleted'),
}))

const statusClass: Record<string, string> = {
  draft: 'bg-accent text-muted-foreground',
  registration: 'bg-primary/20 text-primary',
  registration_closed: 'bg-amber-500/20 text-amber-600 dark:text-amber-400',
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

async function fetchSiteSettings() {
  try {
    const data = await api.getSiteSettings()
    siteTitle.value = data.site_title || ''
    siteSubtitle.value = data.site_subtitle || ''
    discordUrl.value = data.site_discord_url || ''
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

import { formatMatchDate, formatDate as formatDateUtil } from '@/utils/format'

const isLoggedIn = computed(() => !!store.currentUser.value)

// Flat list: live first, then by scheduled_at
const sortedMatches = computed(() => {
  return [...upcomingMatches.value].sort((a: any, b: any) => {
    if (a.status === 'live' && b.status !== 'live') return -1
    if (a.status !== 'live' && b.status === 'live') return 1
    const tA = a.scheduled_at ? new Date(a.scheduled_at).getTime() : Infinity
    const tB = b.scheduled_at ? new Date(b.scheduled_at).getTime() : Infinity
    return tA - tB
  })
})
</script>

<template>
  <div>
    <!-- Hero Content -->
    <div class="relative">
      <div class="max-w-[1200px] mx-auto w-full px-6 md:px-10 pt-16 pb-16 md:pt-24 md:pb-24 flex flex-col items-center text-center gap-6">
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

    <div class="relative z-10 max-w-[1200px] mx-auto w-full px-6 md:px-10 pt-6 pb-8 flex flex-col gap-6">
    <div class="flex flex-col lg:flex-row gap-6">
      <!-- Main Content -->
      <div class="flex-1 min-w-0 flex flex-col gap-6">
        <!-- News & Announcements -->
        <div class="rounded-lg bg-card overflow-hidden">
          <!-- Header -->
          <div class="flex items-center justify-between px-5 py-4">
            <div class="flex items-center gap-2">
              <Newspaper class="w-[18px] h-[18px] text-primary" />
              <span class="text-base font-semibold text-foreground">{{ t('newsTitle') }}</span>
            </div>
            <router-link v-if="news.length > 5" to="/news" class="text-xs font-medium text-primary hover:text-primary/80 transition-colors">
              {{ t('viewAll') }} →
            </router-link>
          </div>
          <!-- Entries -->
          <div v-if="news.length === 0" class="px-5 pb-5 text-sm text-muted-foreground">
            {{ t('noNewsYet') }}
          </div>
          <div v-else class="flex flex-col">
            <!-- Featured first post -->
            <router-link
              :to="{ name: 'news-post', params: { id: news[0].id } }"
              class="block hover:opacity-90 transition-opacity"
            >
              <div v-if="news[0].image_url" class="w-full bg-surface overflow-hidden" style="aspect-ratio: 1120 / 400;">
                <img :src="news[0].image_url" class="w-full h-full object-cover" />
              </div>
              <div class="px-5 py-4 border-b border-foreground/10">
                <h3 class="text-lg font-bold text-foreground leading-tight mb-1.5">{{ news[0].title }}</h3>
                <p class="text-sm text-muted-foreground line-clamp-2 mb-2">{{ news[0].content.replace(/<[^>]*>/g, '').slice(0, 150) }}</p>
                <div class="flex items-center gap-3">
                  <div v-if="news[0].created_by_avatar" class="flex items-center gap-1.5">
                    <img :src="news[0].created_by_avatar" class="w-4 h-4 rounded-full" />
                    <span class="text-xs text-text-muted">{{ news[0].created_by_name }}</span>
                  </div>
                  <span class="text-xs text-text-muted">{{ formatDate(news[0].created_at) }}</span>
                  <span class="text-xs text-text-muted">{{ commentCounts[news[0].id] || 0 }} {{ (commentCounts[news[0].id] || 0) === 1 ? t('comment') : t('comments') }}</span>
                </div>
              </div>
            </router-link>
            <!-- Rest of posts -->
            <div class="px-5 pb-5 flex flex-col gap-0">
              <router-link
                v-for="(post, idx) in news.slice(1, 5)"
                :key="post.id"
                :to="{ name: 'news-post', params: { id: post.id } }"
                class="flex items-center gap-3 py-3 hover:opacity-80 transition-opacity"
                :class="idx < news.length - 2 ? 'border-b border-foreground/10' : ''"
              >
                <div class="w-20 h-[60px] rounded-md bg-surface overflow-hidden shrink-0">
                  <img v-if="post.image_url" :src="post.image_url" class="w-full h-full object-cover" />
                </div>
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
      </div>

      <!-- Sidebar -->
      <div class="lg:w-[320px] shrink-0">
        <div class="flex flex-col gap-4 lg:sticky lg:top-4">
          <!-- Competitions -->
          <div class="rounded-lg bg-card overflow-hidden">
            <div class="flex items-center justify-between px-5 py-4 border-b border-surface">
              <div class="flex items-center gap-2">
                <Trophy class="w-[18px] h-[18px] text-primary" />
                <span class="text-sm font-semibold text-foreground">{{ t('competitions') }}</span>
              </div>
              <router-link to="/competitions" class="text-xs font-medium text-primary hover:text-primary/80 transition-colors">
                {{ t('viewAll') }} →
              </router-link>
            </div>
            <div v-if="activeCompetitions.length === 0" class="px-5 py-4 text-sm text-muted-foreground">
              {{ t('noActiveCompetitions') }}
            </div>
            <div v-else class="divide-y divide-surface">
              <router-link
                v-for="comp in activeCompetitions"
                :key="comp.id"
                :to="`/c/${comp.id}/info`"
                class="flex flex-col gap-1 px-5 py-3 hover:bg-surface/50 transition-colors"
              >
                <div class="flex items-center gap-2">
                  <span class="text-sm font-semibold text-foreground truncate">{{ comp.name }}</span>
                  <span class="inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold font-mono shrink-0"
                    :class="statusClass[getCompStatus(comp)] || statusClass.draft">
                    {{ statusLabel[getCompStatus(comp)] || t('statusSetup') }}
                  </span>
                </div>
                <span class="text-[10px] text-text-muted">
                  {{ comp.registration_start ? formatDate(comp.registration_start) : '' }}{{ comp.registration_end ? ' - ' + formatDate(comp.registration_end) : '' }}
                </span>
              </router-link>
            </div>
          </div>
          <!-- Matches (separate block, grouped by competition) -->
          <div v-if="upcomingMatches.length > 0" class="rounded-lg bg-card overflow-hidden">
            <div class="flex items-center justify-between px-5 py-4 border-b border-surface">
              <div class="flex items-center gap-2">
                <Swords class="w-[18px] h-[18px] text-primary" />
                <span class="text-sm font-semibold text-foreground">{{ t('upcomingMatches') }}</span>
              </div>
              <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold bg-primary/15 text-primary">{{ upcomingMatches.length }}</span>
            </div>
            <div class="divide-y divide-surface">
                <router-link
                  v-for="match in sortedMatches"
                  :key="match.id"
                  :to="`/c/${match.competition_id}/match/${match.id}`"
                  class="flex items-center gap-2 px-4 py-2 hover:bg-surface/50 transition-colors"
                >
                  <!-- Live indicator -->
                  <div class="w-3 shrink-0 flex justify-center">
                    <span v-if="match.status === 'live'" class="w-1.5 h-1.5 rounded-full bg-destructive animate-pulse"></span>
                  </div>
                  <!-- Teams stacked -->
                  <div class="flex flex-col gap-1 flex-1 min-w-0">
                    <div class="flex items-center gap-1.5">
                      <div class="w-4 h-4 rounded-full bg-surface overflow-hidden shrink-0">
                        <img v-if="match.team1_banner || match.team1_avatar" :src="match.team1_banner || match.team1_avatar" class="w-full h-full object-cover" />
                      </div>
                      <span class="text-[11px] text-foreground truncate" :class="match.score1 > match.score2 ? 'font-bold' : 'font-medium'">{{ match.team1_name || t('tbd') }}</span>
                    </div>
                    <div class="flex items-center gap-1.5">
                      <div class="w-4 h-4 rounded-full bg-surface overflow-hidden shrink-0">
                        <img v-if="match.team2_banner || match.team2_avatar" :src="match.team2_banner || match.team2_avatar" class="w-full h-full object-cover" />
                      </div>
                      <span class="text-[11px] text-foreground truncate" :class="match.score2 > match.score1 ? 'font-bold' : 'font-medium'">{{ match.team2_name || t('tbd') }}</span>
                    </div>
                  </div>
                  <!-- Score + Time (right side) -->
                  <div class="shrink-0 flex flex-col items-end gap-1">
                    <template v-if="match.status === 'live' || (match.score1 > 0 || match.score2 > 0)">
                      <span class="text-[11px] font-bold font-mono" :class="{ 'text-foreground': match.score1 >= match.score2, 'text-muted-foreground': match.score1 < match.score2 }">{{ match.score1 ?? 0 }}</span>
                      <span class="text-[11px] font-bold font-mono" :class="{ 'text-foreground': match.score2 >= match.score1, 'text-muted-foreground': match.score2 < match.score1 }">{{ match.score2 ?? 0 }}</span>
                    </template>
                    <template v-else>
                      <span v-if="match.scheduled_at" class="text-[10px] text-muted-foreground font-mono whitespace-nowrap">{{ formatMatchDate(match.scheduled_at, t) }}</span>
                      <span v-else class="text-[10px] text-muted-foreground font-mono">{{ t('tbd') }}</span>
                      <span class="text-[10px] text-muted-foreground font-mono">BO{{ match.best_of || 3 }}</span>
                    </template>
                  </div>
                </router-link>
            </div>
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
