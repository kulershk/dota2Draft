<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Medal, Trophy, ChevronLeft } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import { getSocket } from '@/composables/useSocket'

interface Season {
  id: number
  name: string
  slug: string
  description: string | null
  starts_at: string | null
  ends_at: string | null
  is_active: boolean
  settings: Record<string, any>
  player_count: number
  match_count: number
}

interface LeaderRow {
  player_id: number
  display_name: string
  name: string
  avatar_url: string | null
  mmr: number
  points: number
  peak_points: number
  games_played: number
  wins: number
  losses: number
  last_match_at: string | null
}

const { t } = useI18n()
const route = useRoute()
const api = useApi()

const slug = computed(() => String(route.params.slug || ''))

const season = ref<Season | null>(null)
const rows = ref<LeaderRow[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    const [s, rs] = await Promise.all([
      api.getPublicSeason(slug.value),
      api.getSeasonLeaderboard(slug.value, { limit: 200 }),
    ])
    season.value = s
    rows.value = rs
  } catch (e: any) {
    error.value = e.message || 'Failed to load season'
  } finally {
    loading.value = false
  }
}

function fmtPoints(p: number): string {
  return Math.round(Number(p) || 0).toString()
}
function winratePct(r: LeaderRow): number {
  const total = (r.wins || 0) + (r.losses || 0)
  if (!total) return 0
  return Math.round(((r.wins || 0) / total) * 100)
}
function fmtRange(s: Season): string {
  const a = s.starts_at ? new Date(s.starts_at).toLocaleDateString() : '—'
  const b = s.ends_at   ? new Date(s.ends_at  ).toLocaleDateString() : '—'
  return `${a} → ${b}`
}

let socketHandler: ((p: any) => void) | null = null
function attachSocket() {
  const s = getSocket()
  if (!s) return
  socketHandler = (p: any) => {
    if (!season.value) return
    if (p?.seasonId === season.value.id) load()
  }
  s.on('season:rankUpdated', socketHandler)
}
function detachSocket() {
  const s = getSocket()
  if (s && socketHandler) s.off('season:rankUpdated', socketHandler)
}

watch(slug, load)
onMounted(() => { load(); attachSocket() })
onUnmounted(detachSocket)
</script>

<template>
  <div class="max-w-[1100px] mx-auto px-4 md:px-8 py-6 flex-1 w-full">
    <router-link :to="{ name: 'seasons' }" class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-3">
      <ChevronLeft class="w-3.5 h-3.5" />
      {{ t('seasonsPageTitle') }}
    </router-link>

    <div v-if="loading" class="text-sm text-muted-foreground">{{ t('loading') }}…</div>
    <div v-else-if="error" class="card p-4 border border-destructive/40 text-destructive text-sm">{{ error }}</div>
    <template v-else-if="season">
      <div class="flex items-start gap-3 mb-2">
        <Medal class="w-6 h-6 text-primary mt-1" />
        <div class="flex-1 min-w-0">
          <h1 class="text-2xl font-bold">{{ season.name }}</h1>
          <p v-if="season.description" class="text-sm text-muted-foreground">{{ season.description }}</p>
        </div>
      </div>

      <div class="flex flex-wrap gap-2 text-[11px] font-mono text-muted-foreground mb-5">
        <span class="px-2 py-1 rounded bg-accent/40">{{ fmtRange(season) }}</span>
        <span class="px-2 py-1 rounded bg-accent/40">{{ season.player_count }} {{ t('players') }}</span>
        <span class="px-2 py-1 rounded bg-accent/40">{{ season.match_count }} {{ t('seasonMatches') }}</span>
        <span v-if="season.is_active" class="px-2 py-1 rounded bg-green-500/15 text-green-500">{{ t('seasonStatus_active') }}</span>
        <span v-else class="px-2 py-1 rounded bg-muted/40">{{ t('seasonStatus_ended') }}</span>
      </div>

      <div v-if="rows.length === 0" class="card p-8 text-center text-muted-foreground">
        <Trophy class="w-10 h-10 mx-auto mb-3 opacity-40" />
        <p class="text-sm">{{ t('seasonLeaderboardEmpty') }}</p>
      </div>
      <div v-else class="card overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th class="text-right px-4 py-2.5 w-12">#</th>
              <th class="text-left px-4 py-2.5">{{ t('player') }}</th>
              <th class="text-right px-4 py-2.5">{{ t('seasonPoints') }}</th>
              <th class="text-right px-4 py-2.5 hidden md:table-cell">{{ t('seasonPeak') }}</th>
              <th class="text-right px-4 py-2.5">{{ t('seasonGames') }}</th>
              <th class="text-right px-4 py-2.5">W / L</th>
              <th class="text-right px-4 py-2.5 hidden md:table-cell">WR</th>
            </tr>
          </thead>
          <tbody>
            <router-link
              v-for="(row, i) in rows" :key="row.player_id"
              :to="{ name: 'player-profile', params: { id: row.player_id } }"
              custom v-slot="{ navigate }"
            >
              <tr class="border-t border-border/40 hover:bg-accent/20 cursor-pointer" @click="navigate">
                <td class="px-4 py-2.5 text-right font-mono tabular-nums" :class="i < 3 ? 'text-amber-400 font-bold' : 'text-muted-foreground'">{{ i + 1 }}</td>
                <td class="px-4 py-2.5">
                  <div class="flex items-center gap-2">
                    <img v-if="row.avatar_url" :src="row.avatar_url" class="w-7 h-7 rounded-full object-cover" />
                    <div v-else class="w-7 h-7 rounded-full bg-accent" />
                    <span class="font-semibold">{{ row.display_name }}</span>
                    <span class="text-[11px] text-muted-foreground font-mono tabular-nums">{{ row.mmr }} MMR</span>
                  </div>
                </td>
                <td class="px-4 py-2.5 text-right font-mono font-bold tabular-nums">{{ fmtPoints(row.points) }}</td>
                <td class="px-4 py-2.5 text-right font-mono text-muted-foreground tabular-nums hidden md:table-cell">{{ fmtPoints(row.peak_points) }}</td>
                <td class="px-4 py-2.5 text-right font-mono tabular-nums">{{ row.games_played }}</td>
                <td class="px-4 py-2.5 text-right font-mono tabular-nums">
                  <span class="text-green-500">{{ row.wins }}</span>
                  <span class="text-muted-foreground"> / </span>
                  <span class="text-red-500">{{ row.losses }}</span>
                </td>
                <td class="px-4 py-2.5 text-right font-mono tabular-nums hidden md:table-cell"
                    :class="winratePct(row) >= 60 ? 'text-green-500' : (winratePct(row) >= 45 ? 'text-amber-400' : 'text-red-500')">
                  {{ winratePct(row) }}%
                </td>
              </tr>
            </router-link>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
