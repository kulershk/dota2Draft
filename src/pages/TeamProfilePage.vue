<script setup lang="ts">
import { Users, Trophy, Swords, ExternalLink, Calendar, Shield } from 'lucide-vue-next'
import { formatMatchDate } from '@/utils/format'
import { ref, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'
import RoleBadge from '@/components/common/RoleBadge.vue'
import RankBadge from '@/components/common/RankBadge.vue'
import MmrDisplay from '@/components/common/MmrDisplay.vue'
import UserName from '@/components/common/UserName.vue'
import { sortedRoles } from '@/utils/roles'

const { t } = useI18n()
const route = useRoute()
const api = useApi()

const captainId = computed(() => Number(route.params.id))
const profile = ref<any>(null)
const loading = ref(true)
const error = ref(false)

watch(captainId, async (id) => {
  if (!id) return
  loading.value = true
  error.value = false
  try {
    profile.value = await api.getTeamProfile(id)
  } catch {
    error.value = true
    profile.value = null
  } finally {
    loading.value = false
  }
}, { immediate: true })


const posLabel: Record<number, string> = { 1: 'Carry', 2: 'Mid', 3: 'Offlane', 4: 'Pos 4', 5: 'Pos 5' }
</script>

<template>
  <div class="p-4 md:p-8 flex flex-col gap-5 md:gap-6 max-w-[900px] mx-auto w-full">
    <div v-if="loading" class="text-center py-12 text-muted-foreground">{{ t('loading') }}</div>
    <div v-else-if="error" class="text-center py-12 text-muted-foreground">{{ t('teamNotFound') }}</div>

    <template v-else-if="profile">
      <!-- Team header -->
      <div class="card p-6">
        <div class="flex items-start gap-4">
          <div class="w-16 h-16 rounded-full bg-surface overflow-hidden shrink-0">
            <img v-if="profile.banner_url || profile.avatar_url" :src="profile.banner_url || profile.avatar_url" class="w-full h-full object-cover" />
            <div v-else class="w-full h-full flex items-center justify-center">
              <Shield class="w-8 h-8 text-primary" />
            </div>
          </div>
          <div class="flex-1 min-w-0">
            <h1 class="text-2xl font-bold text-foreground truncate">{{ profile.team }}</h1>
            <div class="flex flex-wrap items-center gap-3 mt-1.5 text-sm text-muted-foreground">
              <span class="flex items-center gap-1">
                <Trophy class="w-3.5 h-3.5" />
                {{ t('captainLabel') }}: {{ profile.captain_name }}
              </span>
              <router-link
                :to="{ name: 'comp-info', params: { compId: profile.competition_id } }"
                class="flex items-center gap-1 hover:text-foreground transition-colors"
              >
                <Swords class="w-3.5 h-3.5" />
                {{ profile.competition_name }}
              </router-link>
            </div>
            <!-- Stats -->
            <div class="flex items-center gap-4 mt-3">
              <div class="flex items-center gap-1.5 text-sm">
                <span class="font-mono font-bold text-green-500">{{ profile.stats.wins }}W</span>
                <span class="text-muted-foreground">/</span>
                <span v-if="profile.stats.draws" class="font-mono font-bold text-amber-500">{{ profile.stats.draws }}D</span>
                <span v-if="profile.stats.draws" class="text-muted-foreground">/</span>
                <span class="font-mono font-bold text-red-500">{{ profile.stats.losses }}L</span>
              </div>
              <span class="text-sm font-mono text-primary font-semibold">{{ profile.budget?.toLocaleString() }}g</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Roster -->
      <div class="card">
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Users class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">{{ t('roster') }} ({{ profile.roster.length }})</span>
        </div>
        <div v-if="profile.roster.length === 0" class="p-6 text-center text-sm text-muted-foreground">
          {{ t('noTeamMembers') }}
        </div>
        <div v-else class="divide-y divide-border">
          <div
            v-for="player in profile.roster" :key="player.player_id"
            class="flex items-center gap-3 px-4 py-3 hover:bg-accent/30 transition-colors"
          >
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <UserName :id="player.player_id" :name="player.name" :avatar-url="player.avatar_url" />
                <Shield v-if="player.is_captain" class="w-3.5 h-3.5 text-amber-500 shrink-0" />
                <span v-if="player.is_captain" class="text-[9px] font-bold text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded">{{ t('captainLabel') }}</span>
                <span v-if="player.playing_role" class="text-[9px] font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded">{{ posLabel[player.playing_role] || 'P' + player.playing_role }}</span>
              </div>
              <div class="flex items-center gap-2 mt-0.5">
                <div v-if="player.roles?.length" class="flex gap-0.5">
                  <RoleBadge v-for="role in sortedRoles(player.roles)" :key="role" :role="role" />
                </div>
                <span v-if="player.draft_price" class="text-xs font-mono text-primary">{{ player.draft_price }}g</span>
              </div>
            </div>
            <MmrDisplay v-if="player.mmr" :mmr="player.mmr" size="sm" />
          </div>
        </div>
      </div>

      <!-- Matches -->
      <div class="card">
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Swords class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">{{ t('matchHistory') }} ({{ profile.matches.length }})</span>
        </div>
        <div v-if="profile.matches.length === 0" class="p-6 text-center text-sm text-muted-foreground">
          {{ t('noMatches') }}
        </div>
        <div v-else class="divide-y divide-border">
          <router-link
            v-for="match in profile.matches" :key="match.id"
            :to="`/c/${profile.competition_id}/match/${match.id}`"
            class="flex items-center gap-3 px-4 py-3 hover:bg-accent/30 transition-colors"
          >
            <!-- Result indicator -->
            <div class="w-1.5 h-10 rounded-full shrink-0"
              :class="match.status !== 'completed' ? 'bg-muted-foreground/30' : match.won ? 'bg-green-500' : match.draw ? 'bg-amber-500' : 'bg-red-500'"
            ></div>
            <!-- Teams -->
            <div class="flex-1 min-w-0 flex items-center gap-3">
              <div class="flex items-center gap-2 flex-1 min-w-0" :class="match.is_team1 ? 'font-semibold' : ''">
                <div class="w-7 h-7 rounded-full bg-surface overflow-hidden shrink-0">
                  <img v-if="match.team1_banner || match.team1_avatar" :src="match.team1_banner || match.team1_avatar" class="w-full h-full object-cover" />
                </div>
                <span class="text-sm text-foreground truncate">{{ match.team1_name || t('tbd') }}</span>
              </div>
              <div class="flex flex-col items-center shrink-0 w-16">
                <span class="text-sm font-bold font-mono text-foreground">{{ match.score1 ?? 0 }} : {{ match.score2 ?? 0 }}</span>
                <span class="text-[9px] text-muted-foreground">BO{{ match.best_of }}</span>
              </div>
              <div class="flex items-center gap-2 flex-1 min-w-0 justify-end" :class="!match.is_team1 ? 'font-semibold' : ''">
                <span class="text-sm text-foreground truncate text-right">{{ match.team2_name || t('tbd') }}</span>
                <div class="w-7 h-7 rounded-full bg-surface overflow-hidden shrink-0">
                  <img v-if="match.team2_banner || match.team2_avatar" :src="match.team2_banner || match.team2_avatar" class="w-full h-full object-cover" />
                </div>
              </div>
            </div>
            <!-- Status / Date -->
            <div class="shrink-0 text-right w-24">
              <span v-if="match.status === 'live'" class="badge-success text-[10px]">LIVE</span>
              <span v-else-if="match.status === 'completed'" class="text-[10px] font-semibold" :class="match.won ? 'text-green-500' : match.draw ? 'text-amber-500' : 'text-red-500'">
                {{ match.won ? t('win') : match.draw ? t('draw') : t('loss') }}
              </span>
              <span v-else class="text-[10px] text-muted-foreground">{{ formatMatchDate(match.scheduled_at, t) }}</span>
              <div v-if="match.bracket" class="text-[9px] text-muted-foreground mt-0.5">{{ match.bracket }}</div>
            </div>
          </router-link>
        </div>
      </div>
    </template>
  </div>
</template>
