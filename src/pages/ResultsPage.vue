<script setup lang="ts">
import { Trophy, Download } from 'lucide-vue-next'
import { ref, onMounted } from 'vue'
import { useDraftStore } from '@/composables/useDraftStore'

interface TeamResult {
  id: number
  name: string
  team: string
  budget: number
  status: string
  players: { id: number; name: string; roles: string[]; mmr: number; draft_price: number }[]
}

const store = useDraftStore()
const results = ref<TeamResult[]>([])
const loading = ref(true)

onMounted(async () => {
  try {
    results.value = await store.getResults()
  } catch {
    // fallback to captains list if no results
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

const roleColors: Record<string, string> = {
  Carry: 'bg-color-success text-color-success-foreground',
  Mid: 'bg-color-error text-color-error-foreground',
  Offlane: 'bg-color-info text-color-info-foreground',
  Support: 'bg-color-warning text-color-warning-foreground',
}
</script>

<template>
  <div class="p-8 px-10 flex flex-col gap-6">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-semibold text-foreground">Draft Results</h1>
        <p class="text-sm text-muted-foreground mt-1">Final team compositions from the auction draft</p>
      </div>
    </div>

    <div v-if="loading" class="text-center py-12 text-muted-foreground">Loading results...</div>

    <div v-else class="grid grid-cols-2 gap-5">
      <div v-for="team in results" :key="team.id" class="card">
        <div class="flex items-center justify-between px-4 py-3 border-b border-border">
          <div class="flex items-center gap-2.5">
            <div class="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-xs font-semibold text-secondary-foreground">
              {{ team.name.charAt(0) }}
            </div>
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
                <span v-for="role in player.roles" :key="role" class="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium" :class="roleColors[role]">{{ role }}</span>
              </div>
              <div class="flex items-center gap-3">
                <span class="text-xs font-mono text-muted-foreground">{{ player.mmr.toLocaleString() }} MMR</span>
                <span class="text-sm font-mono font-semibold text-primary">{{ player.draft_price }}g</span>
              </div>
            </div>
            <div class="flex justify-between pt-2 text-xs text-muted-foreground border-t border-border">
              <span>{{ team.players.length }} players</span>
              <span>Total spent: <span class="font-semibold text-foreground">{{ formatGold(totalSpent(team)) }}</span></span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
