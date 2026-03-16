<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'

const { t } = useI18n()

const props = defineProps<{
  matches: any[]
  tournamentState: any
  isAdmin: boolean
}>()

const emit = defineEmits<{
  'edit-match': [match: any]
}>()

const totalRounds = computed(() => props.tournamentState.totalRounds || 1)

const rounds = computed(() => {
  const r: Record<number, any[]> = {}
  for (let i = 1; i <= totalRounds.value; i++) r[i] = []
  for (const m of props.matches) {
    if (!r[m.round]) r[m.round] = []
    r[m.round].push(m)
  }
  // Sort each round by match_order
  for (const k in r) r[k].sort((a: any, b: any) => a.match_order - b.match_order)
  return r
})

function roundLabel(round: number) {
  const fromEnd = totalRounds.value - round
  if (fromEnd === 0) return t('finals')
  if (fromEnd === 1) return t('semiFinals')
  if (fromEnd === 2) return t('quarterFinals')
  return t('roundN', { n: round })
}

function teamName(match: any, slot: 1 | 2) {
  const name = slot === 1 ? match.team1_name : match.team2_name
  const id = slot === 1 ? match.team1_captain_id : match.team2_captain_id
  if (!id) return match.status === 'completed' ? t('bye') : t('tbd')
  return name || t('tbd')
}

function score(match: any, slot: 1 | 2) {
  const s = slot === 1 ? match.score1 : match.score2
  return s != null ? s : '-'
}

function isWinner(match: any, slot: 1 | 2) {
  const id = slot === 1 ? match.team1_captain_id : match.team2_captain_id
  return match.winner_captain_id && match.winner_captain_id === id
}

function statusClass(match: any) {
  if (match.status === 'completed') return 'border-l-green-500'
  if (match.status === 'live') return 'border-l-amber-500'
  return 'border-l-border'
}
</script>

<template>
  <div class="overflow-x-auto">
    <div class="flex gap-6 min-w-max py-4">
      <div v-for="round in totalRounds" :key="round" class="flex flex-col gap-2 min-w-[220px]">
        <!-- Round header -->
        <div class="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-center mb-2">
          {{ roundLabel(round) }}
        </div>

        <!-- Matches with spacing for bracket alignment -->
        <div class="flex flex-col flex-1 justify-around" :style="{ gap: `${Math.pow(2, round - 1) * 8}px` }">
          <div
            v-for="match in rounds[round]"
            :key="match.id"
            class="card border-l-4 overflow-hidden cursor-pointer hover:shadow-md transition-shadow"
            :class="statusClass(match)"
            @click="match.team1_captain_id && match.team2_captain_id ? emit('edit-match', match) : null"
          >
            <!-- Team 1 -->
            <div class="flex items-center justify-between px-3 py-2 border-b border-border/50"
              :class="isWinner(match, 1) ? 'bg-primary/10' : ''"
            >
              <div class="flex items-center gap-2 min-w-0">
                <img v-if="match.team1_banner || match.team1_avatar" :src="match.team1_banner || match.team1_avatar" class="w-5 h-5 object-cover" :class="match.team1_banner ? 'rounded' : 'rounded-full'" />
                <span class="text-sm truncate" :class="isWinner(match, 1) ? 'font-bold text-foreground' : 'text-foreground'">
                  {{ teamName(match, 1) }}
                </span>
              </div>
              <span class="text-sm font-bold ml-2" :class="isWinner(match, 1) ? 'text-primary' : 'text-muted-foreground'">
                {{ score(match, 1) }}
              </span>
            </div>
            <!-- Team 2 -->
            <div class="flex items-center justify-between px-3 py-2"
              :class="isWinner(match, 2) ? 'bg-primary/10' : ''"
            >
              <div class="flex items-center gap-2 min-w-0">
                <img v-if="match.team2_banner || match.team2_avatar" :src="match.team2_banner || match.team2_avatar" class="w-5 h-5 object-cover" :class="match.team2_banner ? 'rounded' : 'rounded-full'" />
                <span class="text-sm truncate" :class="isWinner(match, 2) ? 'font-bold text-foreground' : 'text-foreground'">
                  {{ teamName(match, 2) }}
                </span>
              </div>
              <span class="text-sm font-bold ml-2" :class="isWinner(match, 2) ? 'text-primary' : 'text-muted-foreground'">
                {{ score(match, 2) }}
              </span>
            </div>
            <!-- Status badge -->
            <div v-if="match.status === 'live'" class="px-3 py-1 bg-amber-500/10 text-center">
              <span class="text-[10px] font-bold text-amber-500 uppercase">{{ t('matchLive') }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Winner column -->
      <div v-if="matches.some(m => !m.next_match_id && m.winner_captain_id)" class="flex flex-col justify-center min-w-[160px]">
        <div class="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-center mb-2">
          {{ t('winner') }}
        </div>
        <div class="card p-4 text-center bg-primary/5 border-primary/20">
          <div class="text-lg font-bold text-primary">
            {{ matches.find(m => !m.next_match_id && m.winner_captain_id)?.winner_name || '' }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
