<script setup lang="ts">
import { Newspaper, Calendar, Trophy, Users, Swords, User } from 'lucide-vue-next'
import { ref, onMounted } from 'vue'
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

const api = useApi()
const store = useDraftStore()
const news = ref<NewsPost[]>([])

async function fetchNews() {
  news.value = await api.getNews()
}

onMounted(async () => {
  fetchNews()
  getSocket().on('news:updated', fetchNews)
  await store.fetchCompetitions()
})

function formatDate(dateStr: string) {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const statusLabel: Record<string, string> = {
  draft: 'Setup',
  registration: 'Registration Open',
  active: 'In Progress',
  finished: 'Completed',
  archived: 'Archived',
}

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
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-6 max-w-[1440px] mx-auto w-full">
    <!-- Hero -->
    <div class="text-center py-6 md:py-10">
      <h1 class="text-3xl md:text-4xl font-bold text-foreground">DOTA 2 Auction Draft</h1>
      <p class="text-muted-foreground mt-2 text-sm md:text-base">Salary Cap Auction Draft System</p>
    </div>

    <!-- Competitions -->
    <div class="card">
      <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Swords class="w-5 h-5 text-foreground" />
        <span class="text-sm font-semibold text-foreground">Competitions</span>
        <span class="text-xs text-muted-foreground">({{ store.competitions.value.length }})</span>
      </div>
      <div v-if="store.competitions.value.length === 0" class="px-4 py-10 text-center text-sm text-muted-foreground">
        No competitions yet. An admin can create one from the Admin Panel.
      </div>
      <div v-else class="divide-y divide-border">
        <router-link
          v-for="comp in store.competitions.value"
          :key="comp.id"
          :to="`/c/${comp.id}/players`"
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
            {{ statusLabel[getAuctionStatus(comp)] || 'Setup' }}
          </span>
        </router-link>
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
          <div class="prose prose-sm dark:prose-invert max-w-none mt-2 text-muted-foreground" v-html="post.content"></div>
        </div>
      </div>
    </div>
  </div>
</template>
