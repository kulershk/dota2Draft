<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ArrowLeft, Save, RotateCcw, Trophy, Pencil, History } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import { toLocalDatetime, localDatetimeToISO } from '@/utils/format'

interface SeasonRow {
  id: number
  name: string
  slug: string
  description: string | null
  starts_at: string | null
  ends_at: string | null
  is_active: boolean
  settings: Record<string, any>
  pools?: Array<{ id: number; name: string; enabled: boolean }>
}

interface LeaderRow {
  player_id: number
  display_name: string
  name: string
  avatar_url: string | null
  mmr: number
  points: number
  peak_points: number
  games_played: number
  wins: number
  losses: number
  last_match_at: string | null
}

interface AuditRow {
  id: number
  queue_match_id: number | null
  player_id: number
  team: number | null
  won: boolean | null
  points_before: number
  points_after: number
  delta: number
  team_avg_mmr: number | null
  opponent_avg_mmr: number | null
  expected_win: number | null
  k_used: number | null
  reason: string | null
  player_display_name: string
  avatar_url: string | null
  created_at: string
}

const SETTING_DEFAULTS = {
  starting_points: 1000,
  k_win: 30,
  k_loss: 15,
  mmr_scale: 1500,
  min_points: 0,
  max_points: '' as number | '',
  min_games_for_leaderboard: 5,
}

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const api = useApi()

const seasonId = computed(() => Number(route.params.id))

const tab = ref<'settings' | 'leaderboard' | 'audit'>('settings')
const season = ref<SeasonRow | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)

// Settings form
const form = ref({
  name: '',
  slug: '',
  description: '',
  starts_at: '',
  ends_at: '',
  is_active: true,
  settings: { ...SETTING_DEFAULTS },
})
const saving = ref(false)
const saveMsg = ref<string | null>(null)

// Leaderboard
const leader = ref<LeaderRow[]>([])
const leaderLoading = ref(false)

// Audit
const audit = ref<AuditRow[]>([])
const auditLoading = ref(false)
const auditPlayerFilter = ref('')

// Adjust modal
const adjustOpen = ref(false)
const adjustPlayer = ref<LeaderRow | null>(null)
const adjustDelta = ref(0)
const adjustReason = ref('')
const adjustSaving = ref(false)

async function load() {
  loading.value = true
  error.value = null
  try {
    const s = await api.getAdminSeason(seasonId.value)
    season.value = s
    form.value.name = s.name
    form.value.slug = s.slug
    form.value.description = s.description || ''
    form.value.starts_at = s.starts_at ? toLocalDatetime(s.starts_at) : ''
    form.value.ends_at = s.ends_at ? toLocalDatetime(s.ends_at) : ''
    form.value.is_active = !!s.is_active
    form.value.settings = { ...SETTING_DEFAULTS, ...(s.settings || {}) }
    if (form.value.settings.max_points == null) form.value.settings.max_points = ''
  } catch (e: any) {
    error.value = e.message || 'Failed to load season'
  } finally {
    loading.value = false
  }
}

async function loadLeader() {
  leaderLoading.value = true
  try {
    leader.value = await api.getAdminSeasonLeaderboard(seasonId.value)
  } finally {
    leaderLoading.value = false
  }
}

async function loadAudit() {
  auditLoading.value = true
  try {
    const playerId = auditPlayerFilter.value ? Number(auditPlayerFilter.value) : undefined
    audit.value = await api.getAdminSeasonAudit(seasonId.value, { playerId, limit: 200 })
  } finally {
    auditLoading.value = false
  }
}

watch(tab, (newTab) => {
  if (newTab === 'leaderboard') loadLeader()
  if (newTab === 'audit') loadAudit()
})

