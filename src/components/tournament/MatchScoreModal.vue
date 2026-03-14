<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { EyeOff } from 'lucide-vue-next'
import ModalOverlay from '@/components/common/ModalOverlay.vue'

const { t } = useI18n()

const props = defineProps<{
  match: any
}>()

const emit = defineEmits<{
  close: []
  save: [data: any]
}>()

const bestOf = computed(() => props.match.best_of || 3)
const games = ref<{ game_number: number; winner_captain_id: number | null; dotabuff_id: string }[]>([])
const isHidden = ref(false)
const matchStatus = ref('pending')

onMounted(() => {
  isHidden.value = !!props.match.hidden
  matchStatus.value = props.match.status || 'pending'
  // Initialize games from existing data
  const existing = props.match.games || []
  for (let i = 1; i <= bestOf.value; i++) {
    const g = existing.find((e: any) => e.game_number === i)
    games.value.push({
      game_number: i,
      winner_captain_id: g?.winner_captain_id || null,
      dotabuff_id: g?.dotabuff_id || '',
    })
  }
})

const score1 = computed(() => games.value.filter(g => g.winner_captain_id === props.match.team1_captain_id).length)
const score2 = computed(() => games.value.filter(g => g.winner_captain_id === props.match.team2_captain_id).length)

function setGameWinner(idx: number, captainId: number | null) {
  const g = games.value[idx]
  g.winner_captain_id = g.winner_captain_id === captainId ? null : captainId
}

function save() {
  emit('save', {
    score1: score1.value,
    score2: score2.value,
    status: matchStatus.value,
    games: games.value.filter(g => g.winner_captain_id || g.dotabuff_id),
    hidden: isHidden.value,
  })
}
</script>

<template>
  <ModalOverlay :show="true" wide @close="emit('close')">
    <div class="border-b border-border px-7 py-6">
      <h2 class="text-xl font-semibold text-foreground">{{ t('matchScore') }}</h2>
      <div class="flex items-center gap-3 mt-2">
        <span class="text-sm font-medium text-foreground">{{ match.team1_name || t('tbd') }}</span>
        <span class="text-lg font-bold text-primary">{{ score1 }}</span>
        <span class="text-muted-foreground">:</span>
        <span class="text-lg font-bold text-primary">{{ score2 }}</span>
        <span class="text-sm font-medium text-foreground">{{ match.team2_name || t('tbd') }}</span>
      </div>
    </div>

    <div class="px-7 py-5 flex flex-col gap-4">
      <div v-for="(game, idx) in games" :key="idx" class="flex items-center gap-3 p-3 rounded-lg bg-accent/30">
        <span class="text-xs font-semibold text-muted-foreground w-16">{{ t('game') }} {{ game.game_number }}</span>

        <!-- Winner buttons -->
        <div class="flex gap-2 flex-1">
          <button
            class="flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
            :class="game.winner_captain_id === match.team1_captain_id
              ? 'bg-primary text-primary-foreground'
              : 'bg-accent text-foreground hover:bg-accent/80'"
            @click="setGameWinner(idx, match.team1_captain_id)"
          >{{ match.team1_name || 'Team 1' }}</button>
          <button
            class="flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
            :class="game.winner_captain_id === match.team2_captain_id
              ? 'bg-primary text-primary-foreground'
              : 'bg-accent text-foreground hover:bg-accent/80'"
            @click="setGameWinner(idx, match.team2_captain_id)"
          >{{ match.team2_name || 'Team 2' }}</button>
        </div>

        <!-- Dotabuff ID -->
        <input
          v-model="game.dotabuff_id"
          class="input-field !h-8 !text-xs w-36"
          :placeholder="t('dotabuffId')"
        />
      </div>
    </div>

    <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
      <div class="flex items-center gap-3">
        <label class="text-sm text-foreground font-medium">{{ t('statusCol') }}</label>
        <select class="input-field flex-1" v-model="matchStatus">
          <option value="pending">{{ t('matchPending') }}</option>
          <option value="live">{{ t('matchLive') }}</option>
          <option value="completed">{{ t('matchCompleted') }}</option>
        </select>
      </div>
      <label class="flex items-center gap-2 cursor-pointer py-1">
        <input type="checkbox" class="w-4 h-4 accent-primary" v-model="isHidden" />
        <EyeOff class="w-4 h-4 text-muted-foreground" />
        <span class="text-sm text-foreground">{{ t('hideMatch') }}</span>
        <span class="text-xs text-muted-foreground">{{ t('hideMatchHint') }}</span>
      </label>
      <button class="btn-primary w-full justify-center" @click="save">
        {{ t('updateScore') }}
      </button>
      <button class="btn-secondary w-full justify-center" @click="emit('close')">{{ t('cancel') }}</button>
    </div>
  </ModalOverlay>
</template>
