<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Search, Loader2, RefreshCw, ExternalLink, UserMinus, UserX, ShieldOff, AlertTriangle, Circle } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import { getSocket, getServerNow } from '@/composables/useSocket'
import { fmtDateTime, fmtDateTimeSeconds } from '@/utils/format'
import ModalOverlay from '@/components/common/ModalOverlay.vue'

// ── Types (contract: docs/superpowers/specs/2026-10-01-admin-lobby-history-design.md §4) ──
type Filter = 'live' | 'recent' | 'all'
type KickMode = 'kick' | 'unassign'

interface LobbyRow {
  id: number
  status: string
  bot_id: number | null
  bot_name: string | null
  match_id: number | null
  game_number: number | null
  competition_id: number | null
  competition_name: string | null
  queue_match_id?: number | null
  label: string | null
  players_joined_count: number
  players_expected_count: number
  members_count: number
  error_message: string | null
  dota_match_id: string | null
  created_at: string
  updated_at: string | null
  game_name?: string | null
}

interface LobbyDetail extends LobbyRow {
  blocked_steam_ids: string[]
  members: any[]
  players_expected: any[]
  players_joined?: any[]
}

interface LobbyEvent {
  id: number | string
  lobby_id?: number
  bot_id?: number | null
  type: string
  steam_id: string | null
  player_id: number | null
  actor_id: number | null
  actor_name?: string | null
  player_name?: string | null
  data: Record<string, any> | null
  created_at: string
}

interface Member { steamId: string; name: string; team: string; slot: number | null }

interface RosterRow extends Member {
  expected: boolean
  blocked: boolean
  absent: boolean
}

const LIVE_STATUSES = ['creating', 'waiting', 'launching', 'cointoss', 'active']
const TEAM_ORDER = ['radiant', 'dire', 'unassigned', 'pool', 'spectator', 'other']

const { t, te } = useI18n()
const api = useApi()
const route = useRoute()
const router = useRouter()

// ── Helpers ──
function asArray(v: any): any[] {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : [] } catch { return [] }
  }
  return []
}

function sid(p: any): string {
  return String(p?.steamId ?? p?.steam_id ?? '')
}

// Unregistered players come back with an empty name or the steam id as the
// name — treat both as "no name" so the UI shows the steam id exactly once.
function realName(name: any, steamId: string | null | undefined): string {
  const n = name == null ? '' : String(name).trim()
  return n && n !== String(steamId ?? '') ? n : ''
}

function lobbyLabel(l: LobbyRow): string {
  if (l.label) return l.label
  if (l.competition_name) return `${l.competition_name} · Match #${l.match_id} G${l.game_number ?? 1}`
  if (l.queue_match_id) return `Queue #${l.queue_match_id}`
  return l.match_id ? `Match #${l.match_id}` : `#${l.id}`
}

function statusLabel(s: string | null | undefined): string {
  if (!s) return '—'
  const key = `adminLobbiesStatus_${s}`
  return te(key) ? t(key) : s
}

function statusPill(s: string): string {
  switch (s) {
    case 'creating': return 'bg-blue-500/15 text-blue-500'
    case 'waiting': return 'bg-amber-500/15 text-amber-500'
    case 'launching':
    case 'cointoss': return 'bg-purple-500/15 text-purple-400'
    case 'active': return 'bg-green-500/15 text-green-500'
    case 'completed': return 'bg-accent text-muted-foreground'
    case 'cancelled': return 'bg-accent text-muted-foreground line-through'
    case 'error': return 'bg-red-500/15 text-red-500'
    default: return 'bg-accent text-muted-foreground'
  }
}

function teamLabel(team: string | null | undefined): string {
  if (!team) return '—'
  const key = `adminLobbiesTeam_${team}`
  return te(key) ? t(key) : team
}

function teamColor(team: string): string {
  if (team === 'radiant') return 'text-green-500'
  if (team === 'dire') return 'text-red-500'
  return 'text-muted-foreground'
}

function teamSlot(team: string | null | undefined, slot: number | null | undefined): string {
  const base = teamLabel(team)
  if ((team === 'radiant' || team === 'dire') && slot != null && slot >= 0) return `${base} · ${t('adminLobbiesSlot', { n: Number(slot) + 1 })}`
  return base
}

// Relative time for list rows; a coarse 30s tick keeps it fresh.
const nowMs = ref(getServerNow())
let nowTimer: ReturnType<typeof setInterval> | null = null
function relTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const ms = new Date(iso).getTime()
  if (Number.isNaN(ms)) return ''
  const min = Math.floor((nowMs.value - ms) / 60000)
  if (min < 1) return t('justNow')
  if (min < 60) return t('minutesAgo', { n: min })
  const h = Math.floor(min / 60)
  if (h < 24) return t('hoursAgo', { n: h })
  return t('daysAgo', { n: Math.floor(h / 24) })
}

function fmtTs(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : fmtDateTimeSeconds(d)
}

