<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { Clock, Users, Swords, X, Check, Loader2, Shield, ChevronRight, Timer, Send, MessageSquare, Ban, Target, Copy, Eye, EyeOff, Hourglass } from 'lucide-vue-next'
import { useQueueStore, type QueuePlayer, QUEUE_ROLES } from '@/composables/useQueueStore'
import { useDraftStore } from '@/composables/useDraftStore'
import { getServerNow } from '@/composables/useSocket'
import { formatRelativeTime } from '@/utils/format'

function teamAvgMmr(players: any[] | undefined | null): number {
  if (!players?.length) return 0
  const withMmr = players.filter(p => Number(p?.mmr) > 0)
  if (!withMmr.length) return 0
  return Math.round(withMmr.reduce((s, p) => s + Number(p.mmr), 0) / withMmr.length)
}

function winnerSide(qm: any): 1 | 2 | null {
  if (qm?.winner_captain_id == null) return null
  if (qm.winner_captain_id === qm.captain1_player_id) return 1
  if (qm.winner_captain_id === qm.captain2_player_id) return 2
  return null
}

const { t } = useI18n()
const router = useRouter()
const store = useDraftStore()
const queue = useQueueStore()

const selectedPoolId = ref<number | null>(null)

const HISTORY_PER_PAGE = 5
const historyPage = ref(1)
const totalHistoryPages = computed(() => Math.max(1, Math.ceil(queue.queueHistory.value.length / HISTORY_PER_PAGE)))
const pagedHistory = computed(() => {
  const start = (historyPage.value - 1) * HISTORY_PER_PAGE
  return queue.queueHistory.value.slice(start, start + HISTORY_PER_PAGE)
})
watch(totalHistoryPages, (n) => { if (historyPage.value > n) historyPage.value = n })

const selectedPool = computed(() => queue.pools.value.find(p => p.id === selectedPoolId.value) || null)
const teamSize = computed(() => (selectedPool.value as any)?.team_size || 5)
const totalPlayers = computed(() => teamSize.value * 2)
const emptySlots = computed(() => teamSize.value - 1) // per team, excluding captain

const currentUserId = computed(() => store.currentUser.value?.id || null)

const iAmCaptain1 = computed(() => queue.activeMatch.value?.captain1.playerId === currentUserId.value)
const iAmCaptain2 = computed(() => queue.activeMatch.value?.captain2.playerId === currentUserId.value)
const iAmCaptain = computed(() => iAmCaptain1.value || iAmCaptain2.value)
const iAmParticipant = computed(() => {
  const uid = currentUserId.value
  if (!uid || !queue.activeMatch.value) return false
  return queue.activeMatch.value.players.some(p => p.playerId === uid)
})
const myPrefs = computed<string[]>(() => {
  const uid = currentUserId.value
  if (!uid) return []
  return queue.rolePreferences.value[uid] || []
})
function myRoleRank(role: string): number | null {
  const idx = myPrefs.value.indexOf(role)
  return idx >= 0 ? idx + 1 : null
}

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

const passwordVisible = ref(false)
const copiedKey = ref<string | null>(null)
async function copyToClipboard(key: string, text: string) {
  try {
    await navigator.clipboard.writeText(text)
    copiedKey.value = key
    setTimeout(() => { if (copiedKey.value === key) copiedKey.value = null }, 1500)
  } catch {}
}
function isInLobby(steamId: string | undefined): boolean {
  if (!steamId) return false
  return queue.lobbyPlayersJoined.value.includes(steamId)
}
const joinedCount = computed(() => queue.lobbyPlayersJoined.value.length)
function topRoleOf(playerId: number): string | null {
  const prefs = queue.rolePreferences.value[playerId]
  return (prefs && prefs.length) ? prefs[0] : null
}

