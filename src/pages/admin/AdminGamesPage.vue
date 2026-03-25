<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Gamepad2, RefreshCw, CheckCircle, ExternalLink } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'

const { t } = useI18n()
const api = useApi()

const games = ref<any[]>([])
const loading = ref(true)
const refetching = ref<Record<number, boolean>>({})
const refetchResults = ref<Record<number, { ok?: boolean; parsed?: boolean; error?: string }>>({})

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

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

onMounted(fetchGames)
</script>

<template>
  <div class="p-6 md:p-8 flex flex-col gap-5 max-w-[1000px]">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-xl font-bold text-foreground">{{ t('adminGames') }}</h1>
        <p class="text-sm text-muted-foreground mt-0.5">{{ t('adminGamesDesc') }}</p>
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
      </div>
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