// ── Bot service connectivity (kick needs the Go service) ──
const goConnected = ref(true)
let goCheckedAt = 0
async function refreshGoConnected(force = false) {
  if (!force && Date.now() - goCheckedAt < 15_000) return
  goCheckedAt = Date.now()
  try {
    const res: any = await api.getBots()
    goConnected.value = res?.goConnected !== false
  } catch {}
}

// ── List ──
const filter = ref<Filter>('all')
const search = ref(typeof route.query.q === 'string' ? route.query.q : '')
const lobbies = ref<LobbyRow[]>([])
const nextBefore = ref<number | null>(null)
const listLoading = ref(false)
const listError = ref('')
let listSeq = 0

async function fetchList(opts: { append?: boolean; limit?: number } = {}) {
  const seq = ++listSeq
  listLoading.value = true
  listError.value = ''
  try {
    const res: any = await api.getAdminLobbies({
      filter: filter.value,
      q: search.value.trim() || undefined,
      before: opts.append ? nextBefore.value : null,
      limit: opts.limit,
    })
    if (seq !== listSeq) return
    const rows: LobbyRow[] = res?.lobbies ?? []
    lobbies.value = opts.append ? [...lobbies.value, ...rows] : rows
    nextBefore.value = res?.nextBefore ?? null
  } catch (e: any) {
    if (seq !== listSeq) return
    listError.value = e?.message || 'Request failed'
  } finally {
    if (seq === listSeq) listLoading.value = false
  }
}

// Live refresh keeps however many rows the admin has already paged in.
function refreshListInPlace() {
  fetchList({ limit: Math.min(200, Math.max(50, lobbies.value.length)) })
}

let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(search, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => fetchList(), 300)
})
watch(filter, () => fetchList())

// ── Selected lobby ──
const selectedId = computed<number | null>(() => {
  const raw = route.params.lobbyId
  const v = Array.isArray(raw) ? raw[0] : raw
  const n = Number(v)
  return v && Number.isFinite(n) && n > 0 ? n : null
})

const detail = ref<LobbyDetail | null>(null)
const attempts = ref<{ id: number; status: string; created_at: string }[]>([])
const events = ref<LobbyEvent[]>([])
const botLogs = ref<any[]>([])
const showBotLogs = ref(false)
const detailLoading = ref(false)
const detailError = ref('')
let detailSeq = 0

async function fetchDetail(opts: { silent?: boolean } = {}) {
  const id = selectedId.value
  const seq = ++detailSeq
  if (!id) {
    detail.value = null
    events.value = []
    attempts.value = []
    botLogs.value = []
    return
  }
  if (!opts.silent) detailLoading.value = true
  detailError.value = ''
  try {
    const res: any = await api.getAdminLobby(id, { botLogs: showBotLogs.value })
    if (seq !== detailSeq) return
    const l = res?.lobby ?? null
    detail.value = l
      ? {
          ...l,
          blocked_steam_ids: asArray(l.blocked_steam_ids).map(String),
          members: asArray(l.members),
          players_expected: asArray(l.players_expected),
          players_joined: asArray(l.players_joined),
        }
      : null
    attempts.value = res?.attempts ?? []
    events.value = res?.events ?? []
    botLogs.value = res?.botLogs ?? []
  } catch (e: any) {
    if (seq !== detailSeq) return
    if (!opts.silent) detail.value = null
    detailError.value = e?.message || t('adminLobbiesNotFound')
  } finally {
    if (seq === detailSeq) detailLoading.value = false
  }
  refreshGoConnected()
}

watch(selectedId, () => {
  actionNotice.value = ''
  blockedError.value = ''
  fetchDetail()
})
watch(showBotLogs, () => fetchDetail({ silent: true }))

function selectLobby(id: number) {
  if (id === selectedId.value) return
  router.push({ name: 'admin-lobbies', params: { lobbyId: String(id) } })
}

const isLive = computed(() => !!detail.value && LIVE_STATUSES.includes(detail.value.status))
const canAct = computed(() => detail.value?.status === 'waiting' && goConnected.value)
const actionsDisabledReason = computed(() => {
  if (!detail.value || !isLive.value) return ''
  if (detail.value.status !== 'waiting') return t('adminLobbiesActionsDisabledStatus')
  if (!goConnected.value) return t('adminLobbiesActionsDisabledGo')
  return ''
})

const matchLink = computed(() => {
  const l = detail.value
  if (!l) return null
  if (l.queue_match_id) return `/queue/match/${l.queue_match_id}`
  if (l.competition_id && l.match_id) return `/c/${l.competition_id}/match/${l.match_id}`
  return null
})

const expectedSet = computed(() => new Set((detail.value?.players_expected ?? []).map(sid).filter(Boolean)))
const blockedSet = computed(() => new Set(detail.value?.blocked_steam_ids ?? []))

// Old bot builds don't report `members` — fall back to the slotted-only
// players_joined so the panel still shows something.
const rosterFallback = computed(() => {
  const l = detail.value
  return !!l && l.members.length === 0 && (l.players_joined?.length ?? 0) > 0
})

