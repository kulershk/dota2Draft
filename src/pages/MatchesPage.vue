<script setup lang="ts">
import { Swords, Search, Calendar, ChevronLeft, ChevronRight } from 'lucide-vue-next'
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'
import { formatMatchDate } from '@/utils/format'
import { MATCH_STATUS } from '@/utils/constants'
import TeamName from '@/components/common/TeamName.vue'

const { t } = useI18n()
const api = useApi()

const matches = ref<any[]>([])
const total = ref(0)
const searchQuery = ref('')
const statusFilter = ref('all')
const loading = ref(true)
const page = ref(1)
const PAGE_SIZE = 30
let debounceTimer: ReturnType<typeof setTimeout> | null = null

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))

async function fetchMatches() {
  loading.value = true
  try {
    const res = await api.getAllMatches({
      status: statusFilter.value,
      search: searchQuery.value || undefined,
      limit: PAGE_SIZE,
      offset: (page.value - 1) * PAGE_SIZE,
    })
    matches.value = res.rows || []
    total.value = res.total ?? matches.value.length
  } catch {
    matches.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

onMounted(fetchMatches)

watch([statusFilter, page], fetchMatches)

watch(searchQuery, () => {
  page.value = 1
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(fetchMatches, 250)
})
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 max-w-[1200px] mx-auto w-full flex flex-col gap-5">
    <div>
      <h1 class="text-2xl md:text-3xl font-bold text-foreground">{{ t('navMatches') }}</h1>
      <p class="text-sm text-muted-foreground mt-1">{{ t('allMatchesGlobalDesc') }}</p>
    </div>

    <!-- Filters -->
    <div class="flex flex-col sm:flex-row gap-3">
      <div class="relative flex-1">
        <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input v-model="searchQuery" type="text" :placeholder="t('search')" class="input-field pl-9 w-full" />
      </div>
      <select v-model="statusFilter" class="input-field w-full sm:w-auto" @change="page = 1">
        <option value="all">{{ t('allStatuses') }}</option>
        <option :value="MATCH_STATUS.LIVE">{{ t('matchLive') }}</option>
        <option :value="MATCH_STATUS.COMPLETED">{{ t('matchCompleted') }}</option>
        <option :value="MATCH_STATUS.PENDING">{{ t('matchUpcoming') }}</option>
      </select>
    </div>

    <!-- List -->
    <div class="card">
      <div v-if="loading" class="px-4 py-10 text-center text-sm text-muted-foreground">
        {{ t('loading') }}
      </div>
      <div v-else-if="matches.length === 0" class="px-4 py-10 text-center text-sm text-muted-foreground">
        {{ t('noResults') }}
      </div>
      <div v-else class="divide-y divide-border">
        <router-link
          v-for="match in matches"
          :key="match.id"
          :to="`/c/${match.competition_id}/match/${match.id}`"
          class="relative flex items-center px-4 py-4 md:px-6 md:py-4 hover:bg-accent/30 transition-colors gap-3"
            :class="match.my_match ? `bg-primary/5 match-bar match-bar--${match.status}` : ''"
        >
          <!-- Status -->
          <span class="text-[9px] font-bold uppercase tracking-wider w-[70px] shrink-0"
            :class="match.status === MATCH_STATUS.LIVE ? 'text-destructive' : match.status === MATCH_STATUS.COMPLETED ? 'text-color-success' : 'text-muted-foreground'">
            {{ match.status === MATCH_STATUS.LIVE ? t('matchLive') : match.status === MATCH_STATUS.COMPLETED ? t('matchCompleted') : t('matchUpcoming') }}
          </span>

          <!-- Team 1 -->
          <div class="flex-1 flex items-center justify-end min-w-0">
            <TeamName :id="match.team1_captain_id || 0" :name="match.team1_name || t('tbd')" :banner-url="match.team1_banner" :avatar-url="match.team1_avatar" no-link reverse />
          </div>

          <!-- Score -->
          <div class="flex items-center gap-2 w-20 justify-center shrink-0">
            <span class="text-sm font-bold font-mono" :class="match.winner_captain_id === match.team1_captain_id ? 'text-color-success' : 'text-foreground'">
              {{ match.score1 ?? 0 }}
            </span>
            <span class="text-xs text-muted-foreground">:</span>
            <span class="text-sm font-bold font-mono" :class="match.winner_captain_id === match.team2_captain_id ? 'text-color-success' : 'text-foreground'">
              {{ match.score2 ?? 0 }}
            </span>
          </div>

          <!-- Team 2 -->
          <div class="flex-1 flex items-center min-w-0">
            <TeamName :id="match.team2_captain_id || 0" :name="match.team2_name || t('tbd')" :banner-url="match.team2_banner" :avatar-url="match.team2_avatar" no-link />
          </div>

          <!-- Meta -->
          <div class="shrink-0 text-right w-32 hidden sm:block">
            <span class="text-[10px] text-primary font-medium truncate block">{{ match.competition_name }}</span>
            <div class="flex items-center gap-1 justify-end mt-0.5">
              <span class="text-[10px] text-muted-foreground">BO{{ match.best_of }}</span>
              <template v-if="match.scheduled_at">
                <span class="text-[10px] text-muted-foreground mx-0.5">&middot;</span>
                <span class="text-[10px] text-muted-foreground">{{ formatMatchDate(match.scheduled_at, t) }}</span>
              </template>
            </div>
          </div>
        </router-link>
      </div>
      <!-- Pagination -->
      <div v-if="totalPages > 1" class="flex items-center justify-between px-4 py-3 border-t border-border">
        <button class="p-1.5 rounded hover:bg-accent disabled:opacity-30" :disabled="page <= 1" @click="page--">
          <ChevronLeft class="w-4 h-4 text-muted-foreground" />
        </button>
        <span class="text-xs text-muted-foreground font-mono">{{ page }} / {{ totalPages }} · {{ total }}</span>
        <button class="p-1.5 rounded hover:bg-accent disabled:opacity-30" :disabled="page >= totalPages" @click="page++">
          <ChevronRight class="w-4 h-4 text-muted-foreground" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.match-bar::after {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
}
.match-bar--live::after { background: #ef4444; }
.match-bar--completed::after { background: #22c55e; }
.match-bar--pending::after { background: #6b7280; }
</style>
