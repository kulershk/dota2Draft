<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Coins, Loader2, Sparkles } from 'lucide-vue-next'
import ModalOverlay from './ModalOverlay.vue'
import { useSlotMachine } from '@/composables/useSlotMachine'
import { useQueueStore } from '@/composables/useQueueStore'
import { useDraftStore } from '@/composables/useDraftStore'
import { useDotaConstants } from '@/composables/useDotaConstants'
import { useApi } from '@/composables/useApi'

interface SlotSymbol { key: string; heroId: number; tier: string; pay: Record<string, number> }

const { t } = useI18n()
const slots = useSlotMachine()
const queue = useQueueStore()
const store = useDraftStore()
const dota = useDotaConstants()
const api = useApi()

const AEGIS = 'aegis'
const REELS = 5
const ROWS = 3
const ITEM_H = 76                                  // px per cell; reel window = 3×
const STRIP_LEN = 24                               // random fillers per reel while spinning
const DURATIONS = [1.0, 1.2, 1.4, 1.6, 1.8]        // staggered left→right stop
const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)'
const FALLBACK_KEYS = ['meepo', 'invoker', 'broodmother', 'legion_commander', 'lina', 'vengefulspirit', 'pudge', 'juggernaut']

// ── config ──
const betTiers = ref<number[]>([10, 50, 100, 500])
const paytable = ref<SlotSymbol[]>([])
const aegisCfg = ref<{ itemId: number; name: string; scatter: Record<string, number>; freeSpins: number }>({ itemId: 117, name: 'Aegis of the Immortal', scatter: { 3: 2, 4: 5, 5: 20 }, freeSpins: 10 })
const gambleCfg = ref<{ maxSteps: number; maxAmount: number }>({ maxSteps: 5, maxAmount: 1_000_000 })
const lines = ref(10)
const configLoaded = ref(false)

const selectedBet = ref(10)
const lineStake = computed(() => Math.floor(selectedBet.value / lines.value))
const spinning = ref(false)
const bonusPlaying = ref(false)
const skipBonus = ref(false)
const error = ref<string | null>(null)

// ── grid + reel animation state ──
const grid = ref<string[][]>(makeRandomGrid())   // grid[reel][row]
const reelStrips = ref<string[][]>(grid.value.map(c => [...c]))
const reelOffsets = ref<number[]>(Array(REELS).fill(0))
const reelTransitions = ref<string[]>(Array(REELS).fill('none'))
const showHighlights = ref(false)
const highlightCells = ref<Set<string>>(new Set())
const scatterCells = ref<Set<string>>(new Set())
const expandedReelSet = ref<Set<number>>(new Set())

// ── result + bonus + gamble ──
const lastWin = ref<{ total: number; bonus: boolean } | null>(null)
const bonusState = ref<{ special: string; total: number; index: number; count: number } | null>(null)
const pendingWin = ref(0)
const gamble = ref<{ steps: number; canGamble: boolean; flipping: boolean; card: string | null; result: string | null }>({ steps: 0, canGamble: false, flipping: false, card: null, result: null })
const collected = ref<number | null>(null)

// Auto-spin: spins repeatedly and banks each win (never gambles). -1 = ∞.
const AUTO_PRESETS = [10, 25, 50, -1]
const autoCount = ref(25)
const autoSpinning = ref(false)
const autoRemaining = ref(0)

const balance = computed(() => store.currentUser.value?.gcoins ?? 0)
const busy = computed(() => spinning.value || bonusPlaying.value)
const symbolKeys = computed(() => [...paytable.value.map(s => s.key), AEGIS])
const heroIdByKey = computed<Record<string, number>>(() => {
  const m: Record<string, number> = {}
  for (const s of paytable.value) m[s.key] = s.heroId
  return m
})

function makeRandomGrid(): string[][] {
  // Heroes only (no Aegis) for the idle/pre-config grid. Uses `paytable`
  // (declared above) — never `symbolKeys`, which is declared later and would be
  // in the temporal dead zone when this runs during the `grid` ref init.
  const pool = paytable.value.length ? paytable.value.map(s => s.key) : FALLBACK_KEYS
  const g: string[][] = []
  for (let r = 0; r < REELS; r++) g.push([rand(pool), rand(pool), rand(pool)])
  return g
}
function rand<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)] }
function randomKey(): string {
  const keys = symbolKeys.value.length ? symbolKeys.value : FALLBACK_KEYS
  return keys[Math.floor(Math.random() * keys.length)]
}

