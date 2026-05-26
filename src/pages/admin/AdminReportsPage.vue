<script setup lang="ts">
// Single admin landing page for inhouse discipline:
//   * Toxic reports — read-only feed of peer reports (auto-accumulate
//     into strikes via the report endpoint, no review step).
//   * Grief reports — captain-filed, with Approve / Reject buttons.
//   * Strike log — every ±strike including decays.
// Permission gate: review_grief_reports (matches the original grief page).
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { Check, X, Loader2, AlertTriangle, Flag, Users } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import ModalOverlay from '@/components/common/ModalOverlay.vue'

interface GriefReport {
  id: number
  reporter_player_id: number
  reported_player_id: number
  queue_match_id: number | null
  pool_id: number | null
  comment: string
  status: 'pending' | 'approved' | 'rejected'
  reviewed_by: number | null
  reviewed_at: string | null
  review_note: string | null
  created_at: string
  reporter_name: string
  reporter_display_name: string
  reporter_avatar: string | null
  reported_name: string
  reported_display_name: string
  reported_avatar: string | null
  reported_captain_pool: boolean
  reported_grief_strikes: number
  pool_name: string | null
}

interface ToxicReport {
  id: number
  reporter_player_id: number
  reported_player_id: number
  queue_match_id: number | null
  pool_id: number | null
  comment: string | null
  status: 'pending' | 'approved' | 'rejected'
  reviewed_by: number | null
  reviewed_at: string | null
  review_note: string | null
  created_at: string
  reporter_display_name: string
  reporter_name: string
  reporter_avatar: string | null
  reported_display_name: string
  reported_name: string
  reported_avatar: string | null
  reported_toxic_reports_received: number
  reported_toxic_strikes: number
  pool_name: string | null
}

interface StrikeLogRow {
  id: number
  player_id: number
  kind: 'toxic' | 'grief' | 'toxic_decay' | 'grief_decay' | 'captain_revoked' | 'admin_lift'
  delta: number
  reason: string | null
  source_report_id: number | null
  source_queue_match_id: number | null
  applied_by: number | null
  created_at: string
  player_display_name: string
  player_name: string
  player_avatar: string | null
  applied_by_display_name: string | null
}

const { t } = useI18n()
const api = useApi()
const router = useRouter()

interface StrikePlayer {
  id: number
  name: string
  display_name: string
  avatar_url: string | null
  toxic_strikes: number
  grief_strikes: number
  toxic_reports_received: number
  is_banned: boolean
}

type Tab = 'toxic' | 'grief' | 'strikes' | 'players'
const tab = ref<Tab>('toxic')
const griefStatus = ref<'pending' | 'approved' | 'rejected'>('pending')
const toxicStatus = ref<'pending' | 'approved' | 'rejected'>('pending')

const toxicRows = ref<ToxicReport[]>([])
const griefRows = ref<GriefReport[]>([])
const strikeRows = ref<StrikeLogRow[]>([])
const playerRows = ref<StrikePlayer[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const acting = ref<number | null>(null)

// Lift-strikes confirmation modal.
const liftModal = ref<{ open: boolean; player: StrikePlayer | null; kind: 'toxic' | 'grief'; clear: boolean }>({
  open: false, player: null, kind: 'toxic', clear: false,
})
const liftSubmitting = ref(false)
const liftError = ref<string | null>(null)

// Single review modal shared by toxic + grief, both now go through admin
// approval. Replaces window.prompt/confirm per CLAUDE.md.
const reviewModal = ref<{
  open: boolean
  kind: 'toxic' | 'grief'
  report: ToxicReport | GriefReport | null
  action: 'approve' | 'reject'
  targetName: string
}>({
  open: false, kind: 'grief', report: null, action: 'approve', targetName: '',
})
const reviewNote = ref('')
const reviewSubmitting = ref(false)
const reviewError = ref<string | null>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    if (tab.value === 'toxic')        toxicRows.value  = await api.getAdminToxicReports({ status: toxicStatus.value, limit: 200 })
    else if (tab.value === 'grief')   griefRows.value  = await api.getAdminGriefReports(griefStatus.value)
    else if (tab.value === 'players') playerRows.value = await api.getStrikePlayers()
    else                              strikeRows.value = await api.getAdminStrikeLog({ limit: 200 })
  } catch (e: any) {
    error.value = e.message || 'Failed to load'
  } finally {
    loading.value = false
  }
}