async function handleSave() {
  saving.value = true
  saveMsg.value = null
  try {
    const payload: Record<string, any> = {
      name: form.value.name,
      slug: form.value.slug,
      description: form.value.description,
      starts_at: form.value.starts_at ? localDatetimeToISO(form.value.starts_at) : null,
      ends_at: form.value.ends_at ? localDatetimeToISO(form.value.ends_at) : null,
      is_active: form.value.is_active,
      settings: { ...form.value.settings },
    }
    if (payload.settings.max_points === '') payload.settings.max_points = null
    await api.updateSeason(seasonId.value, payload)
    saveMsg.value = t('saved')
    setTimeout(() => { saveMsg.value = null }, 2000)
    await load()
  } catch (e: any) {
    saveMsg.value = e.message || 'Save failed'
  } finally {
    saving.value = false
  }
}

async function handleRecompute() {
  if (!confirm(t('seasonRecomputeConfirm'))) return
  try {
    const res = await api.recomputeSeason(seasonId.value)
    alert(t('seasonRecomputeDone', { players: res.players, events: res.events }))
    if (tab.value === 'leaderboard') await loadLeader()
    if (tab.value === 'audit') await loadAudit()
  } catch (e: any) {
    alert(e.message || 'Recompute failed')
  }
}

async function handleBackfill() {
  if (!confirm(t('seasonBackfillConfirm'))) return
  try {
    const res = await api.backfillSeason(seasonId.value)
    alert(t('seasonBackfillDone', { claimed: res.claimed, players: res.players, events: res.events }))
    if (tab.value === 'leaderboard') await loadLeader()
    if (tab.value === 'audit') await loadAudit()
  } catch (e: any) {
    alert(e.message || 'Backfill failed')
  }
}

function openAdjust(row: LeaderRow) {
  adjustPlayer.value = row
  adjustDelta.value = 0
  adjustReason.value = ''
  adjustOpen.value = true
}

async function submitAdjust() {
  if (!adjustPlayer.value || !adjustDelta.value) return
  adjustSaving.value = true
  try {
    await api.adjustSeasonPoints(seasonId.value, {
      player_id: adjustPlayer.value.player_id,
      delta: Number(adjustDelta.value),
      reason: adjustReason.value || undefined,
    })
    adjustOpen.value = false
    await loadLeader()
  } catch (e: any) {
    alert(e.message || 'Adjust failed')
  } finally {
    adjustSaving.value = false
  }
}

function fmtPoints(p: number): string {
  return Math.round(Number(p) || 0).toString()
}
function fmtSignedDelta(d: number): string {
  const n = Number(d) || 0
  const r = Math.round(n * 10) / 10
  return r > 0 ? `+${r}` : String(r)
}
function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

onMounted(load)
</script>