function imgFor(key: string): string {
  if (key === AEGIS) return dota.itemImg(aegisCfg.value.itemId)
  const id = heroIdByKey.value[key]
  return id ? dota.heroImg(id) : ''
}
function nameFor(key: string): string {
  if (key === AEGIS) return aegisCfg.value.name
  return dota.heroName(heroIdByKey.value[key]) || key
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const nextFrame = () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())))

function resetReels() {
  reelStrips.value = grid.value.map(c => [...c])
  reelOffsets.value = Array(REELS).fill(0)
  reelTransitions.value = Array(REELS).fill('none')
}
function clearHighlights() {
  showHighlights.value = false
  highlightCells.value = new Set()
  scatterCells.value = new Set()
  expandedReelSet.value = new Set()
}

async function loadConfig() {
  dota.loadConstants()
  if (configLoaded.value) return
  try {
    const cfg: any = await api.getSlotsConfig()
    if (Array.isArray(cfg?.betTiers) && cfg.betTiers.length) { betTiers.value = cfg.betTiers; selectedBet.value = cfg.betTiers[0] }
    if (typeof cfg?.lines === 'number') lines.value = cfg.lines
    if (Array.isArray(cfg?.symbols)) paytable.value = cfg.symbols
    if (cfg?.aegis) aegisCfg.value = cfg.aegis
    if (cfg?.gamble) gambleCfg.value = cfg.gamble
    configLoaded.value = true
    grid.value = makeRandomGrid()
    resetReels()
  } catch {
    // Leave defaults; the spin endpoint is the source of truth.
  }
}

// Animate every reel from the current grid to `resultGrid` (5 cols × 3 rows),
// landing the result in the visible window, then collapse strips so cells map
// 1:1 to rows for highlighting.
async function animateReels(resultGrid: string[][]) {
  clearHighlights()
  const strips: string[][] = []
  for (let i = 0; i < REELS; i++) {
    const s = [...grid.value[i]]
    for (let k = 0; k < STRIP_LEN; k++) s.push(randomKey())
    s.push(resultGrid[i][0], resultGrid[i][1], resultGrid[i][2])
    strips.push(s)
  }
  reelStrips.value = strips
  reelOffsets.value = Array(REELS).fill(0)
  reelTransitions.value = Array(REELS).fill('none')
  await nextTick()
  await nextFrame()
  for (let i = 0; i < REELS; i++) {
    reelTransitions.value[i] = `transform ${DURATIONS[i]}s ${EASE}`
    reelOffsets.value[i] = (strips[i].length - ROWS) * ITEM_H
  }
  await sleep(DURATIONS[REELS - 1] * 1000 + 120)
  grid.value = resultGrid.map(c => [...c])
  resetReels()
}

function applyHighlights(lineWins: any[], scatter: any, expandedSpecial: string | null) {
  const hl = new Set<string>()
  const sc = new Set<string>()
  const exp = new Set<number>()
  for (const w of (lineWins || [])) for (const c of w.cells) hl.add(`${c.reel},${c.row}`)
  for (const p of (scatter?.positions || [])) sc.add(`${p.reel},${p.row}`)
  if (expandedSpecial) {
    for (let reel = 0; reel < REELS; reel++) if (grid.value[reel].includes(expandedSpecial)) exp.add(reel)
  }
  highlightCells.value = hl
  scatterCells.value = sc
  expandedReelSet.value = exp
  showHighlights.value = true
}

async function spin() {
  if (busy.value || pendingWin.value > 0) return
  const bet = selectedBet.value
  error.value = null
  lastWin.value = null
  collected.value = null
  if (balance.value < bet) { error.value = t('slotsNotEnough'); return }

  spinning.value = true
  let r: any
  try {
    r = await api.spinSlots(bet)
  } catch (e: any) {
    error.value = e?.message || t('slotsSpinFailed')
    resetReels()
    spinning.value = false
    return
  }

  await animateReels(r.grid)
  applyHighlights(r.lineWins, r.scatter, null)
  if (store.currentUser.value) store.currentUser.value.gcoins = r.balance
  lastWin.value = { total: r.totalWin, bonus: !!r.bonus }

  if (r.bonus) {
    await playBonus(r.bonus)
  }

  pendingWin.value = r.pendingWin || 0
  gamble.value = { steps: 0, canGamble: !!r.canGamble, flipping: false, card: null, result: null }
  spinning.value = false
}

