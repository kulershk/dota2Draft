<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Medal, Trophy, ChevronRight } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'

interface SeasonRow {
  id: number
  name: string
  slug: string
  description: string | null
  starts_at: string | null
  ends_at: string | null
  is_active: boolean
  player_count: number
  match_count: number
}

const { t } = useI18n()
const api = useApi()

const seasons = ref<SeasonRow[]>([])
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    seasons.value = await api.getPublicSeasons()
  } finally {
    loading.value = false
  }
}

const active = computed(() => seasons.value.filter(s => {
  if (!s.is_active) return false
  const now = Date.now()
  if (s.ends_at && new Date(s.ends_at).getTime() < now) return false
  if (s.starts_at && new Date(s.starts_at).getTime() > now) return false
  return true
}))
const past = computed(() => seasons.value.filter(s => !active.value.includes(s)))

function fmtRange(s: SeasonRow): string {
  const a = s.starts_at ? new Date(s.starts_at).toLocaleDateString() : '—'
  const b = s.ends_at   ? new Date(s.ends_at  ).toLocaleDateString() : '—'
  return `${a} → ${b}`
}

onMounted(load)
</script>

<template>
  <div class="max-w-[1100px] mx-auto px-4 md:px-8 py-6 flex-1 w-full">
    <div class="flex items-center gap-3 mb-2">
      <Medal class="w-6 h-6 text-primary" />
      <h1 class="text-2xl font-bold">{{ t('seasonsPageTitle') }}</h1>
    </div>
    <p class="text-sm text-muted-foreground mb-6">{{ t('seasonsPageDesc') }}</p>

    <div v-if="loading" class="text-sm text-muted-foreground">{{ t('loading') }}…</div>
    <div v-else-if="seasons.length === 0" class="card p-8 text-center text-muted-foreground">
      <Trophy class="w-10 h-10 mx-auto mb-3 opacity-40" />
      <p class="text-sm">{{ t('seasonsEmpty') }}</p>
    </div>
    <template v-else>
      <h2 v-if="active.length" class="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">{{ t('seasonsActive') }}</h2>
      <div v-if="active.length" class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
        <router-link
          v-for="s in active" :key="s.id"
          :to="{ name: 'season-leaderboard', params: { slug: s.slug } }"
          class="card p-4 flex items-center gap-3 hover:border-primary/40 transition-colors"
        >
          <div class="w-10 h-10 rounded-lg bg-primary/15 flex items-center justify-center text-primary">
            <Medal class="w-5 h-5" />
          </div>
          <div class="flex-1 min-w-0">
            <div class="font-bold truncate">{{ s.name }}</div>
            <div class="text-[11px] text-muted-foreground font-mono">{{ fmtRange(s) }}</div>
            <div class="text-[11px] text-muted-foreground tabular-nums mt-0.5">
              {{ s.player_count }} {{ t('players') }} · {{ s.match_count }} {{ t('seasonMatches') }}
            </div>
          </div>
          <ChevronRight class="w-4 h-4 text-muted-foreground" />
        </router-link>
      </div>

      <h2 v-if="past.length" class="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">{{ t('seasonsRecent') }}</h2>
      <div v-if="past.length" class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <router-link
          v-for="s in past" :key="s.id"
          :to="{ name: 'season-leaderboard', params: { slug: s.slug } }"
          class="card p-3 flex items-center gap-3 hover:border-primary/40 transition-colors"
        >
          <div class="flex-1 min-w-0">
            <div class="font-semibold text-sm truncate">{{ s.name }}</div>
            <div class="text-[10px] text-muted-foreground font-mono tabular-nums">
              {{ s.player_count }} · {{ s.match_count }}m
            </div>
          </div>
        </router-link>
      </div>
    </template>
  </div>
</template>
