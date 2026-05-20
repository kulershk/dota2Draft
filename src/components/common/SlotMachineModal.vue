<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Coins, Loader2 } from 'lucide-vue-next'
import ModalOverlay from './ModalOverlay.vue'
import { useSlotMachine } from '@/composables/useSlotMachine'
import { useQueueStore } from '@/composables/useQueueStore'
import { useDraftStore } from '@/composables/useDraftStore'
import { useDotaConstants } from '@/composables/useDotaConstants'
import { useApi } from '@/composables/useApi'

interface SlotSymbol { key: string; heroId: number; name: string; three: number }

const { t } = useI18n()
const slots = useSlotMachine()
const queue = useQueueStore()
const store = useDraftStore()
const dota = useDotaConstants()
const api = useApi()

// Pixel height of one reel cell — vertical scrolling math is in px, so this is
// fixed rather than aspect-based.
const ITEM_H = 96
// Number of symbols each reel scrolls through before landing.
const STRIP_LEN = 28
// Staggered spin durations (seconds) so the reels stop left-to-right.
const DURATIONS = [1.5, 1.95, 2.4]
const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)'

const betTiers = ref<number[]>([10, 50, 100, 500])
const paytable = ref<SlotSymbol[]>([])
const consolationKey = ref('vengefulspirit')
const consolationMult = ref(2)
const configLoaded = ref(false)

const selectedBet = ref(10)
const spinning = ref(false)
const error = ref<string | null>(null)
const lastResult = ref<{ win: boolean; payout: number; net: number } | null>(null)

// Per-reel scroll state. Each reel renders a vertical strip translated by its
// offset; the visible window (ITEM_H tall) shows whichever item is at the top.
const DEFAULTS = ['vengefulspirit', 'invoker', 'meepo']
const currentSymbols = ref<string[]>([...DEFAULTS])
const reelStrips = ref<string[][]>(DEFAULTS.map(k => [k]))
const reelOffsets = ref<number[]>([0, 0, 0])
const reelTransitions = ref<string[]>(['none', 'none', 'none'])

const balance = computed(() => store.currentUser.value?.gcoins ?? 0)
const symbolKeys = computed(() => paytable.value.map(s => s.key))
const heroIdByKey = computed<Record<string, number>>(() => {
  const m: Record<string, number> = {}
  for (const s of paytable.value) m[s.key] = s.heroId
  return m
})
const heroNameByKey = computed<Record<string, string>>(() => {
  const m: Record<string, string> = {}
  for (const s of paytable.value) m[s.key] = s.name
  return m
})
const consolationHero = computed(() => paytable.value.find(s => s.key === consolationKey.value) || null)

function imgFor(key: string): string {
  const id = heroIdByKey.value[key]
  return id ? dota.heroImg(id) : ''
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
// Two rAFs guarantee the browser commits the transition:none reset before we
// apply the animated offset, so the scroll actually plays.
const nextFrame = () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())))
function randomKey(): string {
  const keys = symbolKeys.value
  if (!keys.length) return DEFAULTS[Math.floor(Math.random() * DEFAULTS.length)]
  return keys[Math.floor(Math.random() * keys.length)]
}

function resetReels() {
  reelStrips.value = currentSymbols.value.map(k => [k])
  reelOffsets.value = [0, 0, 0]
  reelTransitions.value = ['none', 'none', 'none']
}

async function loadConfig() {
  dota.loadConstants()
  if (configLoaded.value) return
  try {
    const cfg: any = await api.getSlotsConfig()
    if (Array.isArray(cfg?.betTiers) && cfg.betTiers.length) {
      betTiers.value = cfg.betTiers
      selectedBet.value = cfg.betTiers[0]
    }
    if (Array.isArray(cfg?.symbols)) paytable.value = cfg.symbols
    if (typeof cfg?.consolationKey === 'string') consolationKey.value = cfg.consolationKey
    if (typeof cfg?.consolationMult === 'number') consolationMult.value = cfg.consolationMult
    configLoaded.value = true
  } catch {
    // Leave defaults; the spin endpoint is still the source of truth.
  }
}

