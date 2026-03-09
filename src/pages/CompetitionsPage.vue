<script setup lang="ts">
import { Trophy, Calendar, Users, User, Search } from 'lucide-vue-next'
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDraftStore } from '@/composables/useDraftStore'

const { t } = useI18n()
const store = useDraftStore()

const searchQuery = ref('')
const statusFilter = ref('all')
const page = ref(1)
const PAGE_SIZE = 20

onMounted(() => {
  store.fetchCompetitions()
})

const statusLabel = computed<Record<string, string>>(() => ({
  draft: t('statusSetup'),
  registration: t('statusRegistrationOpen'),
  active: t('statusInProgress'),
  finished: t('statusFinished'),
}))

const statusClass: Record<string, string> = {
  draft: 'bg-accent text-muted-foreground',
  registration: 'bg-primary/10 text-primary',
  active: 'bg-color-success text-color-success-foreground',
  finished: 'bg-yellow-500/20 text-yellow-600 dark:text-yellow-400',
}

function getCompStatus(comp: any) {
  const auctionStatus = comp.auction_state?.status || 'idle'
  if (['nominating', 'bidding', 'paused'].includes(auctionStatus)) return 'active'
  return comp.status || 'draft'
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const filteredCompetitions = computed(() => {
  let list = store.competitions.value
  if (statusFilter.value !== 'all') {
    list = list.filter(c => getCompStatus(c) === statusFilter.value)
  }
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter(c => c.name.toLowerCase().includes(q))
  }
  return list
})

const paginatedCompetitions = computed(() => filteredCompetitions.value.slice(0, page.value * PAGE_SIZE))
const hasMore = computed(() => paginatedCompetitions.value.length < filteredCompetitions.value.length)

watch([searchQuery, statusFilter], () => { page.value = 1 })
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 max-w-[1200px] mx-auto w-full flex flex-col gap-5">
    <div>
      <h1 class="text-2xl md:text-3xl font-bold text-foreground">{{ t('allCompetitions') }}</h1>
      <p class="text-sm text-muted-foreground mt-1">{{ t('allCompetitionsDesc') }}</p>
    </div>

    <!-- Filters -->
    <div class="flex flex-col sm:flex-row gap-3">
      <div class="relative flex-1">
        <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input v-model="searchQuery" type="text" :placeholder="t('search')" class="input-field pl-9 w-full" />
      </div>
      <select v-model="statusFilter" class="input-field w-full sm:w-auto">
        <option value="all">{{ t('allStatuses') }}</option>
        <option value="registration">{{ t('statusRegistrationOpen') }}</option>
        <option value="active">{{ t('statusInProgress') }}</option>
        <option value="finished">{{ t('statusFinished') }}</option>
        <option value="draft">{{ t('statusSetup') }}</option>
      </select>
    </div>

    <!-- List -->
    <div class="card">
      <div v-if="filteredCompetitions.length === 0" class="px-4 py-10 text-center text-sm text-muted-foreground">
        {{ t('noResults') }}
      </div>
      <div v-else class="divide-y divide-border">
        <router-link
          v-for="comp in paginatedCompetitions"
          :key="comp.id"
          :to="`/c/${comp.id}/info`"
          class="flex items-center justify-between px-4 py-4 md:px-6 md:py-5 hover:bg-accent/30 transition-colors"
        >
          <div class="flex items-center gap-4">
            <div class="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Trophy class="w-5 h-5 text-primary" />
            </div>
            <div class="min-w-0">
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
          <span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium shrink-0 ml-3"
            :class="statusClass[getCompStatus(comp)] || statusClass.draft">
            {{ statusLabel[getCompStatus(comp)] || t('statusSetup') }}
          </span>
        </router-link>
      </div>
      <div v-if="hasMore" class="px-4 py-3 border-t border-border text-center">
        <button class="btn-ghost text-sm text-primary" @click="page++">
          {{ t('showMore', { remaining: filteredCompetitions.length - paginatedCompetitions.length }) }}
        </button>
      </div>
    </div>
  </div>
</template>
