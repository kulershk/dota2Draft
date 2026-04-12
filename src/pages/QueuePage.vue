<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { Clock, Users, Swords, X, Check, Loader2, Shield, ChevronRight, Timer, Send, MessageSquare } from 'lucide-vue-next'
import { useQueueStore, type QueuePlayer } from '@/composables/useQueueStore'
import { useDraftStore } from '@/composables/useDraftStore'
import { getServerNow } from '@/composables/useSocket'

const { t } = useI18n()
const router = useRouter()
const store = useDraftStore()
const queue = useQueueStore()

const selectedPoolId = ref<number | null>(null)

const selectedPool = computed(() => queue.pools.value.find(p => p.id === selectedPoolId.value) || null)
const teamSize = computed(() => (selectedPool.value as any)?.team_size || 5)
const totalPlayers = computed(() => teamSize.value * 2)
const emptySlots = computed(() => teamSize.value - 1) // per team, excluding captain

const currentUserId = computed(() => store.currentUser.value?.id || null)

const iAmCaptain1 = computed(() => queue.activeMatch.value?.captain1.playerId === currentUserId.value)
const iAmCaptain2 = computed(() => queue.activeMatch.value?.captain2.playerId === currentUserId.value)
const iAmCaptain = computed(() => iAmCaptain1.value || iAmCaptain2.value)

const isMyTurn = computed(() => {
  if (!queue.pickState.value || !iAmCaptain.value) return false
  const cp = queue.pickState.value.currentPicker
  return (cp === 1 && iAmCaptain1.value) || (cp === 2 && iAmCaptain2.value)
})

const currentPickerCaptain = computed(() => {
  const m = queue.activeMatch.value
  const cp = queue.pickState.value?.currentPicker
  if (!m || !cp) return null
  return cp === 1 ? m.captain1 : m.captain2
})

// Pick timer countdown
const now = ref(getServerNow())
let tickInterval: ReturnType<typeof setInterval> | null = null

const pickTimeLeft = computed(() => {
  if (!queue.pickState.value?.pickTimerEnd) return null
  const remaining = queue.pickState.value.pickTimerEnd - now.value
  return Math.max(0, remaining)
})

const timerPercent = computed(() => {
  if (!pickTimeLeft.value || !queue.activeMatch.value) return 0
  const total = (selectedPool.value?.pick_timer || 30) * 1000
  return Math.min(100, (pickTimeLeft.value / total) * 100)
})

function formatTimer(ms: number): string {
  const s = Math.ceil(ms / 1000)
  return `${s}s`
}

const lobbyTimeLeft = computed(() => {
  if (!queue.lobbyInfo.value?.expiresAt) return null
  return Math.max(0, queue.lobbyInfo.value.expiresAt - now.value)
})

