<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Trash2, Pencil, X, Check, Ban, RefreshCw, Swords, Loader2, UserX, Clock, Search, CheckSquare, AlertTriangle, RotateCcw } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import RichTextEditor from '@/components/common/RichTextEditor.vue'

const { t } = useI18n()
const api = useApi()
const store = useDraftStore()
const canManageAllPools = computed(() => store.hasPerm('manage_queue_pools'))
const canDeleteMatches = computed(() => store.hasPerm('delete_queue_matches'))
const canEditPool = (pool: any) => canManageAllPools.value || pool.created_by === store.currentUser.value?.id
const pools = ref<any[]>([])
const editingId = ref<number | null>(null)
const showCreate = ref(false)
const activeMatches = ref<any[]>([])
const loadingMatches = ref(false)
const matchHistory = ref<any[]>([])
const loadingHistory = ref(false)
// Delete-confirm modal state (no window.confirm — see CLAUDE.md UI Dialogs rule).
const deleteTarget = ref<any | null>(null)
const deleting = ref(false)
const deleteError = ref('')
// Cancel / force-complete confirm modal state (same rule — no window.confirm/alert).
const cancelTarget = ref<any | null>(null)
const cancelling = ref(false)
const cancelError = ref('')
const forceTarget = ref<any | null>(null)
const forcing = ref(false)
const forceError = ref('')
// Per-row inline error for the retry action (replaces alert()).
const retryError = ref<{ id: number; message: string } | null>(null)
// Force-remake confirm modal — destroys an in-flight (stuck) lobby and recreates
// it on a different bot. Behind a confirm because it drops whatever lobby exists.
const remakeTarget = ref<any | null>(null)
const remaking = ref(false)
const remakeError = ref('')
// Recreate-match modal — cancels the current queue match and starts a NEW one
// with the same captains/teams/pool/season (a do-over). Destructive: drops the
// current Dota lobby and players have to rejoin the fresh one.
const recreateTarget = ref<any | null>(null)
const recreating = ref(false)
const recreateError = ref('')
const queuedPlayers = ref<any[]>([])
const bans = ref<any[]>([])
const banForm = ref<{
  player_id: number | null
  player_label: string
  pool_id: number | null
  duration_minutes: number
  reason: string
}>({
  player_id: null,
  player_label: '',
  pool_id: null,
  duration_minutes: 60,
  reason: '',
})
const showBanModal = ref(false)
const banSearchQuery = ref('')
const banSearchResults = ref<any[]>([])
let banSearchTimer: ReturnType<typeof setTimeout> | null = null
let refreshInterval: ReturnType<typeof setInterval> | null = null

const seasons = ref<Array<{ id: number; name: string; is_active: boolean }>>([])
const leagues = ref<Array<{ id: number; name: string; dota_league_id: number }>>([])

type QueueTab = 'pools' | 'queue' | 'matches' | 'history'
const TAB_STORAGE_KEY = 'admin_queue_tab'
const validTab = (v: string | null): QueueTab =>
  (v === 'pools' || v === 'queue' || v === 'matches' || v === 'history' ? v : 'pools')
const activeTab = ref<QueueTab>(validTab(typeof window !== 'undefined' ? localStorage.getItem(TAB_STORAGE_KEY) : null))
function setTab(tab: QueueTab) {
  activeTab.value = tab
  try { localStorage.setItem(TAB_STORAGE_KEY, tab) } catch {}
  if (tab === 'history') fetchMatchHistory()
}

const INHOUSE_DEFAULTS = {
  inhouse_enabled: false,
  pick_order: '1,2,1,2,1,2,2,1',
  weekday_game_mode: 16,
  friday_game_mode: 2,
  friday_win_bonus: 5,
  friday_top1_bonus: 12,
  friday_top2_bonus: 6,
  friday_top3_bonus: 6,
  friday_window_start_hour: 0,
  friday_window_end_hour: 0,
  leaver_penalty: -50,
  leaver_grace_minutes: 15,
  winstreak_tiers: [{ streak: 3, bonus: 1 }, { streak: 5, bonus: 2 }, { streak: 8, bonus: 3 }],
  mmr_diff_tiers: [{ min: 400, max: 599, bonus: 2 }, { min: 600, max: 1000, bonus: 3 }, { min: 1001, max: 99999, bonus: 5 }],
  prize_active_pct: 25,
  toxic_report_thresholds: [{ reports: 3, strike_delta: 1 }, { reports: 4, strike_delta: 2 }],
  toxic_strike_cooldowns: [{ strikes: 2, action: 'warn' }, { strikes: 3, hours: 12 }, { strikes: 4, hours: 24 }, { strikes: 5, hours: 72 }],
  grief_strike_cooldowns: [{ strikes: 1, action: 'warn' }, { strikes: 2, hours: 24 }, { strikes: 3, hours: 72 }, { strikes: 4, action: 'ban' }],
  grief_revoke_captain: true,
  clean_games_to_decay_strike: 5,
  report_window_minutes: 15,
  use_static_points: false,
  inhouse_win_points: 21,
  inhouse_loss_points: 19,
}

const form = ref<Record<string, any>>({
  name: '',
  enabled: true,
  is_featured: false,
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
  captain_eligibility_threshold: 1500,
  season_id: null,
  rules_title: '',
  rules_content: '',
  ...INHOUSE_DEFAULTS,
})

function resetForm() {
  form.value = {
    name: '', enabled: true, is_featured: false, min_mmr: 0, max_mmr: 0, pick_timer: 30, best_of: 1, team_size: 5,
    lobby_server_region: 3, lobby_game_mode: 2, lobby_league_id: 0, lobby_dotv_delay: 1,
    lobby_cheats: false, lobby_allow_spectating: true, lobby_pause_setting: 0,
    lobby_selection_priority: 0, lobby_cm_pick: 0, lobby_auto_assign_teams: true,
    lobby_penalty_radiant: 0, lobby_penalty_dire: 0,
    lobby_series_type: 0, lobby_timeout_minutes: 10,
    xp_win: 15, xp_participate: 5,
    accept_timer: 20, decline_ban_minutes: 5,
    captain_eligibility_threshold: 1500,
    season_id: null,
    rules_title: '',
    rules_content: '',
    ...INHOUSE_DEFAULTS,
    // Re-create the array references so the editor doesn't share state with
    // INHOUSE_DEFAULTS (Vue would otherwise let edits leak across resets).
    winstreak_tiers: INHOUSE_DEFAULTS.winstreak_tiers.map(t => ({ ...t })),
    mmr_diff_tiers: INHOUSE_DEFAULTS.mmr_diff_tiers.map(t => ({ ...t })),
    toxic_report_thresholds: INHOUSE_DEFAULTS.toxic_report_thresholds.map(t => ({ ...t })),
    toxic_strike_cooldowns: INHOUSE_DEFAULTS.toxic_strike_cooldowns.map(t => ({ ...t })),
    grief_strike_cooldowns: INHOUSE_DEFAULTS.grief_strike_cooldowns.map(t => ({ ...t })),
  }
}

// Friday window slider helpers. Hours are 0–23 (Europe/Riga); the window runs
// from Friday start_hour to Saturday end_hour. 0/0 = plain calendar Friday.
function hh(h: number): string { return String(Math.min(23, Math.max(0, Math.trunc(Number(h)) || 0))).padStart(2, '0') + ':00' }
const fridayWindowLabel = computed(
  () => `Fri ${hh(form.value.friday_window_start_hour)} → Sat ${hh(form.value.friday_window_end_hour)}`
)

async function fetchPools() {
  try { pools.value = await api.getAdminQueuePools() } catch { pools.value = [] }
}

function startEdit(pool: any) {
  editingId.value = pool.id
  // Backfill any missing inhouse fields so the form bindings always have
  // something to render even on pools created before the migration.
  form.value = { ...INHOUSE_DEFAULTS, ...pool }
  showCreate.value = false
}

