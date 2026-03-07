<script setup lang="ts">
import { Newspaper, Calendar, Gavel, Users, Trophy } from 'lucide-vue-next'
import { ref, onMounted } from 'vue'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import { getSocket } from '@/composables/useSocket'

interface NewsPost {
  id: number
  title: string
  content: string
  created_at: string
}

const api = useApi()
const store = useDraftStore()
const news = ref<NewsPost[]>([])

async function fetchNews() {
  news.value = await api.getNews()
}

onMounted(() => {
  fetchNews()
  getSocket().on('news:updated', fetchNews)
})

function formatDate(dateStr: string) {
  const d = new Date(dateStr + 'Z')
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const statusLabel: Record<string, string> = {
  idle: 'Not Started',
  nominating: 'In Progress',
  bidding: 'In Progress',
  paused: 'Paused',
  finished: 'Completed',
}

const statusClass: Record<string, string> = {
  idle: 'bg-accent text-muted-foreground',
  nominating: 'bg-color-success text-color-success-foreground',
  bidding: 'bg-color-success text-color-success-foreground',
  paused: 'bg-yellow-500/20 text-yellow-600 dark:text-yellow-400',
  finished: 'bg-primary/10 text-primary',
}
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-6 max-w-[1440px] mx-auto w-full">
    <!-- Hero -->
    <div class="text-center py-6 md:py-10">
      <h1 class="text-3xl md:text-4xl font-bold text-foreground">DOTA 2 Auction Draft</h1>
      <p class="text-muted-foreground mt-2 text-sm md:text-base">Salary Cap Auction Draft System</p>
    </div>

    <!-- Quick Stats -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
      <div class="card p-4 flex items-center gap-3">
        <div class="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
          <Gavel class="w-5 h-5 text-primary" />
        </div>
        <div>
          <p class="text-xs text-muted-foreground">Draft Status</p>
          <span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium mt-0.5" :class="statusClass[store.auction.status] || statusClass.idle">
            {{ statusLabel[store.auction.status] || 'Not Started' }}
          </span>
        </div>
      </div>
      <div class="card p-4 flex items-center gap-3">
        <div class="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
          <Users class="w-5 h-5 text-primary" />
        </div>
        <div>
          <p class="text-xs text-muted-foreground">Captains</p>
          <p class="text-lg font-bold text-foreground">{{ store.captains.value.length }}</p>
        </div>
      </div>
      <div class="card p-4 flex items-center gap-3">
        <div class="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
          <Users class="w-5 h-5 text-primary" />
        </div>
        <div>
          <p class="text-xs text-muted-foreground">Players</p>
          <p class="text-lg font-bold text-foreground">{{ store.players.value.length }}</p>
        </div>
      </div>
      <div class="card p-4 flex items-center gap-3">
        <div class="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
          <Trophy class="w-5 h-5 text-primary" />
        </div>
        <div>
          <p class="text-xs text-muted-foreground">Drafted</p>
          <p class="text-lg font-bold text-foreground">{{ store.players.value.filter(p => p.drafted).length }}</p>
        </div>
      </div>
    </div>

    <!-- News -->
    <div class="card">
      <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Newspaper class="w-5 h-5 text-foreground" />
        <span class="text-sm font-semibold text-foreground">News & Announcements</span>
      </div>
      <div v-if="news.length === 0" class="px-4 py-10 text-center text-sm text-muted-foreground">
        No announcements yet.
      </div>
      <div v-else class="divide-y divide-border">
        <div v-for="post in news" :key="post.id" class="px-4 py-4 md:px-6 md:py-5">
          <div class="flex items-start justify-between gap-3">
            <h3 class="text-base font-semibold text-foreground">{{ post.title }}</h3>
            <span class="flex items-center gap-1.5 text-xs text-muted-foreground whitespace-nowrap mt-0.5">
              <Calendar class="w-3.5 h-3.5" />
              {{ formatDate(post.created_at) }}
            </span>
          </div>
          <div class="prose prose-sm dark:prose-invert max-w-none mt-2 text-muted-foreground" v-html="post.content"></div>
        </div>
      </div>
    </div>
  </div>
</template>