const members = computed<Member[]>(() => {
  const l = detail.value
  if (!l) return []
  const src = rosterFallback.value ? (l.players_joined ?? []) : l.members
  return src
    .map((m: any) => ({
      steamId: sid(m),
      name: realName(m?.name, sid(m)),
      team: String(m?.team ?? 'other'),
      slot: m?.slot == null ? null : Number(m.slot),
    }))
    .filter((m: Member) => m.steamId)
})

// Best-known display name per steam id (roster > expected list > events).
const nameBySteamId = computed(() => {
  const map = new Map<string, string>()
  for (const e of events.value) {
    if (!e.steam_id) continue
    const n = realName(e.player_name, e.steam_id) || realName(e.data?.name, e.steam_id)
    if (n) map.set(String(e.steam_id), n)
  }
  for (const p of detail.value?.players_expected ?? []) {
    const n = realName(p?.name, sid(p))
    if (sid(p) && n) map.set(sid(p), n)
  }
  for (const m of members.value) if (m.name) map.set(m.steamId, m.name)
  return map
})

function nameOf(steamId: string | null | undefined): string {
  if (!steamId) return '?'
  return nameBySteamId.value.get(String(steamId)) || String(steamId)
}

const roster = computed<RosterRow[]>(() => {
  const present = members.value
    .map(m => ({ ...m, expected: expectedSet.value.has(m.steamId), blocked: blockedSet.value.has(m.steamId), absent: false }))
    .sort((a, b) => {
      const ta = TEAM_ORDER.indexOf(a.team), tb = TEAM_ORDER.indexOf(b.team)
      if (ta !== tb) return (ta < 0 ? 99 : ta) - (tb < 0 ? 99 : tb)
      return (a.slot ?? 99) - (b.slot ?? 99)
    })
  const presentIds = new Set(present.map(m => m.steamId))
  const absent: RosterRow[] = (detail.value?.players_expected ?? [])
    .filter((p: any) => sid(p) && !presentIds.has(sid(p)))
    .map((p: any) => ({
      steamId: sid(p),
      name: realName(p?.name, sid(p)),
      team: String(p?.team ?? ''),
      slot: null,
      expected: true,
      blocked: blockedSet.value.has(sid(p)),
      absent: true,
    }))
  return [...present, ...absent]
})

// ── Timeline ──
function evName(e: LobbyEvent): string {
  return realName(e.player_name, e.steam_id) || realName(e.data?.name, e.steam_id) || nameOf(e.steam_id)
}

function evActor(e: LobbyEvent): string {
  return e.actor_name || (e.actor_id ? `#${e.actor_id}` : t('adminLobbiesSomeAdmin'))
}

function kickReason(r: string | null | undefined): string {
  if (!r) return ''
  const key = `adminLobbiesKickReason_${r}`
  return te(key) ? t(key) : r
}

function eventSentence(e: LobbyEvent): string {
  const d = e.data || {}
  switch (e.type) {
    case 'created':
      return d.attempt
        ? t('lobbyEv_createdAttempt', { gameName: d.gameName || '—', attempt: d.attempt })
        : t('lobbyEv_created', { gameName: d.gameName || '—' })
    case 'status_changed':
      return t('lobbyEv_status_changed', { from: statusLabel(d.from), to: statusLabel(d.to) })
    case 'player_joined':
      return t('lobbyEv_player_joined', { name: evName(e), team: teamSlot(d.team, d.slot) })
    case 'player_moved':
      return t('lobbyEv_player_moved', { name: evName(e), from: teamSlot(d.fromTeam, d.fromSlot), to: teamSlot(d.toTeam, d.toSlot) })
    case 'player_left':
      return t('lobbyEv_player_left', { name: evName(e), team: teamLabel(d.team) })
    case 'launch_requested':
      return d.auto ? t('lobbyEv_launch_requested_auto') : t('lobbyEv_launch_requested', { actor: evActor(e) })
    case 'match_id_assigned':
      return t('lobbyEv_match_id_assigned', { matchId: d.matchId ?? '—' })
    case 'game_aborted':
      return t('lobbyEv_game_aborted', { matchId: d.matchId ?? '—' })
    case 'draft_started':
      return t('lobbyEv_draft_started', { matchId: d.matchId ?? '—' })
    case 'error':
      return t('lobbyEv_error', { message: d.message || d.kind || '—' })
    case 'cancelled':
      return t('lobbyEv_cancelled')
    case 'admin_unassign':
      return t('lobbyEv_admin_unassign', { actor: evActor(e), name: evName(e) })
    case 'admin_kick':
      return t('lobbyEv_admin_kick', { actor: evActor(e), name: evName(e) })
    case 'admin_unblock':
      return t('lobbyEv_admin_unblock', { actor: evActor(e), name: evName(e) })
    case 'kick_result':
      if (d.auto) return t('lobbyEv_kick_result_auto', { name: evName(e) })
      if (d.mode === 'unassign') return t(d.ok ? 'lobbyEv_kick_result_unassign_ok' : 'lobbyEv_kick_result_unassign_failed', { name: evName(e) })
      return t(d.ok ? 'lobbyEv_kick_result_kick_ok' : 'lobbyEv_kick_result_kick_failed', { name: evName(e) })
    default:
      return e.type
  }
}

