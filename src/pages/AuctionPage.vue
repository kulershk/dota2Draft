<script setup lang="ts">
import { Gavel, Pause, Play, XCircle, Zap, History, Wallet, Users as UsersIcon, AlertCircle, CheckCircle, Circle, Undo2, Search, EyeOff, Eye, RefreshCw } from 'lucide-vue-next'
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDraftStore } from '@/composables/useDraftStore'
import RoleBadge from '@/components/common/RoleBadge.vue'
import MmrDisplay from '@/components/common/MmrDisplay.vue'
import RankBadge from '@/components/common/RankBadge.vue'
import CaptainAvatar from '@/components/common/CaptainAvatar.vue'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import { sortedRoles } from '@/utils/roles'
import { getServerNow } from '@/composables/useSocket'

const store = useDraftStore()
const { t } = useI18n()

// Live countdown timer
const timeLeft = ref(0)
let timerInterval: ReturnType<typeof setInterval> | null = null

function updateTimer() {
  if (isPaused.value && store.auction.bidTimerEnd === 0) {
    timeLeft.value = store.settings.bidTimer
    return
  }
  if (store.auction.bidTimerEnd > 0) {
    const remaining = Math.max(0, Math.ceil((store.auction.bidTimerEnd - getServerNow()) / 1000))
    timeLeft.value = remaining
  } else {
    timeLeft.value = 0
  }
}

onMounted(() => {
  timerInterval = setInterval(updateTimer, 200)
})

onUnmounted(() => {
  if (timerInterval) clearInterval(timerInterval)
})

const timerDisplay = computed(() => {
  const m = Math.floor(timeLeft.value / 60)
  const s = timeLeft.value % 60
  return `${m}:${String(s).padStart(2, '0')}`
})

const activeCaptainId = computed(() => store.currentCaptain.value?.id ?? 0)
const myCaptainLive = computed(() => store.captains.value.find(c => c.id === activeCaptainId.value))
const bidCooldown = ref(false)
const canBid = computed(() => !!store.currentCaptain.value && !bidCooldown.value)
const isLoggedIn = computed(() => !!store.currentUser.value)

function startCooldown() {
  bidCooldown.value = true
  setTimeout(() => { bidCooldown.value = false }, 300)
}

function placeBid(increment: number) {
  if (!canBid.value) return
  const newAmount = store.auction.currentBid + increment
  store.placeBid(newAmount)
  startCooldown()
}

watch(() => store.auction.bidHistory.length, (newLen, oldLen) => {
  if (newLen > oldLen) startCooldown()
})

const isNominator = computed(() =>
  store.auction.nominator && store.currentCaptain.value && store.auction.nominator.id === store.currentCaptain.value.id
)
const canNominate = computed(() => {
  if (store.settings.biddingType === 'blind') return store.isAdmin.value
  return isNominator.value || store.isAdmin.value
})

const startingPrices = ref<Record<number, number>>({})
const showNominateConfirm = ref(false)
const pendingNominateId = ref<number | null>(null)
const nominateSearch = ref('')

const filteredAvailablePlayers = computed(() => {
  let list = [...store.availablePlayers.value].sort((a, b) => b.mmr - a.mmr)
  if (nominateSearch.value) {
    const q = nominateSearch.value.toLowerCase()
    list = list.filter(p =>
      p.name.toLowerCase().includes(q) || p.roles.some((r: string) => r.toLowerCase().includes(q))
    )
  }
  return list
})

function nominatePlayer(playerId: number) {
  if (store.isAdmin.value && !isNominator.value) {
    pendingNominateId.value = playerId
    showNominateConfirm.value = true
    return
  }
  doNominate(playerId)
}

function confirmNominate() {
  if (pendingNominateId.value !== null) {
    doNominate(pendingNominateId.value)
  }
  showNominateConfirm.value = false
  pendingNominateId.value = null
}

function doNominate(playerId: number) {
  const price = startingPrices.value[playerId] || 0
  store.nominatePlayer(playerId, price > 0 ? price : undefined)
}

function formatGold(amount: number) {
  return amount.toLocaleString() + 'g'
}

const isMeReady = computed(() => {
  if (!store.currentCaptain.value) return false
  return store.readyCaptainIds.value.includes(store.currentCaptain.value.id)
})

const readyCount = computed(() => store.readyCaptainIds.value.length)
const totalCaptains = computed(() => store.captains.value.length)
const allReady = computed(() => totalCaptains.value > 0 && store.captains.value.every(c => store.readyCaptainIds.value.includes(c.id)))

function toggleReady() {
  if (!store.currentCaptain.value) return
  if (isMeReady.value) {
    store.setUnready()
  } else {
    store.setReady()
  }
}

