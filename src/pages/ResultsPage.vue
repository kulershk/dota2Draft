<script setup lang="ts">
import { Trophy, Download, Shield } from 'lucide-vue-next'
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDraftStore } from '@/composables/useDraftStore'
import RoleBadge from '@/components/common/RoleBadge.vue'
import MmrDisplay from '@/components/common/MmrDisplay.vue'
import CaptainAvatar from '@/components/common/CaptainAvatar.vue'
import UserName from '@/components/common/UserName.vue'
import { sortedRoles } from '@/utils/roles'

interface TeamPlayer {
  id: number
  name: string
  roles: string[]
  mmr: number
  draft_price: number
  avatar_url?: string | null
  is_captain?: boolean
}

interface TeamResult {
  id: number
  name: string
  team: string
  budget: number
  status: string
  mmr: number
  banner_url?: string | null
  players: TeamPlayer[]
  game_wins?: number
  game_losses?: number
}

const { t } = useI18n()
const store = useDraftStore()
const results = ref<TeamResult[]>([])
const loading = ref(true)

watch(() => store.currentCompetitionId.value, async (compId) => {
  if (!compId) return
  loading.value = true
  try {
    const data = await store.getCompResults(compId)
    // Sort teams by average MMR descending
    results.value = [...data].sort((a: TeamResult, b: TeamResult) => {
      const avgA = a.players.length ? a.players.reduce((s: number, p: TeamPlayer) => s + p.mmr, 0) / a.players.length : a.mmr || 0
      const avgB = b.players.length ? b.players.reduce((s: number, p: TeamPlayer) => s + p.mmr, 0) / b.players.length : b.mmr || 0
      return avgB - avgA
    })
  } catch {
    results.value = store.captains.value.map(c => ({ ...c, players: [] }))
  } finally {
    loading.value = false
  }
}, { immediate: true })

function formatGold(amount: number) {
  return amount.toLocaleString() + 'g'
}

function totalSpent(team: TeamResult) {
  return team.players.reduce((sum, p) => sum + (p.draft_price || 0), 0)
}

</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[1200px] mx-auto w-full">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-semibold text-foreground">{{ t('teams') }}</h1>
        <p class="text-sm text-muted-foreground mt-1">{{ t('teamsSubtitle') }}</p>
      </div>
    </div>

    <div v-if="loading" class="text-center py-12 text-muted-foreground">{{ t('loadingResults') }}</div>

    <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-5">
      <div v-for="team in results" :key="team.id" class="card overflow-hidden">
        <div class="flex items-center border-b border-border">
          <!-- Team logo (1:1 square) -->
          <div class="shrink-0 w-24 aspect-square">
            <img v-if="team.banner_url" :src="team.banner_url" class="w-full h-full object-cover" />
            <div v-else class="w-full h-full bg-gradient-to-br from-primary/10 to-primary/5 flex items-center justify-center">
              <Trophy class="w-6 h-6 text-primary/30" />
            </div>
          </div>
          <!-- Team info -->
          <div class="flex items-center justify-between flex-1 px-4 py-3 min-w-0">
            <div class="min-w-0">
              <router-link :to="{ name: 'team-profile', params: { id: team.id } }" class="text-sm font-semibold text-foreground truncate block hover:text-primary transition-colors">{{ team.team }}</router-link>
              <p class="text-xs text-muted-foreground truncate">{{ t('captainLabel', { name: team.name }) }}</p>
            </div>
            <div class="flex items-center gap-4 shrink-0 ml-3">
              <div v-if="(team.game_wins || 0) + (team.game_losses || 0) > 0" class="text-center">
                <p class="text-sm font-bold text-foreground">
                  <span class="text-green-500">{{ team.game_wins || 0 }}</span>
                  <span class="text-muted-foreground">:</span>
                  <span class="text-red-500">{{ team.game_losses || 0 }}</span>
                </p>
                <p class="text-[10px] text-muted-foreground">W:L</p>
              </div>
              <div class="text-right">
                <p class="text-sm font-mono font-semibold text-foreground">{{ formatGold(team.budget) }}</p>
                <p class="text-xs text-muted-foreground">{{ t('remaining') }}</p>
              </div>
            </div>
          </div>
        </div>

        <div class="p-4">
          <div v-if="team.players.length === 0" class="text-xs text-muted-foreground py-2">
            {{ t('noDraftedYet') }}
          </div>
          <div v-else>
            <table class="w-full text-sm">
              <tbody>
                <tr v-for="player in team.players" :key="player.id" class="border-b border-foreground/10 last:border-0">
                  <td class="py-2 pr-2">
                    <div class="flex items-center gap-1.5">
                      <UserName :id="player.id" :name="player.name" :avatar-url="player.avatar_url" />
                      <Shield v-if="player.is_captain" class="w-3.5 h-3.5 text-amber-500 shrink-0" :title="t('captain')" />
                    </div>
                  </td>
                  <td class="py-2 px-2">
                    <div class="flex flex-wrap gap-1">
                      <RoleBadge v-for="role in sortedRoles(player.roles)" :key="role" :role="role" />
                    </div>
                  </td>
                  <td class="py-2 px-2 text-right">
                    <MmrDisplay :mmr="player.mmr" />
                  </td>
                  <td class="py-2 pl-2 text-right w-[60px]">
                    <span v-if="!player.is_captain" class="font-mono font-semibold text-primary">{{ player.draft_price }}g</span>
                    <span v-else class="text-[10px] text-amber-500 font-medium uppercase">{{ t('captain') }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <div class="flex justify-between pt-2 mt-2 text-xs text-muted-foreground border-t border-border">
              <span>{{ team.players.length }} players &bull; {{ t('avgMmr') }} {{ Math.round(team.players.reduce((s, p) => s + p.mmr, 0) / team.players.length).toLocaleString() }} MMR</span>
              <span>{{ t('totalSpent') }} <span class="font-semibold text-foreground">{{ formatGold(totalSpent(team)) }}</span></span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
