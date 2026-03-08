<script setup lang="ts">
import { Trophy, Download } from 'lucide-vue-next'
import { ref, onMounted } from 'vue'
import { useDraftStore } from '@/composables/useDraftStore'
import RoleBadge from '@/components/common/RoleBadge.vue'
import MmrDisplay from '@/components/common/MmrDisplay.vue'
import CaptainAvatar from '@/components/common/CaptainAvatar.vue'
import { sortedRoles } from '@/utils/roles'

interface TeamResult {
  id: number
  name: string
  team: string
  budget: number
  status: string
  mmr: number
  banner_url?: string | null
  players: { id: number; name: string; roles: string[]; mmr: number; draft_price: number }[]
}

const store = useDraftStore()
const results = ref<TeamResult[]>([])
const loading = ref(true)

onMounted(async () => {
  try {
    const compId = store.currentCompetitionId.value
    if (compId) {
      results.value = await store.getCompResults(compId)
    } else {
      results.value = store.captains.value.map(c => ({ ...c, players: [] }))
    }
  } catch {
    results.value = store.captains.value.map(c => ({ ...c, players: [] }))
  } finally {
    loading.value = false
  }
})

function formatGold(amount: number) {
  return amount.toLocaleString() + 'g'
}

function totalSpent(team: TeamResult) {
  return team.players.reduce((sum, p) => sum + (p.draft_price || 0), 0)
}

</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[1440px] mx-auto w-full">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-semibold text-foreground">Draft Results</h1>
        <p class="text-sm text-muted-foreground mt-1">Final team compositions from the auction draft</p>
      </div>
    </div>

    <div v-if="loading" class="text-center py-12 text-muted-foreground">Loading results...</div>

    <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-5">
      <div v-for="team in results" :key="team.id" class="card overflow-hidden">
        <img v-if="team.banner_url" :src="team.banner_url" class="w-full h-20 object-cover" />
        <div class="flex items-center justify-between px-4 py-3 border-b border-border">
          <div class="flex items-center gap-2.5">
            <CaptainAvatar :name="team.name" />
            <div>
              <p class="text-sm font-semibold text-foreground">{{ team.team }}</p>
              <p class="text-xs text-muted-foreground">Captain: {{ team.name }}</p>
            </div>
          </div>
          <div class="text-right">
            <p class="text-sm font-mono font-semibold text-foreground">{{ formatGold(team.budget) }}</p>
            <p class="text-xs text-muted-foreground">remaining</p>
          </div>
        </div>

        <div class="p-4">
          <div v-if="team.players.length === 0" class="text-xs text-muted-foreground py-2">
            No players drafted yet.
          </div>
          <div v-else class="flex flex-col gap-2">
            <div v-for="player in team.players" :key="player.id" class="flex items-center justify-between py-1.5 border-b border-border last:border-0">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium text-foreground">{{ player.name }}</span>
                <div class="flex flex-wrap gap-1">
                  <RoleBadge v-for="role in sortedRoles(player.roles)" :key="role" :role="role" />
                </div>
              </div>
              <div class="flex items-center gap-3">
                <MmrDisplay :mmr="player.mmr" />
                <span class="text-sm font-mono font-semibold text-primary">{{ player.draft_price }}g</span>
              </div>
            </div>
            <div class="flex justify-between pt-2 text-xs text-muted-foreground border-t border-border">
              <span>{{ team.players.length }} players &bull; avg {{ Math.round(((team.mmr || 0) + team.players.reduce((s, p) => s + p.mmr, 0)) / (1 + team.players.length)).toLocaleString() }} MMR</span>
              <span>Total spent: <span class="font-semibold text-foreground">{{ formatGold(totalSpent(team)) }}</span></span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