// Blind bidding
const blindBidAmount = ref<number | null>(null)
const isBlindPhase = computed(() => store.auction.blindPhase)
const hasSubmittedBlindBid = computed(() => store.myBlindBid.value !== null)
const isInTopBidders = computed(() => {
  if (!store.currentCaptain.value) return false
  return store.auction.topBidderIds.includes(store.currentCaptain.value.id)
})
const isOpenPhaseAfterBlind = computed(() => {
  return !store.auction.blindPhase && store.auction.topBidderIds.length > 0
})

function submitBlindBid() {
  if (blindBidAmount.value == null || blindBidAmount.value < store.settings.minimumBid) return
  store.submitBlindBid(blindBidAmount.value)
}

const captainRosters = computed(() =>
  store.captains.value.map(c => ({
    ...c,
    players: store.players.value.filter(p => p.drafted && p.drafted_by === c.id).sort((a, b) => (a.draft_round || 0) - (b.draft_round || 0)),
  }))
)

const highlightedCaptainId = computed(() => {
  if (isBidding.value || isPaused.value) return store.auction.currentBidder?.id ?? null
  if (isNominating.value) return store.auction.nominator?.id ?? null
  return null
})

const isActive = computed(() => ['nominating', 'bidding'].includes(store.auction.status))
const isPaused = computed(() => store.auction.status === 'paused')
const isBidding = computed(() => store.auction.status === 'bidding')
const isNominating = computed(() => store.auction.status === 'nominating')
const isIdle = computed(() => store.auction.status === 'idle')
const isFinished = computed(() => store.auction.status === 'finished')

// --- Bidding Sounds (Web Audio API) ---
let audioCtx: AudioContext | null = null
function getAudioCtx() {
  if (!audioCtx) audioCtx = new AudioContext()
  return audioCtx
}

function playBidSound() {
  const ctx = getAudioCtx()
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.type = 'sine'
  osc.frequency.setValueAtTime(600, ctx.currentTime)
  osc.frequency.linearRampToValueAtTime(800, ctx.currentTime + 0.1)
  gain.gain.setValueAtTime(0.3, ctx.currentTime)
  gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.15)
  osc.start(ctx.currentTime)
  osc.stop(ctx.currentTime + 0.15)
}

function playMyBidSound() {
  const ctx = getAudioCtx()
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.type = 'sine'
  osc.frequency.setValueAtTime(800, ctx.currentTime)
  osc.frequency.linearRampToValueAtTime(1200, ctx.currentTime + 0.12)
  gain.gain.setValueAtTime(0.3, ctx.currentTime)
  gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.18)
  osc.start(ctx.currentTime)
  osc.stop(ctx.currentTime + 0.18)
}

function playSoldSound() {
  const ctx = getAudioCtx()
  const times = [0, 0.15, 0.3]
  const freqs = [523, 659, 784]
  times.forEach((t, i) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.type = 'sine'
    osc.frequency.value = freqs[i]
    gain.gain.setValueAtTime(0.25, ctx.currentTime + t)
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + t + 0.2)
    osc.start(ctx.currentTime + t)
    osc.stop(ctx.currentTime + t + 0.2)
  })
}

const prevBidCount = ref(0)

watch(() => store.auction.bidHistory.length, (newLen, oldLen) => {
  if (newLen > oldLen && oldLen > 0) {
    const latestBid = store.auction.bidHistory[0]
    if (latestBid && latestBid.captain_id === activeCaptainId.value) {
      playMyBidSound()
    } else {
      playBidSound()
    }
  }
  prevBidCount.value = newLen
})

watch(() => store.lastSoldMessage.value, (msg) => {
  if (msg) playSoldSound()
})

function playNominationSound() {
  const ctx = getAudioCtx()
  const freqs = [440, 554, 659]
  freqs.forEach((freq, i) => {
    const t = i * 0.1
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.type = 'triangle'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0.3, ctx.currentTime + t)
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + t + 0.15)
    osc.start(ctx.currentTime + t)
    osc.stop(ctx.currentTime + t + 0.15)
  })
}

watch(() => store.auction.status, (newStatus, oldStatus) => {
  if (newStatus === 'bidding' && oldStatus === 'nominating') {
    playNominationSound()
  }
})
</script>

