<script setup lang="ts">
import { Calendar, User, MessageSquare, Send, Trash2, ArrowLeft, ThumbsUp, ThumbsDown } from 'lucide-vue-next'
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import { getSocket, getServerNow } from '@/composables/useSocket'
import { fmtDateTime, fmtDateOnly } from '@/utils/format'

interface Comment {
  id: number
  news_id: number
  player_id: number
  player_name: string
  player_avatar: string | null
  content: string
  created_at: string
  likes: number
  dislikes: number
  my_vote: number
}

const { t } = useI18n()
const route = useRoute()
const api = useApi()
const store = useDraftStore()

const post = ref<any>(null)
const loading = ref(true)
const comments = ref<Comment[]>([])
const newComment = ref('')
const submitting = ref(false)

const postId = computed(() => Number(route.params.id))
const isLoggedIn = computed(() => !!store.currentUser.value)

async function fetchPost() {
  loading.value = true
  try {
    post.value = await api.getNewsPost(postId.value)
  } catch {
    post.value = null
  } finally {
    loading.value = false
  }
}

async function fetchComments() {
  try {
    comments.value = await api.getComments(postId.value)
  } catch {
    comments.value = []
  }
}

async function submitComment() {
  const text = newComment.value.trim()
  if (!text) return
  submitting.value = true
  try {
    await api.addComment(postId.value, text)
    newComment.value = ''
    await fetchComments()
  } finally {
    submitting.value = false
  }
}

async function deleteComment(commentId: number) {
  await api.deleteComment(postId.value, commentId)
  await fetchComments()
}

async function voteComment(comment: Comment, vote: 1 | -1) {
  if (!isLoggedIn.value) return
  // Toggle: if already voted same way, remove vote
  const newVote = comment.my_vote === vote ? 0 : vote
  try {
    const result = await api.voteComment(postId.value, comment.id, newVote)
    comment.likes = result.likes
    comment.dislikes = result.dislikes
    comment.my_vote = result.my_vote
  } catch {}
}

function canDeleteComment(comment: Comment) {
  if (!store.currentUser.value) return false
  return comment.player_id === store.currentUser.value.id || store.currentUser.value.is_admin
}

function formatDate(dateStr: string) {
  return fmtDateTime(new Date(dateStr))
}

