<script setup lang="ts">
import { User, Trophy, Swords, Tv, Calendar, Medal, MessageCircle, Shield } from 'lucide-vue-next'
import { ref, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'
import { useDotaConstants } from '@/composables/useDotaConstants'
import RoleBadge from '@/components/common/RoleBadge.vue'
import MmrDisplay from '@/components/common/MmrDisplay.vue'
import { sortedRoles } from '@/utils/roles'
import { fmtDateOnly } from '@/utils/format'

const { t } = useI18n()
const route = useRoute()
const api = useApi()
const dota = useDotaConstants()

dota.loadConstants()

const playerId = computed(() => Number(route.params.id))
const profile = ref<any>(null)
const loading = ref(true)
const error = ref(false)

watch(playerId, async (id) => {
  if (!id) return
  loading.value = true
  error.value = false
  try {
    profile.value = await api.getPlayerProfile(id)
  } catch {
    error.value = true
    profile.value = null
  } finally {
    loading.value = false
  }
}, { immediate: true })

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
      <!-- Player header -->
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
                  <div v-if="profile.roles?.length" class="flex flex-wrap gap-1">
                    <RoleBadge v-for="role in sortedRoles(profile.roles)" :key="role" :role="role" />
                  </div>
                  <MmrDisplay v-if="profile.mmr" :mmr="profile.mmr" />
                </div>
              </div>
              <!-- External links -->
              <div v-if="profile.steam_id" class="flex items-center gap-1.5 shrink-0">
                <a :href="`https://steamcommunity.com/profiles/${profile.steam_id}`"
                  target="_blank" rel="noopener"
                  class="w-8 h-8 rounded-lg bg-accent flex items-center justify-center hover:bg-accent/70 transition-colors"
                  title="Steam"
                >
                  <svg class="w-4 h-4 text-muted-foreground" viewBox="0 0 24 24" fill="currentColor"><path d="M11.979 0C5.678 0 .511 4.86.022 10.94l6.432 2.658a3.387 3.387 0 0 1 1.912-.588c.063 0 .125.002.188.006l2.861-4.142V8.77c0-2.427 1.975-4.402 4.402-4.402 2.427 0 4.402 1.975 4.402 4.402 0 2.427-1.975 4.402-4.402 4.402h-.103l-4.077 2.911c0 .052.003.104.003.157 0 1.82-1.48 3.3-3.3 3.3-1.62 0-2.97-1.17-3.25-2.71L.636 14.352C1.985 19.71 6.767 23.73 12.479 23.73c6.627 0 12-5.373 12-12s-5.373-12-12-12h-.5zM7.54 18.21l-1.473-.61c.262.543.714.985 1.3 1.2a2.476 2.476 0 0 0 3.227-1.395 2.46 2.46 0 0 0-.003-1.893 2.466 2.466 0 0 0-1.313-1.329 2.477 2.477 0 0 0-1.81-.063l1.522.63a1.82 1.82 0 0 1-.67 3.51 1.82 1.82 0 0 1-.78-.05zm8.277-6.03a2.935 2.935 0 0 1-2.934-2.934 2.935 2.935 0 0 1 2.934-2.934 2.935 2.935 0 0 1 2.934 2.934 2.935 2.935 0 0 1-2.934 2.934zm-.001-5.137a2.2 2.2 0 0 0-2.198 2.198 2.2 2.2 0 0 0 2.198 2.198 2.2 2.2 0 0 0 2.198-2.198 2.2 2.2 0 0 0-2.198-2.198z"/></svg>
                </a>
                <a :href="`https://www.dotabuff.com/players/${BigInt(profile.steam_id) - 76561197960265728n}`"
                  target="_blank" rel="noopener"
                  class="w-8 h-8 rounded-lg bg-accent flex items-center justify-center hover:bg-accent/70 transition-colors"
                  title="Dotabuff"
                >
                  <svg class="w-4 h-4 text-muted-foreground" viewBox="0 0 24 24" fill="currentColor"><path d="M2.88 9.6 0 12l2.88 2.4V9.6zm5.28-4.8L3.84 8.4v7.2l4.32 3.6V4.8zm5.28-4.8L9.12 3.6v16.8l4.32 3.6V0zm5.28 4.8-4.32 3.6v7.2l4.32 3.6V4.8zM24 9.6l-2.88 2.4L24 14.4V9.6z"/></svg>
                </a>
                <a :href="`https://www.opendota.com/players/${BigInt(profile.steam_id) - 76561197960265728n}`"
                  target="_blank" rel="noopener"
                  class="w-8 h-8 rounded-lg bg-accent flex items-center justify-center hover:bg-accent/70 transition-colors"
                  title="OpenDota"
                >
                  <svg class="w-4 h-4 text-muted-foreground" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm0 2a10 10 0 0 1 10 10 10 10 0 0 1-10 10A10 10 0 0 1 2 12 10 10 0 0 1 12 2zm0 3a7 7 0 0 0-7 7 7 7 0 0 0 7 7 7 7 0 0 0 7-7 7 7 0 0 0-7-7zm0 2.5a4.5 4.5 0 0 1 4.5 4.5 4.5 4.5 0 0 1-4.5 4.5A4.5 4.5 0 0 1 7.5 12 4.5 4.5 0 0 1 12 7.5z"/></svg>
                </a>
                <a :href="`https://stratz.com/players/${BigInt(profile.steam_id) - 76561197960265728n}`"
                  target="_blank" rel="noopener"
                  class="w-8 h-8 rounded-lg bg-accent flex items-center justify-center hover:bg-accent/70 transition-colors"
                  title="Stratz"
                >
                  <svg class="w-4 h-4 text-muted-foreground" viewBox="0 0 24 24" fill="currentColor"><path d="M3.5 0L0 7h7L3.5 0zM12 0L8.5 7h7L12 0zM20.5 0L17 7h7l-3.5-7zM3.5 8.5L0 15.5h7l-3.5-7zM12 8.5l-3.5 7h7l-3.5-7zM20.5 8.5l-3.5 7h7l-3.5-7zM12 17l-3.5 7h7l-3.5-7z"/></svg>
                </a>
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-3 mt-2 text-xs text-muted-foreground">
              <span class="flex items-center gap-1">
                <Calendar class="w-3.5 h-3.5" />
                {{ t('memberSince') }} {{ formatDate(profile.created_at) }}
              </span>
            </div>
            <p v-if="profile.info" class="text-sm text-muted-foreground mt-2">{{ profile.info }}</p>
          </div>
        </div>

        <!-- Twitch -->
        <div v-if="profile.twitch_username" class="mt-4 flex items-center gap-3 p-3 rounded-lg bg-[#9146FF]/10 border border-[#9146FF]/20">
          <Tv class="w-5 h-5 text-[#9146FF] shrink-0" />
          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium text-foreground truncate">{{ profile.twitch_username }}</p>
            <p class="text-xs text-muted-foreground">{{ t('twitchLinked') }}</p>
          </div>
          <a
            :href="`https://twitch.tv/${profile.twitch_username}`"
            target="_blank" rel="noopener"
            class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium bg-[#9146FF] text-white hover:bg-[#7c3aed] transition-colors"
          >{{ t('watchStream') }}</a>
        </div>

        <!-- Discord -->
        <div v-if="profile.discord_username" class="mt-4 flex items-center gap-3 p-3 rounded-lg bg-[#5865F2]/10 border border-[#5865F2]/20">
          <MessageCircle class="w-5 h-5 text-[#5865F2] shrink-0" />
          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium text-foreground truncate">{{ profile.discord_username }}</p>
            <p class="text-xs text-muted-foreground">{{ t('discordLinked') }}</p>
          </div>
        </div>
      </div>

      <!-- Top heroes -->
      <div v-if="profile.top_heroes?.length" class="card">
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Shield class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">{{ t('topHeroes') }}</span>
        </div>
        <div class="p-4 flex gap-4">
          <div v-for="hero in profile.top_heroes" :key="hero.hero_id" class="flex items-center gap-3 flex-1 p-3 rounded-lg bg-accent/50 border border-border/50">
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

      <!-- Competition history -->
      <div class="card">
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Swords class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">{{ t('competitionHistory') }} ({{ profile.competitions.length }})</span>
        </div>
        <div v-if="profile.competitions.length === 0" class="p-6 text-center text-sm text-muted-foreground">
          {{ t('noCompetitions') }}
        </div>
        <div v-else class="divide-y divide-border">
          <div v-for="comp in profile.competitions" :key="comp.competition_id" class="flex items-center gap-3 px-4 py-3">
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
            <div class="flex items-center gap-2 shrink-0">
              <div v-if="comp.roles?.length" class="flex gap-0.5">
                <RoleBadge v-for="role in sortedRoles(comp.roles)" :key="role" :role="role" />
              </div>
              <MmrDisplay v-if="comp.mmr" :mmr="comp.mmr" size="sm" />
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
