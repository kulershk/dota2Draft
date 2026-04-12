<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ArrowLeft, ExternalLink, Clock, Trophy, Swords, Loader2 } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const api = useApi()

const match = ref<any>(null)
const loading = ref(true)
const error = ref<string | null>(null)

const team1 = computed(() => match.value?.team1_players || [])
const team2 = computed(() => match.value?.team2_players || [])
const games = computed(() => match.value?.games || [])

function statusColor(status: string) {
  switch (status) {
    case 'completed': return 'bg-green-500/10 text-green-500'
    case 'live': return 'bg-amber-500/10 text-amber-500'
    case 'picking': return 'bg-blue-500/10 text-blue-500'
    case 'cancelled': return 'bg-destructive/10 text-destructive'
    default: return 'bg-accent text-muted-foreground'
  }
}

function gameWinnerTeam(game: any): 1 | 2 | null {
  if (!game.winner_captain_id) return null
  if (game.winner_captain_id === match.value?.captain1_player_id) return 1
  if (game.winner_captain_id === match.value?.captain2_player_id) return 2
  return null
}

function formatDuration(minutes: number | null): string {
  if (!minutes) return '—'
  return `${minutes}m`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString()
}

onMounted(async () => {
  try {
    match.value = await api.getQueueMatch(Number(route.params.id))
  } catch (e: any) {
    error.value = e.message || 'Match not found'
  }
  loading.value = false
})
</script>