async function spin() {
  if (spinning.value) return
  const bet = selectedBet.value
  error.value = null
  lastResult.value = null
  if (balance.value < bet) { error.value = t('slotsNotEnough'); return }

  spinning.value = true

  // Build each reel: start on the currently shown symbol (continuity), scroll
  // through a run of randoms, land on a placeholder we overwrite once the
  // server result is in.
  const strips = currentSymbols.value.map((cur) => {
    const s = [cur]
    for (let k = 0; k < STRIP_LEN - 2; k++) s.push(randomKey())
    s.push(randomKey())
    return s
  })
  reelStrips.value = strips
  reelOffsets.value = [0, 0, 0]
  reelTransitions.value = ['none', 'none', 'none']
  await nextTick()

  let r: any
  try {
    r = await api.spinSlots(bet)
  } catch (e: any) {
    error.value = e?.message || t('slotsSpinFailed')
    resetReels()
    spinning.value = false
    return
  }

  // Land each reel on its real result.
  for (let i = 0; i < 3; i++) reelStrips.value[i][reelStrips.value[i].length - 1] = r.reels[i]

  await nextFrame()
  for (let i = 0; i < 3; i++) {
    reelTransitions.value[i] = `transform ${DURATIONS[i]}s ${EASE}`
    reelOffsets.value[i] = (reelStrips.value[i].length - 1) * ITEM_H
  }

  await sleep(DURATIONS[2] * 1000 + 140)

  currentSymbols.value = [...r.reels]
  resetReels()
  if (store.currentUser.value) store.currentUser.value.gcoins = r.balance
  lastResult.value = { win: !!r.win, payout: r.payout, net: r.net }
  spinning.value = false
}

function close() {
  if (spinning.value) return
  slots.closeSlots()
}

watch(() => slots.isOpen.value, (open) => {
  if (open) { resetReels(); loadConfig() }
})
// Slots are a queue-only feature: bail out the moment the player stops
// searching (match found, or left the queue).
watch(() => queue.inQueue.value, (inQ) => {
  if (!inQ && slots.isOpen.value) { spinning.value = false; resetReels(); slots.closeSlots() }
})

onUnmounted(() => { spinning.value = false })
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

      <!-- Reels: each is a fixed-height window over a vertically scrolling strip -->
      <div class="grid grid-cols-3 gap-3">
        <div
          v-for="(strip, i) in reelStrips" :key="i"
          class="relative rounded-xl overflow-hidden border-2 bg-[#0F172A]"
          :class="spinning ? 'border-primary/50' : 'border-border/60'"
          :style="{ height: ITEM_H + 'px' }"
        >
          <div
            class="will-change-transform"
            :style="{ transform: `translateY(-${reelOffsets[i]}px)`, transition: reelTransitions[i] }"
          >
            <div
              v-for="(key, idx) in strip" :key="idx"
              class="flex items-center justify-center"
              :style="{ height: ITEM_H + 'px' }"
              :title="heroNameByKey[key] || ''"
            >
              <img v-if="imgFor(key)" :src="imgFor(key)" :alt="heroNameByKey[key] || key" class="w-full h-full object-cover" />
              <span v-else class="text-[10px] text-muted-foreground text-center px-1">{{ heroNameByKey[key] || '…' }}</span>
            </div>
          </div>
          <!-- subtle top/bottom shading for depth -->
          <div class="pointer-events-none absolute inset-0" style="box-shadow: inset 0 8px 12px -8px #000, inset 0 -8px 12px -8px #000"></div>
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
        <div class="uppercase tracking-wide mb-2">{{ t('slotsPaytable') }}</div>
        <div class="grid grid-cols-2 gap-2">
          <div v-for="s in paytable" :key="s.key" class="flex items-center gap-2">
            <img v-if="imgFor(s.key)" :src="imgFor(s.key)" :alt="s.name" class="w-9 h-6 rounded object-cover shrink-0" />
            <span class="truncate text-foreground/80">{{ s.name }} ×3</span>
            <span class="font-mono font-bold text-amber-300 ml-auto">{{ s.three }}×</span>
          </div>
          <div v-if="consolationHero" class="flex items-center gap-2">
            <img v-if="imgFor(consolationHero.key)" :src="imgFor(consolationHero.key)" :alt="consolationHero.name" class="w-9 h-6 rounded object-cover shrink-0" />
            <span class="truncate text-foreground/80">{{ consolationHero.name }} ×2</span>
            <span class="font-mono font-bold text-amber-300 ml-auto">{{ consolationMult }}×</span>
          </div>
        </div>
      </div>
    </div>
  </ModalOverlay>
</template>