async function playBonus(bonus: any) {
  bonusPlaying.value = true
  skipBonus.value = false
  bonusState.value = { special: bonus.specialSymbol, total: 0, index: 0, count: bonus.spins.length }
  await sleep(1500) // intro: reveal the expanding symbol
  for (let i = 0; i < bonus.spins.length; i++) {
    if (skipBonus.value) break
    const sp = bonus.spins[i]
    bonusState.value = { ...bonusState.value!, index: i + 1 }
    await animateReels(sp.grid)
    applyHighlights(sp.lineWins, sp.scatter, sp.expanded ? bonus.specialSymbol : null)
    bonusState.value = { ...bonusState.value!, total: bonusState.value!.total + sp.spinPay }
    await sleep(sp.retrigger ? 1500 : 1050)
  }
  if (skipBonus.value && bonus.spins.length) {
    const last = bonus.spins[bonus.spins.length - 1]
    grid.value = last.grid.map((c: string[]) => [...c])
    resetReels()
    applyHighlights(last.lineWins, last.scatter, last.expanded ? bonus.specialSymbol : null)
    bonusState.value = { ...bonusState.value!, index: bonus.spins.length, total: bonus.totalBonusPayout }
    await sleep(300)
  }
  bonusPlaying.value = false
}

async function doGamble(guess: 'red' | 'black') {
  if (gamble.value.flipping || pendingWin.value <= 0 || !gamble.value.canGamble) return
  gamble.value = { ...gamble.value, flipping: true, card: null, result: null }
  try {
    const r: any = await api.gambleSlots(guess)
    // Reveal the drawn card; keep flipping=true so all buttons stay locked
    // during the reveal window.
    gamble.value = { ...gamble.value, card: r.card, result: r.result, canGamble: false }
    await sleep(r.result === 'win' ? 750 : 950)
    if (r.result === 'win') {
      pendingWin.value = r.amount
      gamble.value = { steps: r.steps, canGamble: !!r.canGamble, flipping: false, card: r.card, result: 'win' }
    } else {
      // Win is gone server-side; hide the panel only after the loss is seen.
      pendingWin.value = 0
      lastWin.value = null
      gamble.value = { steps: gamble.value.steps, canGamble: false, flipping: false, card: r.card, result: 'lose' }
    }
  } catch (e: any) {
    error.value = e?.message || t('slotsSpinFailed')
    gamble.value = { ...gamble.value, flipping: false }
  }
}

async function doCollect() {
  if (gamble.value.flipping || pendingWin.value <= 0) return
  const amt = pendingWin.value
  try {
    const r: any = await api.collectSlots()
    if (store.currentUser.value) store.currentUser.value.gcoins = r.balance
    collected.value = r.collected ?? amt
  } catch {
    // best-effort; queue hooks will bank it server-side as a backstop
  }
  pendingWin.value = 0
  gamble.value = { steps: 0, canGamble: false, flipping: false, card: null, result: null }
}

function stopAuto() { autoSpinning.value = false; autoRemaining.value = 0 }

// Auto-spin loop: spins, banks each win immediately (auto-collect — never
// gambles), and stops on count exhausted / Stop / not enough gcoins / spin
// error / leaving the queue.
async function startAuto() {
  if (autoSpinning.value || busy.value || pendingWin.value > 0) return
  autoSpinning.value = true
  autoRemaining.value = autoCount.value // -1 = infinite
  try {
    while (autoSpinning.value && queue.inQueue.value) {
      if (autoRemaining.value === 0) break
      if (balance.value < selectedBet.value) { error.value = t('slotsNotEnough'); break }
      error.value = null
      await spin()
      if (error.value) break
      if (pendingWin.value > 0) await doCollect() // bank the win, keep going
      if (autoRemaining.value > 0) autoRemaining.value--
      if (!autoSpinning.value) break
      await sleep(450)
    }
  } finally {
    stopAuto()
  }
}

