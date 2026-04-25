<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Trash2, Pencil, X, Check, Ban, RefreshCw, Swords, Loader2, UserX, Clock, Search } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import ModalOverlay from '@/components/common/ModalOverlay.vue'

const { t } = useI18n()
const api = useApi()
const pools = ref<any[]>([])
const editingId = ref<number | null>(null)
const showCreate = ref(false)
const activeMatches = ref<any[]>([])
const loadingMatches = ref(false)
const queuedPlayers = ref<any[]>([])
const bans = ref<any[]>([])
const banForm = ref<{
  player_id: number | null
  player_label: string
  duration_minutes: number
  reason: string
}>({
  player_id: null,
  player_label: '',
  duration_minutes: 60,
  reason: '',
})
const showBanModal = ref(false)
const banSearchQuery = ref('')
const banSearchResults = ref<any[]>([])
let banSearchTimer: ReturnType<typeof setTimeout> | null = null
let refreshInterval: ReturnType<typeof setInterval> | null = null

const seasons = ref<Array<{ id: number; name: string; is_active: boolean }>>([])

const form = ref<Record<string, any>>({
  name: '',
  enabled: true,
  min_mmr: 0,
  max_mmr: 0,
  pick_timer: 30,
  best_of: 1,
  lobby_server_region: 3,
  lobby_game_mode: 2,
  lobby_league_id: 0,
  lobby_dotv_delay: 1,
  lobby_cheats: false,
  lobby_allow_spectating: true,
  lobby_pause_setting: 0,
  lobby_selection_priority: 0,
  lobby_cm_pick: 0,
  lobby_auto_assign_teams: true,
  lobby_penalty_radiant: 0,
  lobby_penalty_dire: 0,
  lobby_series_type: 0,
  lobby_timeout_minutes: 10,
  team_size: 5,
  xp_win: 15,
  xp_participate: 5,
  accept_timer: 20,
  decline_ban_minutes: 5,
  season_id: null,
})

function resetForm() {
  form.value = {
    name: '', enabled: true, min_mmr: 0, max_mmr: 0, pick_timer: 30, best_of: 1, team_size: 5,
    lobby_server_region: 3, lobby_game_mode: 2, lobby_league_id: 0, lobby_dotv_delay: 1,
    lobby_cheats: false, lobby_allow_spectating: true, lobby_pause_setting: 0,
    lobby_selection_priority: 0, lobby_cm_pick: 0, lobby_auto_assign_teams: true,
    lobby_penalty_radiant: 0, lobby_penalty_dire: 0,
    lobby_series_type: 0, lobby_timeout_minutes: 10,
    xp_win: 15, xp_participate: 5,
    accept_timer: 20, decline_ban_minutes: 5,
    season_id: null,
  }
}

async function fetchPools() {
  try { pools.value = await api.getAdminQueuePools() } catch { pools.value = [] }
}

function startEdit(pool: any) {
  editingId.value = pool.id
  form.value = { ...pool }
  showCreate.value = false
}

function startCreate() {
  resetForm()
  editingId.value = null
  showCreate.value = true
}

function cancelEdit() {
  editingId.value = null
  showCreate.value = false
  resetForm()
}

async function savePool() {
  if (!form.value.name) return
  try {
    if (editingId.value) {
      await api.updateQueuePool(editingId.value, form.value)
    } else {
      await api.createQueuePool(form.value)
    }
    editingId.value = null
    showCreate.value = false
    resetForm()
    await fetchPools()
  } catch (e: any) {
    alert(e.message)
  }
}

async function deletePool(id: number) {
  if (!confirm('Delete this queue pool?')) return
  await api.deleteQueuePool(id)
  await fetchPools()
}

async function fetchActiveMatches() {
  loadingMatches.value = true
  try { activeMatches.value = await api.getAdminQueueMatches() } catch { activeMatches.value = [] }
  loadingMatches.value = false
}

async function fetchQueuedPlayers() {
  try { queuedPlayers.value = await api.getAdminQueuePlayers() } catch { queuedPlayers.value = [] }
}

