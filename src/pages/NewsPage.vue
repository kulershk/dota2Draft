<script setup lang="ts">
import { Newspaper, Search, Calendar, User } from 'lucide-vue-next'
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'
import { fmtDateTime } from '@/utils/format'

const { t } = useI18n()
const api = useApi()
const news = ref<any[]>([])
const loading = ref(true)
const searchQuery = ref('')
const page = ref(1)
const PAGE_SIZE = 20

onMounted(async () => {
  try {
    news.value = await api.getNews()
  } catch {}
  loading.value = false
})

function formatDate(dateStr: string) {
  return fmtDateTime(new Date(dateStr))
}

const filteredNews = computed(() => {
  if (!searchQuery.value) return news.value
  const q = searchQuery.value.toLowerCase()
  return news.value.filter(p => p.title.toLowerCase().includes(q) || (p.content || '').toLowerCase().includes(q))
})

const paginatedNews = computed(() => filteredNews.value.slice(0, page.value * PAGE_SIZE))
const hasMore = computed(() => paginatedNews.value.length < filteredNews.value.length)

watch(searchQuery, () => { page.value = 1 })
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 max-w-[1200px] mx-auto w-full flex flex-col gap-5">
    <div>
      <h1 class="text-2xl md:text-3xl font-bold text-foreground">{{ t('allNews') }}</h1>
      <p class="text-sm text-muted-foreground mt-1">{{ t('allNewsDesc') }}</p>
    </div>

    <!-- Search -->
    <div class="flex flex-col sm:flex-row gap-3">
      <div class="relative flex-1">
        <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input v-model="searchQuery" type="text" :placeholder="t('search')" class="input-field pl-9 w-full" />
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="text-center py-12 text-muted-foreground">{{ t('loading') }}</div>

    <!-- List -->
    <div v-else class="card">
      <div v-if="filteredNews.length === 0" class="px-4 py-10 text-center text-sm text-muted-foreground">
        {{ t('noResults') }}
      </div>
      <div v-else class="divide-y divide-border">
        <router-link
          v-for="post in paginatedNews"
          :key="post.id"
          :to="{ name: 'news-post', params: { id: post.id } }"
          class="flex items-center justify-between px-4 py-4 md:px-6 md:py-5 hover:bg-accent/30 transition-colors gap-4"
        >
          <div class="flex items-center gap-4 flex-1 min-w-0">
            <div class="w-20 h-14 rounded-lg bg-surface overflow-hidden shrink-0">
              <img v-if="post.image_url" :src="post.image_url" class="w-full h-full object-cover" />
              <div v-else class="w-full h-full flex items-center justify-center">
                <Newspaper class="w-5 h-5 text-muted-foreground" />
              </div>
            </div>
            <div class="min-w-0">
              <h3 class="text-base font-semibold text-foreground truncate">{{ post.title }}</h3>
              <p class="text-xs text-muted-foreground mt-0.5 line-clamp-1">{{ post.content.replace(/<[^>]*>/g, '').slice(0, 200) }}</p>
              <div class="flex items-center gap-3 mt-1 flex-wrap">
                <span class="flex items-center gap-1 text-xs text-muted-foreground">
                  <Calendar class="w-3 h-3" />
                  {{ formatDate(post.created_at) }}
                </span>
                <span v-if="post.created_by_name" class="flex items-center gap-1 text-xs text-muted-foreground">
                  <User class="w-3 h-3" />
                  {{ post.created_by_name }}
                </span>
              </div>
            </div>
          </div>
        </router-link>
      </div>
      <div v-if="hasMore" class="px-4 py-3 border-t border-border text-center">
        <button class="btn-ghost text-sm text-primary" @click="page++">
          {{ t('showMore', { remaining: filteredNews.length - paginatedNews.length }) }}
        </button>
      </div>
    </div>
  </div>
</template>