// Queue ban — banner + live countdown
const banRemainingMs = computed(() => {
  const b = queue.myBan.value
  if (!b) return 0
  if (b.bannedUntil == null) return Infinity // permanent
  const end = new Date(b.bannedUntil).getTime()
  return Math.max(0, end - now.value)
})
const isBanned = computed(() => !!queue.myBan.value && (banRemainingMs.value > 0))
function formatBanRemaining(ms: number): string {
  if (!Number.isFinite(ms)) return t('queueAdminBanPermanent')
  const s = Math.ceil(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return rs > 0 ? `${m}m ${rs}s` : `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  if (h < 24) return rm > 0 ? `${h}h ${rm}m` : `${h}h`
  const d = Math.floor(h / 24)
  const rh = h % 24
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`
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

// Keep the W/L mini form guide in sync with the live queue roster. Only
// fetch when the viewer is themselves queued (the card is hidden otherwise).
watch(
  () => [
    queue.inQueue.value,
    selectedPoolId.value,
    queue.queuePlayers.value.map(p => p.playerId).sort((a, b) => a - b).join(','),
  ] as const,
  ([inQ, poolId, ids]) => {
    if (!inQ || !poolId || !ids) return
    const idList = ids.split(',').map(Number).filter(Boolean)
    if (idList.length > 0) queue.fetchPlayerStats(poolId, idList)
  },
  { immediate: true }
)

onMounted(async () => {
  await queue.fetchPools()
  if (queue.pools.value.length > 0) {
    // If we're already queued or in an active match on some pool, preselect
    // that one instead of clobbering state with pools[0]. Otherwise fall back
    // to the first pool.
    const preferred = (queue.inQueue.value || queue.activeMatch.value)
      ? queue.currentPoolId.value
      : null
    const initial = preferred && queue.pools.value.some(p => p.id === preferred)
      ? preferred
      : queue.pools.value[0].id
    selectPool(initial)
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
  <div class="flex flex-col flex-1">
    <!-- Ready-check failure banner -->
    <div
      v-if="queue.readyCheckFailed.value"
      class="max-w-[1200px] mx-auto w-full px-4 md:px-8 pt-4"
    >
      <div class="card overflow-hidden border border-destructive/40">
        <div class="h-1 bg-destructive" />
        <div class="px-5 py-3 flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-destructive/15 flex items-center justify-center shrink-0">
            <X class="w-4 h-4 text-destructive" />
          </div>
          <div class="flex-1 text-sm">
            <template v-if="queue.readyCheckFailed.value.requeued">
              {{ t('queueReadyCheckRequeued') }}
            </template>
            <template v-else-if="queue.readyCheckFailed.value.reason === 'declined'">
              {{ t('queueReadyCheckFailedDeclined') }}
              <template v-if="queue.readyCheckFailed.value.banMinutes > 0">
                {{ t('queueReadyCheckBanSuffix', { mins: queue.readyCheckFailed.value.banMinutes }) }}
              </template>
            </template>
            <template v-else>
              {{ t('queueReadyCheckFailedTimeout') }}
              <template v-if="queue.readyCheckFailed.value.banMinutes > 0">
                {{ t('queueReadyCheckBanSuffix', { mins: queue.readyCheckFailed.value.banMinutes }) }}
              </template>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- Slim page header -->
    <div class="max-w-[1200px] mx-auto w-full px-4 md:px-8 pt-6 pb-4">
      <h1 class="text-2xl font-bold">{{ t('queue') }}</h1>
      <p class="text-muted-foreground text-sm mt-0.5">{{ t('queueDesc') }}</p>
    </div>

    <!-- Pool submenu (tab bar, full-width, only when there are pools and not in pick phase) -->
    <template v-if="queue.pools.value.length > 0 && !queue.activeMatch.value">
      <div class="bg-muted">
        <div class="max-w-[1200px] mx-auto w-full px-4 md:px-8 flex items-center overflow-x-auto">
          <button
            v-for="pool in queue.pools.value" :key="pool.id"
            type="button"
            class="flex items-center gap-1.5 px-6 py-3.5 text-sm transition-colors whitespace-nowrap border-b-2"
            :class="selectedPoolId === pool.id
              ? 'text-primary font-semibold border-primary'
              : 'text-text-tertiary border-transparent hover:text-foreground'"
            @click="selectPool(pool.id)"
          >
            <Shield class="w-3.5 h-3.5" />
            <span>{{ pool.name }}</span>
            <span class="text-[10px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full min-w-[1.25rem] text-center"
              :class="selectedPoolId === pool.id
                ? 'bg-primary/15 text-primary'
                : ((queue.poolCounts.value[pool.id] || 0) > 0 ? 'bg-accent text-foreground' : 'bg-accent/50 text-muted-foreground')">
              {{ queue.poolCounts.value[pool.id] || 0 }}
            </span>
          </button>
        </div>
      </div>
      <div class="h-px bg-border" />
    </template>

    <div class="max-w-[1200px] mx-auto w-full px-4 md:px-8 py-6">
      <!-- Queue ban banner (shown before anything else, no pools needed) -->
      <div v-if="isBanned" class="card overflow-hidden mb-6 border border-destructive/40">
        <div class="h-1 bg-destructive" />
        <div class="px-6 py-5 flex items-center gap-4">
          <div class="w-10 h-10 rounded-lg bg-destructive/15 flex items-center justify-center shrink-0">
            <Ban class="w-5 h-5 text-destructive" />
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-bold text-destructive">{{ t('queueBannedTitle') }}</div>
            <div class="text-xs text-muted-foreground mt-0.5">
              <template v-if="queue.myBan.value?.reason">{{ queue.myBan.value.reason }}</template>
              <template v-else>{{ t('queueBannedNoReason') }}</template>
            </div>
            <div class="text-xs text-muted-foreground mt-0.5">
              {{ t('queueBannedBy', { name: queue.myBan.value?.bannedBy || t('queueBannedBySystem') }) }}
            </div>
          </div>
          <div class="text-right">
            <div class="text-[10px] font-semibold uppercase text-muted-foreground">{{ t('queueBannedUntil') }}</div>
            <div class="text-xl font-mono font-bold tabular-nums text-destructive">{{ formatBanRemaining(banRemainingMs) }}</div>
          </div>
        </div>
      </div>

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
          <div v-else-if="queue.lobbyInfo.value" class="flex flex-col gap-4">

            <!-- Hero header -->
            <div class="flex items-start justify-between gap-6 flex-wrap">
              <div>
                <div class="flex items-center gap-3 mb-1">
                  <h2 class="text-3xl font-bold tracking-tight">{{ t('queueLobbyReady') }}</h2>
                  <span class="text-[10px] font-bold tracking-wider bg-green-500/15 text-green-400 border border-green-500/30 px-2.5 py-1 rounded-full flex items-center gap-1.5">
                    <Check class="w-3 h-3" /> {{ t('queueLobbyReadyBadge') }}
                  </span>
                </div>
                <p class="text-sm text-muted-foreground">{{ t('queueLobbyReadyHint') }}</p>
              </div>
            </div>

            <!-- Phase bar -->
            <div class="card px-5 py-4 flex items-center gap-6 flex-wrap">
              <div class="flex items-center gap-3 flex-1 min-w-[220px]">
                <div class="w-9 h-9 rounded-lg bg-green-500/15 border border-green-500/30 flex items-center justify-center shrink-0">
                  <Check class="w-4 h-4 text-green-400" />
                </div>
                <div class="flex flex-col">
                  <span class="text-[10px] font-bold tracking-[0.1em] text-green-400">{{ t('queueLobbyCreatedPhase') }}</span>
                  <span class="text-xs text-muted-foreground">{{ t('queueLobbyWaitingForPlayers') }}</span>
                </div>
              </div>
              <div class="flex items-center gap-3">
                <div class="flex flex-col items-end">
                  <span class="text-[10px] font-bold tracking-[0.1em] text-muted-foreground">{{ t('queueLobbyJoined') }}</span>
                  <span class="font-mono text-sm font-bold tabular-nums">{{ joinedCount }} <span class="text-muted-foreground">/ {{ totalPlayers }}</span> <span class="text-xs text-muted-foreground font-normal">{{ t('queueLobbyJoinedSuffix') }}</span></span>
                </div>
              </div>
              <div v-if="lobbyTimeLeft != null && lobbyTimeLeft > 0" class="flex items-center gap-2 border-l border-border/30 pl-6">
                <Hourglass class="w-4 h-4" :class="lobbyTimeLeft < 60000 ? 'text-destructive' : 'text-amber-400'" />
                <div class="flex flex-col items-end">
                  <span class="text-[10px] font-bold tracking-[0.1em] text-muted-foreground">{{ t('queueLobbyExpiresIn') }}</span>
                  <span class="font-mono font-bold text-xl tabular-nums leading-tight" :class="lobbyTimeLeft < 60000 ? 'text-destructive' : 'text-amber-400'">
                    {{ formatLobbyTimer(lobbyTimeLeft) }}
                  </span>
                </div>
              </div>
            </div>

            <!-- Credentials -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div class="card p-5 flex flex-col gap-3">
                <div class="text-[10px] font-bold tracking-[0.1em] text-muted-foreground">{{ t('queueLobbyName') }}</div>
                <div class="flex items-center gap-3">
                  <span class="font-mono font-bold text-lg flex-1 truncate select-all">{{ queue.lobbyInfo.value.gameName }}</span>
                  <button
                    class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-accent hover:bg-accent/70 transition-colors"
                    @click="copyToClipboard('name', queue.lobbyInfo.value.gameName)"
                  >
                    <Check v-if="copiedKey === 'name'" class="w-3.5 h-3.5 text-green-400" />
                    <Copy v-else class="w-3.5 h-3.5" />
                    {{ copiedKey === 'name' ? t('queueCopied') : t('queueCopy') }}
                  </button>
                </div>
              </div>
              <div class="card p-5 flex flex-col gap-3">
                <div class="text-[10px] font-bold tracking-[0.1em] text-muted-foreground">{{ t('queueLobbyPassword') }}</div>
                <div class="flex items-center gap-3">
                  <span class="font-mono font-bold text-lg flex-1 truncate select-all tracking-widest">
                    {{ passwordVisible ? queue.lobbyInfo.value.password : '•'.repeat(queue.lobbyInfo.value.password.length) }}
                  </span>
                  <button
                    class="p-1.5 rounded-lg hover:bg-accent transition-colors"
                    :title="passwordVisible ? t('queueHidePassword') : t('queueShowPassword')"
                    @click="passwordVisible = !passwordVisible"
                  >
                    <EyeOff v-if="passwordVisible" class="w-4 h-4 text-muted-foreground" />
                    <Eye v-else class="w-4 h-4 text-muted-foreground" />
                  </button>
                  <button
                    class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-accent hover:bg-accent/70 transition-colors"
                    @click="copyToClipboard('pass', queue.lobbyInfo.value.password)"
                  >
                    <Check v-if="copiedKey === 'pass'" class="w-3.5 h-3.5 text-green-400" />
                    <Copy v-else class="w-3.5 h-3.5" />
                    {{ copiedKey === 'pass' ? t('queueCopied') : t('queueCopy') }}
                  </button>
                </div>
              </div>
            </div>

            <!-- Teams -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <!-- Radiant -->
              <div class="card overflow-hidden">
                <div class="h-1 bg-green-500" />
                <div class="px-5 py-4 border-b border-border/30 flex items-center justify-between gap-3">
                  <div class="flex items-center gap-2.5">
                    <div class="w-8 h-8 rounded-lg bg-green-500/15 border border-green-500/30 flex items-center justify-center">
                      <Shield class="w-4 h-4 text-green-400" />
                    </div>
                    <div class="flex flex-col">
                      <span class="text-[10px] font-bold tracking-[0.1em] text-green-400">{{ t('queueRadiant') }}</span>
                      <span class="text-xs font-semibold">{{ queue.teamsFormed.value?.team1?.[0]?.name || '—' }}'s team</span>
                    </div>
                  </div>
                  <span class="text-[10px] font-bold tracking-wider bg-green-500/15 text-green-400 border border-green-500/30 px-2 py-1 rounded-full">
                    {{ (queue.teamsFormed.value?.team1 || []).filter(p => isInLobby(p.steamId)).length }}/{{ teamSize }} {{ t('queueLobbyInLobby') }}
                  </span>
                </div>
                <div class="flex flex-col">
                  <div v-for="(p, idx) in (queue.teamsFormed.value?.team1 || [])" :key="p.playerId"
                    class="px-4 py-2.5 flex items-center gap-3 border-b border-border/20 last:border-b-0"
                    :class="isInLobby(p.steamId) ? '' : 'opacity-80'">
                    <img v-if="p.avatarUrl" :src="p.avatarUrl" class="w-8 h-8 rounded-full" :class="idx === 0 ? 'ring-2 ring-green-500/40' : ''" />
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="text-sm font-semibold truncate">{{ p.name }}</span>
                        <span v-if="idx === 0" class="text-[9px] font-bold text-green-400 bg-green-500/15 px-1.5 py-0.5 rounded">CPT</span>
                        <span v-if="topRoleOf(p.playerId)" class="text-[9px] font-bold text-purple-300 bg-purple-500/15 border border-purple-500/30 px-1.5 py-0.5 rounded">
                          {{ t('queueRoleShort_' + topRoleOf(p.playerId)) }}
                        </span>
                      </div>
                      <div class="text-[10px] text-muted-foreground">{{ p.mmr }} MMR</div>
                    </div>
                    <span v-if="isInLobby(p.steamId)" class="text-[10px] font-bold tracking-wider text-green-400 bg-green-500/10 px-2 py-1 rounded-full flex items-center gap-1">
                      <Check class="w-3 h-3" /> {{ t('queueLobbyInLobby') }}
                    </span>
                    <span v-else class="text-[10px] font-semibold text-muted-foreground bg-accent/60 px-2 py-1 rounded-full flex items-center gap-1">
                      <Loader2 class="w-3 h-3 animate-spin" /> {{ t('queueLobbyNotReady') }}
                    </span>
                  </div>
                </div>
              </div>

              <!-- Dire -->
              <div class="card overflow-hidden">
                <div class="h-1 bg-red-500" />
                <div class="px-5 py-4 border-b border-border/30 flex items-center justify-between gap-3">
                  <div class="flex items-center gap-2.5">
                    <div class="w-8 h-8 rounded-lg bg-red-500/15 border border-red-500/30 flex items-center justify-center">
                      <Shield class="w-4 h-4 text-red-400" />
                    </div>
                    <div class="flex flex-col">
                      <span class="text-[10px] font-bold tracking-[0.1em] text-red-400">{{ t('queueDire') }}</span>
                      <span class="text-xs font-semibold">{{ queue.teamsFormed.value?.team2?.[0]?.name || '—' }}'s team</span>
                    </div>
                  </div>
                  <span class="text-[10px] font-bold tracking-wider bg-red-500/15 text-red-400 border border-red-500/30 px-2 py-1 rounded-full">
                    {{ (queue.teamsFormed.value?.team2 || []).filter(p => isInLobby(p.steamId)).length }}/{{ teamSize }} {{ t('queueLobbyInLobby') }}
                  </span>
                </div>
                <div class="flex flex-col">
                  <div v-for="(p, idx) in (queue.teamsFormed.value?.team2 || [])" :key="p.playerId"
                    class="px-4 py-2.5 flex items-center gap-3 border-b border-border/20 last:border-b-0"
                    :class="isInLobby(p.steamId) ? '' : 'opacity-80'">
                    <img v-if="p.avatarUrl" :src="p.avatarUrl" class="w-8 h-8 rounded-full" :class="idx === 0 ? 'ring-2 ring-red-500/40' : ''" />
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="text-sm font-semibold truncate">{{ p.name }}</span>
                        <span v-if="idx === 0" class="text-[9px] font-bold text-red-400 bg-red-500/15 px-1.5 py-0.5 rounded">CPT</span>
                        <span v-if="topRoleOf(p.playerId)" class="text-[9px] font-bold text-purple-300 bg-purple-500/15 border border-purple-500/30 px-1.5 py-0.5 rounded">
                          {{ t('queueRoleShort_' + topRoleOf(p.playerId)) }}
                        </span>
                      </div>
                      <div class="text-[10px] text-muted-foreground">{{ p.mmr }} MMR</div>
                    </div>
                    <span v-if="isInLobby(p.steamId)" class="text-[10px] font-bold tracking-wider text-green-400 bg-green-500/10 px-2 py-1 rounded-full flex items-center gap-1">
                      <Check class="w-3 h-3" /> {{ t('queueLobbyInLobby') }}
                    </span>
                    <span v-else class="text-[10px] font-semibold text-muted-foreground bg-accent/60 px-2 py-1 rounded-full flex items-center gap-1">
                      <Loader2 class="w-3 h-3 animate-spin" /> {{ t('queueLobbyNotReady') }}
                    </span>
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

            <!-- Your Role Preference (visible to every participant) -->
            <div v-if="iAmParticipant" class="px-6 py-4 border-b border-border/30 flex items-center gap-4 flex-wrap bg-purple-500/5">
              <div class="flex items-center gap-2.5 min-w-[220px]">
                <div class="w-8 h-8 rounded-lg bg-purple-500/15 border border-purple-500/30 flex items-center justify-center shrink-0">
                  <Target class="w-3.5 h-3.5 text-purple-400" />
                </div>
                <div class="flex flex-col">
                  <span class="text-[10px] font-bold tracking-[0.1em] text-purple-400">{{ t('queueYourRolePref') }}</span>
                  <span class="text-[11px] text-muted-foreground">{{ t('queueYourRolePrefHint') }}</span>
                </div>
              </div>
              <div class="flex items-center gap-1.5 flex-wrap flex-1">
                <button
                  v-for="role in QUEUE_ROLES" :key="role"
                  type="button"
                  class="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold transition-colors border"
                  :class="myRoleRank(role)
                    ? 'bg-purple-500 border-purple-500 text-white'
                    : 'border-border/60 text-muted-foreground hover:border-purple-500/50 hover:text-foreground'"
                  @click="queue.toggleRolePreference(role, currentUserId)"
                >
                  <span v-if="myRoleRank(role)" class="inline-flex items-center justify-center min-w-[14px] text-[10px]">{{ myRoleRank(role) }}·</span>
                  {{ t('queueRole_' + role) }}
                </button>
              </div>
              <span v-if="myPrefs.length > 0" class="text-[10px] font-bold tracking-wider text-green-400 flex items-center gap-1">
                <Check class="w-3 h-3" /> {{ t('queueRolePrefSaved') }}
              </span>
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
                    class="flex flex-col gap-1.5 px-3 py-2.5 rounded-lg text-sm transition-all text-left"
                    :class="isMyTurn
                      ? 'hover:bg-primary/{{ totalPlayers }} hover:ring-1 hover:ring-primary/30 cursor-pointer'
                      : 'cursor-default opacity-60'"
                    :disabled="!isMyTurn"
                    @click="isMyTurn && handlePick(p.playerId)"
                  >
                    <div class="flex items-center gap-2.5 w-full">
                      <img v-if="p.avatarUrl" :src="p.avatarUrl" class="w-6 h-6 rounded-full" />
                      <span class="font-medium flex-1 truncate">{{ p.name }}</span>
                      <span class="text-[10px] text-muted-foreground tabular-nums">{{ p.mmr }}</span>
                      <ChevronRight v-if="isMyTurn" class="w-3.5 h-3.5 text-muted-foreground/50" />
                    </div>
                    <div v-if="(queue.rolePreferences.value[p.playerId] || []).length > 0" class="flex items-center gap-1 flex-wrap pl-8">
                      <span class="text-[9px] font-bold tracking-wider text-purple-400">{{ t('queueWants') }}</span>
                      <span
                        v-for="(role, rank) in queue.rolePreferences.value[p.playerId]" :key="role"
                        class="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                        :class="rank < 3
                          ? 'bg-purple-500/20 border border-purple-500/50 text-purple-300'
                          : 'bg-accent text-muted-foreground'"
                      >
                        <template v-if="rank < 3">{{ rank + 1 }}· </template>{{ t('queueRoleShort_' + role) }}
                      </span>
                    </div>
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
          <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-6">
            <!-- Left column -->
            <div class="flex flex-col gap-6 min-w-0">
              <!-- Pool card: header + big count + progress + ready row + CTA -->
              <div v-if="selectedPool" class="card overflow-hidden">
                <div class="px-6 py-4 border-b border-border/30 flex items-center gap-3">
                  <div class="w-10 h-10 rounded-lg bg-primary/15 flex items-center justify-center shrink-0">
                    <Shield class="w-5 h-5 text-primary" />
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="font-bold truncate">{{ selectedPool.name }}</div>
                    <div class="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
                      <span>{{ teamSize }}v{{ teamSize }}</span>
                      <span v-if="(selectedPool as any).min_mmr || (selectedPool as any).max_mmr">
                        · MMR {{ (selectedPool as any).min_mmr || 0 }}{{ (selectedPool as any).max_mmr ? `–${(selectedPool as any).max_mmr}` : '+' }}
                      </span>
                      <span v-else>· {{ t('queueAllSkillLevels') }}</span>
                    </div>
                  </div>
                  <span class="text-[10px] font-semibold bg-primary/10 text-primary px-2.5 py-1 rounded-full uppercase tracking-wider">
                    {{ t('captains') }}
                  </span>
                </div>

                <div class="px-6 py-6">
                  <div class="flex items-baseline gap-3 mb-3">
                    <span class="text-6xl font-bold tabular-nums leading-none">{{ queue.queueCount.value }}</span>
                    <span class="text-sm text-muted-foreground">/ {{ totalPlayers }} {{ t('queuePlayers') }}</span>
                  </div>
                  <div class="w-full h-1.5 bg-accent rounded-full overflow-hidden">
                    <div class="h-full bg-primary transition-all duration-300"
                         :style="{ width: Math.min(100, (queue.queueCount.value / totalPlayers) * 100) + '%' }" />
                  </div>
                  <div v-if="queue.queueCount.value < totalPlayers" class="text-[11px] text-muted-foreground mt-2">
                    {{ t('queueNeedMoreToStart', { n: totalPlayers - queue.queueCount.value }) }}
                  </div>
                </div>

                <div class="px-6 py-4 border-t border-border/30 bg-accent/20 flex items-center justify-between gap-4">
                  <div class="flex items-center gap-2 min-w-0">
                    <Check class="w-4 h-4 text-green-500 shrink-0" />
                    <span class="text-sm font-medium">{{ t('queueYouAreReady') }}</span>
                    <span v-if="store.currentUser.value?.mmr" class="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                      · {{ store.currentUser.value.mmr }} MMR
                    </span>
                  </div>
                  <div class="shrink-0">
                    <button v-if="!queue.inQueue.value"
                      class="btn-primary px-8 py-2.5 text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
                      :disabled="isBanned"
                      @click="handleJoin">
                      {{ t('queueJoin') }}
                    </button>
                    <button v-else
                      class="px-6 py-2.5 rounded-lg text-sm font-semibold border border-primary/30 text-primary bg-primary/5 hover:bg-primary/10 transition-colors flex items-center gap-2"
                      @click="handleLeave">
                      <Loader2 class="w-4 h-4 animate-spin" />
                      <span>{{ t('queueSearching') }}...</span>
                      <span class="text-primary/60 ml-1">{{ t('queueLeave') }}</span>
                    </button>
                  </div>
                </div>

                <div v-if="queue.queueError.value" class="px-6 py-3 border-t border-border/30">
                  <div class="px-3 py-2 rounded-lg bg-destructive/10 text-destructive text-sm">
                    {{ queue.queueError.value }}
                  </div>
                </div>
              </div>

              <!-- Players in Queue grid (only visible once you've joined) -->
              <div v-if="selectedPool && queue.inQueue.value" class="card p-5">
                <div class="flex items-center justify-between mb-4">
                  <h3 class="text-sm font-semibold">{{ t('queuePlayersInQueue') }}</h3>
                  <span class="text-[11px] text-muted-foreground tabular-nums">{{ queue.queuePlayers.value.length }}/{{ totalPlayers }}</span>
                </div>
                <div v-if="queue.queuePlayers.value.length === 0" class="text-xs text-muted-foreground text-center py-8">
                  {{ t('queueEmptyPool') }}
                </div>
                <div v-else class="grid grid-cols-4 gap-4">
                  <router-link
                    v-for="p in queue.queuePlayers.value" :key="p.playerId"
                    :to="{ name: 'player-profile', params: { id: p.playerId } }"
                    class="flex flex-col items-center gap-1 min-w-0 p-2 -m-2 rounded-lg hover:bg-accent/40 transition-colors"
                    :title="t('queuePlayerCardOpenProfile')"
                  >
                    <img v-if="p.avatarUrl" :src="p.avatarUrl" class="w-14 h-14 rounded-lg object-cover" />
                    <div v-else class="w-14 h-14 rounded-lg bg-accent flex items-center justify-center">
                      <Users class="w-6 h-6 text-muted-foreground/40" />
                    </div>
                    <span class="text-xs font-medium truncate max-w-full">{{ p.name }}</span>
                    <span class="text-[10px] text-muted-foreground tabular-nums">{{ p.mmr }}</span>
                    <span class="text-[10px] tabular-nums flex items-center gap-1 mt-0.5"
                      :title="t('queuePlayerStatsTooltip')">
                      <template v-if="queue.playerStats.value[p.playerId]">
                        <span class="text-green-500 font-semibold">{{ queue.playerStats.value[p.playerId].wins }}W</span>
                        <span class="text-muted-foreground/60">·</span>
                        <span class="text-destructive font-semibold">{{ queue.playerStats.value[p.playerId].losses }}L</span>
                      </template>
                      <span v-else class="text-muted-foreground/50">—</span>
                    </span>
                  </router-link>
                </div>
              </div>

              <!-- Recent Matches -->
              <div v-if="queue.queueHistory.value.length > 0">
                <h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">{{ t('queueRecentMatches') }}</h2>
                <div class="flex flex-col gap-2">
                  <router-link v-for="qm in pagedHistory" :key="qm.id"
                    :to="{ name: 'queue-match', params: { id: qm.id } }"
                    class="card px-5 py-3 flex items-center gap-4 hover:bg-accent/30 transition-colors cursor-pointer">
                    <!-- Team 1 (left) -->
                    <div class="flex items-center gap-3 flex-1 min-w-0">
                      <div class="flex -space-x-1.5 shrink-0">
                        <template v-for="(p, i) in (qm.team1_players?.length ? qm.team1_players : (qm.captain1_avatar ? [{ avatarUrl: qm.captain1_avatar }] : []))" :key="i">
                          <img v-if="p.avatarUrl" :src="p.avatarUrl" class="w-6 h-6 rounded-full ring-2 ring-card object-cover" />
                          <div v-else class="w-6 h-6 rounded-full bg-accent ring-2 ring-card" />
                        </template>
                      </div>
                      <div class="flex flex-col min-w-0">
                        <span class="text-sm truncate"
                          :class="winnerSide(qm) === 1 ? 'font-semibold' : (winnerSide(qm) === 2 ? 'text-muted-foreground' : 'font-medium')">
                          {{ qm.captain1_display_name || qm.captain1_name }}
                        </span>
                        <span v-if="teamAvgMmr(qm.team1_players)" class="text-[10px] font-mono text-muted-foreground">
                          {{ t('avgMmr') }} {{ teamAvgMmr(qm.team1_players) }}
                        </span>
                      </div>
                    </div>

                    <!-- Score / VS + relative time -->
                    <div class="flex flex-col items-center shrink-0 min-w-[72px]">
                      <div v-if="qm.score1 != null && qm.score2 != null" class="flex items-center gap-2 font-mono font-bold text-sm tabular-nums">
                        <span :class="winnerSide(qm) === 1 ? 'text-green-500' : 'text-muted-foreground'">{{ qm.score1 }}</span>
                        <span class="text-muted-foreground/50">–</span>
                        <span :class="winnerSide(qm) === 2 ? 'text-green-500' : 'text-muted-foreground'">{{ qm.score2 }}</span>
                      </div>
                      <div v-else class="px-3 py-1 rounded bg-accent text-xs font-semibold text-muted-foreground">VS</div>
                      <span v-if="qm.status === 'live'" class="text-[10px] text-amber-500 font-semibold mt-0.5">{{ t('matchLive') }}</span>
                      <span v-else-if="qm.completed_at" class="text-[10px] text-muted-foreground whitespace-nowrap mt-0.5">
                        {{ formatRelativeTime(qm.completed_at) }}
                      </span>
                    </div>

                    <!-- Team 2 (right) -->
                    <div class="flex items-center gap-3 flex-1 min-w-0 justify-end">
                      <div class="flex flex-col items-end min-w-0">
                        <span class="text-sm truncate"
                          :class="winnerSide(qm) === 2 ? 'font-semibold' : (winnerSide(qm) === 1 ? 'text-muted-foreground' : 'font-medium')">
                          {{ qm.captain2_display_name || qm.captain2_name }}
                        </span>
                        <span v-if="teamAvgMmr(qm.team2_players)" class="text-[10px] font-mono text-muted-foreground">
                          {{ t('avgMmr') }} {{ teamAvgMmr(qm.team2_players) }}
                        </span>
                      </div>
                      <div class="flex flex-row-reverse -space-x-1.5 space-x-reverse shrink-0">
                        <template v-for="(p, i) in (qm.team2_players?.length ? qm.team2_players : (qm.captain2_avatar ? [{ avatarUrl: qm.captain2_avatar }] : []))" :key="i">
                          <img v-if="p.avatarUrl" :src="p.avatarUrl" class="w-6 h-6 rounded-full ring-2 ring-card object-cover" />
                          <div v-else class="w-6 h-6 rounded-full bg-accent ring-2 ring-card" />
                        </template>
                      </div>
                    </div>
                  </router-link>
                </div>
                <div v-if="totalHistoryPages > 1" class="flex items-center justify-center gap-2 mt-3">
                  <button
                    type="button"
                    class="px-2.5 py-1.5 rounded-md bg-accent/40 border border-border/40 text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-accent/60 transition-colors"
                    :disabled="historyPage <= 1"
                    @click="historyPage--"
                  >‹</button>
                  <span class="text-xs text-muted-foreground tabular-nums">{{ historyPage }} / {{ totalHistoryPages }}</span>
                  <button
                    type="button"
                    class="px-2.5 py-1.5 rounded-md bg-accent/40 border border-border/40 text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-accent/60 transition-colors"
                    :disabled="historyPage >= totalHistoryPages"
                    @click="historyPage++"
                  >›</button>
                </div>
              </div>
            </div>

            <!-- Right column: Pool Chat -->
            <div class="flex flex-col gap-6 min-w-0">
              <div v-if="selectedPool" class="card overflow-hidden flex flex-col" style="max-height: calc(100vh - 220px); min-height: 400px;">
                <div class="px-5 py-3 border-b border-border/30 flex items-center gap-2 shrink-0">
                  <MessageSquare class="w-4 h-4 text-muted-foreground" />
                  <span class="text-sm font-semibold">{{ t('queueChat') }}</span>
                  <span class="text-[10px] text-muted-foreground ml-auto">{{ t('queueChatHint') }}</span>
                </div>
                <div ref="chatScroll" class="px-5 py-3 flex-1 overflow-y-auto flex flex-col gap-2">
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
                <form class="px-5 py-3 border-t border-border/30 flex items-center gap-2 shrink-0" @submit.prevent="sendChat">
                  <input
                    v-model="chatInput"
                    type="text"
                    maxlength="300"
                    :placeholder="t('queueChatPlaceholder')"
                    class="flex-1 min-w-0 bg-accent/40 border border-border/40 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40"
                  />
                  <button
                    type="submit"
                    :disabled="!canSendChat"
                    class="btn-primary px-3 py-2 text-sm flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                  >
                    <Send class="w-3.5 h-3.5" />
                    <span v-if="chatCooldownLeft > 0" class="tabular-nums">{{ Math.ceil(chatCooldownLeft / 1000) }}s</span>
                    <span v-else>{{ t('queueChatSend') }}</span>
                  </button>
                </form>
              </div>
            </div>
          </div>
        </template>
      </template>
    </div>
  </div>
</template>
