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

const ubRounds = computed(() => props.tournamentState.ubRounds || 1)
const lbTotalRounds = computed(() => props.tournamentState.lbTotalRounds || 1)

// Upper bracket matches (round 1..ubRounds)
const upperRounds = computed(() => {
  const r: Record<number, any[]> = {}
  for (let i = 1; i <= ubRounds.value; i++) r[i] = []
  for (const m of props.matches) {
    if (m.bracket === 'upper' && r[m.round]) {
      r[m.round].push(m)
    }
  }
  for (const k in r) r[k].sort((a: any, b: any) => a.match_order - b.match_order)
  return r
})

// Lower bracket matches (round stored as 100+lr)
const lowerRounds = computed(() => {
  const r: Record<number, any[]> = {}
  for (let i = 1; i <= lbTotalRounds.value; i++) r[i] = []
  for (const m of props.matches) {
    if (m.bracket === 'lower') {
      const lr = m.round - 100
      if (lr >= 1 && lr <= lbTotalRounds.value) {
        if (!r[lr]) r[lr] = []
        r[lr].push(m)
      }
    }
  }
  for (const k in r) r[k].sort((a: any, b: any) => a.match_order - b.match_order)
  return r
})

// Grand finals match (round 200)
const grandFinals = computed(() => {
  return props.matches.find(m => m.bracket === 'grand_finals') || null
})

function ubRoundLabel(round: number) {
  const fromEnd = ubRounds.value - round
  if (fromEnd === 0) return `${t('upperBracket')} ${t('finals')}`
  if (fromEnd === 1) return `${t('upperBracket')} ${t('semiFinals')}`
  if (fromEnd === 2) return `${t('upperBracket')} ${t('quarterFinals')}`
  return `${t('upperBracket')} ${t('roundN', { n: round })}`
}

