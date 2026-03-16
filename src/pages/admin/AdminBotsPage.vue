<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Bot, Plus, Trash2, Plug, Unplug, ShieldQuestion, ChevronDown, ChevronUp } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'

const { t } = useI18n()
const api = useApi()
const store = useDraftStore()

const bots = ref<any[]>([])
const showAddBot = ref(false)
const newUsername = ref('')
const newPassword = ref('')
const showSteamGuard = ref(false)
const steamGuardBotId = ref<number | null>(null)
const steamGuardCode = ref('')
const expandedBotId = ref<number | null>(null)
const botLogs = ref<Record<number, any[]>>({})

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
}

function statusColor(status: string) {
  if (status === 'available') return 'bg-green-500'
  if (status === 'busy') return 'bg-amber-500'
  if (status === 'connecting' || status === 'connecting_gc' || status === 'awaiting_guard') return 'bg-blue-500 animate-pulse'
  if (status === 'error') return 'bg-red-500'
  return 'bg-gray-500'
}

// Listen for socket events
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
  // Keep last 50
  if (botLogs.value[data.botId].length > 50) botLogs.value[data.botId].shift()
}

function onSteamGuardRequired(data: any) {
  steamGuardBotId.value = data.botId
  showSteamGuard.value = true
}

onMounted(() => {
  fetchBots()
  const socket = (store as any).socket
  if (socket) {
    socket.on('bot:statusChanged', onBotStatusChanged)
    socket.on('bot:steamGuardRequired', onSteamGuardRequired)
    socket.on('bot:log', onBotLog)
  }
})

onUnmounted(() => {
  const socket = (store as any).socket
  if (socket) {
    socket.off('bot:statusChanged', onBotStatusChanged)
    socket.off('bot:steamGuardRequired', onSteamGuardRequired)
    socket.off('bot:log', onBotLog)
  }
})
</script>

<template>
  <div class="flex flex-col gap-6">
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

    <!-- Bot list -->
    <div v-if="bots.length === 0" class="text-sm text-muted-foreground text-center py-8">
      {{ t('noBotsYet') }}
    </div>

    <div v-for="bot in bots" :key="bot.id" class="card">
      <div class="p-4 flex items-center gap-4">
        <div class="w-3 h-3 rounded-full shrink-0" :class="statusColor(bot.status)"></div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium text-foreground">{{ bot.display_name || bot.username }}</span>
            <span class="text-[10px] text-muted-foreground">{{ bot.username }}</span>
          </div>
          <div class="text-xs text-muted-foreground">
            {{ bot.status }}
            <span v-if="bot.error_message" class="text-red-500 ml-1">— {{ bot.error_message }}</span>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button
            v-if="bot.status === 'offline' || bot.status === 'error'"
            class="btn-secondary text-xs px-3 py-1.5"
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
          <button
            v-if="bot.status === 'available' || bot.status === 'connecting' || bot.status === 'connecting_gc'"
            class="btn-secondary text-xs px-3 py-1.5"
            @click="disconnectBot(bot.id)"
          >
            <Unplug class="w-3.5 h-3.5" />
            {{ t('disconnectBot') }}
          </button>
          <button class="p-1.5 rounded hover:bg-accent" @click="toggleLogs(bot.id)">
            <component :is="expandedBotId === bot.id ? ChevronUp : ChevronDown" class="w-4 h-4 text-muted-foreground" />
          </button>
          <button class="p-1.5 rounded hover:bg-accent" @click="removeBot(bot.id)">
            <Trash2 class="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
      </div>
      <!-- Logs panel -->
      <div v-if="expandedBotId === bot.id" class="border-t border-border">
        <div class="bg-black/80 text-green-400 font-mono text-[11px] p-3 max-h-[250px] overflow-y-auto flex flex-col gap-0.5">
          <div v-if="!(botLogs[bot.id]?.length)" class="text-muted-foreground">{{ t('noLogs') }}</div>
          <div v-for="(log, idx) in botLogs[bot.id]" :key="idx">
            <span class="text-muted-foreground">{{ log.time?.slice(11, 19) }}</span>
            <span class="ml-2">{{ log.message }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Add Bot Modal -->
    <Teleport to="body">
      <div v-if="showAddBot" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" @click.self="showAddBot = false">
        <div class="card p-6 w-full max-w-sm flex flex-col gap-4">
          <h3 class="text-lg font-semibold text-foreground">{{ t('addBot') }}</h3>
          <input class="input-field" v-model="newUsername" :placeholder="t('steamUsername')" />
          <input class="input-field" type="password" v-model="newPassword" :placeholder="t('steamPassword')" />
          <div class="flex gap-3">
            <button class="btn-primary flex-1" @click="addBot">{{ t('addBot') }}</button>
            <button class="btn-secondary flex-1" @click="showAddBot = false">{{ t('cancel') }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Steam Guard Modal -->
    <Teleport to="body">
      <div v-if="showSteamGuard" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" @click.self="showSteamGuard = false">
        <div class="card p-6 w-full max-w-sm flex flex-col gap-4">
          <h3 class="text-lg font-semibold text-foreground">{{ t('steamGuardRequired') }}</h3>
          <p class="text-sm text-muted-foreground">{{ t('steamGuardHint') }}</p>
          <input class="input-field text-center text-lg tracking-widest" v-model="steamGuardCode" placeholder="XXXXX" maxlength="5" />
          <div class="flex gap-3">
            <button class="btn-primary flex-1" @click="submitGuard">{{ t('submitCode') }}</button>
            <button class="btn-secondary flex-1" @click="showSteamGuard = false">{{ t('cancel') }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