async function fetchBans() {
  try { bans.value = await api.getAdminQueueBans() } catch { bans.value = [] }
}

async function kickQueued(playerId: number) {
  try {
    await api.adminKickFromQueue(playerId)
    await fetchQueuedPlayers()
  } catch (e: any) { alert(e.message) }
}

function openBanModal(prefill?: { id: number; name: string }) {
  banForm.value = {
    player_id: prefill?.id || null,
    player_label: prefill?.name || '',
    duration_minutes: 60,
    reason: '',
  }
  banSearchQuery.value = ''
  banSearchResults.value = []
  showBanModal.value = true
}

function closeBanModal() {
  showBanModal.value = false
  banSearchResults.value = []
}

function onBanSearchInput() {
  if (banSearchTimer) clearTimeout(banSearchTimer)
  const q = banSearchQuery.value.trim()
  if (q.length < 2) { banSearchResults.value = []; return }
  banSearchTimer = setTimeout(async () => {
    try {
      banSearchResults.value = await api.searchPlayers(q)
    } catch {
      banSearchResults.value = []
    }
  }, 200)
}

function pickBanPlayer(p: any) {
  banForm.value.player_id = p.id
  banForm.value.player_label = p.display_name || p.name
  banSearchQuery.value = ''
  banSearchResults.value = []
}

async function submitBan() {
  if (!banForm.value.player_id) return
  try {
    await api.addAdminQueueBan({
      player_id: Number(banForm.value.player_id),
      duration_minutes: Number(banForm.value.duration_minutes) || 0,
      reason: banForm.value.reason,
    })
    closeBanModal()
    await Promise.all([fetchBans(), fetchQueuedPlayers()])
  } catch (e: any) { alert(e.message) }
}

async function unban(playerId: number) {
  try {
    await api.removeAdminQueueBan(playerId)
    await fetchBans()
  } catch (e: any) { alert(e.message) }
}

