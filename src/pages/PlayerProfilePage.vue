<script setup lang="ts">
import { User, Trophy, Swords, ExternalLink, Tv, Calendar, Medal, MessageCircle, Shield } from 'lucide-vue-next'
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
            <h1 class="text-2xl font-bold text-foreground truncate">{{ profile.name }}</h1>
            <div class="flex flex-wrap items-center gap-2 mt-1.5">
              <div v-if="profile.roles?.length" class="flex flex-wrap gap-1">
                <RoleBadge v-for="role in sortedRoles(profile.roles)" :key="role" :role="role" />
              </div>
              <MmrDisplay v-if="profile.mmr" :mmr="profile.mmr" />
            </div>
            <div class="flex flex-wrap items-center gap-3 mt-2 text-xs text-muted-foreground">
              <span class="flex items-center gap-1">
                <Calendar class="w-3.5 h-3.5" />
                {{ t('memberSince') }} {{ formatDate(profile.created_at) }}
              </span>
              <a v-if="profile.steam_id"
                :href="`https://steamcommunity.com/profiles/${profile.steam_id}`"
                target="_blank" rel="noopener"
                class="flex items-center gap-1 hover:text-foreground transition-colors"
              >
                <ExternalLink class="w-3.5 h-3.5" />
                {{ t('steamProfile') }}
              </a>
              <a v-if="profile.steam_id"
                :href="`https://www.dotabuff.com/players/${BigInt(profile.steam_id) - 76561197960265728n}`"
                target="_blank" rel="noopener"
                class="flex items-center gap-1 hover:text-foreground transition-colors"
              >
                <ExternalLink class="w-3.5 h-3.5" />
                Dotabuff
              </a>
              <a v-if="profile.steam_id"
                :href="`https://www.opendota.com/players/${BigInt(profile.steam_id) - 76561197960265728n}`"
                target="_blank" rel="noopener"
                class="flex items-center gap-1 hover:text-foreground transition-colors"
              >
                <ExternalLink class="w-3.5 h-3.5" />
                OpenDota
              </a>
              <a v-if="profile.steam_id"
                :href="`https://stratz.com/players/${BigInt(profile.steam_id) - 76561197960265728n}`"
                target="_blank" rel="noopener"
                class="flex items-center gap-1 hover:text-foreground transition-colors"
              >
                <ExternalLink class="w-3.5 h-3.5" />
                Stratz
              </a>
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