<template>
  <div>
    <!-- Header -->
    <div class="border-b border-border/50">
      <div class="max-w-4xl mx-auto px-4 md:px-8 pt-8 pb-6">
        <button class="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4" @click="router.push('/queue')">
          <ArrowLeft class="w-4 h-4" /> {{ t('queueBackToQueue') }}
        </button>
        <div class="flex items-center gap-3">
          <Swords class="w-6 h-6 text-primary" />
          <h1 class="text-xl md:text-2xl font-bold">{{ t('queueMatchDetails') }}</h1>
          <span v-if="match" class="text-sm text-muted-foreground">#{{ match.id }}</span>
        </div>
      </div>
    </div>

    <div class="max-w-4xl mx-auto px-4 md:px-8 py-8">
      <!-- Loading -->
      <div v-if="loading" class="card px-8 py-16 text-center">
        <Loader2 class="w-8 h-8 text-primary mx-auto animate-spin" />
      </div>

      <!-- Error -->
      <div v-else-if="error" class="card px-8 py-16 text-center">
        <p class="text-destructive font-semibold">{{ error }}</p>
        <button class="btn-outline mt-4" @click="router.push('/queue')">{{ t('queueBackToQueue') }}</button>
      </div>

      <template v-else-if="match">

        <!-- Match info bar -->
        <div class="card px-5 py-4 mb-6 flex flex-wrap items-center gap-4">
          <span class="text-xs font-semibold px-2.5 py-1 rounded" :class="statusColor(match.status)">
            {{ match.status === 'completed' ? t('matchCompleted') : match.status === 'live' ? t('matchLive') : match.status }}
          </span>
          <span v-if="match.pool_name" class="text-sm text-muted-foreground">{{ match.pool_name }}</span>
          <span class="text-xs text-muted-foreground flex items-center gap-1">
            <Clock class="w-3 h-3" /> {{ formatDate(match.created_at) }}
          </span>
        </div>

        <!-- Teams + Score -->
        <div class="card overflow-hidden mb-6">
          <!-- Score header -->
          <div class="grid grid-cols-[1fr_auto_1fr] items-center px-6 py-5 border-b border-border/30">
            <div class="flex items-center gap-3">
              <img v-if="match.captain1_avatar" :src="match.captain1_avatar" class="w-10 h-10 rounded-full ring-2 ring-green-500/30" />
              <div>
                <div class="font-bold">{{ match.captain1_display_name || match.captain1_name }}</div>
                <div class="text-[10px] font-bold text-green-400 uppercase">{{ t('queueRadiant') }}</div>
              </div>
            </div>
            <div class="flex items-center gap-3 px-6">
              <span class="text-3xl font-bold tabular-nums" :class="games.filter((g: any) => gameWinnerTeam(g) === 1).length > games.filter((g: any) => gameWinnerTeam(g) === 2).length ? 'text-green-400' : 'text-foreground'">
                {{ games.filter((g: any) => gameWinnerTeam(g) === 1).length }}
              </span>
              <span class="text-muted-foreground/30 text-xl font-bold">:</span>
              <span class="text-3xl font-bold tabular-nums" :class="games.filter((g: any) => gameWinnerTeam(g) === 2).length > games.filter((g: any) => gameWinnerTeam(g) === 1).length ? 'text-red-400' : 'text-foreground'">
                {{ games.filter((g: any) => gameWinnerTeam(g) === 2).length }}
              </span>
            </div>
            <div class="flex items-center gap-3 justify-end">
              <div class="text-right">
                <div class="font-bold">{{ match.captain2_display_name || match.captain2_name }}</div>
                <div class="text-[10px] font-bold text-red-400 uppercase">{{ t('queueDire') }}</div>
              </div>
              <img v-if="match.captain2_avatar" :src="match.captain2_avatar" class="w-10 h-10 rounded-full ring-2 ring-red-500/30" />
            </div>
          </div>

          <!-- Team rosters -->
          <div class="grid grid-cols-2">
            <!-- Team 1 -->
            <div class="p-5 border-r border-border/30">
              <div class="flex flex-col gap-1.5">
                <div v-for="(p, idx) in team1" :key="p.playerId || idx"
                  class="flex items-center gap-2.5 px-3 py-2 rounded-lg"
                  :class="idx === 0 ? 'bg-green-500/8 border border-green-500/15' : 'bg-accent/40'">
                  <img v-if="p.avatarUrl" :src="p.avatarUrl" class="w-6 h-6 rounded-full" />
                  <span class="text-sm font-medium flex-1 truncate">{{ p.name }}</span>
                  <span class="text-[10px] text-muted-foreground tabular-nums">{{ p.mmr }} MMR</span>
                  <span v-if="idx === 0" class="text-[9px] font-bold text-green-400 bg-green-500/10 px-1.5 py-0.5 rounded">CPT</span>
                </div>
                <div v-if="team1.length === 0" class="text-sm text-muted-foreground/40 px-3 py-2">{{ match.captain1_display_name || match.captain1_name }}</div>
              </div>
            </div>
            <!-- Team 2 -->
            <div class="p-5">
              <div class="flex flex-col gap-1.5">
                <div v-for="(p, idx) in team2" :key="p.playerId || idx"
                  class="flex items-center gap-2.5 px-3 py-2 rounded-lg"
                  :class="idx === 0 ? 'bg-red-500/8 border border-red-500/15' : 'bg-accent/40'">
                  <img v-if="p.avatarUrl" :src="p.avatarUrl" class="w-6 h-6 rounded-full" />
                  <span class="text-sm font-medium flex-1 truncate">{{ p.name }}</span>
                  <span class="text-[10px] text-muted-foreground tabular-nums">{{ p.mmr }} MMR</span>
                  <span v-if="idx === 0" class="text-[9px] font-bold text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded">CPT</span>
                </div>
                <div v-if="team2.length === 0" class="text-sm text-muted-foreground/40 px-3 py-2">{{ match.captain2_display_name || match.captain2_name }}</div>
              </div>
            </div>
          </div>
        </div>

        <!-- Games -->
        <div v-if="games.length > 0">
          <h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">{{ t('queueGames') }}</h2>
          <div class="flex flex-col gap-3">
            <div v-for="game in games" :key="game.id" class="card px-5 py-4">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-3">
                  <span class="text-sm font-bold">{{ t('queueGameNumber', { n: game.game_number }) }}</span>
                  <template v-if="gameWinnerTeam(game)">
                    <Trophy class="w-4 h-4" :class="gameWinnerTeam(game) === 1 ? 'text-green-400' : 'text-red-400'" />
                    <span class="text-xs font-semibold" :class="gameWinnerTeam(game) === 1 ? 'text-green-400' : 'text-red-400'">
                      {{ gameWinnerTeam(game) === 1 ? (match.captain1_display_name || match.captain1_name) : (match.captain2_display_name || match.captain2_name) }}
                    </span>
                  </template>
                  <span v-else class="text-xs text-muted-foreground">{{ t('queueGamePending') }}</span>
                </div>
                <div class="flex items-center gap-4">
                  <span v-if="game.duration_minutes" class="text-xs text-muted-foreground flex items-center gap-1">
                    <Clock class="w-3 h-3" /> {{ formatDuration(game.duration_minutes) }}
                  </span>
                  <a v-if="game.dotabuff_id"
                    :href="`https://www.opendota.com/matches/${game.dotabuff_id}`"
                    target="_blank"
                    class="flex items-center gap-1 text-xs text-primary hover:underline">
                    OpenDota <ExternalLink class="w-3 h-3" />
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- No games -->
        <div v-else class="card px-6 py-8 text-center">
          <p class="text-sm text-muted-foreground">{{ t('queueNoGamesYet') }}</p>
        </div>

      </template>
    </div>
  </div>
</template>