function eventDot(e: LobbyEvent): string {
  const d = e.data || {}
  switch (e.type) {
    case 'error':
    case 'game_aborted': return 'text-red-500'
    case 'kick_result': return d.ok ? 'text-green-500' : 'text-red-500'
    case 'admin_kick':
    case 'admin_unassign':
    case 'admin_unblock':
    case 'launch_requested': return 'text-purple-400'
    case 'draft_started':
    case 'match_id_assigned': return 'text-green-500'
    case 'player_joined': return 'text-blue-400'
    case 'player_left': return 'text-amber-500'
    case 'cancelled': return 'text-muted-foreground'
    default: return 'text-muted-foreground'
  }
}

function logColor(log: any) {
  if (log.level === 'error') return 'text-red-400'
  if (log.level === 'warn') return 'text-amber-400'
  if (log.level === 'action') return 'text-purple-300'
  return 'text-muted-foreground'
}

type TimelineItem =
  | { key: string; kind: 'event'; time: number; ev: LobbyEvent }
  | { key: string; kind: 'log'; time: number; log: any }

const timeline = computed<TimelineItem[]>(() => {
  const items: TimelineItem[] = events.value.map((ev, i) => ({
    key: `e-${ev.id ?? i}`,
    kind: 'event' as const,
    time: new Date(ev.created_at).getTime() || 0,
    ev,
  }))
  if (showBotLogs.value) {
    botLogs.value.forEach((log, i) => {
      items.push({ key: `l-${log.id ?? `live-${i}`}`, kind: 'log', time: new Date(log.created_at ?? log.time).getTime() || 0, log })
    })
  }
  // Stable sort: equal timestamps keep events before logs, and insertion order.
  return items
    .map((it, idx) => ({ it, idx }))
    .sort((a, b) => a.it.time - b.it.time || a.idx - b.idx)
    .map(x => x.it)
})

// ── Kick / unassign modal ──
const kickTarget = ref<RosterRow | null>(null)
const kickMode = ref<KickMode>('kick')
const kickBusy = ref(false)
const kickError = ref('')
const actionNotice = ref('')
let noticeTimer: ReturnType<typeof setTimeout> | null = null

function isSlotted(team: string) {
  return team === 'radiant' || team === 'dire'
}

function openKick(row: RosterRow, mode: KickMode) {
  kickTarget.value = row
  kickMode.value = mode
  kickError.value = ''
}

function closeKick() {
  if (kickBusy.value) return
  kickTarget.value = null
  kickError.value = ''
}

function showNotice(msg: string) {
  actionNotice.value = msg
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { actionNotice.value = '' }, 6000)
}

async function confirmKick() {
  const target = kickTarget.value
  const id = selectedId.value
  if (!target || !id) return
  kickBusy.value = true
  kickError.value = ''
  try {
    await api.kickLobbyPlayer(id, target.steamId, kickMode.value)
    kickTarget.value = null
    showNotice(t('adminLobbiesKickSent'))
    scheduleDetailRefresh()
  } catch (e: any) {
    kickError.value = e?.message || 'Request failed'
    refreshGoConnected(true)
  } finally {
    kickBusy.value = false
  }
}

// ── Unblock ──
const unblockBusy = ref<string | null>(null)
const blockedError = ref('')

async function unblock(steamId: string) {
  const id = selectedId.value
  if (!id || unblockBusy.value) return
  unblockBusy.value = steamId
  blockedError.value = ''
  try {
    const res: any = await api.unblockLobbyPlayer(id, steamId)
    if (detail.value) {
      detail.value.blocked_steam_ids = Array.isArray(res?.blockedSteamIds)
        ? res.blockedSteamIds.map(String)
        : detail.value.blocked_steam_ids.filter(s => s !== steamId)
    }
    scheduleDetailRefresh()
  } catch (e: any) {
    blockedError.value = e?.message || 'Request failed'
  } finally {
    unblockBusy.value = null
  }
}

// ── Live updates ──
let detailRefreshTimer: ReturnType<typeof setTimeout> | null = null
let listRefreshTimer: ReturnType<typeof setTimeout> | null = null

function scheduleDetailRefresh() {
  if (detailRefreshTimer) clearTimeout(detailRefreshTimer)
  detailRefreshTimer = setTimeout(() => fetchDetail({ silent: true }), 800)
}

function scheduleListRefresh() {
  if (listRefreshTimer) clearTimeout(listRefreshTimer)
  listRefreshTimer = setTimeout(refreshListInPlace, 1500)
}

