<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Coins, Loader2 } from 'lucide-vue-next'
import ModalOverlay from './ModalOverlay.vue'
import { useSlotMachine } from '@/composables/useSlotMachine'
import { useQueueStore } from '@/composables/useQueueStore'
import { useDraftStore } from '@/composables/useDraftStore'
import { useApi } from '@/composables/useApi'

const { t } = useI18n()
const slots = useSlotMachine()
const queue = useQueueStore()
const store = useDraftStore()
const api = useApi()

const EMOJI: Record<string, string> = {
  cherry: '🍒', lemon: '🍋', bell: '🔔', star: '⭐', diamond: '💎', seven: '7️⃣',
}

const betTiers = ref<number[]>([10, 50, 100, 500])
const paytable = ref<{ key: string; three: number }[]>([])
const twoCherry = ref(2)
const configLoaded = ref(false)

const selectedBet = ref(10)
const displayReels = ref<string[]>(['cherry', 'lemon', 'bell'])
const spinning = ref(false)
const error = ref<string | null>(null)
const lastResult = ref<{ win: boolean; payout: number; net: number } | null>(null)

const balance = computed(() => store.currentUser.value?.gcoins ?? 0)
const symbolKeys = computed(() => paytable.value.map(s => s.key))

let cyclers: ReturnType<typeof setInterval>[] = []
function clearCyclers() { cyclers.forEach(clearInterval); cyclers = [] }
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
function randomKey(): string {
  const keys = symbolKeys.value.length ? symbolKeys.value : Object.keys(EMOJI)
  return keys[Math.floor(Math.random() * keys.length)]
}

async function loadConfig() {
  if (configLoaded.value) return
  try {
    const cfg: any = await api.getSlotsConfig()
    if (Array.isArray(cfg?.betTiers) && cfg.betTiers.length) {
      betTiers.value = cfg.betTiers
      selectedBet.value = cfg.betTiers[0]
    }
    if (Array.isArray(cfg?.symbols)) paytable.value = cfg.symbols
    if (typeof cfg?.twoCherry === 'number') twoCherry.value = cfg.twoCherry
    configLoaded.value = true
  } catch {
    // Fall back to the hardcoded defaults above.
  }
}

async function spin() {
  if (spinning.value) return
  const bet = selectedBet.value
  error.value = null
  lastResult.value = null
  if (balance.value < bet) { error.value = t('slotsNotEnough'); return }

  spinning.value = true
  clearCyclers()
  cyclers = [0, 1, 2].map(i => setInterval(() => { displayReels.value[i] = randomKey() }, 70))

  try {
    const r: any = await api.spinSlots(bet)
    // Stagger the reel stops for a classic slot feel.
    for (let i = 0; i < 3; i++) {
      await sleep(i === 0 ? 520 : 300)
      clearInterval(cyclers[i])
      displayReels.value[i] = r.reels[i]
    }
    if (store.currentUser.value) store.currentUser.value.gcoins = r.balance
    lastResult.value = { win: !!r.win, payout: r.payout, net: r.net }
  } catch (e: any) {
    clearCyclers()
    error.value = e?.message || t('slotsSpinFailed')
  } finally {
    cyclers = []
    spinning.value = false
  }
}

function close() {
  if (spinning.value) return
  slots.closeSlots()
}

// Load config the first time the modal opens.
watch(() => slots.isOpen.value, (open) => {
  if (open) loadConfig()
})
// Slots are a queue-only feature: bail out the moment the player stops
// searching (match found, or left the queue).
watch(() => queue.inQueue.value, (inQ) => {
  if (!inQ && slots.isOpen.value) { clearCyclers(); spinning.value = false; slots.closeSlots() }
})

onUnmounted(clearCyclers)
</script>

<template>
  <ModalOverlay :show="slots.isOpen.value" @close="close">
    <div class="p-6 flex flex-col gap-5">
      <div class="flex items-center justify-between pr-8">
        <h2 class="text-lg font-bold text-foreground">{{ t('slotsTitle') }}</h2>
        <div class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/10">
          <Coins class="w-4 h-4 text-amber-400" />
          <span class="text-sm font-bold font-mono tabular-nums text-amber-300">{{ balance.toLocaleString() }}</span>
          <span class="text-[11px] text-amber-400/70 font-semibold">{{ t('gcoins') }}</span>
        </div>
      </div>

      <!-- Reels -->
      <div class="grid grid-cols-3 gap-3">
        <div
          v-for="(sym, i) in displayReels" :key="i"
          class="aspect-square rounded-xl flex items-center justify-center text-5xl select-none border-2"
          :class="spinning ? 'border-primary/40 animate-pulse' : 'border-border/60'"
          style="background:#0F172A"
        >
          {{ EMOJI[sym] || '❔' }}
        </div>
      </div>

      <!-- Result banner -->
      <div class="h-8 flex items-center justify-center text-sm font-bold">
        <span v-if="error" class="text-destructive">{{ error }}</span>
        <span v-else-if="lastResult?.win" class="text-green-400">
          {{ t('slotsWon', { n: lastResult.payout.toLocaleString() }) }} (+{{ lastResult.net.toLocaleString() }})
        </span>
        <span v-else-if="lastResult && !lastResult.win" class="text-muted-foreground">
          {{ t('slotsNoWin') }}
        </span>
        <span v-else-if="spinning" class="text-primary flex items-center gap-2">
          <Loader2 class="w-4 h-4 animate-spin" /> {{ t('slotsSpinning') }}
        </span>
      </div>

      <!-- Bet tiers -->
      <div>
        <div class="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">{{ t('slotsBet') }}</div>
        <div class="grid grid-cols-4 gap-2">
          <button
            v-for="tier in betTiers" :key="tier"
            class="py-2 rounded-lg text-sm font-bold font-mono tabular-nums border-2 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            :class="selectedBet === tier
              ? 'border-primary bg-primary/15 text-primary'
              : 'border-border/60 text-foreground hover:border-primary/40'"
            :disabled="spinning || balance < tier"
            @click="selectedBet = tier"
          >
            {{ tier }}
          </button>
        </div>
      </div>

      <!-- Spin -->
      <button
        class="btn-primary w-full py-3 text-base font-extrabold disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        :disabled="spinning || balance < selectedBet"
        @click="spin"
      >
        <Loader2 v-if="spinning" class="w-5 h-5 animate-spin" />
        <span>{{ t('slotsSpin', { n: selectedBet }) }}</span>
      </button>

      <!-- Paytable -->
      <div v-if="paytable.length" class="text-[11px] text-muted-foreground">
        <div class="uppercase tracking-wide mb-1.5">{{ t('slotsPaytable') }}</div>
        <div class="grid grid-cols-3 gap-1.5">
          <div v-for="s in paytable" :key="s.key" class="flex items-center gap-1.5">
            <span class="text-base">{{ EMOJI[s.key] }}{{ EMOJI[s.key] }}{{ EMOJI[s.key] }}</span>
            <span class="font-mono font-bold text-foreground/80">{{ s.three }}×</span>
          </div>
          <div class="flex items-center gap-1.5">
            <span class="text-base">🍒🍒</span>
            <span class="font-mono font-bold text-foreground/80">{{ twoCherry }}×</span>
          </div>
        </div>
      </div>
    </div>
  </ModalOverlay>
</template>