function addTierRow(field: string, blank: any) {
  if (!Array.isArray(form.value[field])) form.value[field] = []
  form.value[field].push({ ...blank })
}
function removeTierRow(field: string, idx: number) {
  if (Array.isArray(form.value[field])) form.value[field].splice(idx, 1)
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

async function fetchMatchHistory() {
  loadingHistory.value = true
  try { matchHistory.value = await api.getAdminQueueMatchHistory({ limit: 50 }) } catch { matchHistory.value = [] }
  loadingHistory.value = false
}

function openDeleteMatch(qm: any) {
  deleteError.value = ''
  deleteTarget.value = qm
}
function closeDeleteMatch() {
  if (deleting.value) return
  deleteTarget.value = null
}
async function confirmDeleteMatch() {
  if (!deleteTarget.value) return
  deleting.value = true
  deleteError.value = ''
  try {
    await api.deleteQueueMatch(deleteTarget.value.id)
    deleteTarget.value = null
    await Promise.all([fetchActiveMatches(), fetchMatchHistory()])
  } catch (e: any) {
    deleteError.value = e?.message || 'Failed to delete match'
  } finally {
    deleting.value = false
  }
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

// setShadowPool removed when shadow flag moved into per-season custom
// groups. Manage members via Admin → Seasons → Season Setup → Groups.

function openBanModal(prefill?: { id: number; name: string; poolId?: number | null }) {
  // Default ban scope: the pool we're banning from (if known), otherwise the
  // first available pool. Never null when the caller can't manage all pools —
  // they aren't allowed to create global bans.
  const defaultPool = prefill?.poolId ?? (pools.value[0]?.id ?? null)
  banForm.value = {
    player_id: prefill?.id || null,
    player_label: prefill?.name || '',
    pool_id: defaultPool,
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
      pool_id: banForm.value.pool_id,
      duration_minutes: Number(banForm.value.duration_minutes) || 0,
      reason: banForm.value.reason,
    })
    closeBanModal()
    await Promise.all([fetchBans(), fetchQueuedPlayers()])
  } catch (e: any) { alert(e.message) }
}

