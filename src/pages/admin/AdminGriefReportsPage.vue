<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, X, Loader2, AlertTriangle } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'

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

const { t } = useI18n()
const api = useApi()

const tab = ref<'pending' | 'approved' | 'rejected'>('pending')
const rows = ref<GriefReport[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const acting = ref<number | null>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    rows.value = await api.getAdminGriefReports(tab.value)
  } catch (e: any) {
    error.value = e.message || 'Failed to load'
  } finally {
    loading.value = false
  }
}

async function approve(r: GriefReport) {
  if (!confirm(t('griefApproveConfirm', { name: r.reported_display_name }))) return
  const note = prompt(t('griefReviewNotePrompt')) ?? ''
  acting.value = r.id
  try {
    await api.approveGriefReport(r.id, note || undefined)
    await load()
  } catch (e: any) {
    alert(e.message || 'Approve failed')
  } finally {
    acting.value = null
  }
}

async function reject(r: GriefReport) {
  const note = prompt(t('griefReviewNotePrompt'))
  if (note === null) return
  acting.value = r.id
  try {
    await api.rejectGriefReport(r.id, note || undefined)
    await load()
  } catch (e: any) {
    alert(e.message || 'Reject failed')
  } finally {
    acting.value = null
  }
}

const pendingCount = computed(() => rows.value.filter(r => r.status === 'pending').length)

function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

function statusPillClass(status: string): string {
  if (status === 'approved') return 'bg-green-500/15 text-green-500'
  if (status === 'rejected') return 'bg-red-500/15 text-red-500'
  return 'bg-amber-500/15 text-amber-400'
}

onMounted(load)
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[var(--admin-content-max,1200px)] w-full">
    <div>
      <h1 class="text-2xl font-semibold text-foreground">{{ t('adminGriefReports') }}</h1>
      <p class="text-sm text-muted-foreground mt-1">{{ t('adminGriefReportsDesc') }}</p>
    </div>

    <div class="flex items-center gap-1 border-b border-border/40">
      <button
        v-for="t_ in (['pending', 'approved', 'rejected'] as const)" :key="t_"
        type="button"
        class="px-4 py-2 text-sm border-b-2 transition-colors flex items-center gap-1.5"
        :class="tab === t_ ? 'border-primary text-foreground font-semibold' : 'border-transparent text-muted-foreground hover:text-foreground'"
        @click="tab = t_; load()"
      >
        {{ t('griefTab_' + t_) }}
        <span v-if="t_ === 'pending' && tab === 'pending' && pendingCount > 0"
              class="px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 text-[10px] font-bold tabular-nums">
          {{ pendingCount }}
        </span>
      </button>
    </div>

    <div v-if="loading" class="text-sm text-muted-foreground flex items-center gap-2">
      <Loader2 class="w-4 h-4 animate-spin" /> {{ t('loading') }}…
    </div>
    <div v-else-if="error" class="card p-4 border border-destructive/40 text-destructive text-sm">{{ error }}</div>
    <div v-else-if="rows.length === 0" class="card p-8 text-center text-muted-foreground text-sm">
      {{ t('griefEmpty') }}
    </div>
    <div v-else class="flex flex-col gap-3">
      <div v-for="r in rows" :key="r.id" class="card p-4 flex flex-col gap-3">
        <div class="flex items-center gap-3 flex-wrap">
          <!-- Reported player -->
          <div class="flex items-center gap-2 min-w-0">
            <AlertTriangle class="w-4 h-4 text-rose-400" />
            <img v-if="r.reported_avatar" :src="r.reported_avatar" class="w-8 h-8 rounded-full object-cover" />
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

          <!-- Reporter -->
          <div class="flex items-center gap-2 min-w-0">
            <img v-if="r.reporter_avatar" :src="r.reporter_avatar" class="w-7 h-7 rounded-full object-cover" />
            <div v-else class="w-7 h-7 rounded-full bg-accent" />
            <p class="text-sm truncate">{{ r.reporter_display_name }}</p>
          </div>

          <div class="ml-auto flex items-center gap-2">
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
            @click="approve(r)"
          >
            <Check class="w-3.5 h-3.5" />
            {{ t('griefApprove') }}
          </button>
          <button
            type="button"
            class="px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 bg-red-500/15 text-red-500 hover:bg-red-500/25 transition-colors disabled:opacity-40"
            :disabled="acting === r.id"
            @click="reject(r)"
          >
            <X class="w-3.5 h-3.5" />
            {{ t('griefReject') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