function formatLobbyTimer(ms: number): string {
  const totalSec = Math.ceil(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function selectPool(poolId: number) {
  selectedPoolId.value = poolId
  queue.requestState(poolId)
  queue.fetchHistory(poolId)
}

function handleJoin() {
  if (!selectedPoolId.value) return
  queue.joinQueue(selectedPoolId.value)
}

function handleLeave() {
  queue.leaveQueue()
}

function handlePick(playerId: number) {
  if (!queue.activeMatch.value) return
  queue.pickPlayer(queue.activeMatch.value.queueMatchId, playerId)
}

// Ready sound — plays when a match is found (10/10)
const readySound = new Audio('/sounds/ready.wav')
readySound.preload = 'auto'
watch(() => queue.activeMatch.value, (m, prev) => {
  if (m && !prev) {
    readySound.currentTime = 0
    readySound.play().catch(() => {})
  }
})

// Chat
const chatInput = ref('')
const chatScroll = ref<HTMLElement | null>(null)
const chatCooldownLeft = ref(0)
const canSendChat = computed(() => chatInput.value.trim().length > 0 && chatCooldownLeft.value <= 0)

function sendChat() {
  if (!canSendChat.value) return
  if (queue.sendChat(chatInput.value)) {
    chatInput.value = ''
  }
}

watch(() => queue.chatMessages.value.length, async () => {
  await nextTick()
  if (chatScroll.value) chatScroll.value.scrollTop = chatScroll.value.scrollHeight
})

onMounted(async () => {
  await queue.fetchPools()
  if (queue.pools.value.length > 0) {
    selectPool(queue.pools.value[0].id)
  }
  tickInterval = setInterval(() => {
    now.value = getServerNow()
    chatCooldownLeft.value = Math.max(0, queue.chatRateLimitedUntil.value - Date.now())
  }, 200)
})

onUnmounted(() => {
  if (tickInterval) clearInterval(tickInterval)
})
</script>

<template>
  <div>
    <!-- Hero header -->
    <div class="border-b border-border/50">
      <div class="max-w-5xl mx-auto px-4 md:px-8 pt-10 pb-8 flex flex-col items-center text-center gap-4">
        <div class="w-12 h-12 rounded-xl bg-primary/{{ totalPlayers }} flex items-center justify-center mb-1">
          <Swords class="w-6 h-6 text-primary" />
        </div>
        <h1 class="text-2xl md:text-3xl font-bold">{{ t('queue') }}</h1>
        <p class="text-muted-foreground text-sm max-w-md">{{ t('queueDesc') }}</p>
      </div>
    </div>

    <div class="max-w-5xl mx-auto px-4 md:px-8 py-8">
      <!-- No pools -->
      <div v-if="queue.pools.value.length === 0" class="card px-6 py-16 text-center">
        <Swords class="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
        <p class="text-muted-foreground">{{ t('queueNoPools') }}</p>
      </div>

      <template v-else>

        <!-- ═══════════════════ PICK PHASE ═══════════════════ -->
        <template v-if="queue.activeMatch.value">

          <!-- Cancelled -->
          <div v-if="queue.cancelled.value" class="card px-8 py-12 text-center">
            <div class="w-14 h-14 rounded-full bg-destructive/{{ totalPlayers }} flex items-center justify-center mx-auto mb-4">
              <X class="w-7 h-7 text-destructive" />
            </div>
            <p class="text-xl font-bold mb-2">{{ t('queueMatchCancelled') }}</p>
            <p class="text-muted-foreground text-sm mb-6">{{ queue.cancelled.value }}</p>
            <button class="btn-primary px-6 py-2.5" @click="queue.resetMatchState()">{{ t('queueBackToQueue') }}</button>
          </div>

          <!-- Lobby Created -->
          <div v-else-if="queue.lobbyInfo.value" class="card overflow-hidden">
            <!-- Green accent bar -->
            <div class="h-1 bg-green-500"></div>

            <!-- Header -->
            <div class="px-6 py-4 border-b border-border/30 flex items-center justify-between">
              <div class="flex items-center gap-3">
                <Check class="w-5 h-5 text-green-500" />
                <span class="text-lg font-bold">{{ t('queueLobbyCreated') }}</span>
                <span class="text-xs font-semibold bg-green-500/15 text-green-500 px-2.5 py-1 rounded-full">
                  {{ t('queueYouAreInvited') }}
                </span>
              </div>
              <div v-if="lobbyTimeLeft != null && lobbyTimeLeft > 0" class="flex items-center gap-2">
                <Timer class="w-4 h-4" :class="lobbyTimeLeft < 60000 ? 'text-destructive' : 'text-muted-foreground'" />
                <span class="font-mono font-bold text-xl tabular-nums" :class="lobbyTimeLeft < 60000 ? 'text-destructive' : 'text-foreground'">
                  {{ formatLobbyTimer(lobbyTimeLeft) }}
                </span>
              </div>
            </div>

            <!-- Lobby info -->
            <div class="px-6 py-4 border-b border-border/30 flex items-center justify-center gap-8 bg-accent/30">
              <div class="flex items-center gap-2">
                <span class="text-xs text-muted-foreground">{{ t('queueLobbyName') }}:</span>
                <span class="font-mono font-bold text-sm">{{ queue.lobbyInfo.value.gameName }}</span>
              </div>
              <div class="flex items-center gap-2">
                <span class="text-xs text-muted-foreground">{{ t('queueLobbyPassword') }}:</span>
                <span class="font-mono font-bold text-sm select-all">{{ queue.lobbyInfo.value.password }}</span>
              </div>
            </div>

            <!-- Teams -->
            <div class="grid grid-cols-2 min-h-[200px]">
              <!-- Team 1 (Radiant) -->
              <div class="p-5 border-r border-border/30">
                <div class="flex items-center gap-2 mb-4">
                  <div class="w-2.5 h-2.5 rounded-full bg-green-500"></div>
                  <span class="text-sm font-bold text-green-400 uppercase tracking-wider">{{ t('queueRadiant') }}</span>
                </div>
                <div class="flex flex-col gap-1">
                  <div v-for="(p, idx) in (queue.teamsFormed.value?.team1 || [])" :key="p.playerId"
                    class="flex items-center gap-2.5 px-3 py-2 rounded-lg"
                    :class="idx === 0 ? 'bg-green-500/8 border border-green-500/15' : 'bg-accent/50'">
                    <img v-if="p.avatarUrl" :src="p.avatarUrl" class="w-7 h-7 rounded-full" :class="idx === 0 ? 'ring-2 ring-green-500/30' : ''" />
                    <div class="flex-1 min-w-0">
                      <div class="text-sm font-semibold truncate">{{ p.name }}</div>
                      <div class="text-[10px] text-muted-foreground">{{ p.mmr }} MMR</div>
                    </div>
                    <span v-if="idx === 0" class="text-[10px] font-bold text-green-400 bg-green-500/10 px-2 py-0.5 rounded">CPT</span>
                  </div>
                </div>
              </div>

              <!-- Team 2 (Dire) -->
              <div class="p-5">
                <div class="flex items-center gap-2 mb-4">
                  <div class="w-2.5 h-2.5 rounded-full bg-red-500"></div>
                  <span class="text-sm font-bold text-red-400 uppercase tracking-wider">{{ t('queueDire') }}</span>
                </div>
                <div class="flex flex-col gap-1">
                  <div v-for="(p, idx) in (queue.teamsFormed.value?.team2 || [])" :key="p.playerId"
                    class="flex items-center gap-2.5 px-3 py-2 rounded-lg"
                    :class="idx === 0 ? 'bg-red-500/8 border border-red-500/15' : 'bg-accent/50'">
                    <img v-if="p.avatarUrl" :src="p.avatarUrl" class="w-7 h-7 rounded-full" :class="idx === 0 ? 'ring-2 ring-red-500/30' : ''" />
                    <div class="flex-1 min-w-0">
                      <div class="text-sm font-semibold truncate">{{ p.name }}</div>
                      <div class="text-[10px] text-muted-foreground">{{ p.mmr }} MMR</div>
                    </div>
                    <span v-if="idx === 0" class="text-[10px] font-bold text-red-400 bg-red-500/10 px-2 py-0.5 rounded">CPT</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Teams Formed, creating lobby -->
          <div v-else-if="queue.teamsFormed.value" class="card px-8 py-12 text-center">
            <Loader2 class="w-10 h-10 text-primary mx-auto mb-4 animate-spin" />
            <p class="text-xl font-bold">{{ t('queueCreatingLobby') }}</p>
          </div>

          <!-- Pick Phase -->
          <div v-else-if="queue.pickState.value" class="card overflow-hidden">
            <!-- Timer bar -->
            <div class="h-1 bg-accent relative overflow-hidden">
              <div
                class="h-full transition-all duration-200 ease-linear"
                :class="pickTimeLeft && pickTimeLeft < 5000 ? 'bg-destructive' : 'bg-primary'"
                :style="{ width: timerPercent + '%' }"
              />
            </div>

            <!-- Header -->
            <div class="px-6 py-4 border-b border-border/30 flex items-center justify-between">
              <div class="flex items-center gap-3">
                <span class="text-lg font-bold">{{ t('queuePickPhase') }}</span>
                <span v-if="isMyTurn" class="text-xs font-semibold bg-primary/15 text-primary px-2.5 py-1 rounded-full animate-pulse">
                  {{ t('queueYourTurn') }}
                </span>
                <span v-else-if="currentPickerCaptain" class="flex items-center gap-2 text-xs font-semibold px-2.5 py-1 rounded-full"
                  :class="queue.pickState.value.currentPicker === 1 ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'">
                  <img v-if="currentPickerCaptain.avatarUrl" :src="currentPickerCaptain.avatarUrl" class="w-4 h-4 rounded-full" />
                  <span>{{ currentPickerCaptain.name }} {{ t('queuePicking') }}</span>
                </span>
                <span v-else class="text-xs text-muted-foreground">
                  {{ t('queueWaitingForPick') }}
                </span>
              </div>
              <div v-if="pickTimeLeft != null" class="flex items-center gap-2">
                <Timer class="w-4 h-4" :class="pickTimeLeft < 5000 ? 'text-destructive' : 'text-muted-foreground'" />
                <span class="font-mono font-bold text-xl tabular-nums" :class="pickTimeLeft < 5000 ? 'text-destructive' : 'text-foreground'">
                  {{ formatTimer(pickTimeLeft) }}
                </span>
              </div>
            </div>

            <div class="grid grid-cols-[1fr_auto_1fr] min-h-[340px]">
              <!-- Team 1 (Radiant) -->
              <div class="p-5">
                <div class="flex items-center gap-2 mb-4">
                  <div class="w-2.5 h-2.5 rounded-full" :class="queue.pickState.value.currentPicker === 1 ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground/20'"></div>
                  <span class="text-sm font-bold text-green-400 uppercase tracking-wider">{{ t('queueRadiant') }}</span>
                </div>
                <!-- Captain -->
                <div class="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-green-500/8 border border-green-500/15 mb-3">
                  <img v-if="queue.activeMatch.value.captain1.avatarUrl" :src="queue.activeMatch.value.captain1.avatarUrl" class="w-7 h-7 rounded-full ring-2 ring-green-500/30" />
                  <div class="flex-1 min-w-0">
                    <div class="text-sm font-semibold truncate">{{ queue.activeMatch.value.captain1.name }}</div>
                    <div class="text-[10px] text-muted-foreground">{{ queue.activeMatch.value.captain1.mmr }} MMR</div>
                  </div>
                  <span class="text-[10px] font-bold text-green-400 bg-green-500/{{ totalPlayers }} px-2 py-0.5 rounded">CPT</span>
                </div>
                <!-- Picked players -->
                <div class="flex flex-col gap-1">
                  <div v-for="p in queue.pickState.value.captain1Picks" :key="p.playerId"
                    class="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-accent/50">
                    <img v-if="p.avatarUrl" :src="p.avatarUrl" class="w-6 h-6 rounded-full" />
                    <span class="text-sm font-medium flex-1 truncate">{{ p.name }}</span>
                    <span class="text-[10px] text-muted-foreground tabular-nums">{{ p.mmr }}</span>
                  </div>
                  <!-- Empty slots -->
                  <div v-for="i in (emptySlots - queue.pickState.value.captain1Picks.length)" :key="'e1-' + i"
                    class="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-dashed border-border/40">
                    <div class="w-6 h-6 rounded-full bg-accent/50"></div>
                    <span class="text-sm text-muted-foreground/30">---</span>
                  </div>
                </div>
              </div>

              <!-- Available Players (center column) -->
              <div class="border-x border-border/30 p-5 min-w-[220px]">
                <div class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-4 text-center">
                  {{ t('queueAvailablePlayers') }}
                </div>
                <div class="flex flex-col gap-1">
                  <button
                    v-for="p in queue.pickState.value.availablePlayers" :key="p.playerId"
                    class="flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm transition-all text-left"
                    :class="isMyTurn
                      ? 'hover:bg-primary/{{ totalPlayers }} hover:ring-1 hover:ring-primary/30 cursor-pointer'
                      : 'cursor-default opacity-60'"
                    :disabled="!isMyTurn"
                    @click="isMyTurn && handlePick(p.playerId)"
                  >
                    <img v-if="p.avatarUrl" :src="p.avatarUrl" class="w-6 h-6 rounded-full" />
                    <span class="font-medium flex-1 truncate">{{ p.name }}</span>
                    <span class="text-[10px] text-muted-foreground tabular-nums">{{ p.mmr }}</span>
                    <ChevronRight v-if="isMyTurn" class="w-3.5 h-3.5 text-muted-foreground/50" />
                  </button>
                </div>
              </div>

              <!-- Team 2 (Dire) -->
              <div class="p-5">
                <div class="flex items-center gap-2 mb-4">
                  <div class="w-2.5 h-2.5 rounded-full" :class="queue.pickState.value.currentPicker === 2 ? 'bg-red-500 animate-pulse' : 'bg-muted-foreground/20'"></div>
                  <span class="text-sm font-bold text-red-400 uppercase tracking-wider">{{ t('queueDire') }}</span>
                </div>
                <!-- Captain -->
                <div class="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-red-500/8 border border-red-500/15 mb-3">
                  <img v-if="queue.activeMatch.value.captain2.avatarUrl" :src="queue.activeMatch.value.captain2.avatarUrl" class="w-7 h-7 rounded-full ring-2 ring-red-500/30" />
                  <div class="flex-1 min-w-0">
                    <div class="text-sm font-semibold truncate">{{ queue.activeMatch.value.captain2.name }}</div>
                    <div class="text-[10px] text-muted-foreground">{{ queue.activeMatch.value.captain2.mmr }} MMR</div>
                  </div>
                  <span class="text-[10px] font-bold text-red-400 bg-red-500/{{ totalPlayers }} px-2 py-0.5 rounded">CPT</span>
                </div>
                <!-- Picked players -->
                <div class="flex flex-col gap-1">
                  <div v-for="p in queue.pickState.value.captain2Picks" :key="p.playerId"
                    class="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-accent/50">
                    <img v-if="p.avatarUrl" :src="p.avatarUrl" class="w-6 h-6 rounded-full" />
                    <span class="text-sm font-medium flex-1 truncate">{{ p.name }}</span>
                    <span class="text-[10px] text-muted-foreground tabular-nums">{{ p.mmr }}</span>
                  </div>
                  <!-- Empty slots -->
                  <div v-for="i in (emptySlots - queue.pickState.value.captain2Picks.length)" :key="'e2-' + i"
                    class="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-dashed border-border/40">
                    <div class="w-6 h-6 rounded-full bg-accent/50"></div>
                    <span class="text-sm text-muted-foreground/30">---</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>

        <!-- ═══════════════════ QUEUE / IDLE ═══════════════════ -->
        <template v-else>
          <!-- Pool cards -->
          <div :class="queue.pools.value.length > 1 ? 'grid grid-cols-1 md:grid-cols-2 gap-4 mb-8' : 'mb-8'">
            <div
              v-for="pool in queue.pools.value" :key="pool.id"
              class="card overflow-hidden cursor-pointer transition-all hover:ring-1 hover:ring-primary/30"
              :class="selectedPoolId === pool.id ? 'ring-2 ring-primary' : ''"
              @click="selectPool(pool.id)"
            >
              <div class="px-5 py-4 flex items-center gap-4">
                <div class="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
                  :class="selectedPoolId === pool.id ? 'bg-primary/15' : 'bg-accent'">
                  <Shield class="w-5 h-5" :class="selectedPoolId === pool.id ? 'text-primary' : 'text-muted-foreground'" />
                </div>
                <div class="flex-1 min-w-0">
                  <div class="font-semibold truncate">{{ pool.name }}</div>
                  <div class="text-xs text-muted-foreground flex items-center gap-3 mt-0.5">
                    <span>{{ pool.team_size || 5 }}v{{ pool.team_size || 5 }}</span>
                    <span v-if="pool.min_mmr || pool.max_mmr">
                      MMR {{ pool.min_mmr || 0 }}{{ pool.max_mmr ? `–${pool.max_mmr}` : '+' }}
                    </span>
                    <span v-else>{{ t('queueAllSkillLevels') }}</span>
                  </div>
                </div>
                <div class="flex flex-col items-end gap-1">
                  <div class="flex items-center gap-1.5 text-sm">
                    <Users class="w-3.5 h-3.5 text-muted-foreground" />
                    <span class="font-mono font-bold" :class="selectedPoolId === pool.id ? 'text-primary' : ''">
                      {{ selectedPoolId === pool.id ? queue.queueCount.value : '—' }}
                    </span>
                    <span class="text-muted-foreground text-xs">/{{ totalPlayers }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Active queue section -->
          <div v-if="selectedPool" class="card overflow-hidden mb-8">
            <!-- Queue bar -->
            <div class="px-6 py-5 flex items-center justify-between gap-4">
              <div class="flex items-center gap-4">
                <div class="flex items-center gap-2">
                  <div class="flex gap-0.5">
                    <div v-for="i in totalPlayers" :key="i"
                      class="w-2 h-6 rounded-sm transition-colors"
                      :class="i <= queue.queueCount.value ? 'bg-primary' : 'bg-accent'"
                    />
                  </div>
                  <span class="font-mono text-lg font-bold tabular-nums ml-2">{{ queue.queueCount.value }}<span class="text-muted-foreground font-normal">/{{ totalPlayers }}</span></span>
                </div>
              </div>
              <div>
                <button v-if="!queue.inQueue.value"
                  class="btn-primary px-8 py-2.5 text-sm font-semibold"
                  @click="handleJoin">
                  {{ t('queueJoin') }}
                </button>
                <button v-else
                  class="relative px-8 py-2.5 rounded-lg text-sm font-semibold border border-primary/30 text-primary bg-primary/5 hover:bg-primary/{{ totalPlayers }} transition-colors flex items-center gap-2"
                  @click="handleLeave">
                  <Loader2 class="w-4 h-4 animate-spin" />
                  {{ t('queueSearching') }}...
                  <span class="text-primary/60 ml-1">{{ t('queueLeave') }}</span>
                </button>
              </div>
            </div>

            <!-- Error -->
            <div v-if="queue.queueError.value" class="px-6 pb-4">
              <div class="px-3 py-2 rounded-lg bg-destructive/{{ totalPlayers }} text-destructive text-sm">
                {{ queue.queueError.value }}
              </div>
            </div>

            <!-- Queued players list -->
            <div v-if="queue.inQueue.value && queue.queuePlayers.value.length > 0" class="px-6 pb-5 pt-0">
              <div class="border-t border-border/30 pt-4">
                <div class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">{{ t('queueInQueue') }}</div>
                <div class="flex flex-wrap gap-2">
                  <div v-for="p in queue.queuePlayers.value" :key="p.playerId"
                    class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-accent/60 text-sm">
                    <img v-if="p.avatarUrl" :src="p.avatarUrl" class="w-5 h-5 rounded-full" />
                    <span class="font-medium">{{ p.name }}</span>
                    <span class="text-[10px] text-muted-foreground tabular-nums">{{ p.mmr }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Pool Chat -->
          <div v-if="selectedPool" class="card overflow-hidden mb-8">
            <div class="px-5 py-3 border-b border-border/30 flex items-center gap-2">
              <MessageSquare class="w-4 h-4 text-muted-foreground" />
              <span class="text-sm font-semibold">{{ t('queueChat') }}</span>
              <span class="text-[10px] text-muted-foreground ml-auto">{{ t('queueChatHint') }}</span>
            </div>
            <div ref="chatScroll" class="px-5 py-3 max-h-64 min-h-[8rem] overflow-y-auto flex flex-col gap-2">
              <div v-if="queue.chatMessages.value.length === 0" class="text-xs text-muted-foreground text-center py-6">
                {{ t('queueChatEmpty') }}
              </div>
              <div v-for="m in queue.chatMessages.value" :key="m.id" class="flex items-start gap-2.5">
                <img v-if="m.avatarUrl" :src="m.avatarUrl" class="w-6 h-6 rounded-full mt-0.5 shrink-0" />
                <div v-else class="w-6 h-6 rounded-full bg-accent shrink-0" />
                <div class="flex-1 min-w-0">
                  <div class="flex items-baseline gap-2">
                    <span class="text-xs font-semibold truncate">{{ m.name }}</span>
                    <span class="text-[10px] text-muted-foreground tabular-nums">{{ new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</span>
                  </div>
                  <div class="text-sm break-words whitespace-pre-wrap">{{ m.text }}</div>
                </div>
              </div>
            </div>
            <form class="px-5 py-3 border-t border-border/30 flex items-center gap-2" @submit.prevent="sendChat">
              <input
                v-model="chatInput"
                type="text"
                maxlength="300"
                :placeholder="t('queueChatPlaceholder')"
                class="flex-1 bg-accent/40 border border-border/40 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
              <button
                type="submit"
                :disabled="!canSendChat"
                class="btn-primary px-3 py-2 text-sm flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Send class="w-3.5 h-3.5" />
                <span v-if="chatCooldownLeft > 0" class="tabular-nums">{{ Math.ceil(chatCooldownLeft / 1000) }}s</span>
                <span v-else>{{ t('queueChatSend') }}</span>
              </button>
            </form>
          </div>

          <!-- Recent Matches -->
          <div v-if="queue.queueHistory.value.length > 0">
            <h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">{{ t('queueRecentMatches') }}</h2>
            <div class="flex flex-col gap-2">
              <router-link v-for="qm in queue.queueHistory.value" :key="qm.id"
                :to="{ name: 'queue-match', params: { id: qm.id } }"
                class="card px-5 py-3.5 flex items-center gap-4 hover:bg-accent/30 transition-colors cursor-pointer">
                <div class="flex items-center gap-2.5 flex-1 min-w-0">
                  <img v-if="qm.captain1_avatar" :src="qm.captain1_avatar" class="w-7 h-7 rounded-full" />
                  <span class="font-medium text-sm truncate">{{ qm.captain1_display_name || qm.captain1_name }}</span>
                </div>
                <div class="px-3 py-1 rounded bg-accent text-xs font-semibold text-muted-foreground">VS</div>
                <div class="flex items-center gap-2.5 flex-1 min-w-0 justify-end">
                  <span class="font-medium text-sm truncate">{{ qm.captain2_display_name || qm.captain2_name }}</span>
                  <img v-if="qm.captain2_avatar" :src="qm.captain2_avatar" class="w-7 h-7 rounded-full" />
                </div>
                <span class="text-[10px] font-semibold px-2.5 py-1 rounded-full"
                  :class="qm.status === 'completed' ? 'bg-green-500/{{ totalPlayers }} text-green-500' : qm.status === 'live' ? 'bg-amber-500/{{ totalPlayers }} text-amber-500' : 'bg-accent text-muted-foreground'">
                  {{ qm.status === 'completed' ? t('matchCompleted') : qm.status === 'live' ? t('matchLive') : qm.status }}
                </span>
              </router-link>
            </div>
          </div>
        </template>
      </template>
    </div>
  </div>
</template>
