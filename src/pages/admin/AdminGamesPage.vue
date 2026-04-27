<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Gamepad2, RefreshCw, CheckCircle, ExternalLink } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import { fmtDateTime } from '@/utils/format'

const { t } = useI18n()
const api = useApi()

const games = ref<any[]>([])
const loading = ref(true)
const refetching = ref<Record<number, boolean>>({})
const refetchResults = ref<Record<number, { ok?: boolean; parsed?: boolean; error?: string }>>({})
const forceFetching = ref(false)
const forceProgress = ref({ done: 0, total: 0, errors: 0 })

async function fetchGames() {
  loading.value = true
  try {
    games.value = await api.getUnparsedGames()
  } catch {
    games.value = []
  } finally {
    loading.value = false
  }
}

async function refetchGame(game: any) {
  refetching.value[game.id] = true
  refetchResults.value[game.id] = {}
  try {
    const result = await api.refetchGame(game.id)
    refetchResults.value[game.id] = result
    if (result.parsed) {
      games.value = games.value.filter(g => g.id !== game.id)
    }
  } catch (e: any) {
    refetchResults.value[game.id] = { error: e.message || 'Failed' }
  } finally {
    refetching.value[game.id] = false
  }
}

async function refetchAll() {
  for (const game of [...games.value]) {
    if (refetching.value[game.id]) continue
    await refetchGame(game)
  }
}

async function forceFetchAll() {
  forceFetching.value = true
  forceProgress.value = { done: 0, total: 0, errors: 0 }
  try {
    const allGames = await api.getAllGames()
    forceProgress.value.total = allGames.length
    for (const game of allGames) {
      try {
        await api.refetchGame(game.id)
      } catch {
        forceProgress.value.errors++
      }
      forceProgress.value.done++
    }
    await fetchGames()
  } finally {
    forceFetching.value = false
  }
}

function formatDate(dateStr: string) {
  return fmtDateTime(new Date(dateStr))
}

onMounted(fetchGames)
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[var(--admin-content-max,1200px)] w-full">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-semibold text-foreground">{{ t('adminGames') }}</h1>
        <p class="text-sm text-muted-foreground mt-1">{{ t('adminGamesDesc') }}</p>
      </div>
      <div class="flex items-center gap-2">
        <button class="btn-secondary text-sm" :disabled="loading" @click="fetchGames">
          <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': loading }" />
          {{ t('refresh') }}
        </button>
        <button v-if="games.length > 0" class="btn-primary text-sm" @click="refetchAll">
          <RefreshCw class="w-3.5 h-3.5" />
          {{ t('refetchAll') }}
        </button>
        <button class="btn-destructive text-sm" :disabled="forceFetching" @click="forceFetchAll">
          <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': forceFetching }" />
          {{ t('forceFetchAll') }}
        </button>
      </div>
    </div>

    <!-- Force fetch progress -->
    <div v-if="forceFetching || forceProgress.total > 0" class="rounded-lg bg-card border border-border p-4 flex flex-col gap-2">
      <div class="flex items-center justify-between text-sm">
        <span class="font-medium text-foreground">{{ t('forceFetchAll') }}</span>
        <span class="text-muted-foreground font-mono">{{ forceProgress.done }} / {{ forceProgress.total }}</span>
      </div>
      <div class="w-full h-2 bg-surface rounded-full overflow-hidden">
        <div class="h-full bg-primary rounded-full transition-all" :style="{ width: forceProgress.total ? (forceProgress.done / forceProgress.total * 100) + '%' : '0%' }" />
      </div>
      <div v-if="forceProgress.errors > 0" class="text-xs text-red-500">{{ forceProgress.errors }} {{ t('errors') || 'errors' }}</div>
      <div v-if="!forceFetching && forceProgress.done === forceProgress.total && forceProgress.total > 0" class="text-xs text-color-success">{{ t('done') || 'Done' }}</div>
    </div>

    <div class="card">
      <div v-if="loading" class="px-4 py-10 text-center text-sm text-muted-foreground">
        {{ t('loading') }}
      </div>

      <div v-else-if="games.length === 0" class="px-4 py-10 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
        <CheckCircle class="w-8 h-8 text-green-500" />
        {{ t('allGamesParsed') }}
      </div>

      <div v-else>
        <div class="px-4 py-2.5 border-b border-border bg-accent/30 text-xs font-medium text-muted-foreground grid grid-cols-12 gap-2 items-center">
          <span class="col-span-3">{{ t('competition') }}</span>
          <span class="col-span-3">{{ t('matchCol') }}</span>
          <span class="col-span-2">{{ t('game') }}</span>
          <span class="col-span-2">{{ t('date') }}</span>
          <span class="col-span-2 text-right">{{ t('actions') }}</span>
        </div>
        <div
          v-for="game in games"
          :key="game.id"
          class="px-4 py-3 border-b border-border last:border-0 grid grid-cols-12 gap-2 items-center hover:bg-accent/20 transition-colors"
        >
          <div class="col-span-3 min-w-0">
            <span class="text-sm text-foreground truncate block">{{ game.competition_name }}</span>
          </div>
          <div class="col-span-3 min-w-0">
            <router-link
              :to="`/c/${game.competition_id}/match/${game.match_id}`"
              class="text-sm text-foreground hover:text-primary transition-colors truncate block"
            >
              {{ game.team1_name || 'TBD' }} vs {{ game.team2_name || 'TBD' }}
            </router-link>
          </div>
          <div class="col-span-2 flex items-center gap-2">
            <Gamepad2 class="w-3.5 h-3.5 text-muted-foreground" />
            <span class="text-sm text-foreground">{{ t('game') }} {{ game.game_number }}</span>
            <a v-if="game.dotabuff_id"
              :href="`https://www.opendota.com/matches/${game.dotabuff_id}`"
              target="_blank" rel="noopener noreferrer"
              class="text-muted-foreground hover:text-foreground transition-colors"
              :title="'#' + game.dotabuff_id"
            >
              <ExternalLink class="w-3 h-3" />
            </a>
          </div>
          <div class="col-span-2">
            <span class="text-xs text-muted-foreground">{{ formatDate(game.created_at) }}</span>
          </div>
          <div class="col-span-2 flex items-center justify-end gap-2">
            <span v-if="refetchResults[game.id]?.error" class="text-[10px] text-red-500 truncate">{{ refetchResults[game.id].error }}</span>
            <span v-else-if="refetchResults[game.id]?.ok && !refetchResults[game.id]?.parsed" class="text-[10px] text-amber-500">{{ t('stillParsing') }}</span>
            <button
              class="btn-secondary text-xs px-2.5 py-1.5"
              :disabled="refetching[game.id]"
              @click="refetchGame(game)"
            >
              <RefreshCw class="w-3 h-3" :class="{ 'animate-spin': refetching[game.id] }" />
              {{ t('refetchStats') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
