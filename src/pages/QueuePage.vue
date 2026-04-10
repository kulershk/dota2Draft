<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { Clock, Users, Trophy, X, Check, Loader2 } from 'lucide-vue-next'
import { useQueueStore, type QueuePlayer } from '@/composables/useQueueStore'
import { useDraftStore } from '@/composables/useDraftStore'
import { getServerNow } from '@/composables/useSocket'
import UserName from '@/components/common/UserName.vue'

const { t } = useI18n()
const router = useRouter()
const store = useDraftStore()
const queue = useQueueStore()

const selectedPoolId = ref<number | null>(null)

const selectedPool = computed(() => queue.pools.value.find(p => p.id === selectedPoolId.value) || null)

const currentUserId = computed(() => store.currentUser.value?.id || null)

const iAmCaptain1 = computed(() => queue.activeMatch.value?.captain1.playerId === currentUserId.value)
const iAmCaptain2 = computed(() => queue.activeMatch.value?.captain2.playerId === currentUserId.value)
const iAmCaptain = computed(() => iAmCaptain1.value || iAmCaptain2.value)

const isMyTurn = computed(() => {
  if (!queue.pickState.value || !iAmCaptain.value) return false
  const cp = queue.pickState.value.currentPicker
  return (cp === 1 && iAmCaptain1.value) || (cp === 2 && iAmCaptain2.value)
})

// Pick timer countdown
const now = ref(getServerNow())
let tickInterval: ReturnType<typeof setInterval> | null = null

const pickTimeLeft = computed(() => {
  if (!queue.pickState.value?.pickTimerEnd) return null
  const remaining = queue.pickState.value.pickTimerEnd - now.value
  return Math.max(0, remaining)
})