async function unban(banId: number) {
  try {
    await api.removeAdminQueueBan(banId)
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

// Cancel — opens a styled confirm modal (no window.confirm), errors shown inline.
function openCancelMatch(qm: any) {
  cancelError.value = ''
  cancelTarget.value = qm
}
function closeCancelMatch() {
  if (cancelling.value) return
  cancelTarget.value = null
}
async function confirmCancelMatch() {
  if (!cancelTarget.value) return
  cancelling.value = true
  cancelError.value = ''
  try {
    await api.cancelQueueMatch(cancelTarget.value.id)
    cancelTarget.value = null
    await fetchActiveMatches()
  } catch (e: any) {
    cancelError.value = e?.message || 'Failed to cancel match'
  } finally {
    cancelling.value = false
  }
}

// Force-complete — same modal pattern.
function openForceComplete(qm: any) {
  forceError.value = ''
  forceTarget.value = qm
}
function closeForceComplete() {
  if (forcing.value) return
  forceTarget.value = null
}
async function confirmForceComplete() {
  if (!forceTarget.value) return
  forcing.value = true
  forceError.value = ''
  try {
    await api.forceCompleteQueueMatch(forceTarget.value.id)
    forceTarget.value = null
    await fetchActiveMatches()
  } catch (e: any) {
    forceError.value = e?.message || 'Failed to force-complete match'
  } finally {
    forcing.value = false
  }
}

const retryingLobby = ref<number | null>(null)
async function retryLobby(id: number, force = false) {
  if (retryingLobby.value) return
  retryingLobby.value = id
  retryError.value = null
  try {
    await api.adminRetryQueueLobby(id, force)
    await fetchActiveMatches()
  } catch (e: any) {
    retryError.value = { id, message: e?.message || 'Failed to retry lobby' }
  } finally {
    retryingLobby.value = null
  }
}

// Force-remake — destroys the current (stuck) lobby and recreates on a new bot.
// Used while a lobby is non-terminal (creating/waiting/launching/active), where
// a plain retry is refused because a lobby is still nominally active.
function openForceRemake(qm: any) {
  remakeError.value = ''
  remakeTarget.value = qm
}
function closeForceRemake() {
  if (remaking.value) return
  remakeTarget.value = null
}
async function confirmForceRemake() {
  if (!remakeTarget.value) return
  remaking.value = true
  remakeError.value = ''
  try {
    await api.adminRetryQueueLobby(remakeTarget.value.id, true)
    remakeTarget.value = null
    await fetchActiveMatches()
  } catch (e: any) {
    remakeError.value = e?.message || 'Failed to remake lobby'
  } finally {
    remaking.value = false
  }
}

// Recreate — cancel the current match and start a new one with the same teams.
function openRecreateMatch(qm: any) {
  recreateError.value = ''
  recreateTarget.value = qm
}
function closeRecreate() {
  if (recreating.value) return
  recreateTarget.value = null
}
async function confirmRecreate() {
  if (!recreateTarget.value) return
  recreating.value = true
  recreateError.value = ''
  try {
    const res: any = await api.recreateQueueMatch(recreateTarget.value.id)
    recreateTarget.value = null
    await fetchActiveMatches()
    // Backend returns ok:false + newQueueMatchId when the new match was created
    // but its lobby dispatch failed (no available bot, etc.) — surface that.
    if (res && res.ok === false && res.lobbyError) {
      retryError.value = { id: res.newQueueMatchId, message: `Lobby dispatch failed: ${res.lobbyError}` }
    }
  } catch (e: any) {
    recreateError.value = e?.message || 'Failed to recreate match'
  } finally {
    recreating.value = false
  }
}


// Force an immediate match-result check (runs the fetch_match_stats job now).
// Non-destructive; on success we flash a checkmark and refresh — the winner
// resolves a few seconds later once the worker picks up the bumped job.
const checkingResult = ref<number | null>(null)
const checkedResult = ref<number | null>(null)
async function checkResult(id: number) {
  if (checkingResult.value) return
  checkingResult.value = id
  try {
    await api.checkQueueMatchResult(id)
    checkedResult.value = id
    setTimeout(() => { if (checkedResult.value === id) checkedResult.value = null }, 2000)
    await fetchActiveMatches()
  } catch (e: any) {
    console.error('[checkResult]', e?.message || e)
  } finally {
    checkingResult.value = null
  }
}

function statusLabel(status: string) {
  switch (status) {
    case 'picking': return t('queueStatusPicking')
    case 'lobby_creating': return t('queueStatusCreatingLobby')
    case 'live': return t('queueStatusLive')
    case 'completed': return t('queueStatusCompleted')
    case 'cancelled': return t('queueStatusCancelled')
    default: return status
  }
}

function statusColor(status: string) {
  switch (status) {
    case 'picking': return 'bg-amber-500/10 text-amber-500'
    case 'lobby_creating': return 'bg-blue-500/10 text-blue-500'
    case 'live': return 'bg-green-500/10 text-green-500'
    case 'completed': return 'bg-primary/10 text-primary'
    case 'cancelled': return 'bg-destructive/10 text-destructive'
    default: return 'bg-accent text-muted-foreground'
  }
}

// Collapse the two raw statuses (queue_matches.status + match_lobbies.status)
// into ONE human-readable stage. The confusing case is qm.status='live' +
// lobby_status='completed' — the Dota game has LAUNCHED and is being played,
// and we're only waiting for the result to be auto-detected; "completed" there
// means "the lobby's job is done", NOT "the match is over". Returns ready-made
// literal class strings (never interpolate Tailwind tokens — JIT purges those).
type MatchStage = {
  key: 'DRAFTING' | 'CREATING_LOBBY' | 'WAITING_PLAYERS' | 'LOBBY_FAILED' | 'IN_GAME' | 'UNKNOWN'
  label: string
  sublabel: string
  color: string          // banner bg + text
  stepIndex: number      // 0 Draft · 1 Lobby · 2 In game · 3 Result
  stepActiveClass: string // fill for the active stepper node
  icon: any
  iconSpin: boolean
  awaitingResult: boolean // IN_GAME and the bot has left (lobby 'completed') — result auto-detect pending
}
function matchStage(qm: any): MatchStage {
  const ls = (qm.lobby_status || '').toLowerCase()
  if (qm.status === 'picking') {
    return { key: 'DRAFTING', label: t('queueStageDrafting'), sublabel: t('queueStageDraftingSub'),
      color: 'bg-amber-500/10 text-amber-500', stepIndex: 0, stepActiveClass: 'bg-amber-500 border-amber-500', icon: Swords, iconSpin: false, awaitingResult: false }
  }
  // 'completed' = bot captured the match id and left; game launched, result auto-detect pending.
  if (qm.status === 'live' && ls === 'completed') {
    return { key: 'IN_GAME', label: t('queueStageInGame'), sublabel: t('queueStageInGameSub'),
      color: 'bg-green-500/10 text-green-500', stepIndex: 2, stepActiveClass: 'bg-green-500 border-green-500', icon: Swords, iconSpin: false, awaitingResult: true }
  }
  // 'active' = Dota lobby state RUN (game is being played); 'cointoss' = SERVERSETUP
  // (game is starting / coin toss). Both mean the game has started — NOT "waiting".
  if (qm.status === 'live' && (ls === 'active' || ls === 'cointoss')) {
    return { key: 'IN_GAME', label: t('queueStageInGame'), sublabel: t('queueStageInGameLiveSub'),
      color: 'bg-green-500/10 text-green-500', stepIndex: 2, stepActiveClass: 'bg-green-500 border-green-500', icon: Swords, iconSpin: false, awaitingResult: false }
  }
  if (qm.status === 'live' && ls === 'error') {
    return { key: 'LOBBY_FAILED', label: t('queueStageLobbyFailed'), sublabel: t('queueStageLobbyFailedSub'),
      color: 'bg-destructive/10 text-destructive', stepIndex: 1, stepActiveClass: 'bg-destructive border-destructive', icon: AlertTriangle, iconSpin: false, awaitingResult: false }
  }
  if (qm.status === 'live' && (ls === 'waiting' || ls === 'launching')) {
    return { key: 'WAITING_PLAYERS', label: t('queueStageWaitingPlayers'), sublabel: t('queueStageWaitingPlayersSub'),
      color: 'bg-blue-500/10 text-blue-500', stepIndex: 1, stepActiveClass: 'bg-blue-500 border-blue-500', icon: Clock, iconSpin: false, awaitingResult: false }
  }
  if (qm.status === 'lobby_creating' || qm.status === 'live') {
    // lobby_creating, or live with no lobby row yet / still 'creating' — the bot
    // is making the lobby. Mid-retry stays blue (self-healing); only ls==='error'
    // (handled above) flips to red.
    const retrying = (qm.lobby_error_count || 0) > 0
    return { key: 'CREATING_LOBBY', label: t('queueStageCreatingLobby'),
      sublabel: retrying ? t('queueStageCreatingLobbyRetrySub') : t('queueStageCreatingLobbySub'),
      color: 'bg-blue-500/10 text-blue-500', stepIndex: 1, stepActiveClass: 'bg-blue-500 border-blue-500', icon: Loader2, iconSpin: true, awaitingResult: false }
  }
  return { key: 'UNKNOWN', label: statusLabel(qm.status), sublabel: '',
    color: 'bg-accent text-muted-foreground', stepIndex: 0, stepActiveClass: 'bg-muted-foreground border-muted-foreground', icon: Swords, iconSpin: false, awaitingResult: false }
}

// Pre-compute the stage once per row so the template doesn't call matchStage 5×.
const activeMatchesWithStage = computed(() =>
  activeMatches.value.map((qm: any) => ({ ...qm, _stage: matchStage(qm) })))

const STAGE_STEPS = ['queueStepDraft', 'queueStepLobby', 'queueStepInGame', 'queueStepResult'] as const

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

async function fetchLeagues() {
  try { leagues.value = await api.getLeagues() } catch { leagues.value = [] }
}

onMounted(() => {
  fetchPools()
  fetchSeasons()
  fetchLeagues()
  fetchActiveMatches()
  fetchQueuedPlayers()
  fetchBans()
  if (activeTab.value === 'history') fetchMatchHistory()
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
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[var(--admin-content-max,1200px)] w-full">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-semibold text-foreground">{{ t('adminQueuePools') }}</h1>
        <p class="text-sm text-muted-foreground mt-1">{{ t('queueAdminSubtitle') }}</p>
      </div>
      <button v-if="activeTab === 'pools'" class="btn-primary flex items-center gap-1.5 text-sm" @click="startCreate">
        <Plus class="w-4 h-4" /> {{ t('queueCreatePool') }}
      </button>
    </div>

    <!-- Tabs -->
    <div class="flex gap-1 border-b border-border overflow-x-auto">
      <button
        class="px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px flex items-center gap-2"
        :class="activeTab === 'pools' ? 'text-primary border-primary' : 'text-muted-foreground border-transparent hover:text-foreground hover:border-border'"
        @click="setTab('pools')"
      >
        {{ t('queueTabPools') }}
        <span v-if="pools.length > 0" class="text-[10px] font-semibold bg-accent text-muted-foreground px-1.5 rounded-full">{{ pools.length }}</span>
      </button>
      <button
        class="px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px flex items-center gap-2"
        :class="activeTab === 'queue' ? 'text-primary border-primary' : 'text-muted-foreground border-transparent hover:text-foreground hover:border-border'"
        @click="setTab('queue')"
      >
        {{ t('queueTabInQueue') }}
        <span v-if="queuedPlayers.length > 0" class="text-[10px] font-semibold bg-primary/15 text-primary px-1.5 rounded-full">{{ queuedPlayers.length }}</span>
      </button>
      <button
        class="px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px flex items-center gap-2"
        :class="activeTab === 'matches' ? 'text-primary border-primary' : 'text-muted-foreground border-transparent hover:text-foreground hover:border-border'"
        @click="setTab('matches')"
      >
        {{ t('queueTabActiveMatches') }}
        <span v-if="activeMatches.length > 0" class="text-[10px] font-semibold bg-primary/15 text-primary px-1.5 rounded-full">{{ activeMatches.length }}</span>
      </button>
      <button
        class="px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px flex items-center gap-2"
        :class="activeTab === 'history' ? 'text-primary border-primary' : 'text-muted-foreground border-transparent hover:text-foreground hover:border-border'"
        @click="setTab('history')"
      >
        {{ t('queueTabHistory') }}
      </button>
    </div>

    <!-- ═══════════════════ Active Queue Matches ═══════════════════ -->
    <div v-if="activeTab === 'matches'">
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
        <div v-for="qm in activeMatchesWithStage" :key="qm.id" class="card overflow-hidden">
          <!-- Header: ids + pool (the stage banner below owns the status, so no badge here) -->
          <div class="px-4 pt-3 pb-2 flex items-center gap-2 flex-wrap">
            <span class="text-sm font-semibold text-muted-foreground">#{{ qm.id }}</span>
            <span v-if="qm.match_id" class="text-[10px] font-mono text-muted-foreground bg-accent/60 px-1.5 py-0.5 rounded">match #{{ qm.match_id }}</span>
            <span v-if="qm.pool_name" class="text-xs text-muted-foreground bg-accent px-2 py-0.5 rounded">{{ qm.pool_name }}</span>
          </div>

          <!-- Progress stepper: Draft → Lobby → In game → Result -->
          <div class="px-6 pb-3 flex items-start">
            <template v-for="(stepKey, i) in STAGE_STEPS" :key="stepKey">
              <div v-if="i > 0" class="flex-1 h-0.5 mt-[5px]"
                :class="i <= qm._stage.stepIndex ? 'bg-foreground/25' : 'bg-border'"></div>
              <div class="flex flex-col items-center gap-1 shrink-0">
                <div class="w-3 h-3 rounded-full border-2"
                  :class="i < qm._stage.stepIndex ? 'bg-foreground/40 border-foreground/40'
                    : i === qm._stage.stepIndex ? qm._stage.stepActiveClass
                    : 'bg-transparent border-border'"></div>
                <span class="text-[10px] uppercase tracking-wider font-semibold leading-none whitespace-nowrap"
                  :class="i === qm._stage.stepIndex ? 'text-foreground' : 'text-muted-foreground/50'">
                  {{ t(stepKey) }}
                </span>
              </div>
            </template>
          </div>

          <!-- Stage banner: single, plain-language source of truth for "what state is this game in" -->
          <div class="mx-4 mb-3 rounded-lg px-3 py-2.5 flex items-start gap-2.5" :class="qm._stage.color">
            <component :is="qm._stage.icon" class="w-4 h-4 mt-0.5 shrink-0" :class="{ 'animate-spin': qm._stage.iconSpin }" />
            <div class="min-w-0">
              <div class="text-sm font-bold leading-tight">{{ qm._stage.label }}</div>
              <div v-if="qm._stage.sublabel" class="text-xs text-muted-foreground mt-0.5">{{ qm._stage.sublabel }}</div>
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

          <!-- Lobby info (name / password / bot / errors). The raw lobby status word
               is intentionally gone — the stage banner above is the single status. -->
          <div v-if="qm.lobby_name" class="px-4 pb-3 flex flex-col gap-1.5 text-xs text-muted-foreground">
            <div class="flex items-center gap-4 flex-wrap">
              <span>{{ t('queueLobbyName') }}: <strong class="text-foreground font-mono">{{ qm.lobby_name }}</strong></span>
              <span>{{ t('queueLobbyPassword') }}: <strong class="text-foreground font-mono select-all">{{ qm.lobby_password }}</strong></span>
              <span v-if="qm.lobby_bot_id" class="text-[10px]">bot #{{ qm.lobby_bot_id }}</span>
              <span v-if="qm.lobby_error_count > 0" class="text-[10px] text-amber-500">
                {{ qm.lobby_error_count }} failed {{ qm.lobby_error_count === 1 ? 'attempt' : 'attempts' }}
              </span>
            </div>
            <div v-if="qm.lobby_error" class="px-2 py-1.5 rounded bg-red-500/10 border border-red-500/30 text-red-400 text-[11px] font-mono whitespace-pre-wrap break-all">
              {{ qm.lobby_error }}
            </div>
          </div>

          <!-- Action footer: emphasized stage action (left) + secondary actions (right) -->
          <div class="px-4 py-2.5 border-t border-border/40 flex items-center justify-between gap-2 flex-wrap">
            <!-- Primary: the one action this stage calls for (none while the system is just working) -->
            <div class="flex items-center gap-1.5">
              <button
                v-if="qm._stage.key === 'LOBBY_FAILED'"
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                :title="t('queueAdminRetryLobbyHint')"
                :disabled="retryingLobby === qm.id"
                @click="retryLobby(qm.id)"
              >
                <RefreshCw class="w-3.5 h-3.5" :class="retryingLobby === qm.id ? 'animate-spin' : ''" /> {{ t('queueAdminRetryLobby') }}
              </button>
              <!-- Force complete only once the bot has left (lobby 'completed') and we're
                   stuck waiting on the result — not while the game is still being played. -->
              <button
                v-else-if="qm._stage.awaitingResult"
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-amber-500 bg-amber-500/10 hover:bg-amber-500/20 transition-colors"
                :title="t('queueAdminForceCompleteHint')"
                @click="openForceComplete(qm)"
              >
                <CheckSquare class="w-3.5 h-3.5" /> {{ t('queueAdminForceComplete') }}
              </button>
            </div>

            <!-- Secondary: muted text buttons -->
            <div class="flex items-center gap-1.5">
              <!-- Remake stays reachable while the lobby is in-flight: destroys the
                   current (possibly stuck) lobby and recreates it on a different bot. -->
              <button
                v-if="qm._stage.key === 'CREATING_LOBBY' || qm._stage.key === 'WAITING_PLAYERS'"
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-primary hover:bg-primary/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                :title="t('queueAdminForceRemakeHint')"
                :disabled="retryingLobby === qm.id"
                @click="openForceRemake(qm)"
              >
                <RefreshCw class="w-3.5 h-3.5" :class="retryingLobby === qm.id ? 'animate-spin' : ''" /> {{ t('queueAdminForceRemake') }}
              </button>
              <!-- Recreate: cancels the current queue match and starts a new one with the
                   exact same captains/teams/pool/season. Available once teams are formed
                   (no DRAFTING) and the game hasn't already launched (no awaitingResult). -->
              <button
                v-if="qm._stage.key !== 'DRAFTING' && qm._stage.key !== 'UNKNOWN' && !qm._stage.awaitingResult"
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-amber-500 hover:bg-amber-500/10 transition-colors"
                :title="t('queueAdminRecreateHint')"
                @click="openRecreateMatch(qm)"
              >
                <RotateCcw class="w-3.5 h-3.5" /> {{ t('queueAdminRecreate') }}
              </button>
              <button
                v-if="qm.match_id"
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-cyan-500 hover:bg-cyan-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                :title="t('queueAdminCheckResultHint')"
                :disabled="checkingResult === qm.id"
                @click="checkResult(qm.id)"
              >
                <Loader2 v-if="checkingResult === qm.id" class="w-3.5 h-3.5 animate-spin" />
                <Check v-else-if="checkedResult === qm.id" class="w-3.5 h-3.5 text-green-400" />
                <Search v-else class="w-3.5 h-3.5" />
                {{ t('queueAdminCheckResult') }}
              </button>
              <button
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                :title="qm._stage.awaitingResult ? t('queueAdminMatchInProgress') : ''"
                :disabled="qm._stage.awaitingResult"
                @click="openCancelMatch(qm)"
              >
                <Ban class="w-3.5 h-3.5" /> {{ t('cancel') }}
              </button>
              <button
                v-if="canDeleteMatches"
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-destructive hover:bg-destructive/10 transition-colors"
                :title="t('queueAdminDeleteTitle')"
                @click="openDeleteMatch(qm)"
              >
                <Trash2 class="w-3.5 h-3.5" /> {{ t('queueAdminDelete') }}
              </button>
            </div>
          </div>

          <!-- Inline retry error (replaces the old alert()) -->
          <div v-if="retryError && retryError.id === qm.id" class="px-4 pb-3">
            <p class="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2">{{ retryError.message }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══════════════════ Match History ═══════════════════ -->
    <div v-if="activeTab === 'history'">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-3">
          <h2 class="text-xl font-bold">{{ t('queueAdminMatchHistory') }}</h2>
          <span v-if="matchHistory.length > 0" class="text-xs font-semibold bg-accent text-muted-foreground px-2 py-0.5 rounded-full">
            {{ matchHistory.length }}
          </span>
        </div>
        <button class="p-1.5 rounded hover:bg-accent" :class="loadingHistory ? 'animate-spin' : ''" @click="fetchMatchHistory">
          <RefreshCw class="w-4 h-4" />
        </button>
      </div>

      <div v-if="matchHistory.length === 0" class="card px-6 py-8 text-center mb-8">
        <Clock class="w-8 h-8 text-muted-foreground/20 mx-auto mb-2" />
        <p class="text-sm text-muted-foreground">{{ t('queueAdminNoHistory') }}</p>
      </div>

      <div v-else class="flex flex-col gap-2 mb-8">
        <div v-for="qm in matchHistory" :key="qm.id" class="card px-4 py-3 flex items-center justify-between gap-4">
          <!-- Left: status + ids + pool -->
          <div class="flex items-center gap-3 flex-wrap min-w-0">
            <span class="text-xs px-2 py-0.5 rounded font-semibold" :class="statusColor(qm.status)">
              {{ statusLabel(qm.status) }}
            </span>
            <span class="text-sm font-semibold text-muted-foreground">#{{ qm.id }}</span>
            <span v-if="qm.match_id" class="text-[10px] font-mono text-muted-foreground bg-accent/60 px-1.5 py-0.5 rounded">match #{{ qm.match_id }}</span>
            <span v-if="qm.pool_name" class="text-xs text-muted-foreground bg-accent px-2 py-0.5 rounded">{{ qm.pool_name }}</span>
            <span v-if="qm.season_id" class="text-[10px] font-semibold text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded">{{ t('queueAdminSeasonTag') }}</span>
          </div>

          <!-- Middle: captains + score -->
          <div class="flex items-center gap-2 text-xs min-w-0 flex-1 justify-center">
            <span class="font-medium truncate max-w-[120px]">{{ qm.captain1_display_name || qm.captain1_name || '—' }}</span>
            <span v-if="qm.score1 != null && qm.score2 != null" class="font-mono font-bold text-foreground">{{ qm.score1 }}–{{ qm.score2 }}</span>
            <span v-else class="text-muted-foreground/40 font-bold">vs</span>
            <span class="font-medium truncate max-w-[120px]">{{ qm.captain2_display_name || qm.captain2_name || '—' }}</span>
          </div>

          <!-- Right: date + delete -->
          <div class="flex items-center gap-3 shrink-0">
            <span class="text-[11px] text-muted-foreground whitespace-nowrap">{{ new Date(qm.completed_at || qm.created_at).toLocaleString() }}</span>
            <button
              v-if="canDeleteMatches"
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-destructive hover:bg-destructive/10 transition-colors"
              :title="t('queueAdminDeleteTitle')"
              @click="openDeleteMatch(qm)"
            >
              <Trash2 class="w-3.5 h-3.5" /> {{ t('queueAdminDelete') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══════════════════ Currently Queued Players ═══════════════════ -->
    <div v-if="activeTab === 'queue'">
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
            <button class="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold text-destructive hover:bg-destructive/10 transition-colors" @click="openBanModal({ id: p.playerId, name: p.name, poolId: p.poolId })">
              <Ban class="w-3.5 h-3.5" /> {{ t('queueAdminBan') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══════════════════ Queue Bans ═══════════════════ -->
    <div v-if="activeTab === 'queue'">
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
        <div v-for="b in bans" :key="b.id" class="flex items-center gap-3 px-4 py-2 border-b border-border/30 last:border-b-0">
          <img v-if="b.avatar_url" :src="b.avatar_url" class="w-6 h-6 rounded-full" />
          <span class="font-medium text-sm">{{ b.display_name || b.name }}</span>
          <span class="text-[10px] text-muted-foreground">#{{ b.player_id }}</span>
          <span class="text-[11px] px-1.5 py-0.5 rounded font-semibold"
            :class="b.pool_id == null ? 'bg-amber-500/15 text-amber-500' : 'bg-primary/15 text-primary'">
            {{ b.pool_id == null ? t('queueAdminBanScopeAll') : (b.pool_name || `pool #${b.pool_id}`) }}
          </span>
          <span class="text-[11px] flex items-center gap-1 px-1.5 py-0.5 rounded bg-destructive/10 text-destructive">
            <Clock class="w-3 h-3" /> {{ formatBanUntil(b.banned_until) }}
          </span>
          <span v-if="b.reason" class="text-[11px] text-muted-foreground italic truncate max-w-[260px]">{{ b.reason }}</span>
          <span v-if="b.banned_by_name" class="text-[10px] text-muted-foreground ml-auto">by {{ b.banned_by_name }}</span>
          <button class="ml-2 p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors" :title="t('queueAdminUnban')" @click="unban(b.id)">
            <X class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>

    <!-- ═══════════════════ Queue Pools ═══════════════════ -->
    <!-- Pool List -->
    <div v-if="activeTab === 'pools'" class="flex flex-col gap-3 mb-6">
      <div v-for="pool in pools" :key="pool.id" class="card px-4 py-3">
        <div class="flex items-center justify-between">
          <div>
            <span class="font-semibold">{{ pool.name }}</span>
            <span class="ml-2 text-xs px-1.5 py-0.5 rounded" :class="pool.enabled ? 'bg-green-500/10 text-green-500' : 'bg-accent text-muted-foreground'">
              {{ pool.enabled ? 'Enabled' : 'Disabled' }}
            </span>
            <span v-if="pool.verified_mmr_only" class="ml-1.5 text-xs px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500 font-semibold">
              {{ t('queuePoolVerifiedOnly') }}
            </span>
            <span class="text-xs text-muted-foreground ml-3">
              {{ pool.team_size || 5 }}v{{ pool.team_size || 5 }}
              | MMR: {{ pool.min_mmr || 0 }}{{ pool.max_mmr ? `-${pool.max_mmr}` : '+' }}
              | Pick: {{ pool.pick_timer }}s
              | Region: {{ SERVER_REGIONS[pool.lobby_server_region] || pool.lobby_server_region }}
              | League: {{ pool.lobby_league_id || 'None' }}
            </span>
          </div>
          <div v-if="canEditPool(pool)" class="flex items-center gap-2">
            <button class="p-1.5 rounded hover:bg-accent" @click="startEdit(pool)"><Pencil class="w-4 h-4" /></button>
            <button class="p-1.5 rounded hover:bg-destructive/10 text-destructive" @click="deletePool(pool.id)"><Trash2 class="w-4 h-4" /></button>
          </div>
        </div>
      </div>
      <div v-if="pools.length === 0" class="text-muted-foreground text-sm text-center py-4">{{ t('queueNoPoolsYet') }}</div>
    </div>

    <!-- Create / Edit Form -->
    <div v-if="activeTab === 'pools' && (showCreate || editingId)" class="card px-6 py-5">
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
        <div class="flex items-center gap-4 pt-5">
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" :checked="form.enabled" @change="form.enabled = ($event.target as HTMLInputElement).checked" />
            <span class="text-sm">{{ t('queueEnabled') }}</span>
          </label>
          <label class="flex items-center gap-2 cursor-pointer" :title="t('queueFeaturedHint')">
            <input type="checkbox" :checked="form.is_featured" @change="form.is_featured = ($event.target as HTMLInputElement).checked" />
            <span class="text-sm">{{ t('queueFeatured') }}</span>
          </label>
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
          <label class="text-xs text-muted-foreground">{{ t('queueCaptainThreshold') }}</label>
          <input class="input-field" type="number" min="0" v-model.number="form.captain_eligibility_threshold" />
          <span class="text-[10px] text-muted-foreground leading-tight">{{ t('queueCaptainThresholdHint') }}</span>
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
          <label class="text-xs text-muted-foreground">{{ t('lobbyLeagueId') }}</label>
          <select class="input-field" v-model.number="form.lobby_league_id">
            <option :value="0">{{ t('lobbyLeagueNone') }}</option>
            <option v-for="lg in leagues" :key="lg.id" :value="lg.dota_league_id">{{ lg.name }} (#{{ lg.dota_league_id }})</option>
            <option v-if="form.lobby_league_id && !leagues.some(l => l.dota_league_id === form.lobby_league_id)" :value="form.lobby_league_id">#{{ form.lobby_league_id }}</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('lobbyTimeout') }} (min)</label>
          <input class="input-field" type="number" v-model.number="form.lobby_timeout_minutes" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('lobbyDotaTvDelay') }}</label>
          <select class="input-field" v-model.number="form.lobby_dotv_delay">
            <option :value="0">{{ t('dotaTvNone') }}</option>
            <option :value="1">{{ t('dotaTv10min') }}</option>
            <option :value="2">{{ t('dotaTv5min') }}</option>
            <option :value="3">{{ t('dotaTv2min') }}</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('lobbySeriesType') }}</label>
          <select class="input-field" v-model.number="form.lobby_series_type">
            <option :value="0">{{ t('seriesNone') }}</option>
            <option :value="1">{{ t('seriesBo2') }}</option>
            <option :value="2">{{ t('seriesBo3') }}</option>
            <option :value="3">{{ t('seriesBo5') }}</option>
          </select>
        </div>
        <div class="flex items-center gap-4 col-span-2 flex-wrap">
          <label class="flex items-center gap-1.5">
            <input type="checkbox" :checked="form.lobby_auto_assign_teams" @change="form.lobby_auto_assign_teams = ($event.target as HTMLInputElement).checked" />
            <span class="text-sm">{{ t('lobbyAutoAssignTeams') }}</span>
          </label>
          <label class="flex items-center gap-1.5">
            <input type="checkbox" :checked="form.lobby_cheats" @change="form.lobby_cheats = ($event.target as HTMLInputElement).checked" />
            <span class="text-sm">{{ t('lobbyCheats') }}</span>
          </label>
          <label class="flex items-center gap-1.5">
            <input type="checkbox" :checked="form.lobby_allow_spectating" @change="form.lobby_allow_spectating = ($event.target as HTMLInputElement).checked" />
            <span class="text-sm">{{ t('lobbyAllowSpectating') }}</span>
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
          <select class="input-field" v-model.number="form.lobby_penalty_radiant">
            <option :value="0">{{ t('penaltyNone') }}</option>
            <option :value="1">{{ t('penaltyLevel', { n: 1 }) }}</option>
            <option :value="2">{{ t('penaltyLevel', { n: 2 }) }}</option>
            <option :value="3">{{ t('penaltyLevel', { n: 3 }) }}</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('lobbyPenaltyDire') }}</label>
          <select class="input-field" v-model.number="form.lobby_penalty_dire">
            <option :value="0">{{ t('penaltyNone') }}</option>
            <option :value="1">{{ t('penaltyLevel', { n: 1 }) }}</option>
            <option :value="2">{{ t('penaltyLevel', { n: 2 }) }}</option>
            <option :value="3">{{ t('penaltyLevel', { n: 3 }) }}</option>
          </select>
        </div>
      </div>

      <!-- Rules -->
      <div class="border-t border-border/30 pt-4 mt-4 flex flex-col gap-3">
        <span class="text-sm font-semibold text-muted-foreground">{{ t('queuePoolRulesSection') }}</span>
        <p class="text-[11px] text-muted-foreground -mt-2">{{ t('queuePoolRulesSectionHint') }}</p>
        <div class="flex flex-col gap-1.5">
          <label class="text-xs text-muted-foreground">{{ t('queuePoolRulesTitle') }}</label>
          <input type="text" class="input-field" v-model="form.rules_title" :placeholder="t('queuePoolRulesTitlePlaceholder')" />
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-xs text-muted-foreground">{{ t('queuePoolRulesContent') }}</label>
          <RichTextEditor v-model="form.rules_content" />
        </div>
      </div>

      <!-- Inhouse -->
      <div class="border-t border-border/30 pt-4 mt-4 flex flex-col gap-3">
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" v-model="form.inhouse_enabled" class="w-4 h-4" />
          <span class="text-sm font-semibold text-muted-foreground">{{ t('queueInhouseEnable') }}</span>
        </label>
        <p class="text-[11px] text-muted-foreground -mt-1">{{ t('queueInhouseEnableHint') }}</p>

        <div v-if="form.inhouse_enabled" class="flex flex-col gap-4 pl-2 border-l-2 border-purple-500/20">
          <!-- Captains subgroup -->
          <div class="flex flex-col gap-2">
            <span class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t('queueInhouseCaptainsSection') }}</span>
            <p class="text-[11px] text-muted-foreground">{{ t('queueInhouseCaptainsHint') }}</p>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label class="text-xs text-muted-foreground">{{ t('queueInhousePickOrder') }}</label>
                <input type="text" class="input-field" v-model="form.pick_order" placeholder="1,2,1,2,1,2,2,1" />
                <p class="text-[11px] text-muted-foreground mt-1">{{ t('queueInhousePickOrderHint', { n: (form.team_size || 5) - 1 }) }}</p>
              </div>
              <div></div>
              <div>
                <label class="text-xs text-muted-foreground">{{ t('queueInhouseWeekdayMode') }}</label>
                <select class="input-field" v-model.number="form.weekday_game_mode">
                  <option :value="1">AP</option><option :value="2">CM</option><option :value="3">RD</option><option :value="4">SD</option>
                  <option :value="5">AR</option><option :value="8">Reverse CM</option><option :value="11">MO</option><option :value="12">LP</option>
                  <option :value="16">CD</option><option :value="18">ABD</option><option :value="20">ARDM</option><option :value="21">1v1</option>
                  <option :value="22">AD</option><option :value="23">Turbo</option>
                </select>
              </div>
              <div>
                <label class="text-xs text-muted-foreground">{{ t('queueInhouseFridayMode') }}</label>
                <select class="input-field" v-model.number="form.friday_game_mode">
                  <option :value="1">AP</option><option :value="2">CM</option><option :value="3">RD</option><option :value="4">SD</option>
                  <option :value="5">AR</option><option :value="8">Reverse CM</option><option :value="11">MO</option><option :value="12">LP</option>
                  <option :value="16">CD</option><option :value="18">ABD</option><option :value="20">ARDM</option><option :value="21">1v1</option>
                  <option :value="22">AD</option><option :value="23">Turbo</option>
                </select>
              </div>
            </div>

            <!-- Friday window: a Riga-time window from Friday start_hour to
                 Saturday end_hour. 0/0 = plain calendar Friday. Drives the
                 Friday game mode, win bonus, top-3 bonus and leaderboard tab. -->
            <div>
              <label class="text-xs text-muted-foreground">{{ t('queueInhouseFridayWindow') }}</label>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 mt-1">
                <div>
                  <div class="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>{{ t('queueInhouseFridayWindowStart') }}</span>
                    <span class="font-mono tabular-nums text-foreground">{{ hh(form.friday_window_start_hour) }}</span>
                  </div>
                  <input type="range" min="0" max="23" step="1" v-model.number="form.friday_window_start_hour" class="w-full accent-primary" />
                </div>
                <div>
                  <div class="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>{{ t('queueInhouseFridayWindowEnd') }}</span>
                    <span class="font-mono tabular-nums text-foreground">{{ hh(form.friday_window_end_hour) }}</span>
                  </div>
                  <input type="range" min="0" max="23" step="1" v-model.number="form.friday_window_end_hour" class="w-full accent-primary" />
                </div>
              </div>
              <p class="text-[11px] text-muted-foreground mt-1">{{ t('queueInhouseFridayWindowHint', { window: fridayWindowLabel }) }}</p>
            </div>
          </div>

          <!-- Points subgroup -->
          <div class="flex flex-col gap-2">
            <span class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t('queueInhousePointsSection') }}</span>

            <!-- Static-points override. When on, the ELO base is skipped:
                 winners get the flat win value, losers lose the flat loss
                 value, and the MMR-diff / winstreak / Friday / leaver
                 bonuses stack on top exactly as in ELO mode. -->
            <label class="flex items-center gap-2 cursor-pointer text-sm">
              <input type="checkbox" v-model="form.use_static_points" class="w-4 h-4" />
              <span>{{ t('queueInhouseUseStaticPoints') }}</span>
            </label>
            <p class="text-[11px] text-muted-foreground -mt-1">{{ t('queueInhouseUseStaticPointsHint') }}</p>
            <div v-if="form.use_static_points" class="grid grid-cols-2 gap-3 pl-6">
              <div>
                <label class="text-xs text-muted-foreground">{{ t('queueInhouseWinPoints') }}</label>
                <input type="number" class="input-field" v-model.number="form.inhouse_win_points" />
              </div>
              <div>
                <label class="text-xs text-muted-foreground">{{ t('queueInhouseLossPoints') }}</label>
                <input type="number" class="input-field" v-model.number="form.inhouse_loss_points" />
              </div>
            </div>

            <div>
              <label class="text-xs text-muted-foreground">{{ t('queueInhouseMmrDiffTiers') }}</label>
              <p class="text-[11px] text-muted-foreground/70 mt-0.5">{{ t('queueInhouseMmrDiffTiersHint') }}</p>
              <div class="flex flex-col gap-1.5 mt-1">
                <div v-for="(tier, i) in form.mmr_diff_tiers" :key="i" class="grid grid-cols-12 gap-2 items-center">
                  <input type="number" class="input-field col-span-3" v-model.number="tier.min" :placeholder="t('queueInhouseMmrDiffMin')" />
                  <input type="number" class="input-field col-span-3" v-model.number="tier.max" :placeholder="t('queueInhouseMmrDiffMax')" />
                  <input type="number" class="input-field col-span-4" v-model.number="tier.bonus" :placeholder="t('queueInhouseTierBonus')" />
                  <button class="col-span-2 btn-outline text-xs" @click="removeTierRow('mmr_diff_tiers', i)">{{ t('remove') }}</button>
                </div>
                <button class="btn-outline text-xs self-start" @click="addTierRow('mmr_diff_tiers', { min: 0, max: 0, bonus: 0 })">
                  + {{ t('queueInhouseAddTier') }}
                </button>
              </div>
            </div>

            <div>
              <label class="text-xs text-muted-foreground">{{ t('queueInhouseWinstreakTiers') }}</label>
              <div class="flex flex-col gap-1.5 mt-1">
                <div v-for="(tier, i) in form.winstreak_tiers" :key="i" class="grid grid-cols-12 gap-2 items-center">
                  <input type="number" class="input-field col-span-5" v-model.number="tier.streak" :placeholder="t('queueInhouseWinstreakAt')" />
                  <input type="number" class="input-field col-span-5" v-model.number="tier.bonus" :placeholder="t('queueInhouseTierBonus')" />
                  <button class="col-span-2 btn-outline text-xs" @click="removeTierRow('winstreak_tiers', i)">{{ t('remove') }}</button>
                </div>
                <button class="btn-outline text-xs self-start" @click="addTierRow('winstreak_tiers', { streak: 0, bonus: 0 })">
                  + {{ t('queueInhouseAddTier') }}
                </button>
              </div>
            </div>

            <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <label class="text-xs text-muted-foreground">{{ t('queueInhouseFridayWinBonus') }}</label>
                <input type="number" class="input-field" v-model.number="form.friday_win_bonus" />
              </div>
              <div>
                <label class="text-xs text-muted-foreground">{{ t('queueInhouseFridayTop1') }}</label>
                <input type="number" class="input-field" v-model.number="form.friday_top1_bonus" />
              </div>
              <div>
                <label class="text-xs text-muted-foreground">{{ t('queueInhouseFridayTop2') }}</label>
                <input type="number" class="input-field" v-model.number="form.friday_top2_bonus" />
              </div>
              <div>
                <label class="text-xs text-muted-foreground">{{ t('queueInhouseFridayTop3') }}</label>
                <input type="number" class="input-field" v-model.number="form.friday_top3_bonus" />
              </div>
              <div>
                <label class="text-xs text-muted-foreground">{{ t('queueInhouseLeaverPenalty') }}</label>
                <input type="number" class="input-field" v-model.number="form.leaver_penalty" />
              </div>
              <div>
                <label class="text-xs text-muted-foreground">{{ t('queueInhouseLeaverGrace') }}</label>
                <input type="number" min="0" class="input-field" v-model.number="form.leaver_grace_minutes" />
              </div>
            </div>
          </div>

          <!-- Discipline subgroup -->
          <div class="flex flex-col gap-2">
            <span class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t('queueInhouseDisciplineSection') }}</span>

            <div>
              <label class="text-xs text-muted-foreground">{{ t('queueInhouseToxicThresholds') }}</label>
              <div class="flex flex-col gap-1.5 mt-1">
                <div v-for="(tier, i) in form.toxic_report_thresholds" :key="i" class="grid grid-cols-12 gap-2 items-center">
                  <input type="number" class="input-field col-span-5" v-model.number="tier.reports" :placeholder="t('queueInhouseAtReports')" />
                  <input type="number" class="input-field col-span-5" v-model.number="tier.strike_delta" :placeholder="t('queueInhouseStrikeDelta')" />
                  <button class="col-span-2 btn-outline text-xs" @click="removeTierRow('toxic_report_thresholds', i)">{{ t('remove') }}</button>
                </div>
                <button class="btn-outline text-xs self-start" @click="addTierRow('toxic_report_thresholds', { reports: 0, strike_delta: 0 })">
                  + {{ t('queueInhouseAddTier') }}
                </button>
              </div>
            </div>

            <div>
              <label class="text-xs text-muted-foreground">{{ t('queueInhouseToxicCooldowns') }}</label>
              <div class="flex flex-col gap-1.5 mt-1">
                <div v-for="(tier, i) in form.toxic_strike_cooldowns" :key="i" class="grid grid-cols-12 gap-2 items-center">
                  <input type="number" class="input-field col-span-3" v-model.number="tier.strikes" :placeholder="t('queueInhouseAtStrikes')" />
                  <input type="number" class="input-field col-span-3" v-model.number="tier.hours" :placeholder="t('queueInhouseHours')" />
                  <select class="input-field col-span-4" v-model="tier.action">
                    <option value="">{{ t('queueInhouseCooldownNoAction') }}</option>
                    <option value="warn">{{ t('queueInhouseCooldownWarn') }}</option>
                    <option value="ban">{{ t('queueInhouseCooldownBan') }}</option>
                  </select>
                  <button class="col-span-2 btn-outline text-xs" @click="removeTierRow('toxic_strike_cooldowns', i)">{{ t('remove') }}</button>
                </div>
                <button class="btn-outline text-xs self-start" @click="addTierRow('toxic_strike_cooldowns', { strikes: 0, hours: 0, action: '' })">
                  + {{ t('queueInhouseAddTier') }}
                </button>
              </div>
            </div>

            <div>
              <label class="text-xs text-muted-foreground">{{ t('queueInhouseGriefCooldowns') }}</label>
              <div class="flex flex-col gap-1.5 mt-1">
                <div v-for="(tier, i) in form.grief_strike_cooldowns" :key="i" class="grid grid-cols-12 gap-2 items-center">
                  <input type="number" class="input-field col-span-3" v-model.number="tier.strikes" :placeholder="t('queueInhouseAtStrikes')" />
                  <input type="number" class="input-field col-span-3" v-model.number="tier.hours" :placeholder="t('queueInhouseHours')" />
                  <select class="input-field col-span-4" v-model="tier.action">
                    <option value="">{{ t('queueInhouseCooldownNoAction') }}</option>
                    <option value="warn">{{ t('queueInhouseCooldownWarn') }}</option>
                    <option value="ban">{{ t('queueInhouseCooldownBan') }}</option>
                  </select>
                  <button class="col-span-2 btn-outline text-xs" @click="removeTierRow('grief_strike_cooldowns', i)">{{ t('remove') }}</button>
                </div>
                <button class="btn-outline text-xs self-start" @click="addTierRow('grief_strike_cooldowns', { strikes: 0, hours: 0, action: '' })">
                  + {{ t('queueInhouseAddTier') }}
                </button>
              </div>
            </div>

            <div>
              <label class="flex items-center gap-2 cursor-pointer text-sm">
                <input type="checkbox" v-model="form.grief_revoke_captain" class="w-4 h-4" />
                <span>{{ t('queueInhouseGriefRevokeCaptain') }}</span>
              </label>
              <p class="text-[11px] text-muted-foreground mt-1">{{ t('queueInhouseGriefRevokeCaptainHint') }}</p>
            </div>

            <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
              <div>
                <label class="text-xs text-muted-foreground">{{ t('queueInhouseCleanGamesDecay') }}</label>
                <input type="number" min="1" class="input-field" v-model.number="form.clean_games_to_decay_strike" />
              </div>
              <div>
                <label class="text-xs text-muted-foreground">{{ t('queueInhouseReportWindow') }}</label>
                <input type="number" min="0" class="input-field" v-model.number="form.report_window_minutes" />
                <p class="text-[11px] text-muted-foreground mt-1">{{ t('queueInhouseReportWindowHint') }}</p>
              </div>
              <div>
                <label class="text-xs text-muted-foreground">{{ t('queueInhousePrizePct') }}</label>
                <input type="number" min="1" max="100" class="input-field" v-model.number="form.prize_active_pct" />
              </div>
            </div>
          </div>
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

        <!-- Pool scope -->
        <div class="flex flex-col gap-1.5">
          <label class="text-[11px] font-semibold uppercase text-muted-foreground">{{ t('queueAdminBanScope') }}</label>
          <select class="bg-accent/40 border border-border/40 rounded px-3 py-2 text-sm" v-model="banForm.pool_id">
            <option v-if="canManageAllPools" :value="null">{{ t('queueAdminBanScopeAll') }}</option>
            <option v-for="p in pools" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <p class="text-xs text-muted-foreground">{{ t('queueAdminBanScopeHint') }}</p>
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

    <!-- Delete queue match confirmation -->
    <ModalOverlay :show="!!deleteTarget" @close="closeDeleteMatch">
      <div class="border-b border-border px-6 py-5">
        <h2 class="text-lg font-bold flex items-center gap-2">
          <Trash2 class="w-4 h-4 text-destructive" />
          {{ t('queueAdminDeleteTitle') }}
        </h2>
        <p class="text-xs text-muted-foreground mt-1">
          {{ t('queueAdminDeleteConfirm') }}
        </p>
      </div>

      <div v-if="deleteTarget" class="px-6 py-5 flex flex-col gap-3">
        <div class="flex items-center gap-2 text-sm flex-wrap">
          <span class="text-xs px-2 py-0.5 rounded font-semibold" :class="statusColor(deleteTarget.status)">{{ statusLabel(deleteTarget.status) }}</span>
          <span class="font-semibold text-muted-foreground">#{{ deleteTarget.id }}</span>
          <span v-if="deleteTarget.pool_name" class="text-xs text-muted-foreground bg-accent px-2 py-0.5 rounded">{{ deleteTarget.pool_name }}</span>
          <span class="font-medium">{{ deleteTarget.captain1_display_name || deleteTarget.captain1_name || '—' }}</span>
          <span class="text-muted-foreground/40 font-bold">vs</span>
          <span class="font-medium">{{ deleteTarget.captain2_display_name || deleteTarget.captain2_name || '—' }}</span>
        </div>
        <p v-if="deleteTarget.season_id" class="text-xs text-amber-500 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
          {{ t('queueAdminDeleteSeasonNote') }}
        </p>
        <p v-if="deleteError" class="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2">
          {{ deleteError }}
        </p>
      </div>

      <div class="px-6 py-4 border-t border-border/30 flex justify-end gap-2">
        <button class="btn-outline" :disabled="deleting" @click="closeDeleteMatch">{{ t('cancel') }}</button>
        <button class="btn-destructive flex items-center gap-1.5" :disabled="deleting" @click="confirmDeleteMatch">
          <Loader2 v-if="deleting" class="w-3.5 h-3.5 animate-spin" />
          <Trash2 v-else class="w-3.5 h-3.5" />
          {{ t('queueAdminDelete') }}
        </button>
      </div>
    </ModalOverlay>

    <!-- Cancel queue match confirmation -->
    <ModalOverlay :show="!!cancelTarget" @close="closeCancelMatch">
      <div class="border-b border-border px-6 py-5">
        <h2 class="text-lg font-bold flex items-center gap-2">
          <Ban class="w-4 h-4 text-destructive" />
          {{ t('queueAdminCancelTitle') }}
        </h2>
        <p class="text-xs text-muted-foreground mt-1">
          {{ t('queueAdminCancelConfirm') }}
        </p>
      </div>

      <div v-if="cancelTarget" class="px-6 py-5 flex flex-col gap-3">
        <div class="flex items-center gap-2 text-sm flex-wrap">
          <span class="font-semibold text-muted-foreground">#{{ cancelTarget.id }}</span>
          <span v-if="cancelTarget.pool_name" class="text-xs text-muted-foreground bg-accent px-2 py-0.5 rounded">{{ cancelTarget.pool_name }}</span>
          <span class="font-medium">{{ cancelTarget.captain1_display_name || cancelTarget.captain1_name || '—' }}</span>
          <span class="text-muted-foreground/40 font-bold">vs</span>
          <span class="font-medium">{{ cancelTarget.captain2_display_name || cancelTarget.captain2_name || '—' }}</span>
        </div>
        <p v-if="cancelError" class="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2">
          {{ cancelError }}
        </p>
      </div>

      <div class="px-6 py-4 border-t border-border/30 flex justify-end gap-2">
        <button class="btn-outline" :disabled="cancelling" @click="closeCancelMatch">{{ t('cancel') }}</button>
        <button class="btn-destructive flex items-center gap-1.5" :disabled="cancelling" @click="confirmCancelMatch">
          <Loader2 v-if="cancelling" class="w-3.5 h-3.5 animate-spin" />
          <Ban v-else class="w-3.5 h-3.5" />
          {{ t('queueAdminCancelButton') }}
        </button>
      </div>
    </ModalOverlay>

    <!-- Force-complete match confirmation -->
    <ModalOverlay :show="!!forceTarget" @close="closeForceComplete">
      <div class="border-b border-border px-6 py-5">
        <h2 class="text-lg font-bold flex items-center gap-2">
          <CheckSquare class="w-4 h-4 text-amber-500" />
          {{ t('queueAdminForceCompleteTitle') }}
        </h2>
        <p class="text-xs text-muted-foreground mt-1">
          {{ t('queueAdminForceCompleteConfirm') }}
        </p>
      </div>

      <div v-if="forceTarget" class="px-6 py-5 flex flex-col gap-3">
        <div class="flex items-center gap-2 text-sm flex-wrap">
          <span class="font-semibold text-muted-foreground">#{{ forceTarget.id }}</span>
          <span v-if="forceTarget.match_id" class="text-[10px] font-mono text-muted-foreground bg-accent/60 px-1.5 py-0.5 rounded">match #{{ forceTarget.match_id }}</span>
          <span v-if="forceTarget.pool_name" class="text-xs text-muted-foreground bg-accent px-2 py-0.5 rounded">{{ forceTarget.pool_name }}</span>
          <span class="font-medium">{{ forceTarget.captain1_display_name || forceTarget.captain1_name || '—' }}</span>
          <span class="text-muted-foreground/40 font-bold">vs</span>
          <span class="font-medium">{{ forceTarget.captain2_display_name || forceTarget.captain2_name || '—' }}</span>
        </div>
        <p class="text-xs text-amber-500 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
          {{ t('queueAdminForceCompleteHint') }}
        </p>
        <p v-if="forceError" class="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2">
          {{ forceError }}
        </p>
      </div>

      <div class="px-6 py-4 border-t border-border/30 flex justify-end gap-2">
        <button class="btn-outline" :disabled="forcing" @click="closeForceComplete">{{ t('cancel') }}</button>
        <button class="btn-primary flex items-center gap-1.5" :disabled="forcing" @click="confirmForceComplete">
          <Loader2 v-if="forcing" class="w-3.5 h-3.5 animate-spin" />
          <CheckSquare v-else class="w-3.5 h-3.5" />
          {{ t('queueAdminForceComplete') }}
        </button>
      </div>
    </ModalOverlay>

    <!-- Force-remake lobby confirmation (destroys the in-flight lobby, recreates on a new bot) -->
    <ModalOverlay :show="!!remakeTarget" @close="closeForceRemake">
      <div class="border-b border-border px-6 py-5">
        <h2 class="text-lg font-bold flex items-center gap-2">
          <RefreshCw class="w-4 h-4 text-primary" />
          {{ t('queueAdminForceRemakeTitle') }}
        </h2>
        <p class="text-xs text-muted-foreground mt-1">
          {{ t('queueAdminForceRemakeConfirm') }}
        </p>
      </div>

      <div v-if="remakeTarget" class="px-6 py-5 flex flex-col gap-3">
        <div class="flex items-center gap-2 text-sm flex-wrap">
          <span class="font-semibold text-muted-foreground">#{{ remakeTarget.id }}</span>
          <span v-if="remakeTarget.pool_name" class="text-xs text-muted-foreground bg-accent px-2 py-0.5 rounded">{{ remakeTarget.pool_name }}</span>
          <span class="font-medium">{{ remakeTarget.captain1_display_name || remakeTarget.captain1_name || '—' }}</span>
          <span class="text-muted-foreground/40 font-bold">vs</span>
          <span class="font-medium">{{ remakeTarget.captain2_display_name || remakeTarget.captain2_name || '—' }}</span>
        </div>
        <div v-if="remakeTarget.lobby_name" class="text-xs text-muted-foreground">
          {{ t('queueLobbyName') }}: <strong class="text-foreground font-mono">{{ remakeTarget.lobby_name }}</strong>
          <span v-if="remakeTarget.lobby_bot_id" class="ml-2">bot #{{ remakeTarget.lobby_bot_id }}</span>
        </div>
        <p v-if="remakeError" class="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2">
          {{ remakeError }}
        </p>
      </div>

      <div class="px-6 py-4 border-t border-border/30 flex justify-end gap-2">
        <button class="btn-outline" :disabled="remaking" @click="closeForceRemake">{{ t('cancel') }}</button>
        <button class="btn-primary flex items-center gap-1.5" :disabled="remaking" @click="confirmForceRemake">
          <Loader2 v-if="remaking" class="w-3.5 h-3.5 animate-spin" />
          <RefreshCw v-else class="w-3.5 h-3.5" />
          {{ t('queueAdminForceRemake') }}
        </button>
      </div>
    </ModalOverlay>

    <!-- Recreate match confirmation (cancel current, create new with same teams) -->
    <ModalOverlay :show="!!recreateTarget" @close="closeRecreate">
      <div class="border-b border-border px-6 py-5">
        <h2 class="text-lg font-bold flex items-center gap-2">
          <RotateCcw class="w-4 h-4 text-amber-500" />
          {{ t('queueAdminRecreateTitle') }}
        </h2>
        <p class="text-xs text-muted-foreground mt-1">
          {{ t('queueAdminRecreateConfirm') }}
        </p>
      </div>

      <div v-if="recreateTarget" class="px-6 py-5 flex flex-col gap-3">
        <div class="flex items-center gap-2 text-sm flex-wrap">
          <span class="font-semibold text-muted-foreground">#{{ recreateTarget.id }}</span>
          <span v-if="recreateTarget.pool_name" class="text-xs text-muted-foreground bg-accent px-2 py-0.5 rounded">{{ recreateTarget.pool_name }}</span>
          <span class="font-medium">{{ recreateTarget.captain1_display_name || recreateTarget.captain1_name || '—' }}</span>
          <span class="text-muted-foreground/40 font-bold">vs</span>
          <span class="font-medium">{{ recreateTarget.captain2_display_name || recreateTarget.captain2_name || '—' }}</span>
        </div>
        <p v-if="recreateError" class="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2">
          {{ recreateError }}
        </p>
      </div>

      <div class="px-6 py-4 border-t border-border/30 flex justify-end gap-2">
        <button class="btn-outline" :disabled="recreating" @click="closeRecreate">{{ t('cancel') }}</button>
        <button class="btn-primary flex items-center gap-1.5" :disabled="recreating" @click="confirmRecreate">
          <Loader2 v-if="recreating" class="w-3.5 h-3.5 animate-spin" />
          <RotateCcw v-else class="w-3.5 h-3.5" />
          {{ t('queueAdminRecreate') }}
        </button>
      </div>
    </ModalOverlay>
  </div>
</template>