function formatCommentDate(dateStr: string) {
  const d = new Date(dateStr)
  const now = new Date(getServerNow())
  const diff = now.getTime() - d.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return t('justNow')
  if (mins < 60) return t('mAgo', { n: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('hAgo', { n: hours })
  const days = Math.floor(hours / 24)
  if (days < 7) return t('dAgo', { n: days })
  return fmtDateOnly(d)
}

onMounted(() => {
  fetchPost()
  fetchComments()
  getSocket().on('news:commented', ({ newsId }: { newsId: number }) => {
    if (newsId === postId.value) fetchComments()
  })
})

watch(postId, () => {
  fetchPost()
  fetchComments()
})
</script>

<template>
  <div class="max-w-[1200px] mx-auto w-full px-6 md:px-10 py-8">
    <!-- Back link -->
    <router-link to="/" class="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6">
      <ArrowLeft class="w-4 h-4" />
      {{ t('backToHome') || 'Back' }}
    </router-link>

    <div v-if="loading" class="text-center py-12 text-muted-foreground">{{ t('loading') }}</div>

    <div v-else-if="!post" class="text-center py-12 text-muted-foreground">{{ t('notFound') || 'Post not found' }}</div>

    <template v-else>
      <!-- Article -->
      <article class="flex flex-col gap-4">
        <h1 class="text-2xl md:text-3xl font-bold text-foreground tracking-tight">{{ post.title }}</h1>
        <div class="flex items-center gap-4">
          <router-link v-if="post.created_by" :to="{ name: 'player-profile', params: { id: post.created_by } }" class="flex items-center gap-2 hover:opacity-80 transition-opacity">
            <img v-if="post.created_by_avatar" :src="post.created_by_avatar" class="w-8 h-8 rounded-full" />
            <div v-else class="w-8 h-8 rounded-full bg-surface flex items-center justify-center text-xs font-semibold text-muted-foreground">
              {{ (post.created_by_name || '?').charAt(0) }}
            </div>
            <span class="text-sm font-medium text-foreground hover:text-primary transition-colors">{{ post.created_by_name }}</span>
          </router-link>
          <span class="text-sm text-text-tertiary">{{ formatDate(post.created_at) }}</span>
        </div>
        <div v-if="post.image_url" class="rounded-lg overflow-hidden">
          <img :src="post.image_url" class="w-full object-cover" style="aspect-ratio: 1120 / 400;" />
        </div>
        <div class="h-px bg-border" />
        <div class="prose prose-sm dark:prose-invert max-w-none text-muted-foreground leading-relaxed" v-html="post.content"></div>
      </article>

      <!-- Comments Section -->
      <div class="mt-10">
        <div class="flex items-center gap-2 mb-6">
          <MessageSquare class="w-[18px] h-[18px] text-primary" />
          <span class="text-lg font-semibold text-foreground">{{ t('comments') }} ({{ comments.length }})</span>
        </div>

        <!-- Add comment -->
        <div v-if="isLoggedIn" class="flex gap-3 items-start mb-6">
          <img v-if="store.currentUser.value?.avatar_url" :src="store.currentUser.value.avatar_url" class="w-9 h-9 rounded-full shrink-0 mt-0.5" />
          <div v-else class="w-9 h-9 rounded-full bg-surface flex items-center justify-center text-xs font-semibold text-muted-foreground shrink-0 mt-0.5">
            {{ store.currentUser.value?.name?.charAt(0) || '?' }}
          </div>
          <div class="flex-1 flex flex-col gap-2">
            <textarea
              v-model="newComment"
              class="textarea-field text-sm"
              rows="3"
              :placeholder="t('writeComment')"
              :disabled="submitting"
              @keydown.ctrl.enter="submitComment"
            />
            <div class="flex justify-end">
              <button
                class="btn-primary text-sm"
                :disabled="!newComment.trim() || submitting"
                @click="submitComment"
              >
                <Send class="w-3.5 h-3.5" />
                {{ submitting ? t('sending') || 'Sending...' : t('postComment') || 'Post Comment' }}
              </button>
            </div>
          </div>
        </div>
        <p v-else class="text-sm text-muted-foreground mb-6">{{ t('loginToComment') }}</p>

        <!-- Comment list -->
        <div v-if="comments.length === 0" class="text-sm text-text-tertiary py-4">{{ t('noCommentsYet') }}</div>
        <div v-else class="flex flex-col gap-0">
          <div
            v-for="comment in comments"
            :key="comment.id"
            class="flex gap-3 py-4 border-b border-foreground/10 last:border-0"
          >
            <router-link :to="{ name: 'player-profile', params: { id: comment.player_id } }" class="shrink-0">
              <img v-if="comment.player_avatar" :src="comment.player_avatar" class="w-9 h-9 rounded-full" />
              <div v-else class="w-9 h-9 rounded-full bg-surface flex items-center justify-center text-xs font-semibold text-muted-foreground">
                {{ comment.player_name.charAt(0) }}
              </div>
            </router-link>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1">
                <router-link :to="{ name: 'player-profile', params: { id: comment.player_id } }" class="text-sm font-semibold text-foreground hover:text-primary transition-colors">
                  {{ comment.player_name }}
                </router-link>
                <span class="text-xs text-text-tertiary">{{ formatCommentDate(comment.created_at) }}</span>
                <button
                  v-if="canDeleteComment(comment)"
                  class="ml-auto p-1 rounded hover:bg-surface text-text-tertiary hover:text-destructive transition-colors"
                  @click="deleteComment(comment.id)"
                >
                  <Trash2 class="w-3.5 h-3.5" />
                </button>
              </div>
              <p class="text-sm text-foreground/80 whitespace-pre-wrap break-words">{{ comment.content }}</p>
              <div class="flex items-center gap-3 mt-1.5">
                <button
                  class="flex items-center gap-1 text-xs transition-colors"
                  :class="comment.my_vote === 1 ? 'text-green-500' : 'text-muted-foreground hover:text-green-500'"
                  :disabled="!isLoggedIn"
                  @click="voteComment(comment, 1)"
                >
                  <ThumbsUp class="w-3.5 h-3.5" :class="comment.my_vote === 1 ? 'fill-current' : ''" />
                  <span v-if="comment.likes > 0">{{ comment.likes }}</span>
                </button>
                <button
                  class="flex items-center gap-1 text-xs transition-colors"
                  :class="comment.my_vote === -1 ? 'text-red-500' : 'text-muted-foreground hover:text-red-500'"
                  :disabled="!isLoggedIn"
                  @click="voteComment(comment, -1)"
                >
                  <ThumbsDown class="w-3.5 h-3.5" :class="comment.my_vote === -1 ? 'fill-current' : ''" />
                  <span v-if="comment.dislikes > 0">{{ comment.dislikes }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