<template>
  <div class="p-4 md:p-6 md:px-8 flex flex-col gap-4 md:gap-5 max-w-[1440px] mx-auto w-full">
    <!-- Toast notifications (fixed top-right) -->
    <div class="fixed top-4 left-4 right-4 md:left-auto md:right-4 z-50 flex flex-col gap-2 md:w-[360px] pointer-events-none">
      <transition name="toast">
        <div v-if="store.error.value" class="flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg bg-color-error text-color-error-foreground text-sm pointer-events-auto">
          <AlertCircle class="w-4 h-4 flex-shrink-0" />
          {{ store.error.value }}
        </div>
      </transition>
      <transition name="toast">
        <div v-if="store.lastSoldMessage.value" class="flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg bg-color-success text-color-success-foreground text-sm font-medium pointer-events-auto">
          <Gavel class="w-4 h-4 flex-shrink-0" />
          {{ store.lastSoldMessage.value }}
        </div>
      </transition>
      <transition name="toast">
        <div v-if="store.undoMessage.value" class="flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg bg-color-warning text-color-warning-foreground text-sm font-medium pointer-events-auto">
          <Undo2 class="w-4 h-4 flex-shrink-0" />
          {{ store.undoMessage.value }}
        </div>
      </transition>
    </div>

    <!-- Top Bar -->
    <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
      <div class="flex items-center gap-4">
        <div>
          <h1 class="text-xl md:text-2xl font-semibold text-foreground">{{ t('liveAuction') }}</h1>
          <p class="text-sm text-muted-foreground mt-0.5">
            <template v-if="isActive || isPaused">
              {{ t('roundOf', { current: store.auction.currentRound, total: store.auction.totalRounds }) }}
              <template v-if="store.auction.nominator"> &bull; {{ t('isNominating', { name: store.auction.nominator.name }) }}</template>
            </template>
            <template v-else-if="isFinished">{{ t('draftComplete') }}</template>
            <template v-else>{{ t('allCaptainsMustReady') }}</template>
          </p>
        </div>
        <div v-if="myCaptainLive && (isActive || isPaused)" class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-primary/10 border border-primary/30">
          <Wallet class="w-4 h-4 text-primary" />
          <span class="text-lg font-bold font-mono text-primary">{{ formatGold(myCaptainLive.budget) }}</span>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2 md:gap-3" v-if="(isActive || isPaused) && store.isAdmin.value">
        <button v-if="!isPaused" class="btn-outline" @click="store.pauseAuction()">
          <Pause class="w-4 h-4" /> {{ t('pause') }}
        </button>
        <button v-else class="btn-primary" @click="store.resumeAuction()">
          <Play class="w-4 h-4" /> {{ t('resume') }}
        </button>
        <select v-if="isPaused" class="input-field !h-9 text-sm" :value="store.auction.nominator?.id || ''" @change="store.setNominator(Number(($event.target as HTMLSelectElement).value))">
          <option v-for="c in store.captains.value" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <button v-if="isPaused && store.settings.nominationOrder !== 'normal'" class="btn-outline" @click="store.recheckOrder()">
          <RefreshCw class="w-4 h-4" /> {{ t('recheckOrder') }}
        </button>
        <button class="btn-outline" @click="store.undoLast()">
          <Undo2 class="w-4 h-4" /> {{ t('undo') }}
        </button>
        <button class="btn-destructive" @click="store.endDraft()">
          <XCircle class="w-4 h-4" /> {{ t('endDraft') }}
        </button>
      </div>
    </div>

    <!-- Idle state: Ready up panel -->
    <div v-if="isIdle" class="flex flex-col gap-5">
      <div class="card">
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
          <UsersIcon class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">{{ t('captainReadyCheck') }}</span>
          <span class="ml-2 rounded-full px-2.5 py-0.5 text-xs font-medium" :class="allReady ? 'bg-color-success text-color-success-foreground' : 'bg-accent text-muted-foreground'">
            {{ readyCount }}/{{ totalCaptains }} {{ t('ready').toLowerCase() }}
          </span>
        </div>
        <div class="divide-y divide-border">
          <div v-for="captain in store.captains.value" :key="captain.id" class="flex items-center justify-between px-4 py-3">
            <div class="flex items-center gap-3">
              <CaptainAvatar :name="captain.name" :online="store.onlineCaptainIds.value.includes(captain.id)" />
              <div>
                <p class="text-sm font-medium text-foreground">{{ captain.name }}</p>
                <p class="text-xs text-muted-foreground">{{ captain.team }}</p>
              </div>
            </div>
            <div class="flex items-center gap-2">
              <span v-if="store.onlineCaptainIds.value.includes(captain.id)" class="text-xs text-muted-foreground">{{ t('online') }}</span>
              <span v-else class="text-xs text-muted-foreground">{{ t('offline') }}</span>
              <CheckCircle v-if="store.readyCaptainIds.value.includes(captain.id)" class="w-5 h-5 text-green-500" />
              <Circle v-else class="w-5 h-5 text-muted-foreground" />
            </div>
          </div>
        </div>
        <div class="px-4 py-4 border-t border-border flex items-center justify-between">
          <div v-if="store.currentCaptain.value">
            <button v-if="!isMeReady" class="btn-primary" @click="toggleReady">
              <CheckCircle class="w-4 h-4" /> {{ t('readyUp') }}
            </button>
            <button v-else class="btn-outline" @click="toggleReady">
              <XCircle class="w-4 h-4" /> {{ t('unready') }}
            </button>
          </div>
          <p v-else class="text-sm text-muted-foreground italic">{{ t('loginAsCaptainReady') }}</p>
          <p v-if="allReady && store.isAdmin.value" class="text-sm text-green-500 font-medium">{{ t('allCaptainsReadyAdmin') }}</p>
          <p v-else-if="!allReady" class="text-sm text-muted-foreground">{{ t('waitingForCaptains') }}</p>
        </div>
      </div>
    </div>

    <!-- Finished state -->
    <div v-if="isFinished" class="card p-12 text-center">
      <Gavel class="w-12 h-12 text-primary mx-auto mb-4" />
      <p class="text-lg font-semibold text-foreground">{{ t('auctionComplete') }}</p>
      <p class="text-sm text-muted-foreground mt-1">{{ t('viewResultsHint') }}</p>
      <router-link :to="`/c/${store.currentCompetitionId.value}/results`" class="btn-primary mt-4 inline-flex">{{ t('viewResults') }}</router-link>
    </div>

    <!-- Active auction: main + sidebar layout -->
    <div v-if="isActive || isPaused" class="flex flex-col lg:flex-row gap-4 md:gap-5">
      <!-- Left: auction content -->
      <div class="flex-1 flex flex-col gap-4 md:gap-5 min-w-0">
        <!-- Nominating phase -->
        <div v-if="isNominating" class="card">
          <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
            <Gavel class="w-5 h-5 text-foreground" />
            <span class="text-sm font-semibold text-foreground">{{ (canNominate) ? t('nominatePlayer') : t('participants') }}</span>
            <span class="badge-info ml-2">{{ t('nominating') }}</span>
            <span class="text-xs text-muted-foreground ml-auto">{{ store.availablePlayers.value.length }} {{ t('remaining') }}</span>
          </div>
          <div class="p-3 md:p-4">
            <div v-if="store.auction.nominator" class="flex items-center gap-3 mb-3 md:mb-4 p-3 rounded-lg bg-primary/10 border border-primary/30">
              <CaptainAvatar :name="store.auction.nominator.name" :online="store.onlineCaptainIds.value.includes(store.auction.nominator.id)" />
              <div>
                <p class="text-sm font-semibold text-primary">{{ t('turnToNominate', { name: store.auction.nominator.name }) }}</p>
                <p class="text-xs text-muted-foreground">
                  <template v-if="isNominator">{{ t('selectFromPool') }}</template>
                  <template v-else>{{ t('waitingForPick') }}</template>
                </p>
              </div>
            </div>

            <!-- Search -->
            <div class="relative mb-3">
              <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input v-model="nominateSearch" type="text" :placeholder="t('search')" class="input-field pl-9 w-full" />
            </div>

            <!-- Mobile: card list -->
            <div class="md:hidden max-h-[400px] overflow-y-auto flex flex-col gap-2">
              <div v-for="player in filteredAvailablePlayers" :key="player.id" class="border border-border rounded-lg p-3 hover:bg-accent/30 transition-colors">
                <div class="flex items-center justify-between">
                  <div class="min-w-0">
                    <p class="text-sm font-medium text-foreground truncate">{{ player.name }}</p>
                    <div class="flex items-center gap-2 mt-1">
                      <div class="flex flex-wrap gap-1">
                        <RoleBadge v-for="role in sortedRoles(player.roles)" :key="role" :role="role" size="xs" />
                      </div>
                      <MmrDisplay :mmr="player.mmr" />
                    </div>
                  </div>
                  <button v-if="canNominate" class="text-xs py-1.5 px-3 flex-shrink-0 ml-2" :class="isNominator ? 'btn-primary' : 'btn-outline border-amber-500 text-amber-500 hover:bg-amber-500/10'" @click="nominatePlayer(player.id)">{{ t('nominate') }}</button>
                </div>
                <div v-if="canNominate" class="mt-2">
                  <input
                    type="number"
                    class="input-field w-full text-sm py-1 px-2 h-8"
                    :placeholder="t('startingBid') + ': ' + store.settings.minimumBid + 'g'"
                    :value="startingPrices[player.id] || ''"
                    @input="startingPrices[player.id] = Number(($event.target as HTMLInputElement).value) || 0"
                  />
                </div>
              </div>
            </div>

            <!-- Desktop: table -->
            <div class="hidden md:block overflow-x-auto max-h-[400px] overflow-y-auto">
              <table class="w-full text-sm">
                <thead class="sticky top-0 bg-card">
                  <tr class="border-b border-border bg-accent/50">
                    <th class="text-left px-4 py-2 font-medium text-muted-foreground">{{ t('playerCol') }}</th>
                    <th class="text-left px-4 py-2 font-medium text-muted-foreground">{{ t('rolesCol') }}</th>
                    <th class="text-left px-4 py-2 font-medium text-muted-foreground">{{ t('mmrCol') }}</th>
                    <th v-if="canNominate" class="text-left px-4 py-2 font-medium text-muted-foreground w-[120px]">{{ t('startBidCol') }}</th>
                    <th v-if="canNominate" class="text-right px-4 py-2 font-medium text-muted-foreground">{{ t('actionCol') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="player in filteredAvailablePlayers" :key="player.id" class="border-b border-border hover:bg-accent/30 transition-colors">
                    <td class="px-4 py-2.5 font-medium text-foreground">{{ player.name }}</td>
                    <td class="px-4 py-2.5">
                      <div class="flex flex-wrap gap-1">
                        <RoleBadge v-for="role in sortedRoles(player.roles)" :key="role" :role="role" />
                      </div>
                    </td>
                    <td class="px-4 py-2.5"><MmrDisplay :mmr="player.mmr" /></td>
                    <td v-if="canNominate" class="px-4 py-2.5">
                      <input
                        type="number"
                        class="input-field w-full text-sm py-1 px-2"
                        :placeholder="store.settings.minimumBid + 'g'"
                        :value="startingPrices[player.id] || ''"
                        @input="startingPrices[player.id] = Number(($event.target as HTMLInputElement).value) || 0"
                      />
                    </td>
                    <td v-if="canNominate" class="px-4 py-2.5 text-right">
                      <button class="text-xs py-1.5 px-3" :class="isNominator ? 'btn-primary' : 'btn-outline border-amber-500 text-amber-500 hover:bg-amber-500/10'" @click="nominatePlayer(player.id)">{{ t('nominate') }}</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- Bidding phase -->
        <template v-if="isBidding || isPaused">
          <div class="flex flex-col md:flex-row gap-4 md:gap-5">
            <!-- Current Nomination Card -->
            <div class="card flex-1">
              <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
                <Gavel class="w-5 h-5 text-foreground" />
                <span class="text-sm font-semibold text-foreground">{{ t('currentNomination') }}</span>
                <span v-if="isBlindPhase" class="badge-info ml-2 flex items-center gap-1">
                  <EyeOff class="w-3 h-3" /> {{ t('blindBidding') }}
                </span>
                <span v-else-if="isOpenPhaseAfterBlind" class="badge-bidding ml-2 flex items-center gap-1">
                  <Eye class="w-3 h-3" /> {{ t('openBidding') }}
                </span>
                <span v-else class="badge-bidding ml-2">{{ isPaused ? t('paused') : t('bidding') }}</span>
              </div>
              <div class="p-4 flex flex-col gap-4" v-if="store.auction.nominatedPlayer">
                <div class="flex flex-col items-center text-center gap-1">
                  <MmrDisplay :mmr="store.auction.nominatedPlayer.mmr" size="lg" />
                  <p class="text-[72px] leading-tight font-bold text-foreground mt-1">{{ store.auction.nominatedPlayer.name }}</p>
                  <p class="text-sm text-muted-foreground">
                    {{ sortedRoles(store.auction.nominatedPlayer.roles).join(', ') }}
                  </p>
                  <p class="text-xs text-muted-foreground" v-if="store.auction.nominator">
                    {{ t('nominatedBy', { name: store.auction.nominator.name }) }}
                  </p>
                </div>

                <!-- Blind phase stats -->
                <div v-if="isBlindPhase" class="grid grid-cols-2 gap-2 md:gap-4">
                  <div class="rounded border border-border p-2 md:p-3 text-center">
                    <p class="text-[10px] md:text-xs text-muted-foreground uppercase tracking-wider">{{ t('timeLeft') }}</p>
                    <p class="text-lg md:text-2xl font-bold font-mono mt-1" :class="timeLeft <= 5 ? 'text-destructive' : 'text-foreground'">{{ timerDisplay }}</p>
                    <p class="hidden md:block text-xs text-muted-foreground">{{ t('secondsRemaining') }}</p>
                  </div>
                  <div class="rounded border border-border p-2 md:p-3 text-center">
                    <p class="text-[10px] md:text-xs text-muted-foreground uppercase tracking-wider">{{ t('bidsSubmitted') }}</p>
                    <p class="text-lg md:text-2xl font-bold text-foreground font-mono mt-1">{{ store.auction.blindBidCount }}</p>
                    <p class="hidden md:block text-xs text-muted-foreground">{{ t('sealed') }}</p>
                  </div>
                </div>

                <!-- Normal/open phase stats -->
                <div v-else class="grid grid-cols-3 gap-2 md:gap-4">
                  <div class="rounded border border-border p-2 md:p-3 text-center">
                    <p class="text-[10px] md:text-xs text-muted-foreground uppercase tracking-wider">{{ t('currentBid') }}</p>
                    <p class="text-lg md:text-2xl font-bold text-primary font-mono mt-1">{{ store.auction.currentBid }}g</p>
                    <p class="text-xs text-muted-foreground" v-if="store.auction.currentBidder">by {{ store.auction.currentBidder.name }}</p>
                  </div>
                  <div class="rounded border border-border p-2 md:p-3 text-center">
                    <p class="text-[10px] md:text-xs text-muted-foreground uppercase tracking-wider">{{ t('timeLeft') }}</p>
                    <p class="text-lg md:text-2xl font-bold font-mono mt-1" :class="timeLeft <= 5 ? 'text-destructive' : 'text-foreground'">{{ timerDisplay }}</p>
                    <p class="hidden md:block text-xs text-muted-foreground">{{ t('secondsRemaining') }}</p>
                  </div>
                  <div class="rounded border border-border p-2 md:p-3 text-center">
                    <p class="text-[10px] md:text-xs text-muted-foreground uppercase tracking-wider">{{ t('bids') }}</p>
                    <p class="text-lg md:text-2xl font-bold text-foreground font-mono mt-1">{{ store.auction.bidHistory.length }}</p>
                    <p class="hidden md:block text-xs text-muted-foreground">{{ t('thisRound') }}</p>
                  </div>
                </div>

                <!-- Blind bid input (during blind phase) -->
                <div v-if="isBlindPhase && !isPaused" class="flex flex-col gap-3">
                  <template v-if="store.currentCaptain.value">
                    <div v-if="hasSubmittedBlindBid" class="p-3 rounded-lg bg-color-success/10 border border-color-success/30 text-center">
                      <p class="text-sm font-medium text-color-success">{{ t('blindBidSubmitted') }}</p>
                      <p class="text-lg font-bold font-mono text-foreground mt-1">{{ store.myBlindBid.value }}g</p>
                      <p class="text-xs text-muted-foreground mt-1">{{ t('blindBidUpdateHint') }}</p>
                    </div>
                    <div class="flex items-center gap-2">
                      <input
                        type="number"
                        class="input-field flex-1 text-center text-lg font-mono"
                        :placeholder="t('enterBlindBid', { min: store.settings.minimumBid })"
                        v-model.number="blindBidAmount"
                        :min="store.settings.minimumBid"
                      />
                      <button class="btn-primary px-6 py-2.5" @click="submitBlindBid">
                        <EyeOff class="w-4 h-4" />
                        {{ hasSubmittedBlindBid ? t('updateBid') : t('submitBid') }}
                      </button>
                    </div>
                    <p class="text-xs text-muted-foreground text-center">
                      {{ t('blindBidInfo', { n: store.settings.blindTopBidders }) }}
                    </p>
                  </template>
                  <p v-else class="text-sm text-muted-foreground italic py-2">{{ t('loginAsCaptainBid') }}</p>
                </div>

                <!-- Revealed bids (after blind phase, before/during open phase) -->
                <div v-if="store.auction.revealedBids && !isBlindPhase" class="rounded border border-border overflow-hidden">
                  <div class="flex items-center gap-2 px-3 py-2 bg-accent/50 border-b border-border">
                    <Eye class="w-4 h-4 text-muted-foreground" />
                    <span class="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{{ t('blindBidResults') }}</span>
                  </div>
                  <div class="divide-y divide-border">
                    <div v-for="(rb, i) in store.auction.revealedBids" :key="i" class="flex items-center justify-between px-3 py-2" :class="rb.qualified ? 'bg-primary/5' : 'opacity-50'">
                      <div class="flex items-center gap-2">
                        <span class="text-sm font-medium" :class="rb.qualified ? 'text-foreground' : 'text-muted-foreground'">{{ rb.captainName }}</span>
                        <span v-if="rb.qualified" class="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">{{ t('qualified') }}</span>
                      </div>
                      <span class="text-sm font-mono" :class="rb.qualified ? 'font-bold text-primary' : 'text-muted-foreground'">{{ rb.amount }}g</span>
                    </div>
                  </div>
                </div>

                <!-- Normal bid buttons (non-blind or open phase after blind) -->
                <div class="grid grid-cols-2 md:flex gap-2 md:gap-3" v-if="!isPaused && !isBlindPhase">
                  <template v-if="store.currentCaptain.value">
                    <template v-if="!isOpenPhaseAfterBlind || isInTopBidders">
                      <button class="btn-outline justify-center" :disabled="bidCooldown" @click="placeBid(5)">+5g</button>
                      <button class="btn-outline justify-center" :disabled="bidCooldown" @click="placeBid(10)">+10g</button>
                      <button class="btn-outline justify-center" :disabled="bidCooldown" @click="placeBid(25)">+25g</button>
                      <button class="btn-primary justify-center col-span-2 md:flex-1" :disabled="bidCooldown" @click="placeBid(store.settings.bidIncrement)">
                        <Zap class="w-4 h-4" /> {{ bidCooldown ? t('waitBid') : t('placeBid') }}
                      </button>
                    </template>
                    <p v-else class="text-sm text-muted-foreground italic py-2 col-span-2">{{ t('notQualifiedBlind') }}</p>
                  </template>
                  <p v-else class="text-sm text-muted-foreground italic py-2">{{ t('loginAsCaptainBid') }}</p>
                </div>
              </div>
            </div>

            <!-- Bid History / Blind Status sidebar -->
            <div class="card md:w-[280px]">
              <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
                <History class="w-5 h-5 text-foreground" />
                <span class="text-sm font-semibold text-foreground">{{ isBlindPhase ? t('blindBidStatus') : t('bidHistory') }}</span>
              </div>
              <div v-if="isBlindPhase" class="p-4 text-center">
                <EyeOff class="w-8 h-8 text-muted-foreground mx-auto mb-3" />
                <p class="text-sm text-muted-foreground">{{ t('blindBidsHidden') }}</p>
                <p class="text-2xl font-bold font-mono text-foreground mt-2">{{ store.auction.blindBidCount }}</p>
                <p class="text-xs text-muted-foreground">{{ t('bidsReceived') }}</p>
              </div>
              <div v-else class="divide-y divide-border max-h-[200px] md:max-h-[400px] overflow-y-auto">
                <div v-for="(bid, i) in store.auction.bidHistory" :key="bid.id || i" class="flex items-center justify-between px-4 py-2.5" :class="i === 0 ? 'bg-primary/5' : ''">
                  <span class="text-sm" :class="i === 0 ? 'font-semibold text-foreground' : 'text-muted-foreground'">
                    {{ bid.captain_name }}
                    <span v-if="i === 0" class="text-xs text-primary ml-1">({{ t('leading') }})</span>
                  </span>
                  <span class="text-sm font-mono" :class="i === 0 ? 'font-bold text-primary' : 'text-foreground'">{{ bid.amount }}g</span>
                </div>
                <div v-if="store.auction.bidHistory.length === 0" class="px-4 py-6 text-center text-sm text-muted-foreground">
                  {{ t('noBidsYet') }}
                </div>
              </div>
            </div>
          </div>
        </template>

        <!-- Participants (show during bidding/paused) -->
        <div v-if="isBidding || isPaused" class="card">
          <div class="flex items-center justify-between gap-2 px-4 py-3 border-b border-border">
            <div class="flex items-center gap-2">
              <UsersIcon class="w-5 h-5 text-foreground" />
              <span class="text-sm font-semibold text-foreground">{{ t('participantsRemaining', { n: store.availablePlayers.value.length }) }}</span>
            </div>
            <div class="relative">
              <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input v-model="nominateSearch" type="text" :placeholder="t('search')" class="input-field pl-9 w-44" />
            </div>
          </div>
          <div class="overflow-x-auto max-h-[300px] overflow-y-auto">
            <table class="w-full text-sm">
              <thead class="sticky top-0 bg-card">
                <tr class="border-b border-border bg-accent/50">
                  <th class="text-left px-4 py-2 font-medium text-muted-foreground text-xs">{{ t('playerCol') }}</th>
                  <th class="text-left px-4 py-2 font-medium text-muted-foreground text-xs">{{ t('rolesCol') }}</th>
                  <th class="text-right px-4 py-2 font-medium text-muted-foreground text-xs">{{ t('mmrCol') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="player in filteredAvailablePlayers" :key="player.id" class="border-b border-border">
                  <td class="px-4 py-2 text-foreground">{{ player.name }}</td>
                  <td class="px-4 py-2">
                    <div class="flex flex-wrap gap-1">
                      <RoleBadge v-for="role in sortedRoles(player.roles)" :key="role" :role="role" />
                    </div>
                  </td>
                  <td class="px-4 py-2 text-right"><MmrDisplay :mmr="player.mmr" /></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Right sidebar: Captain Rosters -->
      <div class="w-full lg:w-[640px] flex-shrink-0 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-2 gap-3">
        <div v-for="roster in captainRosters" :key="roster.id" class="card transition-all" :class="roster.players.length >= store.settings.playersPerTeam ? 'ring-2 ring-green-500 border-green-500' : highlightedCaptainId === roster.id ? 'ring-2 ring-primary border-primary' : ''">
          <div class="flex items-center justify-between px-3 py-2.5 border-b border-border">
            <div class="flex items-center gap-2">
              <img v-if="roster.banner_url" :src="roster.banner_url" class="w-8 h-8 rounded object-cover" />
              <CaptainAvatar v-else :name="roster.name" :online="store.onlineCaptainIds.value.includes(roster.id)" size="sm" />
              <div>
                <div class="flex items-center gap-1.5">
                  <RankBadge :mmr="roster.mmr" size="sm" />
                  <p class="text-sm font-semibold text-foreground leading-tight">{{ roster.name }}</p>
                </div>
                <p class="text-[10px] text-muted-foreground">{{ roster.team }}</p>
              </div>
            </div>
            <div class="text-right">
              <span class="text-xs font-mono font-medium text-foreground">{{ formatGold(roster.budget) }}</span>
              <p class="text-[10px] text-muted-foreground">avg {{ Math.round((roster.mmr + roster.players.reduce((s, p) => s + p.mmr, 0)) / (1 + roster.players.length)).toLocaleString() }} MMR</p>
            </div>
          </div>
          <div v-if="roster.players.length > 0" class="divide-y divide-border max-h-[150px] lg:max-h-none overflow-y-auto">
            <div v-for="player in roster.players" :key="player.id" class="flex items-center justify-between px-3 py-2">
              <div class="flex items-center gap-2 min-w-0">
                <RankBadge :mmr="player.mmr" size="sm" />
                <span class="text-sm text-foreground truncate">{{ player.name }}</span>
                <span class="text-[10px] font-mono text-muted-foreground">{{ player.mmr.toLocaleString() }}</span>
              </div>
              <span class="text-xs font-mono text-muted-foreground flex-shrink-0 ml-2">{{ player.draft_price }}g</span>
            </div>
          </div>
          <div v-else class="px-3 py-3 text-center">
            <p class="text-xs text-muted-foreground italic">{{ t('noPlayersYet') }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Activity Log -->
    <div v-if="store.activityLog.value.length > 0" class="card">
      <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
        <History class="w-5 h-5 text-foreground" />
        <span class="text-sm font-semibold text-foreground">{{ t('activityLog') }}</span>
        <span class="text-xs text-muted-foreground">({{ store.activityLog.value.length }})</span>
      </div>
      <div class="divide-y divide-border max-h-[200px] md:max-h-[300px] overflow-y-auto">
        <div v-for="(entry, i) in store.activityLog.value" :key="i" class="flex items-center gap-2 md:gap-3 px-3 md:px-4 py-2">
          <span class="text-[10px] font-mono text-muted-foreground flex-shrink-0 hidden sm:inline">{{ new Date(entry.time).toLocaleTimeString() }}</span>
          <span class="w-2 h-2 rounded-full flex-shrink-0" :class="{
            'bg-green-500': entry.type === 'sold',
            'bg-blue-500': entry.type === 'nomination',
            'bg-yellow-500': entry.type === 'bid',
            'bg-orange-500': entry.type === 'undo',
            'bg-gray-500': entry.type === 'pause' || entry.type === 'resume',
            'bg-primary': entry.type === 'start',
            'bg-red-500': entry.type === 'end',
            'bg-muted-foreground': entry.type === 'info',
          }"></span>
          <span class="text-sm" :class="entry.type === 'sold' ? 'font-semibold text-foreground' : 'text-muted-foreground'">{{ entry.message }}</span>
        </div>
      </div>
    </div>
    <!-- Admin Nominate Confirmation Modal -->
    <ModalOverlay :show="showNominateConfirm" @close="showNominateConfirm = false; pendingNominateId = null">
      <div class="px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('confirmNomination') }}</h2>
        <p class="text-sm text-muted-foreground mt-2">
          {{ t('nominatingOnBehalf', { player: store.players.value.find(p => p.id === pendingNominateId)?.name, captain: store.auction.nominator?.name }) }}
        </p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center bg-amber-500 hover:bg-amber-600 border-amber-500" @click="confirmNominate">
          {{ t('yesNominate') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showNominateConfirm = false; pendingNominateId = null">
          {{ t('cancel') }}
        </button>
      </div>
    </ModalOverlay>
  </div>
</template>

<style scoped>
.toast-enter-active, .toast-leave-active {
  transition: all 0.3s ease;
}
.toast-enter-from, .toast-leave-to {
  opacity: 0;
  transform: translateX(100%);
}
</style>