// Bank any pending win when leaving (best-effort; server also auto-collects).
async function settleOnExit() {
  if (pendingWin.value > 0) {
    try { const r: any = await api.collectSlots(); if (store.currentUser.value) store.currentUser.value.gcoins = r.balance } catch {}
    pendingWin.value = 0
  }
}

function close() {
  if (busy.value || gamble.value.flipping) return
  stopAuto()
  settleOnExit()
  slots.closeSlots()
}

watch(() => slots.isOpen.value, (open) => {
  if (open) { stopAuto(); clearHighlights(); resetReels(); loadConfig() }
})
// Queue-only: when the player stops searching, settle and close.
watch(() => queue.inQueue.value, (inQ) => {
  if (!inQ && slots.isOpen.value) {
    stopAuto()
    skipBonus.value = true
    settleOnExit()
    spinning.value = false
    bonusPlaying.value = false
    slots.closeSlots()
  }
})

onUnmounted(() => { stopAuto(); skipBonus.value = true; settleOnExit() })
</script>

<template>
  <ModalOverlay :show="slots.isOpen.value" wide @close="close">
    <div class="p-5 flex flex-col gap-4">
      <div class="flex items-center justify-between pr-8">
        <h2 class="text-lg font-bold text-foreground">{{ t('slotsTitle') }}</h2>
        <div class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/10">
          <Coins class="w-4 h-4 text-amber-400" />
          <span class="text-sm font-bold font-mono tabular-nums text-amber-300">{{ balance.toLocaleString() }}</span>
          <span class="text-[11px] text-amber-400/70 font-semibold">{{ t('gcoins') }}</span>
        </div>
      </div>

      <!-- Free-spins banner -->
      <div v-if="bonusState && (bonusPlaying || lastWin?.bonus)"
        class="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
        <div class="flex items-center gap-2 min-w-0">
          <Sparkles class="w-4 h-4 text-amber-400 shrink-0" />
          <span class="text-xs font-bold text-amber-300">{{ t('slotsFreeSpins') }}</span>
          <img v-if="imgFor(bonusState.special)" :src="imgFor(bonusState.special)" :title="t('slotsExpanding') + ': ' + nameFor(bonusState.special)"
            class="w-8 h-5 rounded object-cover ring-1 ring-amber-400/70 shrink-0" />
        </div>
        <div class="flex items-center gap-3 text-[11px] font-mono tabular-nums shrink-0">
          <span class="text-amber-200">{{ t('slotsFreeSpinsLeft', { n: bonusState.count - bonusState.index }) }}</span>
          <span class="text-green-400 font-bold">+{{ bonusState.total.toLocaleString() }}</span>
          <button v-if="bonusPlaying" class="px-2 py-0.5 rounded border border-amber-500/40 text-amber-300 hover:bg-amber-500/15" @click="skipBonus = true">{{ t('slotsSkip') }}</button>
        </div>
      </div>

      <!-- 5×3 grid -->
      <div class="grid grid-cols-5 gap-1.5">
        <div
          v-for="(strip, i) in reelStrips" :key="i"
          class="relative rounded-lg overflow-hidden border-2 bg-[#0F172A]"
          :class="busy ? 'border-primary/50' : 'border-border/60'"
          :style="{ height: (ITEM_H * ROWS) + 'px' }"
        >
          <div class="will-change-transform" :style="{ transform: `translateY(-${reelOffsets[i]}px)`, transition: reelTransitions[i] }">
            <div
              v-for="(key, idx) in strip" :key="idx"
              class="relative flex items-center justify-center"
              :style="{ height: ITEM_H + 'px' }"
              :title="nameFor(key)"
            >
              <img v-if="imgFor(key)" :src="imgFor(key)" :alt="nameFor(key)" class="w-full h-full object-cover"
                :class="key === AEGIS ? 'ring-2 ring-inset ring-amber-400/80' : ''" />
              <span v-else class="text-[10px] text-muted-foreground text-center px-1">{{ nameFor(key) }}</span>
              <!-- win / scatter / expand highlight (only when strip == result rows) -->
              <div v-if="showHighlights && strip.length === ROWS && expandedReelSet.has(i)"
                class="pointer-events-none absolute inset-0 bg-amber-400/25 ring-2 ring-inset ring-amber-300"></div>
              <div v-else-if="showHighlights && strip.length === ROWS && scatterCells.has(`${i},${idx}`)"
                class="pointer-events-none absolute inset-0 ring-4 ring-inset ring-amber-400 shadow-[inset_0_0_18px_rgba(251,191,36,0.7)]"></div>
              <div v-else-if="showHighlights && strip.length === ROWS && highlightCells.has(`${i},${idx}`)"
                class="pointer-events-none absolute inset-0 ring-2 ring-inset ring-green-400 bg-green-400/15"></div>
            </div>
          </div>
          <div class="pointer-events-none absolute inset-0" style="box-shadow: inset 0 10px 14px -10px #000, inset 0 -10px 14px -10px #000"></div>
        </div>
      </div>

      <!-- Result / status banner -->
      <div class="h-7 flex items-center justify-center text-sm font-bold text-center">
        <span v-if="error" class="text-destructive">{{ error }}</span>
        <span v-else-if="busy" class="text-primary flex items-center gap-2"><Loader2 class="w-4 h-4 animate-spin" /> {{ t('slotsSpinning') }}</span>
        <span v-else-if="collected !== null && collected > 0" class="text-green-400">{{ t('slotsWon', { n: collected.toLocaleString() }) }}</span>
        <span v-else-if="pendingWin > 0 && !autoSpinning" class="text-amber-300">{{ t('slotsTotalWin', { n: pendingWin.toLocaleString() }) }}</span>
        <span v-else-if="lastWin && lastWin.total === 0" class="text-muted-foreground">{{ t('slotsNoWin') }}</span>
      </div>

      <!-- Auto-spin status -->
      <div v-if="autoSpinning" class="flex flex-col gap-2 p-3 rounded-lg border border-primary/30 bg-primary/5">
        <div class="text-center text-xs text-muted-foreground">
          {{ t('slotsAuto') }}<span v-if="autoRemaining >= 0"> · {{ t('slotsAutoRemaining', { n: autoRemaining }) }}</span>
        </div>
        <button class="btn-primary w-full py-2.5 text-sm font-extrabold" @click="stopAuto">{{ t('slotsAutoStop') }}</button>
      </div>

      <!-- Gamble panel (shown while a win is pending) -->
      <div v-else-if="pendingWin > 0 && !bonusPlaying" class="flex flex-col gap-3 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5">
        <div class="flex items-center justify-between">
          <span class="text-xs uppercase tracking-wide text-amber-300/80">{{ t('slotsGamble') }}</span>
          <span class="text-[11px] font-mono text-muted-foreground">{{ t('slotsGambleStep', { n: gamble.steps, m: gambleCfg.maxSteps }) }}</span>
        </div>
        <div class="text-center text-2xl font-extrabold font-mono tabular-nums text-amber-300">{{ pendingWin.toLocaleString() }}</div>
        <div v-if="gamble.result" class="text-center text-xs font-bold" :class="gamble.result === 'win' ? 'text-green-400' : 'text-red-400'">
          <span class="inline-block w-3 h-3 rounded-sm mr-1 align-middle" :class="gamble.card === 'red' ? 'bg-red-500' : 'bg-zinc-900 border border-zinc-500'"></span>
          {{ gamble.result === 'win' ? t('slotsGambleWin') : t('slotsGambleLose') }}
        </div>
        <div v-if="gamble.canGamble" class="grid grid-cols-2 gap-2">
          <button class="py-2.5 rounded-lg text-sm font-extrabold text-white bg-red-600/80 hover:bg-red-600 disabled:opacity-40" :disabled="gamble.flipping" @click="doGamble('red')">{{ t('slotsGambleRed') }}</button>
          <button class="py-2.5 rounded-lg text-sm font-extrabold text-white bg-zinc-800 border border-zinc-600 hover:bg-zinc-700 disabled:opacity-40" :disabled="gamble.flipping" @click="doGamble('black')">{{ t('slotsGambleBlack') }}</button>
        </div>
        <button class="btn-primary w-full py-2.5 text-sm font-extrabold disabled:opacity-40" :disabled="gamble.flipping" @click="doCollect">
          {{ t('slotsCollect', { n: pendingWin.toLocaleString() }) }}
        </button>
      </div>

      <!-- Bet + spin (hidden while gambling) -->
      <template v-else>
        <div>
          <div class="flex items-center justify-between mb-2">
            <span class="text-[11px] uppercase tracking-wide text-muted-foreground">{{ t('slotsBet') }}</span>
            <span class="text-[11px] text-muted-foreground">{{ t('slotsLines', { n: lines }) }}</span>
          </div>
          <div class="grid grid-cols-4 gap-2">
            <button
              v-for="tier in betTiers" :key="tier"
              class="py-2 rounded-lg text-sm font-bold font-mono tabular-nums border-2 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              :class="selectedBet === tier ? 'border-primary bg-primary/15 text-primary' : 'border-border/60 text-foreground hover:border-primary/40'"
              :disabled="busy || balance < tier"
              @click="selectedBet = tier"
            >{{ tier }}</button>
          </div>
        </div>
        <button
          class="btn-primary w-full py-3 text-base font-extrabold disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          :disabled="busy || balance < selectedBet"
          @click="spin"
        >
          <Loader2 v-if="busy" class="w-5 h-5 animate-spin" />
          <span>{{ t('slotsSpin', { n: selectedBet }) }}</span>
        </button>
        <!-- Auto-spin: pick a count (∞ = until stopped) then start -->
        <div class="flex items-center gap-2">
          <span class="text-[11px] uppercase tracking-wide text-muted-foreground">{{ t('slotsAuto') }}</span>
          <div class="flex gap-1.5">
            <button
              v-for="p in AUTO_PRESETS" :key="p"
              class="px-2.5 py-1 rounded-md text-xs font-bold font-mono tabular-nums border transition-colors disabled:opacity-40"
              :class="autoCount === p ? 'border-primary text-primary bg-primary/10' : 'border-border/60 text-muted-foreground hover:border-primary/40'"
              :disabled="busy"
              @click="autoCount = p"
            >{{ p === -1 ? '∞' : p }}</button>
          </div>
          <button
            class="ml-auto px-4 py-1.5 rounded-md text-xs font-extrabold border border-primary/50 text-primary hover:bg-primary/10 disabled:opacity-40 disabled:cursor-not-allowed"
            :disabled="busy || balance < selectedBet"
            @click="startAuto"
          >{{ t('slotsAuto') }}</button>
        </div>
      </template>

      <!-- Paytable -->
      <div v-if="paytable.length" class="text-[11px] text-muted-foreground border-t border-border/40 pt-3">
        <div class="uppercase tracking-wide mb-2">{{ t('slotsPaytable') }}</div>
        <div class="grid grid-cols-2 gap-x-4 gap-y-1.5">
          <div v-for="s in paytable" :key="s.key" class="flex items-center gap-2">
            <img v-if="imgFor(s.key)" :src="imgFor(s.key)" :alt="nameFor(s.key)" class="w-8 h-5 rounded object-cover shrink-0" />
            <span class="font-mono font-bold text-amber-300 ml-auto whitespace-nowrap">
              <template v-if="s.pay['2']">2:{{ s.pay['2'] }} · </template>3:{{ s.pay['3'] }} · 4:{{ s.pay['4'] }} · 5:{{ s.pay['5'] }}
            </span>
          </div>
          <div class="flex items-center gap-2 col-span-2 mt-1 pt-1 border-t border-border/30">
            <img v-if="imgFor(AEGIS)" :src="imgFor(AEGIS)" :alt="aegisCfg.name" class="w-8 h-5 rounded object-cover shrink-0 ring-1 ring-amber-400/70" />
            <span class="text-amber-300/90 truncate">{{ aegisCfg.name }} — {{ t('slotsWild') }} · {{ t('slotsScatter') }}</span>
            <span class="font-mono text-amber-300 ml-auto whitespace-nowrap">3+ → {{ aegisCfg.freeSpins }} {{ t('slotsFreeSpins') }}</span>
          </div>
        </div>
      </div>
    </div>
  </ModalOverlay>
</template>