<template>
  <div class="p-6 max-w-[1200px] mx-auto">
    <div class="flex items-center gap-2 mb-4">
      <button type="button" class="p-1.5 rounded-md hover:bg-accent" @click="router.push({ name: 'admin-seasons' })">
        <ArrowLeft class="w-4 h-4" />
      </button>
      <div class="flex-1 min-w-0">
        <h1 class="text-2xl font-bold truncate">{{ season?.name || t('loading') }}</h1>
        <p class="text-xs text-muted-foreground font-mono">{{ season?.slug }}</p>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex items-center gap-1 border-b border-border/40 mb-5">
      <button
        v-for="t_ in (['settings', 'leaderboard', 'audit'] as const)" :key="t_"
        type="button"
        class="px-4 py-2 text-sm border-b-2 transition-colors"
        :class="tab === t_ ? 'border-primary text-foreground font-semibold' : 'border-transparent text-muted-foreground hover:text-foreground'"
        @click="tab = t_"
      >
        {{ t('seasonTab_' + t_) }}
      </button>
    </div>

    <div v-if="loading" class="text-sm text-muted-foreground">{{ t('loading') }}…</div>
    <div v-else-if="error" class="card p-4 border border-destructive/40 text-destructive text-sm">{{ error }}</div>

    <!-- Settings tab -->
    <div v-else-if="tab === 'settings'" class="card p-5 flex flex-col gap-5">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label class="block">
          <span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ t('seasonName') }}</span>
          <input v-model="form.name" type="text" class="mt-1 w-full bg-accent/40 border border-border/40 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40" />
        </label>
        <label class="block">
          <span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ t('seasonSlug') }}</span>
          <input v-model="form.slug" type="text" class="mt-1 w-full bg-accent/40 border border-border/40 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary/40" />
        </label>
        <label class="block md:col-span-2">
          <span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ t('seasonDescription') }}</span>
          <textarea v-model="form.description" rows="2" class="mt-1 w-full bg-accent/40 border border-border/40 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40"></textarea>
        </label>
        <label class="block">
          <span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ t('seasonStartsAt') }}</span>
          <input v-model="form.starts_at" type="datetime-local" class="mt-1 w-full bg-accent/40 border border-border/40 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40" />
        </label>
        <label class="block">
          <span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ t('seasonEndsAt') }}</span>
          <input v-model="form.ends_at" type="datetime-local" class="mt-1 w-full bg-accent/40 border border-border/40 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40" />
        </label>
        <label class="flex items-center gap-2 mt-2">
          <input v-model="form.is_active" type="checkbox" class="w-4 h-4" />
          <span class="text-sm">{{ t('seasonIsActive') }}</span>
        </label>
      </div>

      <div class="border-t border-border/40 pt-4">
        <h3 class="text-sm font-bold mb-1">{{ t('seasonRatingSettings') }}</h3>
        <p class="text-xs text-muted-foreground mb-3">{{ t('seasonRatingSettingsHint') }}</p>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          <label class="block">
            <span class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{{ t('seasonStartingPoints') }}</span>
            <input v-model.number="form.settings.starting_points" type="number" class="mt-1 w-full bg-accent/40 border border-border/40 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary/40" />
          </label>
          <label class="block">
            <span class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{{ t('seasonKWin') }}</span>
            <input v-model.number="form.settings.k_win" type="number" step="0.1" class="mt-1 w-full bg-accent/40 border border-border/40 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary/40" />
          </label>
          <label class="block">
            <span class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{{ t('seasonKLoss') }}</span>
            <input v-model.number="form.settings.k_loss" type="number" step="0.1" class="mt-1 w-full bg-accent/40 border border-border/40 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary/40" />
          </label>
          <label class="block">
            <span class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{{ t('seasonMmrScale') }}</span>
            <input v-model.number="form.settings.mmr_scale" type="number" class="mt-1 w-full bg-accent/40 border border-border/40 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary/40" />
          </label>
          <label class="block">
            <span class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{{ t('seasonMinPoints') }}</span>
            <input v-model.number="form.settings.min_points" type="number" class="mt-1 w-full bg-accent/40 border border-border/40 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary/40" />
          </label>
          <label class="block">
            <span class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{{ t('seasonMaxPoints') }}</span>
            <input v-model="form.settings.max_points" type="number" :placeholder="t('seasonNoCap')" class="mt-1 w-full bg-accent/40 border border-border/40 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary/40" />
          </label>
          <label class="block">
            <span class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{{ t('seasonMinGames') }}</span>
            <input v-model.number="form.settings.min_games_for_leaderboard" type="number" class="mt-1 w-full bg-accent/40 border border-border/40 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary/40" />
          </label>
        </div>
      </div>

      <div v-if="season?.pools?.length" class="border-t border-border/40 pt-4">
        <h3 class="text-sm font-bold mb-2">{{ t('seasonAssignedPools') }}</h3>
        <div class="flex flex-wrap gap-1.5">
          <span v-for="p in season.pools" :key="p.id" class="px-2 py-1 rounded bg-accent/40 text-xs font-mono">
            {{ p.name }}
          </span>
        </div>
      </div>

      <div class="flex items-center justify-between border-t border-border/40 pt-4 flex-wrap gap-3">
        <div class="flex items-center gap-2 flex-wrap">
          <button type="button" class="px-3 py-2 text-sm rounded-md bg-accent/40 hover:bg-accent flex items-center gap-2" @click="handleBackfill" :title="t('seasonBackfillHint')">
            <History class="w-4 h-4" />
            {{ t('seasonBackfill') }}
          </button>
          <button type="button" class="px-3 py-2 text-sm rounded-md bg-accent/40 hover:bg-accent flex items-center gap-2" @click="handleRecompute">
            <RotateCcw class="w-4 h-4" />
            {{ t('seasonRecompute') }}
          </button>
        </div>
        <div class="flex items-center gap-3">
          <span v-if="saveMsg" class="text-xs text-muted-foreground">{{ saveMsg }}</span>
          <button type="button" class="btn-primary px-3 py-2 text-sm flex items-center gap-2" :disabled="saving" @click="handleSave">
            <Save class="w-4 h-4" />
            {{ saving ? `${t('saving')}…` : t('save') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Leaderboard tab -->
    <div v-else-if="tab === 'leaderboard'" class="card overflow-hidden">
      <div v-if="leaderLoading" class="text-sm text-muted-foreground p-4">{{ t('loading') }}…</div>
      <div v-else-if="leader.length === 0" class="text-center text-muted-foreground py-10">
        <Trophy class="w-10 h-10 mx-auto mb-3 opacity-40" />
        <p class="text-sm">{{ t('seasonLeaderboardEmpty') }}</p>
      </div>
      <table v-else class="w-full text-sm">
        <thead class="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th class="text-right px-4 py-2.5 w-12">#</th>
            <th class="text-left px-4 py-2.5">{{ t('player') }}</th>
            <th class="text-right px-4 py-2.5">{{ t('seasonPoints') }}</th>
            <th class="text-right px-4 py-2.5">{{ t('seasonPeak') }}</th>
            <th class="text-right px-4 py-2.5">{{ t('seasonGames') }}</th>
            <th class="text-right px-4 py-2.5">{{ t('seasonRecord') }}</th>
            <th class="text-right px-4 py-2.5">{{ t('seasonLastPlayed') }}</th>
            <th class="px-4 py-2.5"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in leader" :key="row.player_id" class="border-t border-border/40 hover:bg-accent/20">
            <td class="px-4 py-2.5 text-right font-mono tabular-nums text-muted-foreground">{{ i + 1 }}</td>
            <td class="px-4 py-2.5">
              <div class="flex items-center gap-2">
                <img v-if="row.avatar_url" :src="row.avatar_url" class="w-6 h-6 rounded-full" />
                <div v-else class="w-6 h-6 rounded-full bg-accent" />
                <span class="font-semibold">{{ row.display_name }}</span>
                <span class="text-[11px] text-muted-foreground font-mono">{{ row.mmr }} MMR</span>
              </div>
            </td>
            <td class="px-4 py-2.5 text-right font-mono font-bold tabular-nums">{{ fmtPoints(row.points) }}</td>
            <td class="px-4 py-2.5 text-right font-mono text-muted-foreground tabular-nums">{{ fmtPoints(row.peak_points) }}</td>
            <td class="px-4 py-2.5 text-right font-mono tabular-nums">{{ row.games_played }}</td>
            <td class="px-4 py-2.5 text-right font-mono tabular-nums">
              <span class="text-green-500">{{ row.wins }}</span>
              <span class="text-muted-foreground"> / </span>
              <span class="text-red-500">{{ row.losses }}</span>
            </td>
            <td class="px-4 py-2.5 text-right font-mono text-xs text-muted-foreground tabular-nums">{{ fmtTime(row.last_match_at) }}</td>
            <td class="px-4 py-2.5 text-right">
              <button type="button" class="p-1.5 rounded-md hover:bg-accent text-muted-foreground" :title="t('seasonAdjust')" @click="openAdjust(row)">
                <Pencil class="w-4 h-4" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Audit tab -->
    <div v-else-if="tab === 'audit'" class="card overflow-hidden">
      <div class="px-4 py-3 border-b border-border/40 flex items-center gap-2">
        <input
          v-model="auditPlayerFilter"
          type="number"
          :placeholder="t('seasonAuditPlayerFilter')"
          class="w-48 bg-accent/40 border border-border/40 rounded-lg px-3 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary/40"
        />
        <button type="button" class="px-3 py-1.5 text-xs rounded-md bg-accent/40 hover:bg-accent" @click="loadAudit">{{ t('apply') }}</button>
      </div>
      <div v-if="auditLoading" class="text-sm text-muted-foreground p-4">{{ t('loading') }}…</div>
      <div v-else-if="audit.length === 0" class="text-center text-muted-foreground py-10 text-sm">{{ t('seasonAuditEmpty') }}</div>
      <table v-else class="w-full text-xs">
        <thead class="bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground">
          <tr>
            <th class="text-left px-3 py-2">{{ t('seasonWhen') }}</th>
            <th class="text-left px-3 py-2">{{ t('player') }}</th>
            <th class="text-left px-3 py-2">{{ t('seasonMatch') }}</th>
            <th class="text-right px-3 py-2">{{ t('seasonBefore') }}</th>
            <th class="text-right px-3 py-2">{{ t('seasonDelta') }}</th>
            <th class="text-right px-3 py-2">{{ t('seasonAfter') }}</th>
            <th class="text-right px-3 py-2">{{ t('seasonExpected') }}</th>
            <th class="text-left px-3 py-2">{{ t('seasonReason') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in audit" :key="row.id" class="border-t border-border/40">
            <td class="px-3 py-2 font-mono text-muted-foreground tabular-nums">{{ fmtTime(row.created_at) }}</td>
            <td class="px-3 py-2">
              <span class="font-semibold">{{ row.player_display_name }}</span>
              <span v-if="row.team" class="ml-1 text-[10px] text-muted-foreground">T{{ row.team }}</span>
            </td>
            <td class="px-3 py-2 font-mono text-muted-foreground tabular-nums">
              <template v-if="row.queue_match_id">#{{ row.queue_match_id }}</template>
              <template v-else>—</template>
            </td>
            <td class="px-3 py-2 text-right font-mono tabular-nums">{{ fmtPoints(row.points_before) }}</td>
            <td class="px-3 py-2 text-right font-mono font-bold tabular-nums" :class="row.delta > 0 ? 'text-green-500' : (row.delta < 0 ? 'text-red-500' : '')">
              {{ fmtSignedDelta(row.delta) }}
            </td>
            <td class="px-3 py-2 text-right font-mono tabular-nums">{{ fmtPoints(row.points_after) }}</td>
            <td class="px-3 py-2 text-right font-mono tabular-nums">
              <template v-if="row.expected_win != null">{{ Math.round(row.expected_win * 100) }}%</template>
              <template v-else>—</template>
            </td>
            <td class="px-3 py-2 text-muted-foreground">{{ row.reason || (row.queue_match_id ? '' : t('seasonManual')) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Adjust modal -->
    <div v-if="adjustOpen" class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" @click.self="adjustOpen = false">
      <div class="card w-full max-w-md p-6">
        <h2 class="text-lg font-bold mb-1">{{ t('seasonAdjust') }}</h2>
        <p class="text-xs text-muted-foreground mb-4">{{ adjustPlayer?.display_name }} — {{ fmtPoints(adjustPlayer?.points || 0) }} pts</p>
        <div class="flex flex-col gap-3">
          <label class="block">
            <span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ t('seasonDelta') }}</span>
            <input v-model.number="adjustDelta" type="number" step="any" class="mt-1 w-full bg-accent/40 border border-border/40 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary/40" />
          </label>
          <label class="block">
            <span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ t('seasonReason') }}</span>
            <input v-model="adjustReason" type="text" :placeholder="t('seasonReasonPlaceholder')" class="mt-1 w-full bg-accent/40 border border-border/40 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40" />
          </label>
        </div>
        <div class="flex justify-end gap-2 mt-5">
          <button type="button" class="px-3 py-2 text-sm rounded-md hover:bg-accent" @click="adjustOpen = false">{{ t('cancel') }}</button>
          <button type="button" class="btn-primary px-3 py-2 text-sm" :disabled="!adjustDelta || adjustSaving" @click="submitAdjust">
            {{ adjustSaving ? `${t('saving')}…` : t('apply') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
