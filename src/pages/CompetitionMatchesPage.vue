<script setup lang="ts">
import { Swords, Search, Calendar } from 'lucide-vue-next'
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDraftStore } from '@/composables/useDraftStore'
import { formatMatchDate } from '@/utils/format'
import { MATCH_STATUS } from '@/utils/constants'
import TeamName from '@/components/common/TeamName.vue'

const { t } = useI18n()
const store = useDraftStore()

onMounted(() => {
  if (store.currentCompetitionId.value) store.fetchTournament()
})

watch(() => store.currentCompetitionId.value, (id) => {
  if (id && store.tournamentData.value.matches.length === 0) store.fetchTournament()
})

const searchQuery = ref('')
const statusFilter = ref('all')

const allMatches = computed(() => {
  return (store.tournamentData.value.matches || [])
    .filter((m: any) => !m.hidden && (m.team1_captain_id || m.team2_captain_id))
    .sort((a: any, b: any) => {
      // Live first, then by scheduled_at desc, then by id desc
      if (a.status === MATCH_STATUS.LIVE && b.status !== MATCH_STATUS.LIVE) return -1
      if (b.status === MATCH_STATUS.LIVE && a.status !== MATCH_STATUS.LIVE) return 1
      if (a.scheduled_at && b.scheduled_at) return new Date(b.scheduled_at).getTime() - new Date(a.scheduled_at).getTime()
      return b.id - a.id
    })
})

const filteredMatches = computed(() => {
  let list = allMatches.value
  if (statusFilter.value !== 'all') {
    list = list.filter((m: any) => m.status === statusFilter.value)
  }
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter((m: any) =>
      (m.team1_name || '').toLowerCase().includes(q) ||
      (m.team2_name || '').toLowerCase().includes(q)
    )
  }
  return list
})


watch([searchQuery, statusFilter], () => {})
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 max-w-[1200px] mx-auto w-full flex flex-col gap-5">
    <div>
      <h1 class="text-2xl md:text-3xl font-bold text-foreground">{{ t('allMatches') }}</h1>
      <p class="text-sm text-muted-foreground mt-1">{{ t('allMatchesDesc') }}</p>
    </div>

    <!-- Filters -->
    <div class="flex flex-col sm:flex-row gap-3">
      <div class="relative flex-1">
        <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input v-model="searchQuery" type="text" :placeholder="t('search')" class="input-field pl-9 w-full" />
      </div>
      <select v-model="statusFilter" class="input-field w-full sm:w-auto">
        <option value="all">{{ t('allStatuses') }}</option>
        <option :value="MATCH_STATUS.LIVE">{{ t('matchLive') }}</option>
        <option :value="MATCH_STATUS.COMPLETED">{{ t('matchCompleted') }}</option>
        <option :value="MATCH_STATUS.PENDING">{{ t('matchUpcoming') }}</option>
      </select>
    </div>

    <!-- List -->
    <div class="card">
      <div v-if="filteredMatches.length === 0" class="px-4 py-10 text-center text-sm text-muted-foreground">
        {{ t('noResults') }}
      </div>
      <div v-else class="divide-y divide-border">
        <router-link
          v-for="match in filteredMatches"
          :key="match.id"
          :to="{ name: 'comp-match', params: { matchId: match.id } }"
          class="flex items-center px-4 py-4 md:px-6 md:py-4 hover:bg-accent/30 transition-colors gap-3"
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
          <div class="shrink-0 text-right w-28 hidden sm:block">
            <span class="text-[10px] text-muted-foreground">BO{{ match.best_of }}</span>
            <span v-if="match.group_name" class="text-[10px] text-muted-foreground ml-2">{{ match.group_name }}</span>
            <div v-if="match.scheduled_at" class="flex items-center gap-1 justify-end mt-0.5">
              <Calendar class="w-3 h-3 text-muted-foreground" />
              <span class="text-[10px] text-muted-foreground">{{ formatMatchDate(match.scheduled_at, t) }}</span>
            </div>
          </div>
        </router-link>
      </div>
    </div>
  </div>
</template>
