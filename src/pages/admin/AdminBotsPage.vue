<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Bot, Plus, Trash2, Plug, Unplug, ShieldQuestion, ChevronDown, ChevronUp, X, Circle, ExternalLink, Image as ImageIcon, Upload } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import { getSocket } from '@/composables/useSocket'
import ModalOverlay from '@/components/common/ModalOverlay.vue'

const { t } = useI18n()
const api = useApi()
const bots = ref<any[]>([])
const showAddBot = ref(false)
const newUsername = ref('')
const newPassword = ref('')
const showSteamGuard = ref(false)
const steamGuardBotId = ref<number | null>(null)
const steamGuardCode = ref('')
const expandedBotId = ref<number | null>(null)
const botLogs = ref<Record<number, any[]>>({})
const logContainer = ref<HTMLElement | null>(null)

async function fetchBots() {
  try {
    bots.value = await api.getBots()
  } catch { bots.value = [] }
}

async function addBot() {
  if (!newUsername.value || !newPassword.value) return
  await api.addBot({ username: newUsername.value, password: newPassword.value })
  newUsername.value = ''
  newPassword.value = ''
  showAddBot.value = false
  await fetchBots()
}

async function removeBot(id: number) {
  await api.deleteBot(id)
  await fetchBots()
}

async function connectBot(id: number) {
  try {
    await api.connectBot(id)
  } catch {}
  await fetchBots()
}

async function disconnectBot(id: number) {
  await api.disconnectBot(id)
  await fetchBots()
}

async function submitGuard() {
  if (!steamGuardBotId.value || !steamGuardCode.value) return
  await api.submitSteamGuard(steamGuardBotId.value, steamGuardCode.value)
  steamGuardCode.value = ''
  showSteamGuard.value = false
  steamGuardBotId.value = null
  await fetchBots()
}

async function toggleAutoConnect(bot: any) {
  const newVal = !bot.auto_connect
  bot.auto_connect = newVal
  try {
    await api.setBotAutoConnect(bot.id, newVal)
  } catch {
    bot.auto_connect = !newVal
  }
}

async function freeBot(botId: number) {
  try {
    await api.freeBusyBot(botId)
  } catch {}
  await fetchBots()
}

async function toggleLogs(botId: number) {
  if (expandedBotId.value === botId) {
    expandedBotId.value = null
    return
  }
  expandedBotId.value = botId
  try {
    botLogs.value[botId] = await api.getBotLogs(botId)
  } catch {
    botLogs.value[botId] = []
  }
  await nextTick()
  scrollLogsToBottom()
}

function scrollLogsToBottom() {
  if (logContainer.value) {
    logContainer.value.scrollTop = logContainer.value.scrollHeight
  }
}

// ── Bulk avatar upload ──
const avatarFile = ref<File | null>(null)
const avatarPreview = ref<string>('')
const avatarUploading = ref(false)
const avatarResults = ref<any[]>([])
const avatarFileInput = ref<HTMLInputElement | null>(null)

function onAvatarFileChange(e: Event) {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  avatarFile.value = file
  avatarResults.value = []
  if (avatarPreview.value) URL.revokeObjectURL(avatarPreview.value)
  avatarPreview.value = URL.createObjectURL(file)
}

function clearAvatarSelection() {
  avatarFile.value = null
  if (avatarPreview.value) URL.revokeObjectURL(avatarPreview.value)
  avatarPreview.value = ''
  avatarResults.value = []
  if (avatarFileInput.value) avatarFileInput.value.value = ''
}

async function uploadAvatarToAllBots() {
  if (!avatarFile.value) return
  avatarUploading.value = true
  avatarResults.value = []
  try {
    const fd = new FormData()
    fd.append('avatar', avatarFile.value)
    const res = await api.uploadBotAvatar(fd)
    avatarResults.value = res.results || []
  } catch (e: any) {
    avatarResults.value = [{ ok: false, error: e?.message || 'Upload failed' }]
  } finally {
    avatarUploading.value = false
  }
}

