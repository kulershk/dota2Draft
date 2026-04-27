<script setup lang="ts">
import { Zap, Search, ChevronLeft, ChevronRight } from 'lucide-vue-next'
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'
import { fmtDateTime } from '@/utils/format'
import UserName from '@/components/common/UserName.vue'

const { t } = useI18n()
const api = useApi()

const rows = ref<any[]>([])
const total = ref(0)
const loading = ref(false)

const filterPlayer = ref('')
const filterReason = ref('')
const page = ref(0)
const PAGE_SIZE = 30

const reasons = [
  'game_win', 'game_loss', 'match_win',
  'placement_1', 'placement_2', 'placement_3',
  'fantasy_participation', 'fantasy_stage_winner',
  'fantasy_overall_1st', 'fantasy_overall_2nd', 'fantasy_overall_3rd',
  'link_twitch', 'link_discord', 'set_bio',
]

async function fetchLogs() {
  loading.value = true
  try {
    const params: Record<string, string | number> = { limit: PAGE_SIZE, offset: page.value * PAGE_SIZE }
    if (filterPlayer.value) params.player_id = filterPlayer.value
    if (filterReason.value) params.reason = filterReason.value
    const data = await api.getAdminXpLog(params)
    rows.value = data.rows
    total.value = data.total
  } catch (e) {
    console.error(e)
  } finally {
    loading.value = false
  }
}

watch([filterPlayer, filterReason], () => { page.value = 0 })
watch([page, filterPlayer, filterReason], () => fetchLogs(), { immediate: true })
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[var(--admin-content-max,1200px)] w-full">
    <div>
      <h1 class="text-2xl font-semibold text-foreground">{{ t('adminXpLog') }}</h1>
      <p class="text-sm text-muted-foreground mt-1">{{ t('adminXpLogDesc') }}</p>
    </div>

    <!-- Filters -->
    <div class="flex flex-wrap items-center gap-3">
      <div class="relative">
        <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input v-model="filterPlayer" type="text" :placeholder="t('filterByPlayerId')" class="input-field pl-9 w-48" />
      </div>
      <select v-model="filterReason" class="input-field w-56">
        <option value="">{{ t('allReasons') }}</option>
        <option v-for="r in reasons" :key="r" :value="r">{{ t(`xpReason_${r}`) }}</option>
      </select>
      <span class="text-xs text-muted-foreground ml-auto">{{ total }} {{ t('entries') }}</span>
    </div>

    <!-- Table -->
    <div class="rounded-lg border border-border overflow-hidden">
      <div class="flex items-center bg-surface px-4 py-2.5 text-[11px] font-semibold font-mono uppercase tracking-wider text-text-tertiary">
        <span class="w-[200px] shrink-0">{{ t('playerName') }}</span>
        <span class="w-16 text-right shrink-0">{{ t('xpCol') }}</span>
        <span class="w-[160px] shrink-0 ml-4">{{ t('reason') }}</span>
        <span class="flex-1 min-w-0 ml-4">{{ t('detail') }}</span>
        <span class="w-[140px] text-right shrink-0">{{ t('date') }}</span>
      </div>
      <div v-if="loading" class="p-6 text-center text-sm text-muted-foreground">{{ t('loading') }}</div>
      <div v-else-if="rows.length === 0" class="p-6 text-center text-sm text-muted-foreground">{{ t('noXpYet') }}</div>
      <div v-else class="divide-y divide-border">
        <div v-for="row in rows" :key="row.id" class="flex items-center px-4 py-2.5 hover:bg-surface/50 transition-colors">
          <div class="w-[200px] shrink-0">
            <UserName :id="row.player_id" :name="row.player_name" :avatar-url="row.avatar_url" />
          </div>
          <span class="w-16 text-right text-sm font-bold font-mono text-primary shrink-0">+{{ row.amount }}</span>
          <span class="w-[160px] shrink-0 ml-4 text-xs text-foreground">{{ t(`xpReason_${row.reason}`) }}</span>
          <div class="flex-1 min-w-0 ml-4">
            <p v-if="row.detail" class="text-xs text-muted-foreground truncate">{{ row.detail }}</p>
            <p v-if="row.competition_name" class="text-[10px] text-text-tertiary truncate">{{ row.competition_name }}</p>
          </div>
          <span class="w-[140px] text-right text-[11px] text-muted-foreground shrink-0">{{ fmtDateTime(new Date(row.created_at)) }}</span>
        </div>
      </div>
    </div>

    <!-- Pagination -->
    <div v-if="total > PAGE_SIZE" class="flex items-center justify-center gap-3">
      <button class="btn-secondary text-sm" :disabled="page === 0" @click="page--">
        <ChevronLeft class="w-4 h-4" />
      </button>
      <span class="text-sm text-muted-foreground">{{ page + 1 }} / {{ Math.ceil(total / PAGE_SIZE) }}</span>
      <button class="btn-secondary text-sm" :disabled="(page + 1) * PAGE_SIZE >= total" @click="page++">
        <ChevronRight class="w-4 h-4" />
      </button>
    </div>
  </div>
</template>
