<script setup lang="ts">
import { Trophy, User, BadgeCheck } from 'lucide-vue-next'
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useApi } from '@/composables/useApi'
import LevelBadge from '@/components/common/LevelBadge.vue'
import XpProgressBar from '@/components/common/XpProgressBar.vue'

const { t } = useI18n()
const api = useApi()
const router = useRouter()

interface LeaderboardEntry {
  rank: number
  id: number
  name: string
  avatar_url: string | null
  total_xp: number
  level: number
  level_progress: number
  mmr_verified_at?: string | null
}

const rows = ref<LeaderboardEntry[]>([])
const total = ref(0)
const loading = ref(true)
const loadingMore = ref(false)
const PAGE_SIZE = 50

async function fetchLeaderboard(offset = 0) {
  const data = await api.getLeaderboard({ limit: PAGE_SIZE, offset })
  return data
}

onMounted(async () => {
  try {
    const data = await fetchLeaderboard()
    rows.value = data.rows
    total.value = data.total
  } catch {}
  loading.value = false
})

async function loadMore() {
  loadingMore.value = true
  try {
    const data = await fetchLeaderboard(rows.value.length)
    rows.value.push(...data.rows)
    total.value = data.total
  } catch {}
  loadingMore.value = false
}
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 max-w-[1200px] mx-auto w-full flex flex-col gap-5 relative z-10">
    <div>
      <h1 class="text-2xl md:text-3xl font-bold text-foreground flex items-center gap-2">
        <Trophy class="w-7 h-7 text-primary" />
        {{ t('leaderboard') }}
      </h1>
      <p class="text-sm text-muted-foreground mt-1">{{ t('leaderboardDesc') }}</p>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="card p-12 flex items-center justify-center">
      <div class="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
    </div>

    <!-- Empty -->
    <div v-else-if="rows.length === 0" class="card p-12 text-center text-muted-foreground">
      {{ t('leaderboardEmpty') }}
    </div>

    <!-- Table -->
    <div v-else class="card overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full">
          <thead>
            <tr class="border-b border-border">
              <th class="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider py-3 px-4 w-16">{{ t('leaderboardRank') }}</th>
              <th class="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider py-3 px-4">{{ t('leaderboardPlayer') }}</th>
              <th class="text-center text-xs font-medium text-muted-foreground uppercase tracking-wider py-3 px-4 w-20">{{ t('leaderboardLevel') }}</th>
              <th class="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider py-3 px-4 w-24">{{ t('leaderboardXp') }}</th>
              <th class="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider py-3 px-4 w-40 hidden sm:table-cell">{{ t('leaderboardProgress') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in rows"
              :key="row.id"
              class="border-b border-border/30 hover:bg-accent/20 transition-colors cursor-pointer"
              @click="router.push({ name: 'player-profile', params: { id: row.id } })"
            >
              <!-- Rank -->
              <td class="py-3 px-4">
                <div class="flex items-center">
                  <Trophy v-if="row.rank === 1" class="w-5 h-5 text-yellow-500" />
                  <Trophy v-else-if="row.rank === 2" class="w-5 h-5 text-gray-400" />
                  <Trophy v-else-if="row.rank === 3" class="w-5 h-5 text-amber-700" />
                  <span v-else class="text-sm font-mono text-muted-foreground pl-0.5">{{ row.rank }}</span>
                </div>
              </td>
              <!-- Player -->
              <td class="py-3 px-4">
                <div class="flex items-center gap-3">
                  <div class="w-8 h-8 rounded-full overflow-hidden border border-border/50 shrink-0">
                    <img v-if="row.avatar_url" :src="row.avatar_url" class="w-full h-full object-cover" />
                    <div v-else class="w-full h-full bg-card flex items-center justify-center">
                      <User class="w-4 h-4 text-muted-foreground" />
                    </div>
                  </div>
                  <span class="text-sm font-medium text-foreground truncate flex items-center gap-1">
                    {{ row.name }}
                    <BadgeCheck v-if="row.mmr_verified_at" class="w-3.5 h-3.5 text-cyan-400 shrink-0" :title="t('mmrVerifiedTooltip')" />
                  </span>
                </div>
              </td>
              <!-- Level -->
              <td class="py-3 px-4 text-center">
                <div class="flex justify-center">
                  <LevelBadge :level="row.level" size="md" />
                </div>
              </td>
              <!-- XP -->
              <td class="py-3 px-4 text-right">
                <span class="text-sm font-semibold font-mono text-primary">{{ row.total_xp.toLocaleString() }}</span>
              </td>
              <!-- Progress -->
              <td class="py-3 px-4 hidden sm:table-cell">
                <XpProgressBar :current="row.level_progress" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Load more -->
      <div v-if="rows.length < total" class="flex justify-center py-4 border-t border-border/30">
        <button
          class="px-4 py-2 text-sm font-medium text-primary hover:bg-primary/10 rounded-lg transition-colors"
          :disabled="loadingMore"
          @click="loadMore"
        >
          <span v-if="loadingMore" class="flex items-center gap-2">
            <div class="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </span>
          <span v-else>{{ t('leaderboardShowMore') }} ({{ rows.length }}/{{ total }})</span>
        </button>
      </div>
    </div>
  </div>
</template>