function statusColor(status: string) {
  if (status === 'available') return 'text-green-500'
  if (status === 'busy') return 'text-amber-500'
  if (status === 'connecting' || status === 'connecting_gc' || status === 'awaiting_guard') return 'text-blue-500 animate-pulse'
  if (status === 'error') return 'text-red-500'
  return 'text-gray-500'
}

function statusLabel(status: string) {
  switch (status) {
    case 'available': return t('botAvailable')
    case 'busy': return t('botBusy')
    case 'connecting': return t('botConnecting')
    case 'connecting_gc': return t('botConnectingGC')
    case 'awaiting_guard': return t('botAwaitingGuard')
    case 'error': return t('botError')
    default: return t('botOffline')
  }
}

function onBotStatusChanged(data: any) {
  const bot = bots.value.find(b => b.id === data.botId)
  if (bot) {
    bot.status = data.status
    bot.error_message = data.errorMessage || null
  }
}

function onBotLog(data: any) {
  if (!botLogs.value[data.botId]) botLogs.value[data.botId] = []
  botLogs.value[data.botId].push({ time: data.time, message: data.message })
  if (botLogs.value[data.botId].length > 100) botLogs.value[data.botId].shift()
  if (expandedBotId.value === data.botId) {
    nextTick(scrollLogsToBottom)
  }
}

function onSteamGuardRequired(data: any) {
  steamGuardBotId.value = data.botId
  showSteamGuard.value = true
}

onMounted(() => {
  fetchBots()
  const socket = getSocket()
  socket.on('bot:statusChanged', onBotStatusChanged)
  socket.on('bot:steamGuardRequired', onSteamGuardRequired)
  socket.on('bot:log', onBotLog)
})