function formatBanUntil(until: string | null): string {
  if (!until) return t('queueAdminBanPermanent')
  const d = new Date(until)
  const diffMs = d.getTime() - Date.now()
  if (diffMs <= 0) return t('queueAdminBanExpired')
  const mins = Math.ceil(diffMs / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  const rem = mins % 60
  return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`
}

async function cancelMatch(id: number) {
  if (!confirm(t('queueAdminCancelConfirm'))) return
  try {
    await api.cancelQueueMatch(id)
    await fetchActiveMatches()
  } catch (e: any) {
    alert(e.message)
  }
}

const retryingLobby = ref<number | null>(null)
async function retryLobby(id: number) {
  if (retryingLobby.value) return
  retryingLobby.value = id
  try {
    await api.adminRetryQueueLobby(id)
    await fetchActiveMatches()
  } catch (e: any) {
    alert(e.message)
  } finally {
    retryingLobby.value = null
  }
}

function statusLabel(status: string) {
  switch (status) {
    case 'picking': return t('queueStatusPicking')
    case 'lobby_creating': return t('queueStatusCreatingLobby')
    case 'live': return t('queueStatusLive')
    default: return status
  }
}

function statusColor(status: string) {
  switch (status) {
    case 'picking': return 'bg-amber-500/10 text-amber-500'
    case 'lobby_creating': return 'bg-blue-500/10 text-blue-500'
    case 'live': return 'bg-green-500/10 text-green-500'
    default: return 'bg-accent text-muted-foreground'
  }
}

const SERVER_REGIONS: Record<number, string> = {
  0: 'US West', 1: 'US East', 2: 'Europe', 3: 'Europe East',
  5: 'SE Asia', 6: 'Dubai', 7: 'Australia', 8: 'Stockholm',
  9: 'Austria', 10: 'Brazil', 11: 'South Africa', 12: 'China',
  14: 'Chile', 15: 'Peru', 16: 'India', 17: 'Japan', 19: 'Taiwan',
}

const GAME_MODES: [number, string][] = [
  [1, 'gameModeAP'], [2, 'gameModeCM'], [3, 'gameModeRD'],
  [4, 'gameModeSD'], [5, 'gameModeAR'], [8, 'gameModeReverseCM'],
  [11, 'gameModeMO'], [12, 'gameModeLP'], [16, 'gameModeCD'],
  [18, 'gameModeABD'], [20, 'gameModeARDM'], [21, 'gameMode1v1'],
  [22, 'gameModeAD'], [23, 'gameModeTurbo'],
]

async function fetchSeasons() {
  try { seasons.value = (await api.getAdminSeasons()).filter((s: any) => s.is_active) } catch { seasons.value = [] }
}

onMounted(() => {
  fetchPools()
  fetchSeasons()
  fetchActiveMatches()
  fetchQueuedPlayers()
  fetchBans()
  refreshInterval = setInterval(() => {
    fetchActiveMatches()
    fetchQueuedPlayers()
    fetchBans()
  }, 10000)
})

onUnmounted(() => {
  if (refreshInterval) clearInterval(refreshInterval)
})
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[1200px] w-full">

    <!-- ═══════════════════ Active Queue Matches ═══════════════════ -->
    <div>
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-3">
          <h2 class="text-xl font-bold">{{ t('queueAdminActiveMatches') }}</h2>
          <span v-if="activeMatches.length > 0" class="text-xs font-semibold bg-primary/15 text-primary px-2 py-0.5 rounded-full">
            {{ activeMatches.length }}
          </span>
        </div>
        <button class="p-1.5 rounded hover:bg-accent" :class="loadingMatches ? 'animate-spin' : ''" @click="fetchActiveMatches">
          <RefreshCw class="w-4 h-4" />
        </button>
      </div>

      <div v-if="activeMatches.length === 0" class="card px-6 py-8 text-center mb-8">
        <Swords class="w-8 h-8 text-muted-foreground/20 mx-auto mb-2" />
        <p class="text-sm text-muted-foreground">{{ t('queueAdminNoActive') }}</p>
      </div>

      <div v-else class="flex flex-col gap-3 mb-8">
        <div v-for="qm in activeMatches" :key="qm.id" class="card overflow-hidden">
          <div class="px-4 py-3 flex items-center justify-between gap-4">
            <!-- Left: match info -->
            <div class="flex items-center gap-3 flex-1 min-w-0">
              <span class="text-xs px-2 py-0.5 rounded font-semibold" :class="statusColor(qm.status)">
                {{ statusLabel(qm.status) }}
              </span>
              <span class="text-sm font-semibold text-muted-foreground">#{{ qm.id }}</span>
              <span v-if="qm.match_id" class="text-[10px] font-mono text-muted-foreground bg-accent/60 px-1.5 py-0.5 rounded">match #{{ qm.match_id }}</span>
              <span v-if="qm.pool_name" class="text-xs text-muted-foreground bg-accent px-2 py-0.5 rounded">{{ qm.pool_name }}</span>
            </div>

            <!-- Right: retry + cancel -->
            <div class="flex items-center gap-1.5">
              <button
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-primary hover:bg-primary/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                :title="qm.lobby_status === 'completed' ? t('queueAdminMatchInProgress') : t('queueAdminRetryLobbyHint')"
                :disabled="retryingLobby === qm.id || qm.lobby_status === 'completed'"
                @click="retryLobby(qm.id)"
              >
                <RefreshCw class="w-3.5 h-3.5" :class="retryingLobby === qm.id ? 'animate-spin' : ''" /> {{ t('queueAdminRetryLobby') }}
              </button>
              <button
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                :title="qm.lobby_status === 'completed' ? t('queueAdminMatchInProgress') : ''"
                :disabled="qm.lobby_status === 'completed'"
                @click="cancelMatch(qm.id)"
              >
                <Ban class="w-3.5 h-3.5" /> {{ t('cancel') }}
              </button>
            </div>
          </div>

          <!-- Teams row -->
          <div class="px-4 pb-3 flex items-center gap-4">
            <!-- Team 1 (Radiant) -->
            <div class="flex-1 min-w-0">
              <div class="text-[10px] font-bold text-green-400 uppercase tracking-wider mb-1.5">{{ t('queueRadiant') }}</div>
              <div class="flex flex-wrap gap-1.5">
                <div v-for="(p, idx) in qm.team1" :key="p.playerId || idx"
                  class="flex items-center gap-1.5 px-2 py-1 rounded text-xs"
                  :class="idx === 0 ? 'bg-green-500/8 border border-green-500/15' : 'bg-accent/50'">
                  <img v-if="p.avatarUrl || p.avatar_url" :src="p.avatarUrl || p.avatar_url" class="w-4 h-4 rounded-full" />
                  <span class="font-medium truncate max-w-[100px]">{{ p.name }}</span>
                  <span v-if="idx === 0" class="text-[9px] font-bold text-green-400">CPT</span>
                </div>
                <div v-if="!qm.team1 || qm.team1.length === 0" class="text-xs text-muted-foreground/40">
                  {{ qm.captain1_display_name || qm.captain1_name || '—' }}
                </div>
              </div>
            </div>

            <div class="text-xs font-bold text-muted-foreground/40 px-2">VS</div>

            <!-- Team 2 (Dire) -->
            <div class="flex-1 min-w-0">
              <div class="text-[10px] font-bold text-red-400 uppercase tracking-wider mb-1.5">{{ t('queueDire') }}</div>
              <div class="flex flex-wrap gap-1.5">
                <div v-for="(p, idx) in qm.team2" :key="p.playerId || idx"
                  class="flex items-center gap-1.5 px-2 py-1 rounded text-xs"
                  :class="idx === 0 ? 'bg-red-500/8 border border-red-500/15' : 'bg-accent/50'">
                  <img v-if="p.avatarUrl || p.avatar_url" :src="p.avatarUrl || p.avatar_url" class="w-4 h-4 rounded-full" />
                  <span class="font-medium truncate max-w-[100px]">{{ p.name }}</span>
                  <span v-if="idx === 0" class="text-[9px] font-bold text-red-400">CPT</span>
                </div>
                <div v-if="!qm.team2 || qm.team2.length === 0" class="text-xs text-muted-foreground/40">
                  {{ qm.captain2_display_name || qm.captain2_name || '—' }}
                </div>
              </div>
            </div>
          </div>

          <!-- Lobby info (if live) -->
          <div v-if="qm.lobby_name" class="px-4 pb-3 flex flex-col gap-1.5 text-xs text-muted-foreground">
            <div class="flex items-center gap-4 flex-wrap">
              <span>{{ t('queueLobbyName') }}: <strong class="text-foreground font-mono">{{ qm.lobby_name }}</strong></span>
              <span>{{ t('queueLobbyPassword') }}: <strong class="text-foreground font-mono select-all">{{ qm.lobby_password }}</strong></span>
              <span v-if="qm.lobby_status" class="px-1.5 py-0.5 rounded text-[10px] font-semibold" :class="statusColor(qm.lobby_status)">
                {{ qm.lobby_status }}
              </span>
              <span v-if="qm.lobby_bot_id" class="text-[10px]">bot #{{ qm.lobby_bot_id }}</span>
              <span v-if="qm.lobby_error_count > 0" class="text-[10px] text-amber-500">
                {{ qm.lobby_error_count }} failed {{ qm.lobby_error_count === 1 ? 'attempt' : 'attempts' }}
              </span>
            </div>
            <div v-if="qm.lobby_error" class="px-2 py-1.5 rounded bg-red-500/10 border border-red-500/30 text-red-400 text-[11px] font-mono whitespace-pre-wrap break-all">
              {{ qm.lobby_error }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══════════════════ Currently Queued Players ═══════════════════ -->
    <div>
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-3">
          <h2 class="text-xl font-bold">{{ t('queueAdminQueuedPlayers') }}</h2>
          <span v-if="queuedPlayers.length > 0" class="text-xs font-semibold bg-primary/15 text-primary px-2 py-0.5 rounded-full">
            {{ queuedPlayers.length }}
          </span>
        </div>
      </div>

      <div v-if="queuedPlayers.length === 0" class="card px-6 py-6 text-center mb-8">
        <p class="text-sm text-muted-foreground">{{ t('queueAdminNobodyQueued') }}</p>
      </div>
      <div v-else class="card mb-8 overflow-hidden">
        <div v-for="p in queuedPlayers" :key="p.playerId" class="flex items-center gap-3 px-4 py-2 border-b border-border/30 last:border-b-0">
          <img v-if="p.avatarUrl" :src="p.avatarUrl" class="w-6 h-6 rounded-full" />
          <span class="font-medium text-sm">{{ p.name }}</span>
          <span class="text-[10px] text-muted-foreground tabular-nums">{{ p.mmr }} MMR</span>
          <span class="text-[10px] text-muted-foreground">pool #{{ p.poolId }}</span>
          <div class="ml-auto flex items-center gap-2">
            <button class="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold text-muted-foreground hover:text-foreground hover:bg-accent transition-colors" @click="kickQueued(p.playerId)">
              <UserX class="w-3.5 h-3.5" /> {{ t('queueAdminKick') }}
            </button>
            <button class="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold text-destructive hover:bg-destructive/10 transition-colors" @click="openBanModal({ id: p.playerId, name: p.name })">
              <Ban class="w-3.5 h-3.5" /> {{ t('queueAdminBan') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══════════════════ Queue Bans ═══════════════════ -->
    <div>
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-3">
          <h2 class="text-xl font-bold">{{ t('queueAdminBans') }}</h2>
          <span v-if="bans.length > 0" class="text-xs font-semibold bg-destructive/15 text-destructive px-2 py-0.5 rounded-full">
            {{ bans.length }}
          </span>
        </div>
      </div>

      <!-- Add ban button (opens modal with player picker) -->
      <div class="mb-3">
        <button class="btn-primary text-sm flex items-center gap-1.5" @click="openBanModal()">
          <Plus class="w-3.5 h-3.5" /> {{ t('queueAdminBan') }}
        </button>
      </div>

      <div v-if="bans.length === 0" class="card px-6 py-6 text-center mb-8">
        <p class="text-sm text-muted-foreground">{{ t('queueAdminNoBans') }}</p>
      </div>
      <div v-else class="card mb-8 overflow-hidden">
        <div v-for="b in bans" :key="b.player_id" class="flex items-center gap-3 px-4 py-2 border-b border-border/30 last:border-b-0">
          <img v-if="b.avatar_url" :src="b.avatar_url" class="w-6 h-6 rounded-full" />
          <span class="font-medium text-sm">{{ b.display_name || b.name }}</span>
          <span class="text-[10px] text-muted-foreground">#{{ b.player_id }}</span>
          <span class="text-[11px] flex items-center gap-1 px-1.5 py-0.5 rounded bg-destructive/10 text-destructive">
            <Clock class="w-3 h-3" /> {{ formatBanUntil(b.banned_until) }}
          </span>
          <span v-if="b.reason" class="text-[11px] text-muted-foreground italic truncate max-w-[260px]">{{ b.reason }}</span>
          <span v-if="b.banned_by_name" class="text-[10px] text-muted-foreground ml-auto">by {{ b.banned_by_name }}</span>
          <button class="ml-2 p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors" :title="t('queueAdminUnban')" @click="unban(b.player_id)">
            <X class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>

    <!-- ═══════════════════ Queue Pools ═══════════════════ -->
    <div class="flex items-center justify-between mb-6">
      <h2 class="text-xl font-bold">{{ t('adminQueuePools') }}</h2>
      <button class="btn-primary flex items-center gap-1.5 text-sm" @click="startCreate">
        <Plus class="w-4 h-4" /> {{ t('queueCreatePool') }}
      </button>
    </div>

    <!-- Pool List -->
    <div class="flex flex-col gap-3 mb-6">
      <div v-for="pool in pools" :key="pool.id" class="card px-4 py-3">
        <div class="flex items-center justify-between">
          <div>
            <span class="font-semibold">{{ pool.name }}</span>
            <span class="ml-2 text-xs px-1.5 py-0.5 rounded" :class="pool.enabled ? 'bg-green-500/10 text-green-500' : 'bg-accent text-muted-foreground'">
              {{ pool.enabled ? 'Enabled' : 'Disabled' }}
            </span>
            <span class="text-xs text-muted-foreground ml-3">
              {{ pool.team_size || 5 }}v{{ pool.team_size || 5 }}
              | MMR: {{ pool.min_mmr || 0 }}{{ pool.max_mmr ? `-${pool.max_mmr}` : '+' }}
              | Pick: {{ pool.pick_timer }}s
              | Region: {{ SERVER_REGIONS[pool.lobby_server_region] || pool.lobby_server_region }}
              | League: {{ pool.lobby_league_id || 'None' }}
            </span>
          </div>
          <div class="flex items-center gap-2">
            <button class="p-1.5 rounded hover:bg-accent" @click="startEdit(pool)"><Pencil class="w-4 h-4" /></button>
            <button class="p-1.5 rounded hover:bg-destructive/10 text-destructive" @click="deletePool(pool.id)"><Trash2 class="w-4 h-4" /></button>
          </div>
        </div>
      </div>
      <div v-if="pools.length === 0" class="text-muted-foreground text-sm text-center py-4">{{ t('queueNoPoolsYet') }}</div>
    </div>

    <!-- Create / Edit Form -->
    <div v-if="showCreate || editingId" class="card px-6 py-5">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-semibold">{{ editingId ? t('queueEditPool') : t('queueCreatePool') }}</h3>
        <button @click="cancelEdit" class="p-1 rounded hover:bg-accent"><X class="w-4 h-4" /></button>
      </div>

      <div class="grid grid-cols-2 gap-4">
        <!-- Basic -->
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('queuePoolName') }}</label>
          <input class="input-field" v-model="form.name" />
        </div>
        <div class="flex items-center gap-2 pt-5">
          <input type="checkbox" :checked="form.enabled" @change="form.enabled = ($event.target as HTMLInputElement).checked" />
          <span class="text-sm">{{ t('queueEnabled') }}</span>
        </div>

        <!-- MMR -->
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('queueMinMmr') }}</label>
          <input class="input-field" type="number" v-model.number="form.min_mmr" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('queueMaxMmr') }} (0 = {{ t('queueNoLimit') }})</label>
          <input class="input-field" type="number" v-model.number="form.max_mmr" />
        </div>

        <!-- Pick / Match -->
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('queuePickTimer') }} (s)</label>
          <input class="input-field" type="number" v-model.number="form.pick_timer" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('queueAcceptTimer') }} (s)</label>
          <input class="input-field" type="number" v-model.number="form.accept_timer" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('queueDeclineBanMinutes') }} (min, 0 = {{ t('queueAdminBanDisabled') }})</label>
          <input class="input-field" type="number" min="0" v-model.number="form.decline_ban_minutes" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('queueBestOf') }}</label>
          <select class="input-field" v-model.number="form.best_of">
            <option :value="1">Bo1</option>
            <option :value="3">Bo3</option>
            <option :value="5">Bo5</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('queueTeamSize') }}</label>
          <select class="input-field" v-model.number="form.team_size">
            <option :value="1">1v1</option>
            <option :value="2">2v2</option>
            <option :value="3">3v3</option>
            <option :value="4">4v4</option>
            <option :value="5">5v5</option>
          </select>
        </div>

        <!-- Season -->
        <div class="flex flex-col gap-1 col-span-2">
          <label class="text-xs text-muted-foreground">{{ t('queuePoolSeason') }}</label>
          <select class="input-field" v-model="form.season_id">
            <option :value="null">{{ t('queuePoolNoSeason') }}</option>
            <option v-for="s in seasons" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </div>

        <!-- XP -->
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('queueXpWin') }}</label>
          <input class="input-field" type="number" v-model.number="form.xp_win" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('queueXpParticipate') }}</label>
          <input class="input-field" type="number" v-model.number="form.xp_participate" />
        </div>

        <!-- Lobby Settings -->
        <div class="col-span-2 border-t border-border/30 pt-3 mt-1">
          <span class="text-sm font-semibold text-muted-foreground">{{ t('queueLobbySettings') }}</span>
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('serverRegion') }}</label>
          <select class="input-field" v-model.number="form.lobby_server_region">
            <option v-for="(name, id) in SERVER_REGIONS" :key="id" :value="Number(id)">{{ name }}</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('gameMode') }}</label>
          <select class="input-field" v-model.number="form.lobby_game_mode">
            <option v-for="[id, key] in GAME_MODES" :key="id" :value="id">{{ t(key) }}</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('leagueId') }}</label>
          <input class="input-field" type="number" v-model.number="form.lobby_league_id" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('lobbyTimeout') }} (min)</label>
          <input class="input-field" type="number" v-model.number="form.lobby_timeout_minutes" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">DotaTV Delay</label>
          <select class="input-field" v-model.number="form.lobby_dotv_delay">
            <option :value="0">None</option>
            <option :value="1">2 min</option>
            <option :value="2">5 min</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">Series Type</label>
          <select class="input-field" v-model.number="form.lobby_series_type">
            <option :value="0">None</option>
            <option :value="1">Bo3</option>
            <option :value="2">Bo5</option>
          </select>
        </div>
        <div class="flex items-center gap-4 col-span-2 flex-wrap">
          <label class="flex items-center gap-1.5">
            <input type="checkbox" :checked="form.lobby_auto_assign_teams" @change="form.lobby_auto_assign_teams = ($event.target as HTMLInputElement).checked" />
            <span class="text-sm">{{ t('lobbyAutoAssignTeams') }}</span>
          </label>
          <label class="flex items-center gap-1.5">
            <input type="checkbox" :checked="form.lobby_cheats" @change="form.lobby_cheats = ($event.target as HTMLInputElement).checked" />
            <span class="text-sm">Cheats</span>
          </label>
          <label class="flex items-center gap-1.5">
            <input type="checkbox" :checked="form.lobby_allow_spectating" @change="form.lobby_allow_spectating = ($event.target as HTMLInputElement).checked" />
            <span class="text-sm">Allow Spectating</span>
          </label>
        </div>
        <p class="text-xs text-muted-foreground col-span-2 -mt-2">{{ t('lobbyAutoAssignTeamsHint') }}</p>

        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('lobbyPauseSetting') }}</label>
          <select class="input-field" v-model.number="form.lobby_pause_setting">
            <option :value="0">{{ t('pauseUnlimited') }}</option>
            <option :value="1">{{ t('pauseLimited') }}</option>
            <option :value="2">{{ t('pauseDisabled') }}</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('lobbySelectionPriority') }}</label>
          <select class="input-field" v-model.number="form.lobby_selection_priority">
            <option :value="0">{{ t('selectionPriorityManual') }}</option>
            <option :value="1">{{ t('selectionPriorityAutomatic') }}</option>
          </select>
        </div>
        <div v-if="form.lobby_selection_priority === 0" class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('lobbyCmPick') }}</label>
          <select class="input-field" v-model.number="form.lobby_cm_pick">
            <option :value="0">{{ t('cmPickRandom') }}</option>
            <option :value="1">{{ t('cmPickRadiant') }}</option>
            <option :value="2">{{ t('cmPickDire') }}</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('lobbyPenaltyRadiant') }}</label>
          <input class="input-field" type="number" v-model.number="form.lobby_penalty_radiant" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('lobbyPenaltyDire') }}</label>
          <input class="input-field" type="number" v-model.number="form.lobby_penalty_dire" />
        </div>
      </div>

      <div class="flex justify-end gap-2 mt-5 pt-4 border-t border-border/30">
        <button class="btn-outline" @click="cancelEdit">{{ t('cancel') }}</button>
        <button class="btn-primary" @click="savePool">{{ t('save') }}</button>
      </div>
    </div>

    <!-- ═══════════════════ Ban Modal ═══════════════════ -->
    <ModalOverlay :show="showBanModal" @close="closeBanModal">
      <div class="border-b border-border px-6 py-5">
        <h2 class="text-lg font-bold flex items-center gap-2">
          <Ban class="w-4 h-4 text-destructive" />
          {{ t('queueAdminBanTitle') }}
        </h2>
        <p class="text-xs text-muted-foreground mt-1">{{ t('queueAdminBanDesc') }}</p>
      </div>

      <div class="px-6 py-5 flex flex-col gap-4">
        <!-- Player picker -->
        <div class="flex flex-col gap-1.5">
          <label class="text-[11px] font-semibold uppercase text-muted-foreground">{{ t('queueAdminBanPlayer') }}</label>
          <div v-if="banForm.player_id" class="flex items-center gap-2 px-3 py-2 bg-accent/40 rounded-lg">
            <Check class="w-4 h-4 text-primary" />
            <span class="text-sm font-medium flex-1">{{ banForm.player_label }}</span>
            <span class="text-[10px] text-muted-foreground">#{{ banForm.player_id }}</span>
            <button class="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground" @click="banForm.player_id = null; banForm.player_label = ''">
              <X class="w-3.5 h-3.5" />
            </button>
          </div>
          <div v-else class="relative">
            <div class="flex items-center gap-2 px-3 py-2 bg-accent/40 border border-border/40 rounded-lg">
              <Search class="w-4 h-4 text-muted-foreground" />
              <input
                v-model="banSearchQuery"
                type="text"
                class="flex-1 bg-transparent text-sm focus:outline-none"
                :placeholder="t('queueAdminBanSearchPlaceholder')"
                @input="onBanSearchInput"
              />
            </div>
            <div v-if="banSearchResults.length > 0" class="absolute left-0 right-0 top-full mt-1 bg-card border border-border rounded-lg shadow-lg max-h-64 overflow-y-auto z-10">
              <button
                v-for="p in banSearchResults" :key="p.id"
                class="w-full flex items-center gap-2 px-3 py-2 hover:bg-accent/40 transition-colors text-left"
                @click="pickBanPlayer(p)"
              >
                <img v-if="p.avatar_url" :src="p.avatar_url" class="w-6 h-6 rounded-full" />
                <span class="text-sm font-medium flex-1 truncate">{{ p.display_name || p.name }}</span>
                <span class="text-[10px] text-muted-foreground">#{{ p.id }}</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Duration -->
        <div class="flex flex-col gap-1.5">
          <label class="text-[11px] font-semibold uppercase text-muted-foreground">{{ t('queueAdminBanDuration') }}</label>
          <div class="flex items-center gap-2">
            <input v-model.number="banForm.duration_minutes" type="number" min="0" class="bg-accent/40 border border-border/40 rounded px-3 py-2 text-sm w-28" />
            <span class="text-xs text-muted-foreground">{{ t('queueAdminBanDurationHint') }}</span>
          </div>
          <div class="flex flex-wrap gap-1.5 mt-1">
            <button v-for="m in [15, 60, 180, 720, 1440, 0]" :key="m"
              class="px-2.5 py-1 rounded text-[11px] font-semibold border transition-colors"
              :class="banForm.duration_minutes === m ? 'border-primary text-primary bg-primary/10' : 'border-border text-muted-foreground hover:text-foreground'"
              @click="banForm.duration_minutes = m">
              {{ m === 0 ? t('queueAdminBanPermanent') : m < 60 ? `${m}m` : m < 1440 ? `${m / 60}h` : `${m / 1440}d` }}
            </button>
          </div>
        </div>

        <!-- Reason -->
        <div class="flex flex-col gap-1.5">
          <label class="text-[11px] font-semibold uppercase text-muted-foreground">{{ t('queueAdminBanReason') }}</label>
          <input v-model="banForm.reason" type="text" class="bg-accent/40 border border-border/40 rounded px-3 py-2 text-sm" :placeholder="t('queueAdminBanReasonPlaceholder')" />
        </div>
      </div>

      <div class="px-6 py-4 border-t border-border/30 flex justify-end gap-2">
        <button class="btn-outline" @click="closeBanModal">{{ t('cancel') }}</button>
        <button class="btn-primary flex items-center gap-1.5" :disabled="!banForm.player_id" @click="submitBan">
          <Ban class="w-3.5 h-3.5" /> {{ t('queueAdminBan') }}
        </button>
      </div>
    </ModalOverlay>
  </div>
</template>