function onLobbyEvent(payload: any) {
  const lobbyId = Number(payload?.lobbyId)
  const ev: LobbyEvent | undefined = payload?.event
  if (!lobbyId) return
  // Reflect status changes in the list immediately; the debounced refetch
  // settles counts, ordering and any row that's new to this view.
  if (ev?.type === 'status_changed' && ev.data?.to) {
    const row = lobbies.value.find(l => l.id === lobbyId)
    if (row) row.status = ev.data.to
  }
  if (lobbyId === selectedId.value && detail.value) {
    if (ev && !events.value.some(e => e.id === ev.id)) events.value.push(ev)
    if (ev?.type === 'status_changed' && ev.data?.to) detail.value.status = ev.data.to
    scheduleDetailRefresh()
  }
  scheduleListRefresh()
}

function onBotLog(data: any) {
  if (!showBotLogs.value || !selectedId.value) return
  if (Number(data?.lobbyId) !== selectedId.value) return
  botLogs.value.push({ level: data.level, message: data.message, created_at: data.time, lobby_id: selectedId.value })
}

onMounted(() => {
  fetchList()
  fetchDetail()
  refreshGoConnected(true)
  nowTimer = setInterval(() => { nowMs.value = getServerNow() }, 30_000)
  const socket = getSocket()
  socket.on('admin:lobbyEvent', onLobbyEvent)
  socket.on('bot:log', onBotLog)
})