onUnmounted(() => {
  const socket = getSocket()
  socket.off('bot:statusChanged', onBotStatusChanged)
  socket.off('bot:steamGuardRequired', onSteamGuardRequired)
  socket.off('bot:log', onBotLog)
})
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[1200px] w-full">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-3">
        <Bot class="w-6 h-6 text-foreground" />
        <h1 class="text-xl font-bold text-foreground">{{ t('botManagement') }}</h1>
      </div>
      <button class="btn-primary text-sm" @click="showAddBot = true">
        <Plus class="w-4 h-4" />
        {{ t('addBot') }}
      </button>
    </div>

    <p class="text-sm text-muted-foreground">{{ t('botManagementDesc') }}</p>

    <!-- Bulk avatar upload -->
    <div class="card p-5">
      <div class="flex items-center gap-2 mb-3">
        <ImageIcon class="w-4 h-4 text-foreground" />
        <h2 class="text-sm font-semibold text-foreground">{{ t('updateAllBotAvatars') }}</h2>
      </div>
      <p class="text-xs text-muted-foreground mb-4">{{ t('updateAllBotAvatarsDesc') }}</p>
      <div class="flex items-start gap-4">
        <div class="shrink-0">
          <div class="w-24 h-24 rounded-md border border-border bg-accent/30 overflow-hidden flex items-center justify-center">
            <img v-if="avatarPreview" :src="avatarPreview" class="w-full h-full object-cover" />
            <ImageIcon v-else class="w-8 h-8 text-muted-foreground" />
          </div>
        </div>
        <div class="flex-1 flex flex-col gap-2">
          <input
            ref="avatarFileInput"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            class="text-xs"
            @change="onAvatarFileChange"
          />
          <div class="flex items-center gap-2">
            <button
              class="btn-primary text-xs px-3 py-1.5"
              :disabled="!avatarFile || avatarUploading"
              @click="uploadAvatarToAllBots"
            >
              <Upload class="w-3.5 h-3.5" />
              {{ avatarUploading ? t('uploading') : t('applyToAllBots') }}
            </button>
            <button
              v-if="avatarFile"
              class="btn-secondary text-xs px-3 py-1.5"
              :disabled="avatarUploading"
              @click="clearAvatarSelection"
            >{{ t('clear') }}</button>
          </div>
          <div v-if="avatarResults.length" class="mt-2 flex flex-col gap-1">
            <div
              v-for="(r, i) in avatarResults"
              :key="i"
              class="text-[11px] flex items-center gap-2"
              :class="r.ok ? 'text-green-500' : 'text-red-500'"
            >
              <Circle class="w-2 h-2 fill-current" />
              <span class="font-mono">{{ r.username || `bot ${r.botId}` }}</span>
              <span v-if="r.ok">— {{ t('botAvatarUpdated') }}</span>
              <span v-else>— {{ r.error }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Empty state -->
    <div v-if="bots.length === 0" class="card p-8 text-center">
      <Bot class="w-10 h-10 text-muted-foreground mx-auto mb-3" />
      <p class="text-sm text-muted-foreground">{{ t('noBotsYet') }}</p>
    </div>

    <!-- Bot cards -->
    <div v-for="bot in bots" :key="bot.id" class="card overflow-hidden">
      <!-- Bot header -->
      <div class="px-5 py-4 flex items-center gap-4">
        <!-- Status indicator -->
        <div class="flex flex-col items-center gap-1">
          <Circle class="w-4 h-4 fill-current" :class="statusColor(bot.status)" />
        </div>

        <!-- Bot info -->
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-sm font-semibold text-foreground">{{ bot.display_name || bot.username }}</span>
            <span v-if="bot.display_name && bot.display_name !== bot.username" class="text-[10px] text-muted-foreground font-mono">{{ bot.username }}</span>
            <span v-if="bot.steam_id" class="text-[10px] text-muted-foreground font-mono">{{ bot.steam_id }}</span>
          </div>
          <div class="flex items-center gap-2 mt-0.5">
            <span class="text-xs font-medium" :class="statusColor(bot.status)">{{ statusLabel(bot.status) }}</span>
            <span v-if="bot.error_message" class="text-xs text-red-500">— {{ bot.error_message }}</span>
            <label class="flex items-center gap-1 cursor-pointer ml-2" @click.stop>
              <input type="checkbox" class="w-3.5 h-3.5 accent-primary" :checked="bot.auto_connect" @change="toggleAutoConnect(bot)" />
              <span class="text-[10px] text-muted-foreground">{{ t('autoConnect') }}</span>
            </label>
          </div>
        </div>

        <!-- Actions -->
        <div class="flex items-center gap-1.5">
          <button
            v-if="bot.status === 'offline' || bot.status === 'error'"
            class="btn-primary text-xs px-3 py-1.5"
            @click="connectBot(bot.id)"
          >
            <Plug class="w-3.5 h-3.5" />
            {{ t('connectBot') }}
          </button>
          <button
            v-if="bot.status === 'awaiting_guard'"
            class="btn-primary text-xs px-3 py-1.5"
            @click="steamGuardBotId = bot.id; showSteamGuard = true"
          >
            <ShieldQuestion class="w-3.5 h-3.5" />
            {{ t('enterCode') }}
          </button>
          <router-link
            v-if="bot.status === 'busy' && bot.active_match_id && bot.active_competition_id"
            :to="`/c/${bot.active_competition_id}/match/${bot.active_match_id}`"
            class="btn-primary text-xs px-3 py-1.5"
          >
            <ExternalLink class="w-3.5 h-3.5" />
            {{ t('matchDetails') || 'Match' }}
          </router-link>
          <button
            v-if="bot.status === 'busy'"
            class="btn-secondary text-xs px-3 py-1.5 !text-red-500 hover:!bg-red-500/10"
            @click="freeBot(bot.id)"
          >
            <X class="w-3.5 h-3.5" />
            {{ t('cancelLobby') }}
          </button>
          <button
            v-if="bot.status === 'available' || bot.status === 'connecting' || bot.status === 'connecting_gc' || bot.status === 'busy'"
            class="btn-secondary text-xs px-3 py-1.5"
            @click="disconnectBot(bot.id)"
          >
            <Unplug class="w-3.5 h-3.5" />
          </button>
          <button
            class="p-1.5 rounded-md hover:bg-accent transition-colors"
            @click="toggleLogs(bot.id)"
            :title="expandedBotId === bot.id ? 'Hide logs' : 'Show logs'"
          >
            <component :is="expandedBotId === bot.id ? ChevronUp : ChevronDown" class="w-4 h-4 text-muted-foreground" />
          </button>
          <button
            class="p-1.5 rounded-md hover:bg-red-500/10 transition-colors"
            @click="removeBot(bot.id)"
            title="Remove bot"
          >
            <Trash2 class="w-4 h-4 text-muted-foreground hover:text-red-500" />
          </button>
        </div>
      </div>

      <!-- Logs panel -->
      <div v-if="expandedBotId === bot.id" class="border-t border-border">
        <div
          ref="logContainer"
          class="bg-[#0d1117] text-[13px] font-mono p-4 max-h-[300px] overflow-y-auto flex flex-col gap-0.5 scroll-smooth"
        >
          <div v-if="!(botLogs[bot.id]?.length)" class="text-gray-500 text-center py-4">
            {{ t('noLogs') }}
          </div>
          <div v-for="(log, idx) in botLogs[bot.id]" :key="idx" class="flex gap-2 leading-tight py-px">
            <span class="text-gray-600 shrink-0 select-none">{{ log.time?.slice(11, 19) }}</span>
            <span
              :class="log.message?.includes('Error') || log.message?.includes('error') || log.message?.includes('failed') || log.message?.includes('Failed')
                ? 'text-red-400'
                : log.message?.includes('ready') || log.message?.includes('Ready') || log.message?.includes('available') || log.message?.includes('created') || log.message?.includes('Connected')
                  ? 'text-green-400'
                  : log.message?.includes('waiting') || log.message?.includes('Waiting') || log.message?.includes('Invit')
                    ? 'text-blue-400'
                    : 'text-gray-300'"
            >{{ log.message }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Add Bot Modal -->
    <ModalOverlay :show="showAddBot" @close="showAddBot = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('addBot') }}</h2>
        <p class="text-sm text-muted-foreground mt-1">{{ t('addBotDesc') }}</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-4">
        <div class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('steamUsername') }}</label>
          <input class="input-field" v-model="newUsername" :placeholder="t('steamUsername')" />
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('steamPassword') }}</label>
          <input class="input-field" type="password" v-model="newPassword" :placeholder="t('steamPassword')" />
        </div>
      </div>
      <div class="px-7 py-4 border-t border-border flex gap-3">
        <button class="btn-primary flex-1" :disabled="!newUsername || !newPassword" @click="addBot">{{ t('addBot') }}</button>
        <button class="btn-secondary flex-1" @click="showAddBot = false">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>

    <!-- Steam Guard Modal -->
    <ModalOverlay :show="showSteamGuard" @close="showSteamGuard = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('steamGuardRequired') }}</h2>
        <p class="text-sm text-muted-foreground mt-1">{{ t('steamGuardHint') }}</p>
      </div>
      <div class="px-7 py-5">
        <input
          class="input-field text-center text-2xl tracking-[0.5em] font-mono"
          v-model="steamGuardCode"
          placeholder="XXXXX"
          maxlength="5"
          autofocus
          @keyup.enter="submitGuard"
        />
      </div>
      <div class="px-7 py-4 border-t border-border flex gap-3">
        <button class="btn-primary flex-1" :disabled="steamGuardCode.length < 5" @click="submitGuard">{{ t('submitCode') }}</button>
        <button class="btn-secondary flex-1" @click="showSteamGuard = false">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>
  </div>
</template>