function lbRoundLabel(round: number) {
  if (round === lbTotalRounds.value) return `${t('lowerBracket')} ${t('finals')}`
  return `${t('lowerBracket')} ${t('roundN', { n: round })}`
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
  <div class="flex flex-col gap-6">
    <!-- Upper Bracket -->
    <div>
      <h3 class="text-sm font-bold text-foreground uppercase tracking-wider mb-3 px-1">{{ t('upperBracket') }}</h3>
      <div class="overflow-x-auto">
        <div class="flex gap-6 min-w-max py-2">
          <div v-for="round in ubRounds" :key="round" class="flex flex-col gap-2 min-w-[220px]">
            <div class="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-center mb-2">
              {{ ubRoundLabel(round) }}
            </div>
            <div class="flex flex-col flex-1 justify-around" :style="{ gap: `${Math.pow(2, round - 1) * 8}px` }">
              <div
                v-for="match in upperRounds[round]"
                :key="match.id"
                class="card border-l-4 overflow-hidden cursor-pointer hover:shadow-md transition-shadow"
                :class="statusClass(match)"
                @click="isAdmin && match.team1_captain_id && match.team2_captain_id ? emit('edit-match', match) : null"
              >
                <div class="flex items-center justify-between px-3 py-2 border-b border-border/50"
                  :class="isWinner(match, 1) ? 'bg-primary/10' : ''">
                  <div class="flex items-center gap-2 min-w-0">
                    <img v-if="match.team1_avatar" :src="match.team1_avatar" class="w-5 h-5 rounded-full" />
                    <span class="text-sm truncate" :class="isWinner(match, 1) ? 'font-bold text-foreground' : 'text-foreground'">
                      {{ teamName(match, 1) }}
                    </span>
                  </div>
                  <span class="text-sm font-bold ml-2" :class="isWinner(match, 1) ? 'text-primary' : 'text-muted-foreground'">
                    {{ score(match, 1) }}
                  </span>
                </div>
                <div class="flex items-center justify-between px-3 py-2"
                  :class="isWinner(match, 2) ? 'bg-primary/10' : ''">
                  <div class="flex items-center gap-2 min-w-0">
                    <img v-if="match.team2_avatar" :src="match.team2_avatar" class="w-5 h-5 rounded-full" />
                    <span class="text-sm truncate" :class="isWinner(match, 2) ? 'font-bold text-foreground' : 'text-foreground'">
                      {{ teamName(match, 2) }}
                    </span>
                  </div>
                  <span class="text-sm font-bold ml-2" :class="isWinner(match, 2) ? 'text-primary' : 'text-muted-foreground'">
                    {{ score(match, 2) }}
                  </span>
                </div>
                <div v-if="match.status === 'live'" class="px-3 py-1 bg-amber-500/10 text-center">
                  <span class="text-[10px] font-bold text-amber-500 uppercase">{{ t('matchLive') }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Lower Bracket -->
    <div>
      <h3 class="text-sm font-bold text-foreground uppercase tracking-wider mb-3 px-1">{{ t('lowerBracket') }}</h3>
      <div class="overflow-x-auto">
        <div class="flex gap-6 min-w-max py-2">
          <div v-for="lr in lbTotalRounds" :key="lr" class="flex flex-col gap-2 min-w-[220px]">
            <div class="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-center mb-2">
              {{ lbRoundLabel(lr) }}
            </div>
            <div class="flex flex-col flex-1 justify-around" :style="{ gap: `${Math.max(Math.pow(2, Math.floor((lr - 1) / 2)) * 8, 8)}px` }">
              <div
                v-for="match in lowerRounds[lr]"
                :key="match.id"
                class="card border-l-4 overflow-hidden cursor-pointer hover:shadow-md transition-shadow"
                :class="statusClass(match)"
                @click="isAdmin && match.team1_captain_id && match.team2_captain_id ? emit('edit-match', match) : null"
              >
                <div class="flex items-center justify-between px-3 py-2 border-b border-border/50"
                  :class="isWinner(match, 1) ? 'bg-primary/10' : ''">
                  <div class="flex items-center gap-2 min-w-0">
                    <img v-if="match.team1_avatar" :src="match.team1_avatar" class="w-5 h-5 rounded-full" />
                    <span class="text-sm truncate" :class="isWinner(match, 1) ? 'font-bold text-foreground' : 'text-foreground'">
                      {{ teamName(match, 1) }}
                    </span>
                  </div>
                  <span class="text-sm font-bold ml-2" :class="isWinner(match, 1) ? 'text-primary' : 'text-muted-foreground'">
                    {{ score(match, 1) }}
                  </span>
                </div>
                <div class="flex items-center justify-between px-3 py-2"
                  :class="isWinner(match, 2) ? 'bg-primary/10' : ''">
                  <div class="flex items-center gap-2 min-w-0">
                    <img v-if="match.team2_avatar" :src="match.team2_avatar" class="w-5 h-5 rounded-full" />
                    <span class="text-sm truncate" :class="isWinner(match, 2) ? 'font-bold text-foreground' : 'text-foreground'">
                      {{ teamName(match, 2) }}
                    </span>
                  </div>
                  <span class="text-sm font-bold ml-2" :class="isWinner(match, 2) ? 'text-primary' : 'text-muted-foreground'">
                    {{ score(match, 2) }}
                  </span>
                </div>
                <div v-if="match.status === 'live'" class="px-3 py-1 bg-amber-500/10 text-center">
                  <span class="text-[10px] font-bold text-amber-500 uppercase">{{ t('matchLive') }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Grand Finals -->
    <div v-if="grandFinals">
      <h3 class="text-sm font-bold text-foreground uppercase tracking-wider mb-3 px-1">{{ t('grandFinals') }}</h3>
      <div class="max-w-[280px] mx-auto">
        <div
          class="card border-l-4 overflow-hidden cursor-pointer hover:shadow-md transition-shadow"
          :class="statusClass(grandFinals)"
          @click="isAdmin && grandFinals.team1_captain_id && grandFinals.team2_captain_id ? emit('edit-match', grandFinals) : null"
        >
          <div class="flex items-center justify-between px-3 py-2 border-b border-border/50"
            :class="isWinner(grandFinals, 1) ? 'bg-primary/10' : ''">
            <div class="flex items-center gap-2 min-w-0">
              <img v-if="grandFinals.team1_avatar" :src="grandFinals.team1_avatar" class="w-5 h-5 rounded-full" />
              <span class="text-xs text-muted-foreground mr-1">UB</span>
              <span class="text-sm truncate" :class="isWinner(grandFinals, 1) ? 'font-bold text-foreground' : 'text-foreground'">
                {{ teamName(grandFinals, 1) }}
              </span>
            </div>
            <span class="text-sm font-bold ml-2" :class="isWinner(grandFinals, 1) ? 'text-primary' : 'text-muted-foreground'">
              {{ score(grandFinals, 1) }}
            </span>
          </div>
          <div class="flex items-center justify-between px-3 py-2"
            :class="isWinner(grandFinals, 2) ? 'bg-primary/10' : ''">
            <div class="flex items-center gap-2 min-w-0">
              <img v-if="grandFinals.team2_avatar" :src="grandFinals.team2_avatar" class="w-5 h-5 rounded-full" />
              <span class="text-xs text-muted-foreground mr-1">LB</span>
              <span class="text-sm truncate" :class="isWinner(grandFinals, 2) ? 'font-bold text-foreground' : 'text-foreground'">
                {{ teamName(grandFinals, 2) }}
              </span>
            </div>
            <span class="text-sm font-bold ml-2" :class="isWinner(grandFinals, 2) ? 'text-primary' : 'text-muted-foreground'">
              {{ score(grandFinals, 2) }}
            </span>
          </div>
          <div v-if="grandFinals.status === 'live'" class="px-3 py-1 bg-amber-500/10 text-center">
            <span class="text-[10px] font-bold text-amber-500 uppercase">{{ t('matchLive') }}</span>
          </div>
        </div>
        <!-- Winner display -->
        <div v-if="grandFinals.winner_captain_id" class="mt-4 card p-4 text-center bg-primary/5 border-primary/20">
          <div class="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">{{ t('winner') }}</div>
          <div class="text-lg font-bold text-primary">
            {{ grandFinals.winner_name || '' }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