onUnmounted(() => {
  if (nowTimer) clearInterval(nowTimer)
  if (searchTimer) clearTimeout(searchTimer)
  if (detailRefreshTimer) clearTimeout(detailRefreshTimer)
  if (listRefreshTimer) clearTimeout(listRefreshTimer)
  if (noticeTimer) clearTimeout(noticeTimer)
  const socket = getSocket()
  socket.off('admin:lobbyEvent', onLobbyEvent)
  socket.off('bot:log', onBotLog)
})
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[var(--admin-content-max,1200px)] w-full">
    <!-- Header -->
    <div class="flex items-center justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold text-foreground">{{ t('adminLobbies') }}</h1>
        <p class="text-sm text-muted-foreground mt-1">{{ t('adminLobbiesSubtitle') }}</p>
      </div>
      <button class="btn-secondary text-sm shrink-0" :disabled="listLoading" @click="fetchList(); fetchDetail({ silent: true })">
        <RefreshCw class="w-4 h-4" :class="listLoading ? 'animate-spin' : ''" />
        {{ t('refresh') }}
      </button>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-[minmax(280px,360px)_1fr] gap-4 items-start">
      <!-- ── Left: lobby list ── -->
      <div class="card flex flex-col">
        <div class="p-3 border-b border-border flex flex-col gap-2">
          <div class="flex gap-1">
            <button
              v-for="f in (['live', 'recent', 'all'] as const)"
              :key="f"
              class="flex-1 px-2.5 py-1.5 rounded text-xs font-semibold border transition-colors"
              :class="filter === f ? 'border-primary text-primary bg-primary/10' : 'border-border text-muted-foreground hover:text-foreground'"
              @click="filter = f"
            >
              {{ f === 'live' ? t('adminLobbiesFilterLive') : f === 'recent' ? t('adminLobbiesFilterRecent') : t('adminLobbiesFilterAll') }}
            </button>
          </div>
          <div class="flex items-center gap-2 px-3 py-2 bg-accent/40 border border-border/40 rounded-lg">
            <Search class="w-4 h-4 text-muted-foreground shrink-0" />
            <input
              v-model="search"
              type="text"
              class="flex-1 min-w-0 bg-transparent text-sm focus:outline-none"
              :placeholder="t('adminLobbiesSearch')"
            />
          </div>
        </div>

        <div class="flex flex-col overflow-y-auto lg:max-h-[calc(100vh-260px)]">
          <p v-if="listError" class="text-xs text-destructive px-4 py-3">{{ listError }}</p>
          <div v-else-if="!lobbies.length && !listLoading" class="text-sm text-muted-foreground text-center py-8 px-4">
            {{ t('adminLobbiesEmpty') }}
          </div>
          <button
            v-for="l in lobbies"
            :key="l.id"
            class="text-left px-4 py-2.5 border-b border-border/50 last:border-b-0 transition-colors flex flex-col gap-1"
            :class="l.id === selectedId ? 'bg-primary/10 border-l-2 border-l-primary' : 'hover:bg-accent/40'"
            @click="selectLobby(l.id)"
          >
            <div class="flex items-center gap-2 min-w-0">
              <span class="text-xs font-mono text-muted-foreground shrink-0">#{{ l.id }}</span>
              <span class="text-sm font-medium text-foreground truncate flex-1">{{ lobbyLabel(l) }}</span>
              <span class="text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0" :class="statusPill(l.status)">{{ statusLabel(l.status) }}</span>
            </div>
            <div class="flex items-center gap-2 text-[11px] text-muted-foreground min-w-0">
              <span class="truncate">{{ l.bot_name || t('adminLobbiesNoBot') }}</span>
              <span>·</span>
              <span class="shrink-0 tabular-nums">{{ t('adminLobbiesPlayersCount', { joined: l.players_joined_count ?? 0, expected: l.players_expected_count ?? 0 }) }}</span>
              <span class="ml-auto shrink-0" :title="fmtDateTime(new Date(l.updated_at || l.created_at))">{{ relTime(l.updated_at || l.created_at) }}</span>
            </div>
          </button>
          <div v-if="listLoading && !lobbies.length" class="flex justify-center py-6">
            <Loader2 class="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
          <div v-if="nextBefore" class="p-3">
            <button class="btn-outline w-full text-xs py-1.5" :disabled="listLoading" @click="fetchList({ append: true })">
              <Loader2 v-if="listLoading" class="w-3.5 h-3.5 animate-spin" />
              {{ t('adminLobbiesLoadMore') }}
            </button>
          </div>
        </div>
      </div>

      <!-- ── Right: selected lobby ── -->
      <div class="flex flex-col gap-4 min-w-0">
        <div v-if="!selectedId" class="card p-8 text-center text-sm text-muted-foreground">
          {{ t('adminLobbiesSelect') }}
        </div>
        <div v-else-if="detailLoading && !detail" class="card p-8 flex justify-center">
          <Loader2 class="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
        <div v-else-if="!detail" class="card p-8 text-center text-sm text-muted-foreground">
          {{ detailError || t('adminLobbiesNotFound') }}
        </div>

        <template v-else>
          <!-- Header card -->
          <div class="card p-5 flex flex-col gap-2">
            <div class="flex items-start gap-3 flex-wrap">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-sm font-mono text-muted-foreground">#{{ detail.id }}</span>
                  <h2 class="text-lg font-semibold text-foreground truncate">{{ lobbyLabel(detail) }}</h2>
                  <span class="text-[11px] font-semibold px-2 py-0.5 rounded" :class="statusPill(detail.status)">{{ statusLabel(detail.status) }}</span>
                </div>
                <div class="flex items-center gap-x-3 gap-y-1 flex-wrap text-xs text-muted-foreground mt-1">
                  <span>{{ t('adminLobbiesBot') }}: <span class="text-foreground">{{ detail.bot_name || t('adminLobbiesNoBot') }}</span></span>
                  <span v-if="detail.game_name" class="font-mono truncate max-w-[320px]">{{ detail.game_name }}</span>
                  <span>{{ t('adminLobbiesCreated', { time: fmtDateTime(new Date(detail.created_at)) }) }}</span>
                  <a
                    v-if="detail.dota_match_id"
                    :href="`https://www.dotabuff.com/matches/${detail.dota_match_id}`"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    {{ t('adminLobbiesDotaMatch', { id: detail.dota_match_id }) }}
                    <ExternalLink class="w-3 h-3" />
                  </a>
                </div>
              </div>
              <router-link v-if="matchLink" :to="matchLink" class="btn-outline text-xs px-3 py-1.5 shrink-0">
                <ExternalLink class="w-3.5 h-3.5" />
                {{ t('adminLobbiesOpenMatch') }}
              </router-link>
            </div>
            <p v-if="detail.error_message" class="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2">
              {{ detail.error_message }}
            </p>
            <div v-if="attempts.length" class="flex items-center gap-1.5 flex-wrap text-xs">
              <span class="text-muted-foreground">{{ t('adminLobbiesOtherAttempts') }}:</span>
              <router-link
                v-for="a in attempts"
                :key="a.id"
                :to="{ name: 'admin-lobbies', params: { lobbyId: String(a.id) } }"
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-border hover:bg-accent transition-colors"
                :title="fmtDateTime(new Date(a.created_at))"
              >
                <span class="font-mono">#{{ a.id }}</span>
                <span class="text-[10px] font-semibold px-1 rounded" :class="statusPill(a.status)">{{ statusLabel(a.status) }}</span>
              </router-link>
            </div>
            <p v-if="actionNotice" class="text-xs text-green-500 bg-green-500/10 border border-green-500/30 rounded-lg px-3 py-2">{{ actionNotice }}</p>
          </div>

          <!-- Roster -->
          <div class="card">
            <div class="px-5 py-3 border-b border-border flex items-center justify-between gap-2">
              <h3 class="text-sm font-semibold text-foreground">{{ t('adminLobbiesRoster') }}</h3>
              <span v-if="actionsDisabledReason" class="text-[11px] text-muted-foreground">{{ actionsDisabledReason }}</span>
            </div>
            <p v-if="rosterFallback" class="text-[11px] text-amber-500 px-5 pt-3">{{ t('adminLobbiesRosterFallback') }}</p>
            <div v-if="!roster.length" class="text-sm text-muted-foreground text-center py-6">{{ t('adminLobbiesRosterEmpty') }}</div>
            <div v-else class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="text-[11px] uppercase text-muted-foreground text-left">
                    <th class="px-5 py-2 font-semibold">{{ t('adminLobbiesColPlayer') }}</th>
                    <th class="px-3 py-2 font-semibold">{{ t('adminLobbiesColTeam') }}</th>
                    <th class="px-5 py-2" />
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="r in roster"
                    :key="r.steamId"
                    class="border-t border-border/50"
                    :class="r.absent ? 'opacity-50' : ''"
                  >
                    <td class="px-5 py-2">
                      <div class="flex items-center gap-2 flex-wrap">
                        <span v-if="r.name" class="font-medium text-foreground">{{ r.name }}</span>
                        <span v-else class="font-mono text-foreground">{{ r.steamId }}</span>
                        <span v-if="r.absent" class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-accent text-muted-foreground">{{ t('adminLobbiesBadgeAbsent') }}</span>
                        <span v-else-if="r.expected" class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-green-500/15 text-green-500">{{ t('adminLobbiesBadgeExpected') }}</span>
                        <span v-else class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-500">{{ t('adminLobbiesBadgeNotExpected') }}</span>
                        <span v-if="r.blocked" class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-red-500/15 text-red-500">{{ t('adminLobbiesBadgeBlocked') }}</span>
                      </div>
                      <div v-if="r.name" class="text-[11px] font-mono text-muted-foreground">{{ r.steamId }}</div>
                    </td>
                    <td class="px-3 py-2 text-xs" :class="teamColor(r.team)">
                      {{ r.absent ? teamLabel(r.team) : teamSlot(r.team, r.slot) }}
                    </td>
                    <td class="px-5 py-2">
                      <div v-if="!r.absent && isLive" class="flex items-center justify-end gap-1.5">
                        <button
                          v-if="isSlotted(r.team)"
                          class="btn-outline text-xs px-2.5 py-1"
                          :disabled="!canAct"
                          :class="!canAct ? 'opacity-50 cursor-not-allowed' : ''"
                          @click="openKick(r, 'unassign')"
                        >
                          <UserMinus class="w-3.5 h-3.5" />
                          {{ t('adminLobbiesUnassign') }}
                        </button>
                        <button
                          class="btn-outline text-xs px-2.5 py-1 !text-red-500 hover:!bg-red-500/10"
                          :disabled="!canAct"
                          :class="!canAct ? 'opacity-50 cursor-not-allowed' : ''"
                          @click="openKick(r, 'kick')"
                        >
                          <UserX class="w-3.5 h-3.5" />
                          {{ t('adminLobbiesKick') }}
                        </button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- Blocked -->
          <div class="card">
            <div class="px-5 py-3 border-b border-border">
              <h3 class="text-sm font-semibold text-foreground">{{ t('adminLobbiesBlocked') }}</h3>
              <p class="text-[11px] text-muted-foreground mt-0.5">{{ t('adminLobbiesBlockedHint') }}</p>
            </div>
            <p v-if="blockedError" class="text-xs text-destructive px-5 pt-3">{{ blockedError }}</p>
            <div v-if="!detail.blocked_steam_ids.length" class="text-sm text-muted-foreground text-center py-4">{{ t('adminLobbiesBlockedEmpty') }}</div>
            <div
              v-for="s in detail.blocked_steam_ids"
              :key="s"
              class="px-5 py-2 border-t border-border/50 first:border-t-0 flex items-center gap-3"
            >
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium text-foreground truncate" :class="nameOf(s) === s ? 'font-mono' : ''">{{ nameOf(s) }}</div>
                <div v-if="nameOf(s) !== s" class="text-[11px] font-mono text-muted-foreground">{{ s }}</div>
              </div>
              <button
                v-if="isLive"
                class="btn-outline text-xs px-2.5 py-1"
                :disabled="unblockBusy === s"
                @click="unblock(s)"
              >
                <Loader2 v-if="unblockBusy === s" class="w-3.5 h-3.5 animate-spin" />
                <ShieldOff v-else class="w-3.5 h-3.5" />
                {{ t('adminLobbiesUnblock') }}
              </button>
            </div>
          </div>

          <!-- Timeline -->
          <div class="card">
            <div class="px-5 py-3 border-b border-border flex items-center justify-between gap-2">
              <h3 class="text-sm font-semibold text-foreground">{{ t('adminLobbiesTimeline') }}</h3>
              <label class="flex items-center gap-1.5 cursor-pointer text-xs text-muted-foreground">
                <input v-model="showBotLogs" type="checkbox" class="w-3.5 h-3.5 accent-primary" />
                {{ t('adminLobbiesShowBotLogs') }}
              </label>
            </div>
            <div v-if="!timeline.length" class="text-sm text-muted-foreground text-center py-6">{{ t('adminLobbiesTimelineEmpty') }}</div>
            <div v-else class="p-4 flex flex-col max-h-[640px] overflow-y-auto">
              <template v-for="item in timeline" :key="item.key">
                <div v-if="item.kind === 'event'" class="flex items-start gap-3 py-1">
                  <Circle class="w-2.5 h-2.5 fill-current mt-1.5 shrink-0" :class="eventDot(item.ev)" />
                  <span class="text-[11px] font-mono text-muted-foreground shrink-0 mt-0.5 tabular-nums">{{ fmtTs(item.ev.created_at) }}</span>
                  <div class="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
                    <span class="text-sm text-foreground break-words">{{ eventSentence(item.ev) }}</span>
                    <span v-if="item.ev.type === 'error' && item.ev.data?.kind" class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-red-500/15 text-red-500">{{ item.ev.data.kind }}</span>
                    <template v-if="item.ev.type === 'kick_result'">
                      <span
                        class="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                        :class="item.ev.data?.ok ? 'bg-green-500/15 text-green-500' : 'bg-red-500/15 text-red-500'"
                      >{{ item.ev.data?.ok ? t('adminLobbiesOk') : t('adminLobbiesFailed') }}</span>
                      <span v-if="item.ev.data?.reason" class="text-xs text-muted-foreground">{{ kickReason(item.ev.data.reason) }}</span>
                    </template>
                  </div>
                </div>
                <div v-else class="flex items-start gap-3 py-0.5 pl-[22px]">
                  <span class="text-[11px] font-mono text-muted-foreground/70 shrink-0 tabular-nums">{{ fmtTs(item.log.created_at ?? item.log.time) }}</span>
                  <span class="text-[10px] leading-4 px-1.5 rounded bg-accent text-muted-foreground shrink-0">{{ t('adminLobbiesBotLog') }}</span>
                  <span class="text-xs font-mono break-words whitespace-pre-wrap min-w-0" :class="logColor(item.log)">{{ item.log.message }}</span>
                </div>
              </template>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- Kick / unassign confirmation -->
    <ModalOverlay :show="!!kickTarget" @close="closeKick">
      <div class="border-b border-border px-6 py-5">
        <h2 class="text-lg font-bold flex items-center gap-2">
          <UserX v-if="kickMode === 'kick'" class="w-4 h-4 text-destructive" />
          <UserMinus v-else class="w-4 h-4 text-foreground" />
          {{ kickMode === 'kick' ? t('adminLobbiesKickTitle') : t('adminLobbiesUnassignTitle') }}
        </h2>
        <p class="text-xs text-muted-foreground mt-1">
          {{ kickMode === 'kick'
            ? t('adminLobbiesKickDesc', { name: kickTarget?.name || kickTarget?.steamId })
            : t('adminLobbiesUnassignDesc', { name: kickTarget?.name || kickTarget?.steamId }) }}
        </p>
      </div>

      <div v-if="kickTarget" class="px-6 py-5 flex flex-col gap-4">
        <div class="flex items-center gap-2 text-sm flex-wrap">
          <span v-if="kickTarget.name" class="font-medium">{{ kickTarget.name }}</span>
          <span class="text-[11px] font-mono text-muted-foreground">{{ kickTarget.steamId }}</span>
          <span class="text-xs" :class="teamColor(kickTarget.team)">{{ teamSlot(kickTarget.team, kickTarget.slot) }}</span>
        </div>

        <div class="flex flex-col gap-1.5">
          <label class="text-[11px] font-semibold uppercase text-muted-foreground">{{ t('adminLobbiesKickModeLabel') }}</label>
          <label
            v-if="isSlotted(kickTarget.team)"
            class="flex items-start gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors"
            :class="kickMode === 'unassign' ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent/40'"
          >
            <input v-model="kickMode" type="radio" value="unassign" class="mt-0.5 accent-primary" />
            <span class="text-sm">{{ t('adminLobbiesModeUnassign') }}</span>
          </label>
          <label
            class="flex items-start gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors"
            :class="kickMode === 'kick' ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent/40'"
          >
            <input v-model="kickMode" type="radio" value="kick" class="mt-0.5 accent-primary" />
            <span class="text-sm">{{ t('adminLobbiesModeKick') }}</span>
          </label>
        </div>

        <p v-if="kickTarget.expected" class="text-xs text-amber-500 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 flex items-start gap-2">
          <AlertTriangle class="w-3.5 h-3.5 shrink-0 mt-0.5" />
          {{ t('adminLobbiesExpectedWarning') }}
        </p>
        <p v-if="kickError" class="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2">
          {{ kickError }}
        </p>
      </div>

      <div class="px-6 py-4 border-t border-border/30 flex justify-end gap-2">
        <button class="btn-outline" :disabled="kickBusy" @click="closeKick">{{ t('cancel') }}</button>
        <button
          :class="kickMode === 'kick' ? 'btn-destructive' : 'btn-primary'"
          class="flex items-center gap-1.5"
          :disabled="kickBusy"
          @click="confirmKick"
        >
          <Loader2 v-if="kickBusy" class="w-3.5 h-3.5 animate-spin" />
          <UserX v-else-if="kickMode === 'kick'" class="w-3.5 h-3.5" />
          <UserMinus v-else class="w-3.5 h-3.5" />
          {{ kickMode === 'kick' ? t('adminLobbiesKick') : t('adminLobbiesUnassign') }}
        </button>
      </div>
    </ModalOverlay>
  </div>
</template>
