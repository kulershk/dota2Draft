<script setup lang="ts">
import { User, Trophy, Swords, Tv, Calendar, Medal, MessageCircle, Shield, Star, ChevronLeft, ChevronRight } from 'lucide-vue-next'
import { ref, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'
import { useDotaConstants } from '@/composables/useDotaConstants'
import RoleBadge from '@/components/common/RoleBadge.vue'
import MmrDisplay from '@/components/common/MmrDisplay.vue'
import LevelBadge from '@/components/common/LevelBadge.vue'
import XpProgressBar from '@/components/common/XpProgressBar.vue'
import PositionIcon from '@/components/common/PositionIcon.vue'
import { sortedRoles } from '@/utils/roles'
import { fmtDateOnly, fmtDateTime } from '@/utils/format'

const { t } = useI18n()
const route = useRoute()
const api = useApi()
const dota = useDotaConstants()

dota.loadConstants()

const playerId = computed(() => Number(route.params.id))
const profile = ref<any>(null)
const xpLog = ref<any[]>([])
const loading = ref(true)
const error = ref(false)

const PAGE_SIZE = 5
const MATCH_PAGE_SIZE = 10
const xpPage = ref(1)
const compPage = ref(1)
const matchPage = ref(0)
const matchHistory = ref<any[]>([])
const matchTotal = ref(0)
const matchLoading = ref(false)

const xpTotalPages = computed(() => Math.max(1, Math.ceil(xpLog.value.length / PAGE_SIZE)))
const pagedXpLog = computed(() => xpLog.value.slice((xpPage.value - 1) * PAGE_SIZE, xpPage.value * PAGE_SIZE))

const compTotalPages = computed(() => Math.max(1, Math.ceil((profile.value?.competitions?.length || 0) / PAGE_SIZE)))
const pagedCompetitions = computed(() => (profile.value?.competitions || []).slice((compPage.value - 1) * PAGE_SIZE, compPage.value * PAGE_SIZE))

watch(playerId, async (id) => {
  if (!id) return
  loading.value = true
  error.value = false
  xpPage.value = 1
  compPage.value = 1
  try {
    profile.value = await api.getPlayerProfile(id)
    api.getPlayerXpLog(id).then(logs => { xpLog.value = logs }).catch(() => {})
    matchPage.value = 0
    fetchMatches(id)
  } catch {
    error.value = true
    profile.value = null
  } finally {
    loading.value = false
  }
}, { immediate: true })

async function fetchMatches(id?: number) {
  const pid = id || playerId.value
  if (!pid) return
  matchLoading.value = true
  try {
    const data = await api.getPlayerMatches(pid, { limit: MATCH_PAGE_SIZE, offset: matchPage.value * MATCH_PAGE_SIZE })
    matchHistory.value = data.rows
    matchTotal.value = data.total
  } catch { /* ignore */ }
  matchLoading.value = false
}

const matchTotalPages = computed(() => Math.max(1, Math.ceil(matchTotal.value / MATCH_PAGE_SIZE)))

function prevMatchPage() { if (matchPage.value > 0) { matchPage.value--; fetchMatches() } }
function nextMatchPage() { if (matchPage.value + 1 < matchTotalPages.value) { matchPage.value++; fetchMatches() } }

function formatDate(dateStr: string) {
  return fmtDateOnly(new Date(dateStr))
}

function placementLabel(n: number) {
  if (n === 1) return t('placementFirst')
  if (n === 2) return t('placementSecond')
  if (n === 3) return t('placementThird')
  return t('placementN', { n })
}

function placementClass(n: number) {
  if (n === 1) return 'text-yellow-500'
  if (n === 2) return 'text-gray-400'
  if (n === 3) return 'text-amber-700 dark:text-amber-600'
  return 'text-muted-foreground'
}

function placementBg(n: number) {
  if (n === 1) return 'bg-yellow-500/10 border-yellow-500/20'
  if (n === 2) return 'bg-gray-400/10 border-gray-400/20'
  if (n === 3) return 'bg-amber-700/10 border-amber-700/20'
  return 'bg-accent border-border'
}
</script>

<template>
  <div class="p-4 md:p-8 flex flex-col gap-5 md:gap-6 max-w-[900px] mx-auto w-full">
    <div v-if="loading" class="text-center py-12 text-muted-foreground">{{ t('loading') }}</div>
    <div v-else-if="error" class="text-center py-12 text-muted-foreground">{{ t('playerNotFound') }}</div>

    <template v-else-if="profile">
      <!-- Player header + Top heroes side by side -->
      <div class="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-5">
      <div class="card p-6">
        <div class="flex items-start gap-4">
          <img v-if="profile.avatar_url" :src="profile.avatar_url" class="w-16 h-16 rounded-full" />
          <div v-else class="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
            <User class="w-8 h-8 text-primary" />
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <h1 class="text-2xl font-bold text-foreground truncate">{{ profile.name }}</h1>
                <div class="flex flex-wrap items-center gap-2 mt-1.5">
                  <LevelBadge :level="profile.level || 1" size="md" />
                  <span class="text-xs font-semibold text-primary">{{ t('levelN', { n: profile.level || 1 }) }}</span>
                  <div v-if="profile.roles?.length" class="flex flex-wrap gap-1">
                    <RoleBadge v-for="role in sortedRoles(profile.roles)" :key="role" :role="role" />
                  </div>
                  <MmrDisplay v-if="profile.mmr" :mmr="profile.mmr" />
                  <div v-if="profile.favorite_position" class="flex items-center gap-1" :title="`${profile.favorite_position.games}/${profile.favorite_position.total} games`">
                    <PositionIcon :position="profile.favorite_position.position" />
                  </div>
                </div>
                <div class="mt-1.5 max-w-[240px]">
                  <XpProgressBar :current="profile.level_progress || 0" />
                </div>
              </div>
              <!-- External links -->
              <div v-if="profile.steam_id" class="flex items-center gap-1.5 shrink-0">
                <a :href="`https://steamcommunity.com/profiles/${profile.steam_id}`"
                  target="_blank" rel="noopener"
                  class="w-8 h-8 rounded-lg bg-accent flex items-center justify-center hover:bg-accent/70 transition-colors"
                  title="Steam"
                >
                  <img src="/icons/steam.svg" class="w-5 h-5" alt="Steam" />
                </a>
                <a :href="`https://www.dotabuff.com/players/${BigInt(profile.steam_id) - 76561197960265728n}`"
                  target="_blank" rel="noopener"
                  class="w-8 h-8 rounded-lg bg-accent flex items-center justify-center hover:bg-accent/70 transition-colors"
                  title="Dotabuff"
                >
                  <img src="/icons/dotabuff.png" class="w-5 h-5 rounded" alt="Dotabuff" />
                </a>
                <a :href="`https://www.opendota.com/players/${BigInt(profile.steam_id) - 76561197960265728n}`"
                  target="_blank" rel="noopener"
                  class="w-8 h-8 rounded-lg bg-accent flex items-center justify-center hover:bg-accent/70 transition-colors"
                  title="OpenDota"
                >
                  <img src="/icons/opendota.png" class="w-5 h-5" alt="OpenDota" />
                </a>
                <a :href="`https://stratz.com/players/${BigInt(profile.steam_id) - 76561197960265728n}`"
                  target="_blank" rel="noopener"
                  class="w-8 h-8 rounded-lg bg-accent flex items-center justify-center hover:bg-accent/70 transition-colors"
                  title="Stratz"
                >
                  <img src="/icons/stratz.ico" class="w-5 h-5" alt="Stratz" />
                </a>
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-2 mt-2 text-xs text-muted-foreground">
              <span class="flex items-center gap-1">
                <Calendar class="w-3.5 h-3.5" />
                {{ t('memberSince') }} {{ formatDate(profile.created_at) }}
              </span>
              <a v-if="profile.twitch_username"
                :href="`https://twitch.tv/${profile.twitch_username}`"
                target="_blank" rel="noopener"
                class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#9146FF]/10 border border-[#9146FF]/20 text-[#9146FF] hover:bg-[#9146FF]/20 transition-colors"
              >
                <Tv class="w-3.5 h-3.5" />
                <span class="font-medium">{{ profile.twitch_username }}</span>
              </a>
              <span v-if="profile.discord_username"
                class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#5865F2]/10 border border-[#5865F2]/20 text-[#5865F2]"
              >
                <MessageCircle class="w-3.5 h-3.5" />
                <span class="font-medium">{{ profile.discord_username }}</span>
              </span>
            </div>
            <p v-if="profile.info" class="text-sm text-muted-foreground mt-2">{{ profile.info }}</p>
          </div>
        </div>
      </div>

      <!-- Top heroes (right column) -->
      <div v-if="profile.top_heroes?.length" class="card self-start">
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Shield class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">{{ t('topHeroes') }}</span>
        </div>
        <div class="p-4 flex flex-col gap-3">
          <div v-for="hero in profile.top_heroes" :key="hero.hero_id" class="flex items-center gap-3 p-3 rounded-lg bg-accent/50 border border-border/50">
            <img v-if="dota.heroImg(hero.hero_id)" :src="dota.heroImg(hero.hero_id)" :alt="dota.heroName(hero.hero_id)"
              class="w-16 h-9 rounded object-cover border border-border/30 shrink-0" />
            <div class="min-w-0 flex-1">
              <p class="text-sm font-semibold text-foreground truncate">{{ dota.heroName(hero.hero_id) || `Hero #${hero.hero_id}` }}</p>
              <p class="text-xs text-muted-foreground">
                {{ hero.games }} {{ hero.games === 1 ? t('gamesSingular') : t('gamesPlural') }}
                <span class="text-green-500 ml-1">{{ hero.wins }}W</span>
                <span class="text-red-500 ml-0.5">{{ hero.games - hero.wins }}L</span>
              </p>
              <div class="mt-1 h-1 rounded-full bg-border/50 overflow-hidden">
                <div class="h-full rounded-full bg-green-500" :style="{ width: `${hero.games > 0 ? (hero.wins / hero.games * 100) : 0}%` }"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
      </div>

      <!-- Tournament placements -->
      <div v-if="profile.tournament_results.length > 0" class="card">
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Medal class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">{{ t('tournamentPlacements') }}</span>
        </div>
        <div class="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div
            v-for="(result, idx) in profile.tournament_results" :key="idx"
            class="flex items-center gap-3 p-3 rounded-lg border"
            :class="placementBg(result.placement)"
          >
            <div class="w-10 h-10 rounded-full flex items-center justify-center font-bold text-lg shrink-0" :class="placementClass(result.placement)">
              {{ result.placement === 1 ? '🥇' : result.placement === 2 ? '🥈' : result.placement === 3 ? '🥉' : `#${result.placement}` }}
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-sm font-semibold text-foreground truncate">{{ result.competition_name }}</p>
              <p class="text-xs text-muted-foreground truncate">{{ result.team }} &middot; {{ result.stage_name }}</p>
            </div>
            <span class="text-xs font-medium shrink-0" :class="placementClass(result.placement)">
              {{ placementLabel(result.placement) }}
            </span>
          </div>
        </div>
      </div>

      <!-- Match History (full width) -->
      <div class="card flex flex-col">
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Swords class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">{{ t('matchHistory') }}</span>
          <span class="text-xs font-mono text-muted-foreground ml-auto">{{ matchTotal }} {{ t('matches') }}</span>
        </div>
        <div v-if="matchLoading && matchHistory.length === 0" class="p-6 text-center text-sm text-muted-foreground">{{ t('loading') }}</div>
        <div v-else-if="matchHistory.length === 0" class="p-6 text-center text-sm text-muted-foreground">{{ t('noMatches') }}</div>
        <div v-else class="divide-y divide-border">
          <component
            :is="m.type === 'queue' && m.queueMatchId ? 'router-link' : m.type === 'competition' && m.competitionId ? 'router-link' : 'div'"
            v-for="m in matchHistory"
            :key="(m.type === 'queue' ? 'q' : 'c') + m.id"
            :to="m.type === 'queue' ? { name: 'queue-match', params: { id: m.queueMatchId } } : { name: 'comp-match', params: { compId: m.competitionId, matchId: m.id } }"
            class="flex items-center gap-3 px-4 py-3 hover:bg-accent/30 transition-colors"
          >
            <!-- Result indicator -->
            <div class="w-1.5 h-8 rounded-full shrink-0" :class="m.status !== 'completed' ? 'bg-muted-foreground/30' : m.won ? 'bg-green-500' : 'bg-red-500'" />

            <!-- Team 1 -->
            <div class="flex items-center gap-2 flex-1 min-w-0 justify-end">
              <span class="text-sm truncate" :class="m.status === 'completed' && m.winnerCaptainId === m.team1.captainId ? 'font-bold text-foreground' : 'text-muted-foreground'">
                {{ m.team1.name || 'TBD' }}
              </span>
              <img v-if="m.team1.avatar" :src="m.team1.avatar" class="w-6 h-6 rounded-full shrink-0" />
            </div>

            <!-- Score -->
            <div class="flex items-center gap-1.5 shrink-0 px-2">
              <span class="text-sm font-mono font-bold" :class="m.status === 'completed' && m.winnerCaptainId === m.team1.captainId ? 'text-foreground' : 'text-muted-foreground'">{{ m.score1 ?? '-' }}</span>
              <span class="text-xs text-muted-foreground">:</span>
              <span class="text-sm font-mono font-bold" :class="m.status === 'completed' && m.winnerCaptainId === m.team2.captainId ? 'text-foreground' : 'text-muted-foreground'">{{ m.score2 ?? '-' }}</span>
            </div>

            <!-- Team 2 -->
            <div class="flex items-center gap-2 flex-1 min-w-0">
              <img v-if="m.team2.avatar" :src="m.team2.avatar" class="w-6 h-6 rounded-full shrink-0" />
              <span class="text-sm truncate" :class="m.status === 'completed' && m.winnerCaptainId === m.team2.captainId ? 'font-bold text-foreground' : 'text-muted-foreground'">
                {{ m.team2.name || 'TBD' }}
              </span>
            </div>

            <!-- Meta -->
            <div class="flex items-center gap-2 shrink-0 text-right">
              <span v-if="m.type === 'queue'" class="text-[10px] px-1.5 py-0.5 rounded bg-accent text-muted-foreground">{{ m.poolName || 'Queue' }}</span>
              <span v-else class="text-[10px] px-1.5 py-0.5 rounded bg-accent text-muted-foreground truncate max-w-[120px]">{{ m.competitionName }}</span>
              <span class="text-[10px] text-muted-foreground tabular-nums w-[70px]">{{ formatDate(m.date) }}</span>
            </div>
          </component>
        </div>
        <!-- Pagination -->
        <div v-if="matchTotalPages > 1" class="flex items-center justify-between px-4 py-2 border-t border-border">
          <button class="p-1 rounded hover:bg-accent disabled:opacity-30" :disabled="matchPage <= 0" @click="prevMatchPage">
            <ChevronLeft class="w-4 h-4 text-muted-foreground" />
          </button>
          <span class="text-xs text-muted-foreground font-mono">{{ matchPage + 1 }} / {{ matchTotalPages }}</span>
          <button class="p-1 rounded hover:bg-accent disabled:opacity-30" :disabled="matchPage + 1 >= matchTotalPages" @click="nextMatchPage">
            <ChevronRight class="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
      </div>

      <!-- XP History + Competition History side by side -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <!-- XP History -->
        <div v-if="xpLog.length > 0" class="card flex flex-col">
          <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
            <Star class="w-5 h-5 text-foreground" />
            <span class="text-sm font-semibold text-foreground">{{ t('xpHistory') }}</span>
            <span class="text-xs font-mono text-muted-foreground ml-auto">{{ t('xpTotal') }}: {{ (profile.total_xp || 0).toLocaleString() }}</span>
          </div>
          <div class="divide-y divide-border flex-1">
            <div v-for="log in pagedXpLog" :key="log.created_at" class="flex items-center gap-3 px-4 py-2.5">
              <span class="text-sm font-bold font-mono text-primary shrink-0">+{{ log.amount }}</span>
              <div class="flex-1 min-w-0">
                <p class="text-sm text-foreground truncate">{{ t(`xpReason_${log.reason}`) }}</p>
                <p v-if="log.detail" class="text-xs text-muted-foreground truncate">{{ log.detail }}</p>
              </div>
              <div class="text-right shrink-0">
                <p v-if="log.competition_name" class="text-xs text-muted-foreground truncate max-w-[140px]">{{ log.competition_name }}</p>
                <p class="text-[10px] text-text-tertiary">{{ fmtDateTime(new Date(log.created_at)) }}</p>
              </div>
            </div>
          </div>
          <!-- Pagination -->
          <div v-if="xpTotalPages > 1" class="flex items-center justify-between px-4 py-2 border-t border-border">
            <button class="p-1 rounded hover:bg-accent disabled:opacity-30" :disabled="xpPage <= 1" @click="xpPage--">
              <ChevronLeft class="w-4 h-4 text-muted-foreground" />
            </button>
            <span class="text-xs text-muted-foreground font-mono">{{ xpPage }} / {{ xpTotalPages }}</span>
            <button class="p-1 rounded hover:bg-accent disabled:opacity-30" :disabled="xpPage >= xpTotalPages" @click="xpPage++">
              <ChevronRight class="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
        </div>

        <!-- Competition history -->
        <div class="card flex flex-col">
          <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
            <Swords class="w-5 h-5 text-foreground" />
            <span class="text-sm font-semibold text-foreground">{{ t('competitionHistory') }} ({{ profile.competitions.length }})</span>
          </div>
          <div v-if="profile.competitions.length === 0" class="p-6 text-center text-sm text-muted-foreground flex-1 flex items-center justify-center">
            {{ t('noCompetitions') }}
          </div>
          <div v-else class="divide-y divide-border flex-1">
            <div v-for="comp in pagedCompetitions" :key="comp.competition_id" class="flex items-center gap-3 px-4 py-3">
              <div class="flex-1 min-w-0">
                <router-link
                  :to="{ name: 'comp-info', params: { compId: comp.competition_id } }"
                  class="text-sm font-medium text-foreground hover:text-primary transition-colors truncate block"
                >{{ comp.competition_name }}</router-link>
                <div class="flex flex-wrap items-center gap-2 mt-1">
                  <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                    :class="comp.was_captain ? 'bg-primary/10 text-primary' : 'bg-accent text-muted-foreground'">
                    <Trophy v-if="comp.was_captain" class="w-3 h-3 mr-0.5" />
                    {{ comp.was_captain ? t('wasCaptain') : t('wasPlayer') }}
                  </span>
                  <span v-if="comp.captain_team" class="text-xs text-muted-foreground">{{ comp.captain_team }}</span>
                  <span v-if="comp.drafted && comp.drafted_by_team" class="text-xs text-muted-foreground">
                    {{ t('draftedBy') }} {{ comp.drafted_by_team }}
                  </span>
                  <span v-if="comp.draft_price" class="text-xs font-mono text-primary font-semibold">{{ comp.draft_price }}g</span>
                </div>
              </div>
              <div class="shrink-0">
                <MmrDisplay v-if="comp.mmr" :mmr="comp.mmr" size="sm" />
              </div>
            </div>
          </div>
          <!-- Pagination -->
          <div v-if="compTotalPages > 1" class="flex items-center justify-between px-4 py-2 border-t border-border">
            <button class="p-1 rounded hover:bg-accent disabled:opacity-30" :disabled="compPage <= 1" @click="compPage--">
              <ChevronLeft class="w-4 h-4 text-muted-foreground" />
            </button>
            <span class="text-xs text-muted-foreground font-mono">{{ compPage }} / {{ compTotalPages }}</span>
            <button class="p-1 rounded hover:bg-accent disabled:opacity-30" :disabled="compPage >= compTotalPages" @click="compPage++">
              <ChevronRight class="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