function setTab(next: Tab) {
  tab.value = next
  load()
}
function setGriefStatus(next: 'pending' | 'approved' | 'rejected') {
  griefStatus.value = next
  load()
}
function setToxicStatus(next: 'pending' | 'approved' | 'rejected') {
  toxicStatus.value = next
  load()
}

function openReviewToxic(r: ToxicReport, action: 'approve' | 'reject') {
  reviewModal.value = { open: true, kind: 'toxic', report: r, action, targetName: r.reported_display_name }
  reviewNote.value = ''
  reviewError.value = null
}
function openReviewGrief(r: GriefReport, action: 'approve' | 'reject') {
  reviewModal.value = { open: true, kind: 'grief', report: r, action, targetName: r.reported_display_name }
  reviewNote.value = ''
  reviewError.value = null
}
function closeReview() {
  reviewModal.value = { ...reviewModal.value, open: false }
}
async function submitReview() {
  const r = reviewModal.value.report
  if (!r || reviewSubmitting.value) return
  reviewSubmitting.value = true
  reviewError.value = null
  try {
    const note = reviewNote.value.trim() || undefined
    const isToxic = reviewModal.value.kind === 'toxic'
    if (reviewModal.value.action === 'approve') {
      await (isToxic ? api.approveToxicReport(r.id, note) : api.approveGriefReport(r.id, note))
    } else {
      await (isToxic ? api.rejectToxicReport(r.id, note) : api.rejectGriefReport(r.id, note))
    }
    closeReview()
    await load()
  } catch (e: any) {
    reviewError.value = e?.message || 'Action failed'
  } finally {
    reviewSubmitting.value = false
  }
}

const pendingGriefCount = computed(() => griefRows.value.filter(r => r.status === 'pending').length)
const pendingToxicCount = computed(() => toxicRows.value.filter(r => r.status === 'pending').length)

function openLift(player: StrikePlayer, kind: 'toxic' | 'grief', clear: boolean) {
  liftModal.value = { open: true, player, kind, clear }
  liftError.value = null
}
function closeLift() {
  liftModal.value = { ...liftModal.value, open: false }
}
const liftKindWord = computed(() =>
  liftModal.value.kind === 'toxic' ? t('reportsKindToxic') : t('reportsKindGrief'))
