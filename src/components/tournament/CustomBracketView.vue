<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowRight } from 'lucide-vue-next'

const { t } = useI18n()

const props = defineProps<{
  stage: any
  matches: any[]
  captains: any[]
  isAdmin: boolean
}>()

const emit = defineEmits<{ 'edit-match': [match: any] }>()

function captainName(id: number | null): string {
  if (id == null) return t('tbd')
  const c = props.captains.find((x: any) => x.id === id)
  return c?.team || `#${id}`
}

// Group matches by `round` for column layout; matches without a round fall
// into round 1.
const rounds = computed(() => {
  const r: Record<number, any[]> = {}
  for (const m of props.matches) {
    const round = m.round || 1
    if (!r[round]) r[round] = []
    r[round].push(m)
  }
  for (const k in r) {
    r[k].sort((a: any, b: any) => (a.match_order || 0) - (b.match_order || 0) || a.id - b.id)
  }
  return r
})

const sortedRoundNumbers = computed(() =>
  Object.keys(rounds.value).map(Number).sort((a, b) => a - b)
)

function slotLabel(match: any, slot: 1 | 2): string {
  const captainId = slot === 1 ? match.team1_captain_id : match.team2_captain_id
  if (captainId) return captainName(captainId)
  for (const m of props.matches) {
    if (m.id === match.id) continue
    if (m.next_match_id === match.id && m.next_match_slot === slot) return `← W #${m.id}`
    if (m.loser_next_match_id === match.id && m.loser_next_match_slot === slot) return `← L #${m.id}`
  }
  return t('tbd')
}

function score(match: any, slot: 1 | 2): string {
  const s = slot === 1 ? match.score1 : match.score2
  return s != null ? String(s) : '-'
}

function isWinner(match: any, slot: 1 | 2): boolean {
  if (match.status !== 'completed' || !match.winner_captain_id) return false
  const id = slot === 1 ? match.team1_captain_id : match.team2_captain_id
  return id === match.winner_captain_id
}

function onMatchClick(match: any) {
  if (props.isAdmin) emit('edit-match', match)
}
</script>

<template>
  <div class="overflow-x-auto">
    <div class="flex gap-6 min-w-fit pb-4">
      <div v-for="round in sortedRoundNumbers" :key="round" class="flex flex-col gap-3 min-w-[260px]">
        <div class="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          {{ t('customBracketRound') }} {{ round }}
        </div>
        <div v-for="match in rounds[round]" :key="match.id"
          class="card p-3 transition-colors"
          :class="isAdmin ? 'cursor-pointer hover:bg-accent/30' : ''"
          @click="onMatchClick(match)">
          <div class="flex items-center gap-2 mb-2">
            <span class="text-[10px] font-mono text-muted-foreground">#{{ match.id }}</span>
            <span v-if="match.label" class="text-[10px] font-semibold text-primary bg-primary/10 px-1.5 py-0.5 rounded">{{ match.label }}</span>
            <span class="text-[10px] text-muted-foreground ml-auto">Bo{{ match.best_of }}</span>
          </div>
          <div class="flex flex-col gap-1">
            <div class="flex items-center gap-2 px-2 py-1.5 rounded"
              :class="isWinner(match, 1) ? 'bg-green-500/10' : 'bg-accent/40'">
              <span class="text-sm flex-1 truncate" :class="isWinner(match, 1) ? 'font-bold text-green-400' : ''">
                {{ slotLabel(match, 1) }}
              </span>
              <span class="text-sm font-mono tabular-nums" :class="isWinner(match, 1) ? 'text-green-400 font-bold' : 'text-muted-foreground'">
                {{ score(match, 1) }}
              </span>
            </div>
            <div class="flex items-center gap-2 px-2 py-1.5 rounded"
              :class="isWinner(match, 2) ? 'bg-green-500/10' : 'bg-accent/40'">
              <span class="text-sm flex-1 truncate" :class="isWinner(match, 2) ? 'font-bold text-green-400' : ''">
                {{ slotLabel(match, 2) }}
              </span>
              <span class="text-sm font-mono tabular-nums" :class="isWinner(match, 2) ? 'text-green-400 font-bold' : 'text-muted-foreground'">
                {{ score(match, 2) }}
              </span>
            </div>
          </div>
          <div v-if="match.next_match_id || match.loser_next_match_id" class="flex items-center gap-3 mt-2 text-[10px] text-muted-foreground">
            <template v-if="match.next_match_id">
              <ArrowRight class="w-3 h-3" />
              <span>W → #{{ match.next_match_id }} s{{ match.next_match_slot }}</span>
            </template>
            <template v-if="match.loser_next_match_id">
              <ArrowRight class="w-3 h-3" />
              <span>L → #{{ match.loser_next_match_id }} s{{ match.loser_next_match_slot }}</span>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