function formatTimer(ms: number): string {
  const s = Math.ceil(ms / 1000)
  return `${s}s`
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

onMounted(async () => {
  await queue.fetchPools()
  if (queue.pools.value.length > 0) {
    selectPool(queue.pools.value[0].id)
  }
  tickInterval = setInterval(() => { now.value = getServerNow() }, 200)
})

onUnmounted(() => {
  if (tickInterval) clearInterval(tickInterval)
})
</script>

<template>
  <div class="max-w-5xl mx-auto px-4 py-8">
    <h1 class="text-2xl font-bold mb-6">{{ t('queue') }}</h1>

    <!-- No pools -->
    <div v-if="queue.pools.value.length === 0" class="card px-6 py-12 text-center">
      <p class="text-muted-foreground">{{ t('queueNoPools') }}</p>
    </div>

    <template v-else>
      <!-- Pool selector -->
      <div v-if="queue.pools.value.length > 1" class="flex gap-2 mb-6 flex-wrap">
        <button
          v-for="pool in queue.pools.value" :key="pool.id"
          class="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          :class="selectedPoolId === pool.id ? 'bg-primary text-primary-foreground' : 'bg-accent text-foreground hover:bg-accent/80'"
          @click="selectPool(pool.id)"
        >
          {{ pool.name }}
          <span v-if="pool.min_mmr || pool.max_mmr" class="text-xs opacity-70 ml-1">
            ({{ pool.min_mmr || 0 }}{{ pool.max_mmr ? `-${pool.max_mmr}` : '+' }})
          </span>
        </button>
      </div>

      <!-- Active match: Pick Phase -->
      <div v-if="queue.activeMatch.value" class="mb-6">
        <!-- Cancelled -->
        <div v-if="queue.cancelled.value" class="card px-6 py-8 text-center mb-4">
          <X class="w-8 h-8 text-destructive mx-auto mb-2" />
          <p class="text-lg font-semibold mb-1">{{ t('queueMatchCancelled') }}</p>
          <p class="text-muted-foreground text-sm">{{ queue.cancelled.value }}</p>
          <button class="btn-primary mt-4" @click="queue.resetMatchState()">{{ t('queueBackToQueue') }}</button>
        </div>

        <!-- Lobby Created -->
        <div v-else-if="queue.lobbyInfo.value" class="card px-6 py-8 text-center mb-4">
          <Check class="w-8 h-8 text-green-500 mx-auto mb-2" />
          <p class="text-lg font-semibold mb-2">{{ t('queueLobbyCreated') }}</p>
          <div class="flex flex-col items-center gap-2 text-sm">
            <div><span class="text-muted-foreground">{{ t('queueLobbyName') }}:</span> <span class="font-mono font-bold">{{ queue.lobbyInfo.value.gameName }}</span></div>
            <div><span class="text-muted-foreground">{{ t('queueLobbyPassword') }}:</span> <span class="font-mono font-bold">{{ queue.lobbyInfo.value.password }}</span></div>
          </div>
        </div>

        <!-- Teams Formed, waiting for lobby -->
        <div v-else-if="queue.teamsFormed.value" class="card px-6 py-8 text-center mb-4">
          <Loader2 class="w-8 h-8 text-primary mx-auto mb-2 animate-spin" />
          <p class="text-lg font-semibold">{{ t('queueCreatingLobby') }}</p>
        </div>

        <!-- Pick Phase -->
        <div v-else-if="queue.pickState.value" class="card overflow-hidden mb-4">
          <!-- Header with timer -->
          <div class="px-6 py-4 border-b border-border/30 flex items-center justify-between">
            <div class="text-lg font-bold">{{ t('queuePickPhase') }}</div>
            <div v-if="pickTimeLeft != null" class="flex items-center gap-2">
              <Clock class="w-4 h-4" :class="pickTimeLeft < 5000 ? 'text-destructive' : 'text-muted-foreground'" />
              <span class="font-mono font-bold text-lg" :class="pickTimeLeft < 5000 ? 'text-destructive' : ''">
                {{ formatTimer(pickTimeLeft) }}
              </span>
            </div>
          </div>

          <div class="grid grid-cols-3 gap-0">
            <!-- Team 1 (Captain 1) -->
            <div class="p-4 border-r border-border/30">
              <div class="flex items-center gap-2 mb-3">
                <div class="w-2 h-2 rounded-full" :class="queue.pickState.value.currentPicker === 1 ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground/30'"></div>
                <span class="text-sm font-bold text-green-400">{{ t('queueRadiant') }}</span>
              </div>
              <!-- Captain -->
              <div class="flex items-center gap-2 mb-2 px-2 py-1.5 rounded bg-green-500/10 border border-green-500/20">
                <img v-if="queue.activeMatch.value.captain1.avatarUrl" :src="queue.activeMatch.value.captain1.avatarUrl" class="w-6 h-6 rounded-full" />
                <span class="text-sm font-semibold">{{ queue.activeMatch.value.captain1.name }}</span>
                <span class="text-[10px] font-medium text-primary bg-primary/10 px-1.5 py-0.5 rounded ml-auto">C</span>
                <span class="text-[10px] text-muted-foreground">{{ queue.activeMatch.value.captain1.mmr }}</span>
              </div>
              <!-- Picks -->
              <div v-for="(p, i) in queue.pickState.value.captain1Picks" :key="p.playerId" class="flex items-center gap-2 px-2 py-1.5">
                <img v-if="p.avatarUrl" :src="p.avatarUrl" class="w-5 h-5 rounded-full" />
                <span class="text-sm">{{ p.name }}</span>
                <span class="text-[10px] text-muted-foreground ml-auto">{{ p.mmr }}</span>
              </div>
              <div v-for="i in (4 - queue.pickState.value.captain1Picks.length)" :key="'empty1-' + i" class="px-2 py-1.5 text-sm text-muted-foreground/30 italic">
                ---
              </div>
            </div>

            <!-- Available Players (center) -->
            <div class="p-4">
              <div class="text-sm font-medium text-muted-foreground mb-3 text-center">
                {{ isMyTurn ? t('queueYourTurn') : t('queueWaitingForPick') }}
              </div>
              <div class="flex flex-col gap-1">
                <button
                  v-for="p in queue.pickState.value.availablePlayers" :key="p.playerId"
                  class="flex items-center gap-2 px-3 py-2 rounded text-sm transition-colors text-left"
                  :class="isMyTurn ? 'hover:bg-primary/10 cursor-pointer' : 'cursor-default opacity-70'"
                  :disabled="!isMyTurn"
                  @click="isMyTurn && handlePick(p.playerId)"
                >
                  <img v-if="p.avatarUrl" :src="p.avatarUrl" class="w-5 h-5 rounded-full" />
                  <span class="font-medium">{{ p.name }}</span>
                  <span class="text-[10px] text-muted-foreground ml-auto">{{ p.mmr }}</span>
                </button>
              </div>
            </div>

            <!-- Team 2 (Captain 2) -->
            <div class="p-4 border-l border-border/30">
              <div class="flex items-center gap-2 mb-3">
                <div class="w-2 h-2 rounded-full" :class="queue.pickState.value.currentPicker === 2 ? 'bg-red-500 animate-pulse' : 'bg-muted-foreground/30'"></div>
                <span class="text-sm font-bold text-red-400">{{ t('queueDire') }}</span>
              </div>
              <!-- Captain -->
              <div class="flex items-center gap-2 mb-2 px-2 py-1.5 rounded bg-red-500/10 border border-red-500/20">
                <img v-if="queue.activeMatch.value.captain2.avatarUrl" :src="queue.activeMatch.value.captain2.avatarUrl" class="w-6 h-6 rounded-full" />
                <span class="text-sm font-semibold">{{ queue.activeMatch.value.captain2.name }}</span>
                <span class="text-[10px] font-medium text-primary bg-primary/10 px-1.5 py-0.5 rounded ml-auto">C</span>
                <span class="text-[10px] text-muted-foreground">{{ queue.activeMatch.value.captain2.mmr }}</span>
              </div>
              <!-- Picks -->
              <div v-for="(p, i) in queue.pickState.value.captain2Picks" :key="p.playerId" class="flex items-center gap-2 px-2 py-1.5">
                <img v-if="p.avatarUrl" :src="p.avatarUrl" class="w-5 h-5 rounded-full" />
                <span class="text-sm">{{ p.name }}</span>
                <span class="text-[10px] text-muted-foreground ml-auto">{{ p.mmr }}</span>
              </div>
              <div v-for="i in (4 - queue.pickState.value.captain2Picks.length)" :key="'empty2-' + i" class="px-2 py-1.5 text-sm text-muted-foreground/30 italic">
                ---
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Queue Status + Join/Leave -->
      <div v-if="!queue.activeMatch.value" class="card px-6 py-6 mb-6">
        <div class="flex items-center justify-between">
          <div>
            <div v-if="selectedPool" class="text-lg font-semibold mb-1">{{ selectedPool.name }}</div>
            <div class="flex items-center gap-4 text-sm text-muted-foreground">
              <span class="flex items-center gap-1"><Users class="w-4 h-4" /> {{ queue.queueCount.value }}/10 {{ t('queuePlayers') }}</span>
              <span v-if="selectedPool?.min_mmr || selectedPool?.max_mmr">
                MMR: {{ selectedPool?.min_mmr || 0 }}{{ selectedPool?.max_mmr ? `-${selectedPool.max_mmr}` : '+' }}
              </span>
            </div>
          </div>
          <div>
            <button v-if="!queue.inQueue.value" class="btn-primary px-6 py-2.5" @click="handleJoin">
              {{ t('queueJoin') }}
            </button>
            <button v-else class="btn-outline px-6 py-2.5 flex items-center gap-2" @click="handleLeave">
              <Loader2 class="w-4 h-4 animate-spin" />
              {{ t('queueSearching') }}... {{ t('queueLeave') }}
            </button>
          </div>
        </div>
        <!-- Error -->
        <div v-if="queue.queueError.value" class="mt-3 px-3 py-2 rounded bg-destructive/10 text-destructive text-sm">
          {{ queue.queueError.value }}
        </div>
        <!-- Queued players -->
        <div v-if="queue.inQueue.value && queue.queuePlayers.value.length > 0" class="mt-4 pt-4 border-t border-border/30">
          <div class="text-xs text-muted-foreground mb-2">{{ t('queueInQueue') }}:</div>
          <div class="flex flex-wrap gap-2">
            <div v-for="p in queue.queuePlayers.value" :key="p.playerId" class="flex items-center gap-1.5 px-2 py-1 rounded bg-accent text-sm">
              <img v-if="p.avatarUrl" :src="p.avatarUrl" class="w-4 h-4 rounded-full" />
              <span>{{ p.name }}</span>
              <span class="text-[10px] text-muted-foreground">{{ p.mmr }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Recent Matches -->
      <div v-if="queue.queueHistory.value.length > 0">
        <h2 class="text-lg font-semibold mb-3">{{ t('queueRecentMatches') }}</h2>
        <div class="flex flex-col gap-2">
          <div v-for="qm in queue.queueHistory.value" :key="qm.id" class="card px-4 py-3 flex items-center gap-4">
            <div class="flex items-center gap-2 flex-1 min-w-0">
              <img v-if="qm.captain1_avatar" :src="qm.captain1_avatar" class="w-6 h-6 rounded-full" />
              <span class="font-medium text-sm truncate">{{ qm.captain1_display_name || qm.captain1_name }}</span>
            </div>
            <span class="text-xs text-muted-foreground">vs</span>
            <div class="flex items-center gap-2 flex-1 min-w-0 justify-end">
              <span class="font-medium text-sm truncate">{{ qm.captain2_display_name || qm.captain2_name }}</span>
              <img v-if="qm.captain2_avatar" :src="qm.captain2_avatar" class="w-6 h-6 rounded-full" />
            </div>
            <span class="text-[10px] px-2 py-0.5 rounded"
              :class="qm.status === 'completed' ? 'bg-green-500/10 text-green-500' : qm.status === 'live' ? 'bg-amber-500/10 text-amber-500' : 'bg-accent text-muted-foreground'">
              {{ qm.status }}
            </span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