async function submitLift() {
  const m = liftModal.value
  if (!m.player || liftSubmitting.value) return
  liftSubmitting.value = true
  liftError.value = null
  try {
    await api.liftStrikes(m.player.id, { kind: m.kind, clear: m.clear, amount: m.clear ? undefined : 1 })
    closeLift()
    await load()
  } catch (e: any) {
    liftError.value = e?.message || 'Action failed'
  } finally {
    liftSubmitting.value = false
  }
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

function statusPillClass(status: string): string {
  if (status === 'approved') return 'bg-green-500/15 text-green-500'
  if (status === 'rejected') return 'bg-red-500/15 text-red-500'
  return 'bg-amber-500/15 text-amber-400'
}

function strikeKindPill(kind: string): string {
  if (kind === 'toxic')           return 'bg-amber-500/15 text-amber-400'
  if (kind === 'grief')           return 'bg-rose-500/15 text-rose-400'
  if (kind === 'toxic_decay')     return 'bg-green-500/15 text-green-500'
  if (kind === 'grief_decay')     return 'bg-green-500/15 text-green-500'
  if (kind === 'admin_lift')      return 'bg-green-500/15 text-green-500'
  if (kind === 'captain_revoked') return 'bg-purple-500/15 text-purple-400'
  return 'bg-accent/40 text-muted-foreground'
}

function openMatch(queueMatchId: number | null) {
  if (!queueMatchId) return
  router.push({ name: 'queue-match', params: { id: queueMatchId } })
}

onMounted(load)
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[var(--admin-content-max,1200px)] w-full">
    <div>
      <h1 class="text-2xl font-semibold text-foreground">{{ t('adminReportsTitle') }}</h1>
      <p class="text-sm text-muted-foreground mt-1">{{ t('adminReportsDesc') }}</p>
    </div>

    <!-- Top tabs: kind of record -->
    <div class="flex items-center gap-1 border-b border-border/40">
      <button
        v-for="t_ in (['toxic', 'grief', 'strikes', 'players'] as const)" :key="t_"
        type="button"
        class="px-4 py-2 text-sm border-b-2 transition-colors flex items-center gap-1.5"
        :class="tab === t_ ? 'border-primary text-foreground font-semibold' : 'border-transparent text-muted-foreground hover:text-foreground'"
        @click="setTab(t_)"
      >
        <Flag v-if="t_ === 'toxic'" class="w-3.5 h-3.5" />
        <AlertTriangle v-else-if="t_ === 'grief'" class="w-3.5 h-3.5" />
        <Users v-else-if="t_ === 'players'" class="w-3.5 h-3.5" />
        <span v-else class="w-3.5 h-3.5 inline-flex items-center justify-center text-xs">±</span>
        {{ t('reportsTab_' + t_) }}
      </button>
    </div>

    <!-- Toxic sub-tabs (status filter) -->
    <div v-if="tab === 'toxic'" class="flex items-center gap-1">
      <button
        v-for="s_ in (['pending', 'approved', 'rejected'] as const)" :key="s_"
        type="button"
        class="px-3 py-1.5 rounded-full text-xs font-medium transition-colors"
        :class="toxicStatus === s_ ? 'bg-primary/15 text-primary' : 'bg-accent/40 text-muted-foreground hover:text-foreground'"
        @click="setToxicStatus(s_)"
      >
        {{ t('griefTab_' + s_) }}
        <span v-if="s_ === 'pending' && toxicStatus === 'pending' && pendingToxicCount > 0"
              class="ml-1 px-1 py-0.5 rounded-full bg-amber-500/15 text-amber-400 text-[10px] font-bold tabular-nums">
          {{ pendingToxicCount }}
        </span>
      </button>
    </div>

    <!-- Grief sub-tabs (status filter) -->
    <div v-if="tab === 'grief'" class="flex items-center gap-1">
      <button
        v-for="s_ in (['pending', 'approved', 'rejected'] as const)" :key="s_"
        type="button"
        class="px-3 py-1.5 rounded-full text-xs font-medium transition-colors"
        :class="griefStatus === s_ ? 'bg-primary/15 text-primary' : 'bg-accent/40 text-muted-foreground hover:text-foreground'"
        @click="setGriefStatus(s_)"
      >
        {{ t('griefTab_' + s_) }}
        <span v-if="s_ === 'pending' && griefStatus === 'pending' && pendingGriefCount > 0"
              class="ml-1 px-1 py-0.5 rounded-full bg-amber-500/15 text-amber-400 text-[10px] font-bold tabular-nums">
          {{ pendingGriefCount }}
        </span>
      </button>
    </div>

    <div v-if="loading" class="text-sm text-muted-foreground flex items-center gap-2">
      <Loader2 class="w-4 h-4 animate-spin" /> {{ t('loading') }}…
    </div>
    <div v-else-if="error" class="card p-4 border border-destructive/40 text-destructive text-sm">{{ error }}</div>

    <!-- ── Toxic ── -->
    <template v-else-if="tab === 'toxic'">
      <div v-if="toxicRows.length === 0" class="card p-8 text-center text-muted-foreground text-sm">
        {{ t('reportsEmptyToxic') }}
      </div>
      <div v-else class="flex flex-col gap-3">
        <div v-for="r in toxicRows" :key="r.id" class="card p-4 flex flex-col gap-3">
          <div class="flex items-center gap-3 flex-wrap">
            <div class="flex items-center gap-2 min-w-0">
              <Flag class="w-4 h-4 text-amber-400 shrink-0" />
              <img v-if="r.reported_avatar" :src="r.reported_avatar" class="w-8 h-8 rounded-full" />
              <div v-else class="w-8 h-8 rounded-full bg-accent" />
              <div class="min-w-0">
                <p class="text-sm font-semibold truncate">{{ r.reported_display_name }}</p>
                <p class="text-[11px] text-muted-foreground">
                  {{ t('reportsToxicTotals', { reports: r.reported_toxic_reports_received, strikes: r.reported_toxic_strikes }) }}
                </p>
              </div>
            </div>
            <span class="text-[11px] text-muted-foreground">{{ t('griefReportedBy') }}</span>
            <div class="flex items-center gap-2 min-w-0">
              <img v-if="r.reporter_avatar" :src="r.reporter_avatar" class="w-7 h-7 rounded-full" />
              <div v-else class="w-7 h-7 rounded-full bg-accent" />
              <span class="text-sm truncate">{{ r.reporter_display_name }}</span>
            </div>
            <div class="ml-auto flex items-center gap-2">
              <button
                v-if="r.queue_match_id"
                type="button"
                class="text-[11px] text-primary hover:underline"
                @click="openMatch(r.queue_match_id)"
              >{{ t('reportsOpenMatch', { id: r.queue_match_id }) }}</button>
              <span v-if="r.pool_name" class="px-2 py-0.5 rounded bg-accent/40 text-[11px] text-muted-foreground">{{ r.pool_name }}</span>
              <span class="text-[11px] text-muted-foreground font-mono">{{ fmtTime(r.created_at) }}</span>
            </div>
          </div>
          <div v-if="r.comment" class="text-sm bg-accent/20 rounded-md px-3 py-2 whitespace-pre-wrap">"{{ r.comment }}"</div>
          <div v-if="r.status !== 'pending'" class="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span class="font-semibold px-1.5 py-0.5 rounded" :class="statusPillClass(r.status)">
              {{ t('griefStatus_' + r.status) }}
            </span>
            <span v-if="r.reviewed_at" class="font-mono">{{ fmtTime(r.reviewed_at) }}</span>
            <span v-if="r.review_note" class="italic">"{{ r.review_note }}"</span>
          </div>
          <div v-if="r.status === 'pending'" class="flex items-center gap-2">
            <button
              type="button"
              class="px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 bg-green-500/15 text-green-500 hover:bg-green-500/25 transition-colors disabled:opacity-40"
              :disabled="acting === r.id"
              @click="openReviewToxic(r, 'approve')"
            >
              <Check class="w-3.5 h-3.5" />
              {{ t('griefApprove') }}
            </button>
            <button
              type="button"
              class="px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 bg-red-500/15 text-red-500 hover:bg-red-500/25 transition-colors disabled:opacity-40"
              :disabled="acting === r.id"
              @click="openReviewToxic(r, 'reject')"
            >
              <X class="w-3.5 h-3.5" />
              {{ t('griefReject') }}
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- ── Grief ── -->
    <template v-else-if="tab === 'grief'">
      <div v-if="griefRows.length === 0" class="card p-8 text-center text-muted-foreground text-sm">
        {{ t('griefEmpty') }}
      </div>
      <div v-else class="flex flex-col gap-3">
        <div v-for="r in griefRows" :key="r.id" class="card p-4 flex flex-col gap-3">
          <div class="flex items-center gap-3 flex-wrap">
            <div class="flex items-center gap-2 min-w-0">
              <AlertTriangle class="w-4 h-4 text-rose-400" />
              <img v-if="r.reported_avatar" :src="r.reported_avatar" class="w-8 h-8 rounded-full" />
              <div v-else class="w-8 h-8 rounded-full bg-accent" />
              <div class="min-w-0">
                <p class="text-sm font-semibold truncate">{{ r.reported_display_name }}</p>
                <p class="text-[11px] text-muted-foreground">
                  {{ t('griefStrikesNow', { n: r.reported_grief_strikes }) }}
                  <span v-if="r.reported_captain_pool" class="ml-1 px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-300 text-[10px] uppercase tracking-wider">
                    {{ t('griefIsCaptain') }}
                  </span>
                </p>
              </div>
            </div>
            <span class="text-muted-foreground text-xs">{{ t('griefReportedBy') }}</span>
            <div class="flex items-center gap-2 min-w-0">
              <img v-if="r.reporter_avatar" :src="r.reporter_avatar" class="w-7 h-7 rounded-full" />
              <div v-else class="w-7 h-7 rounded-full bg-accent" />
              <p class="text-sm truncate">{{ r.reporter_display_name }}</p>
            </div>
            <div class="ml-auto flex items-center gap-2">
              <button
                v-if="r.queue_match_id"
                type="button"
                class="text-[11px] text-primary hover:underline"
                @click="openMatch(r.queue_match_id)"
              >{{ t('reportsOpenMatch', { id: r.queue_match_id }) }}</button>
              <span v-if="r.pool_name" class="px-2 py-0.5 rounded bg-accent/40 text-[11px] text-muted-foreground">{{ r.pool_name }}</span>
              <span class="text-[11px] text-muted-foreground font-mono">{{ fmtTime(r.created_at) }}</span>
            </div>
          </div>
          <div class="text-sm bg-accent/20 rounded-md px-3 py-2 whitespace-pre-wrap">{{ r.comment }}</div>
          <div v-if="r.status !== 'pending'" class="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span class="font-semibold px-1.5 py-0.5 rounded" :class="statusPillClass(r.status)">
              {{ t('griefStatus_' + r.status) }}
            </span>
            <span v-if="r.reviewed_at" class="font-mono">{{ fmtTime(r.reviewed_at) }}</span>
            <span v-if="r.review_note" class="italic">"{{ r.review_note }}"</span>
          </div>
          <div v-if="r.status === 'pending'" class="flex items-center gap-2">
            <button
              type="button"
              class="px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 bg-green-500/15 text-green-500 hover:bg-green-500/25 transition-colors disabled:opacity-40"
              :disabled="acting === r.id"
              @click="openReviewGrief(r, 'approve')"
            >
              <Check class="w-3.5 h-3.5" />
              {{ t('griefApprove') }}
            </button>
            <button
              type="button"
              class="px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 bg-red-500/15 text-red-500 hover:bg-red-500/25 transition-colors disabled:opacity-40"
              :disabled="acting === r.id"
              @click="openReviewGrief(r, 'reject')"
            >
              <X class="w-3.5 h-3.5" />
              {{ t('griefReject') }}
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- ── Strike log ── -->
    <template v-else-if="tab === 'strikes'">
      <div v-if="strikeRows.length === 0" class="card p-8 text-center text-muted-foreground text-sm">
        {{ t('reportsEmptyStrikes') }}
      </div>
      <div v-else class="card overflow-hidden">
        <div class="px-4 py-2 grid items-center text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border/30"
             style="grid-template-columns: 220px 100px 60px 1fr 160px 140px;">
          <span>{{ t('reportsColPlayer') }}</span>
          <span>{{ t('reportsColKind') }}</span>
          <span class="text-right">Δ</span>
          <span>{{ t('reportsColReason') }}</span>
          <span>{{ t('reportsColAppliedBy') }}</span>
          <span class="text-right">{{ t('reportsColWhen') }}</span>
        </div>
        <div v-for="row in strikeRows" :key="row.id"
             class="px-4 py-2 grid items-center border-b border-border/20 last:border-b-0 hover:bg-accent/15 transition-colors"
             style="grid-template-columns: 220px 100px 60px 1fr 160px 140px;">
          <div class="flex items-center gap-2 min-w-0">
            <img v-if="row.player_avatar" :src="row.player_avatar" class="w-6 h-6 rounded-full" />
            <div v-else class="w-6 h-6 rounded-full bg-accent" />
            <span class="text-sm truncate">{{ row.player_display_name }}</span>
          </div>
          <span class="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded w-fit" :class="strikeKindPill(row.kind)">
            {{ t('reportsStrikeKind_' + row.kind) }}
          </span>
          <span class="text-right text-xs font-mono font-bold tabular-nums"
                :class="row.delta > 0 ? 'text-red-500' : (row.delta < 0 ? 'text-green-500' : 'text-muted-foreground')">
            {{ row.delta > 0 ? `+${row.delta}` : row.delta }}
          </span>
          <span class="text-xs text-muted-foreground truncate" :title="row.reason || ''">{{ row.reason || '—' }}</span>
          <span class="text-xs text-muted-foreground truncate">{{ row.applied_by_display_name || '—' }}</span>
          <span class="text-right text-[11px] text-muted-foreground font-mono">{{ fmtTime(row.created_at) }}</span>
        </div>
      </div>
    </template>

    <!-- ── Players with strikes ── -->
    <template v-else-if="tab === 'players'">
      <div v-if="playerRows.length === 0" class="card p-8 text-center text-muted-foreground text-sm">
        {{ t('reportsStrikePlayersEmpty') }}
      </div>
      <div v-else class="card overflow-hidden">
        <div class="px-4 py-2 grid items-center text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border/30"
             style="grid-template-columns: 1fr 72px 72px 80px 80px 230px;">
          <span>{{ t('reportsColPlayer') }}</span>
          <span class="text-center">{{ t('reportsColToxicStrikes') }}</span>
          <span class="text-center">{{ t('reportsColGriefStrikes') }}</span>
          <span class="text-center">{{ t('reportsColReports') }}</span>
          <span class="text-center">{{ t('reportsColQueue') }}</span>
          <span class="text-right">{{ t('reportsLiftTitle') }}</span>
        </div>
        <div v-for="p in playerRows" :key="p.id"
             class="px-4 py-2 grid items-center border-b border-border/20 last:border-b-0 hover:bg-accent/15 transition-colors"
             style="grid-template-columns: 1fr 72px 72px 80px 80px 230px;">
          <div class="flex items-center gap-2 min-w-0">
            <img v-if="p.avatar_url" :src="p.avatar_url" class="w-7 h-7 rounded-full" />
            <div v-else class="w-7 h-7 rounded-full bg-accent" />
            <span class="text-sm truncate">{{ p.display_name }}</span>
          </div>
          <span class="text-center text-sm font-mono font-bold tabular-nums" :class="p.toxic_strikes > 0 ? 'text-amber-400' : 'text-muted-foreground'">{{ p.toxic_strikes }}</span>
          <span class="text-center text-sm font-mono font-bold tabular-nums" :class="p.grief_strikes > 0 ? 'text-rose-400' : 'text-muted-foreground'">{{ p.grief_strikes }}</span>
          <span class="text-center text-xs font-mono tabular-nums text-muted-foreground">{{ p.toxic_reports_received }}</span>
          <span class="text-center">
            <span v-if="p.is_banned" class="px-1.5 py-0.5 rounded bg-red-500/15 text-red-500 text-[10px] font-bold uppercase tracking-wider">{{ t('reportsBanned') }}</span>
            <span v-else class="text-muted-foreground text-xs">—</span>
          </span>
          <div class="flex items-center justify-end gap-1 flex-wrap">
            <template v-if="p.toxic_strikes > 0">
              <span class="text-[10px] text-amber-400 font-bold">T</span>
              <button type="button" class="px-2 py-1 rounded-md text-xs bg-accent/40 hover:bg-accent" @click="openLift(p, 'toxic', false)">{{ t('reportsLiftMinusOne') }}</button>
              <button type="button" class="px-2 py-1 rounded-md text-xs bg-accent/40 hover:bg-accent" @click="openLift(p, 'toxic', true)">{{ t('reportsLiftClear') }}</button>
            </template>
            <template v-if="p.grief_strikes > 0">
              <span class="text-[10px] text-rose-400 font-bold ml-1">G</span>
              <button type="button" class="px-2 py-1 rounded-md text-xs bg-accent/40 hover:bg-accent" @click="openLift(p, 'grief', false)">{{ t('reportsLiftMinusOne') }}</button>
              <button type="button" class="px-2 py-1 rounded-md text-xs bg-accent/40 hover:bg-accent" @click="openLift(p, 'grief', true)">{{ t('reportsLiftClear') }}</button>
            </template>
          </div>
        </div>
      </div>
    </template>

    <!-- Review modal — shared by toxic + grief -->
    <ModalOverlay :show="reviewModal.open" @close="closeReview">
      <div class="px-6 py-5 border-b border-border">
        <h2 class="text-base font-semibold">
          {{ reviewModal.action === 'approve' ? t('griefApprove') : t('griefReject') }}
        </h2>
        <p class="text-xs text-muted-foreground mt-0.5">
          {{ t('inhouseReportAgainst', { name: reviewModal.targetName }) }}
        </p>
      </div>
      <div class="px-6 py-5 flex flex-col gap-3">
        <p v-if="reviewModal.action === 'approve'" class="text-xs text-muted-foreground">
          {{ reviewModal.kind === 'toxic' ? t('toxicApproveExplain') : t('griefApproveExplain') }}
        </p>
        <label class="text-xs font-medium text-muted-foreground">{{ t('griefReviewNoteLabel') }}</label>
        <textarea
          v-model="reviewNote"
          class="input-field w-full min-h-[90px] resize-y"
          :placeholder="t('griefReviewNotePlaceholder')"
          :disabled="reviewSubmitting"
        />
        <div v-if="reviewError" class="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
          {{ reviewError }}
        </div>
      </div>
      <div class="px-6 py-4 border-t border-border flex justify-end gap-2">
        <button type="button" class="btn-outline" :disabled="reviewSubmitting" @click="closeReview">{{ t('cancel') }}</button>
        <button
          type="button"
          class="btn-primary flex items-center gap-2"
          :disabled="reviewSubmitting"
          @click="submitReview"
        >
          <Loader2 v-if="reviewSubmitting" class="w-3.5 h-3.5 animate-spin" />
          {{ reviewModal.action === 'approve' ? t('griefApprove') : t('griefReject') }}
        </button>
      </div>
    </ModalOverlay>

    <!-- Lift-strikes confirmation -->
    <ModalOverlay :show="liftModal.open" @close="closeLift">
      <div class="px-6 py-5 border-b border-border">
        <h2 class="text-base font-semibold">{{ t('reportsLiftTitle') }}</h2>
      </div>
      <div class="px-6 py-5 flex flex-col gap-3">
        <p class="text-sm">
          {{ liftModal.clear
            ? t('reportsLiftConfirmClear', { name: liftModal.player?.display_name, kind: liftKindWord })
            : t('reportsLiftConfirmOne', { name: liftModal.player?.display_name, kind: liftKindWord }) }}
        </p>
        <div v-if="liftError" class="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">{{ liftError }}</div>
      </div>
      <div class="px-6 py-4 border-t border-border flex justify-end gap-2">
        <button type="button" class="btn-outline" :disabled="liftSubmitting" @click="closeLift">{{ t('cancel') }}</button>
        <button type="button" class="btn-primary flex items-center gap-2" :disabled="liftSubmitting" @click="submitLift">
          <Loader2 v-if="liftSubmitting" class="w-3.5 h-3.5 animate-spin" />
          {{ t('reportsLiftAction') }}
        </button>
      </div>
    </ModalOverlay>
  </div>
</template>
