<script setup lang="ts">
import { Newspaper, Calendar, Trophy, Users, Swords, User, MessageSquare, Send, Trash2, ChevronDown, ChevronUp, Twitch, Eye, Radio } from 'lucide-vue-next'
import { ref, reactive, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import { getSocket } from '@/composables/useSocket'

interface NewsPost {
  id: number
  title: string
  content: string
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
  archived: t('statusArchived'),
}))

const statusClass: Record<string, string> = {
  draft: 'bg-accent text-muted-foreground',
  registration: 'bg-primary/10 text-primary',
  active: 'bg-color-success text-color-success-foreground',
  finished: 'bg-yellow-500/20 text-yellow-600 dark:text-yellow-400',
  archived: 'bg-accent text-muted-foreground',
}

function getAuctionStatus(comp: any) {
  const auctionStatus = comp.auction_state?.status || 'idle'
  if (auctionStatus === 'finished') return 'finished'
  if (['nominating', 'bidding', 'paused'].includes(auctionStatus)) return 'active'
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

async function fetchStreamers() {
  try {
    streamers.value = await api.getStreamers()
  } catch {
    streamers.value = []
  }
}

const isLoggedIn = computed(() => !!store.currentUser.value)
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 max-w-[1440px] mx-auto w-full">
    <!-- Hero -->
    <div class="text-center py-6 md:py-10">
      <h1 class="text-3xl md:text-4xl font-bold text-foreground">{{ t('heroTitle') }}</h1>
      <p class="text-muted-foreground mt-2 text-sm md:text-base">{{ t('heroSubtitle') }}</p>
    </div>

    <div class="flex flex-col lg:flex-row gap-6">
      <!-- Main Content -->
      <div class="flex-1 min-w-0 flex flex-col gap-6">
        <!-- Competitions -->
        <div class="card">
          <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
            <Swords class="w-5 h-5 text-foreground" />
            <span class="text-sm font-semibold text-foreground">{{ t('competitions') }}</span>
            <span class="text-xs text-muted-foreground">({{ store.competitions.value.length }})</span>
          </div>
          <div v-if="store.competitions.value.length === 0" class="px-4 py-10 text-center text-sm text-muted-foreground">
            {{ t('noCompetitionsYet') }}
          </div>
          <div v-else class="divide-y divide-border">
            <router-link
              v-for="comp in store.competitions.value"
              :key="comp.id"
              :to="`/c/${comp.id}/info`"
              class="flex items-center justify-between px-4 py-4 md:px-6 md:py-5 hover:bg-accent/30 transition-colors"
            >
              <div class="flex items-center gap-4">
                <div class="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Trophy class="w-5 h-5 text-primary" />
                </div>
                <div>
                  <h3 class="text-base font-semibold text-foreground">{{ comp.name }}</h3>
                  <div v-if="comp.description" class="text-xs text-muted-foreground mt-0.5 prose prose-sm dark:prose-invert max-w-none [&>*]:m-0 line-clamp-2" v-html="comp.description"></div>
                  <div class="flex items-center gap-3 mt-1 flex-wrap">
                    <span v-if="comp.registration_start || comp.registration_end" class="flex items-center gap-1 text-xs text-muted-foreground">
                      <Users class="w-3 h-3" />
                      Reg: {{ comp.registration_start ? formatDate(comp.registration_start) : '—' }} – {{ comp.registration_end ? formatDate(comp.registration_end) : '—' }}
                    </span>
                    <span v-if="comp.starts_at" class="flex items-center gap-1 text-xs text-muted-foreground">
                      <Calendar class="w-3 h-3" />
                      Draft: {{ formatDate(comp.starts_at) }}
                    </span>
                    <span v-if="comp.created_by_name" class="flex items-center gap-1 text-xs text-muted-foreground">
                      <User class="w-3 h-3" />
                      {{ comp.created_by_name }}
                    </span>
                  </div>
                </div>
              </div>
              <span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium"
                :class="statusClass[getAuctionStatus(comp)] || statusClass.draft">
                {{ statusLabel[getAuctionStatus(comp)] || t('statusSetup') }}
              </span>
            </router-link>
          </div>
        </div>

        <!-- News -->
        <div class="card">
          <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
            <Newspaper class="w-5 h-5 text-foreground" />
            <span class="text-sm font-semibold text-foreground">{{ t('newsTitle') }}</span>
          </div>
          <div v-if="news.length === 0" class="px-4 py-10 text-center text-sm text-muted-foreground">
            {{ t('noNewsYet') }}
          </div>
          <div v-else class="divide-y divide-border">
            <div v-for="post in news" :key="post.id" class="px-4 py-4 md:px-6 md:py-5">
              <!-- Post header -->
              <div class="flex items-start justify-between gap-3">
                <h3 class="text-base font-semibold text-foreground">{{ post.title }}</h3>
                <div class="flex items-center gap-3 shrink-0 mt-0.5">
                  <span v-if="post.created_by_name" class="flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
                    <User class="w-3 h-3" />
                    {{ post.created_by_name }}
                  </span>
                  <span class="flex items-center gap-1.5 text-xs text-muted-foreground whitespace-nowrap">
                    <Calendar class="w-3.5 h-3.5" />
                    {{ formatDate(post.created_at) }}
                  </span>
                </div>
              </div>
              <!-- Post content -->
              <div class="prose prose-sm dark:prose-invert max-w-none mt-2 text-muted-foreground" v-html="post.content"></div>

              <!-- Comments toggle -->
              <button
                class="flex items-center gap-1.5 mt-3 text-xs text-muted-foreground hover:text-foreground transition-colors"
                @click="toggleComments(post.id)"
              >
                <MessageSquare class="w-3.5 h-3.5" />
                {{ commentCounts[post.id] || 0 }} {{ (commentCounts[post.id] || 0) === 1 ? t('comment') : t('comments') }}
                <ChevronUp v-if="expandedComments[post.id]" class="w-3 h-3" />
                <ChevronDown v-else class="w-3 h-3" />
              </button>

              <!-- Comments section -->
              <div v-if="expandedComments[post.id]" class="mt-3 border-t border-border pt-3">
                <!-- Comment list -->
                <div v-if="commentsMap[post.id]?.length" class="flex flex-col gap-3 mb-3">
                  <div v-for="comment in commentsMap[post.id]" :key="comment.id" class="flex gap-2.5">
                    <img v-if="comment.player_avatar" :src="comment.player_avatar" class="w-7 h-7 rounded-full shrink-0 mt-0.5" />
                    <div v-else class="w-7 h-7 rounded-full bg-secondary flex items-center justify-center text-[10px] font-semibold text-secondary-foreground shrink-0 mt-0.5">
                      {{ comment.player_name.charAt(0) }}
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="text-xs font-semibold text-foreground">{{ comment.player_name }}</span>
                        <span class="text-[10px] text-muted-foreground">{{ formatCommentDate(comment.created_at) }}</span>
                        <button
                          v-if="canDeleteComment(comment)"
                          class="ml-auto p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-destructive transition-colors"
                          title="Delete comment"
                          @click="deleteComment(post.id, comment.id)"
                        >
                          <Trash2 class="w-3 h-3" />
                        </button>
                      </div>
                      <p class="text-sm text-foreground/80 mt-0.5 whitespace-pre-wrap break-words">{{ comment.content }}</p>
                    </div>
                  </div>
                </div>
                <div v-else class="text-xs text-muted-foreground mb-3">{{ t('noCommentsYet') }}</div>

                <!-- Add comment -->
                <div v-if="isLoggedIn" class="flex gap-2 items-start">
                  <img v-if="store.currentUser.value?.avatar_url" :src="store.currentUser.value.avatar_url" class="w-7 h-7 rounded-full shrink-0 mt-0.5" />
                  <div v-else class="w-7 h-7 rounded-full bg-secondary flex items-center justify-center text-[10px] font-semibold text-secondary-foreground shrink-0 mt-0.5">
                    {{ store.currentUser.value?.name?.charAt(0) || '?' }}
                  </div>
                  <div class="flex-1 flex gap-2">
                    <input
                      type="text"
                      class="input-field flex-1 text-sm py-1.5"
                      :placeholder="t('writeComment')"
                      :value="newComment[post.id] || ''"
                      @input="newComment[post.id] = ($event.target as HTMLInputElement).value"
                      @keydown.enter="submitComment(post.id)"
                      :disabled="submittingComment[post.id]"
                    />
                    <button
                      class="btn-primary py-1.5 px-3"
                      :disabled="!(newComment[post.id] || '').trim() || submittingComment[post.id]"
                      @click="submitComment(post.id)"
                    >
                      <Send class="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <p v-else class="text-xs text-muted-foreground italic">{{ t('loginToComment') }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Sidebar: Live Streams -->
      <div v-if="streamers.length > 0" class="lg:w-[320px] shrink-0">
        <div class="card lg:sticky lg:top-4">
          <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
            <Radio class="w-4 h-4 text-red-500 animate-pulse" />
            <span class="text-sm font-semibold text-foreground">{{ t('liveStreams') }}</span>
            <span class="text-xs text-muted-foreground">({{ streamers.length }})</span>
          </div>
          <div class="flex flex-col divide-y divide-border">
            <a
              v-for="streamer in streamers"
              :key="streamer.id"
              :href="`https://twitch.tv/${streamer.twitch_username}`"
              target="_blank"
              rel="noopener noreferrer"
              class="flex flex-col hover:bg-accent/30 transition-colors"
            >
              <!-- Thumbnail -->
              <div class="relative aspect-video bg-accent">
                <img v-if="streamer.stream.thumbnail_url" :src="streamer.stream.thumbnail_url" class="w-full h-full object-cover" />
                <div class="absolute top-1.5 left-1.5 flex items-center gap-1 bg-red-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
                  <span class="w-1.5 h-1.5 bg-white rounded-full"></span>
                  LIVE
                </div>
                <div class="absolute bottom-1.5 left-1.5 flex items-center gap-1 bg-black/70 text-white text-[10px] px-1.5 py-0.5 rounded">
                  <Eye class="w-3 h-3" />
                  {{ streamer.stream.viewer_count.toLocaleString() }}
                </div>
              </div>
              <!-- Info -->
              <div class="flex items-start gap-2 px-3 py-2.5">
                <img v-if="streamer.avatar_url" :src="streamer.avatar_url" class="w-7 h-7 rounded-full shrink-0" />
                <div v-else class="w-7 h-7 rounded-full bg-secondary flex items-center justify-center text-[10px] font-semibold text-secondary-foreground shrink-0">
                  {{ streamer.name.charAt(0) }}
                </div>
                <div class="flex-1 min-w-0">
                  <p class="text-xs font-medium text-foreground truncate">{{ streamer.stream.title }}</p>
                  <div class="flex items-center gap-1 mt-0.5">
                    <Twitch class="w-3 h-3 text-[#9146FF]" />
                    <span class="text-[11px] text-[#9146FF]">{{ streamer.twitch_username }}</span>
                    <span class="text-[11px] text-muted-foreground ml-auto">{{ streamer.name }}</span>
                  </div>
                </div>
              </div>
            </a>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
