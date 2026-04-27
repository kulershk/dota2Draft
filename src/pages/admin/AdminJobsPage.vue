<script setup lang="ts">
import { Activity, RefreshCw, RotateCcw, X, Trash2, ChevronLeft, ChevronRight, Play, Plus } from 'lucide-vue-next'
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'
import { fmtDateTime } from '@/utils/format'

const { t } = useI18n()
const api = useApi()

type Job = {
  id: number
  type: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  payload: any
  result: any
  error: string | null
  attempts: number
  max_attempts: number
  run_at: string
  created_at: string
  started_at: string | null
  completed_at: string | null
}

const rows = ref<Job[]>([])
const total = ref(0)
const counts = ref<Record<string, number>>({ pending: 0, running: 0, completed: 0, failed: 0 })
const types = ref<string[]>([])
const loading = ref(false)
const statusFilter = ref<'all' | 'pending' | 'running' | 'completed' | 'failed'>('all')
const typeFilter = ref('')
const page = ref(0)
const PAGE_SIZE = 25
const autoRefresh = ref(true)
const selected = ref<Job | null>(null)
const showCreate = ref(false)
const newType = ref('noop')
const newPayload = ref('{"delayMs": 1000}')
const createError = ref('')

let refreshTimer: ReturnType<typeof setInterval> | null = null

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))

async function fetchJobs() {
  loading.value = true
  try {
    const params: Record<string, string | number> = { limit: PAGE_SIZE, offset: page.value * PAGE_SIZE }
    if (statusFilter.value !== 'all') params.status = statusFilter.value
    if (typeFilter.value) params.type = typeFilter.value
    const data = await api.getAdminJobs(params)
    rows.value = data.rows
    total.value = data.total
    counts.value = data.counts
    types.value = data.types
  } catch (e) {
    console.error(e)
  } finally {
    loading.value = false
  }
}

async function retry(job: Job) {
  await api.retryAdminJob(job.id)
  await fetchJobs()
}

async function cancel(job: Job) {
  await api.cancelAdminJob(job.id)
  await fetchJobs()
}

async function remove(job: Job) {
  if (!confirm(t('jobConfirmDelete'))) return
  await api.deleteAdminJob(job.id)
  if (selected.value?.id === job.id) selected.value = null
  await fetchJobs()
}

async function pruneCompleted() {
  if (!confirm(t('jobConfirmPrune'))) return
  await api.pruneAdminJobs({ status: 'completed', olderThanDays: 7 })
  await fetchJobs()
}

async function createJob() {
  createError.value = ''
  let payload: any = {}
  try {
    payload = newPayload.value.trim() ? JSON.parse(newPayload.value) : {}
  } catch (e: any) {
    createError.value = 'Invalid JSON: ' + e.message
    return
  }
  try {
    await api.createAdminJob({ type: newType.value, payload })
    showCreate.value = false
    newPayload.value = '{"delayMs": 1000}'
    await fetchJobs()
  } catch (e: any) {
    createError.value = e.message || 'Failed'
  }
}

function timeUntil(dateStr: string): string {
  const diff = new Date(dateStr).getTime() - Date.now()
  if (diff <= 0) return 'now'
  const secs = Math.ceil(diff / 1000)
  if (secs < 60) return `in ${secs}s`
  const mins = Math.ceil(secs / 60)
  if (mins < 60) return `in ${mins}m`
  return `in ${Math.floor(mins / 60)}h ${mins % 60}m`
}

function statusClass(status: string) {
  switch (status) {
    case 'pending': return 'bg-amber-500/20 text-amber-500'
    case 'running': return 'bg-sky-500/20 text-sky-500'
    case 'completed': return 'bg-green-500/20 text-green-500'
    case 'failed': return 'bg-red-500/20 text-red-500'
    default: return 'bg-accent text-muted-foreground'
  }
}

watch([statusFilter, typeFilter], () => { page.value = 0 })
watch([page, statusFilter, typeFilter], () => fetchJobs(), { immediate: true })

onMounted(() => {
  refreshTimer = setInterval(() => { if (autoRefresh.value) fetchJobs() }, 3000)
})
onUnmounted(() => { if (refreshTimer) clearInterval(refreshTimer) })
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[1200px] w-full">
    <div class="flex items-center justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold text-foreground">{{ t('adminJobs') }}</h1>
        <p class="text-sm text-muted-foreground mt-1">{{ t('adminJobsDesc') }}</p>
      </div>
      <div class="flex items-center gap-2">
        <button class="btn-secondary text-sm flex items-center gap-1.5" @click="fetchJobs">
          <RefreshCw class="w-4 h-4" /> {{ t('refresh') }}
        </button>
        <button class="btn-primary text-sm flex items-center gap-1.5" @click="showCreate = true">
          <Plus class="w-4 h-4" /> {{ t('jobNew') }}
        </button>
      </div>
    </div>

    <!-- Status counts -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <button
        v-for="s in (['pending','running','completed','failed'] as const)"
        :key="s"
        class="card px-4 py-3 text-left transition-colors"
        :class="statusFilter === s ? 'ring-2 ring-primary' : 'hover:bg-accent/30'"
        @click="statusFilter = statusFilter === s ? 'all' : s"
      >
        <div class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t(`jobStatus_${s}`) }}</div>
        <div class="text-2xl font-bold tabular-nums mt-1" :class="statusClass(s).split(' ')[1]">{{ counts[s] || 0 }}</div>
      </button>
    </div>

    <!-- Filters -->
    <div class="flex flex-wrap items-center gap-3">
      <select v-model="statusFilter" class="input-field w-40">
        <option value="all">{{ t('jobStatusAll') }}</option>
        <option value="pending">{{ t('jobStatus_pending') }}</option>
        <option value="running">{{ t('jobStatus_running') }}</option>
        <option value="completed">{{ t('jobStatus_completed') }}</option>
        <option value="failed">{{ t('jobStatus_failed') }}</option>
      </select>
      <select v-model="typeFilter" class="input-field w-56">
        <option value="">{{ t('jobAllTypes') }}</option>
        <option v-for="ty in types" :key="ty" :value="ty">{{ ty }}</option>
      </select>
      <label class="text-xs text-muted-foreground flex items-center gap-1.5">
        <input v-model="autoRefresh" type="checkbox" /> {{ t('autoRefresh') }}
      </label>
      <button class="btn-secondary text-xs ml-auto" @click="pruneCompleted">{{ t('jobPruneCompleted') }}</button>
    </div>

    <!-- Table -->
    <div class="rounded-lg border border-border overflow-hidden">
      <div class="flex items-center bg-surface px-4 py-2.5 text-[11px] font-semibold font-mono uppercase tracking-wider text-text-tertiary">
        <span class="w-14 shrink-0">{{ t('jobId') }}</span>
        <span class="w-40 shrink-0 ml-2">{{ t('jobType') }}</span>
        <span class="w-24 shrink-0">{{ t('jobStatus') }}</span>
        <span class="w-20 shrink-0 text-right">{{ t('jobAttempts') }}</span>
        <span class="flex-1 min-w-0 ml-4">{{ t('jobError') }}</span>
        <span class="w-[160px] shrink-0 text-right">{{ t('jobNextRun') }}</span>
        <span class="w-[120px] shrink-0 text-right">{{ t('actions') }}</span>
      </div>
      <div v-if="loading && rows.length === 0" class="p-6 text-center text-sm text-muted-foreground">{{ t('loading') }}</div>
      <div v-else-if="rows.length === 0" class="p-6 text-center text-sm text-muted-foreground">{{ t('jobsEmpty') }}</div>
      <div v-else class="divide-y divide-border">
        <div
          v-for="row in rows"
          :key="row.id"
          class="flex items-center px-4 py-2.5 hover:bg-surface/50 transition-colors cursor-pointer"
          @click="selected = row"
        >
          <span class="w-14 shrink-0 text-xs font-mono text-muted-foreground tabular-nums">#{{ row.id }}</span>
          <span class="w-40 shrink-0 ml-2 text-sm truncate">{{ row.type }}</span>
          <span class="w-24 shrink-0">
            <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full" :class="statusClass(row.status)">{{ t(`jobStatus_${row.status}`) }}</span>
          </span>
          <span class="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{{ row.attempts }}/{{ row.max_attempts }}</span>
          <span class="flex-1 min-w-0 ml-4 text-xs text-red-400 truncate">{{ row.error || '' }}</span>
          <span class="w-[160px] shrink-0 text-right text-[11px] text-muted-foreground">
            <template v-if="row.status === 'pending' && row.run_at">
              <span class="text-primary font-semibold">{{ timeUntil(row.run_at) }}</span>
            </template>
            <template v-else>{{ fmtDateTime(new Date(row.created_at)) }}</template>
          </span>
          <span class="w-[120px] shrink-0 text-right flex items-center justify-end gap-1" @click.stop>
            <button
              v-if="row.status === 'failed' || row.status === 'pending'"
              class="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
              :title="t('jobRetry')"
              @click="retry(row)"
            ><RotateCcw class="w-3.5 h-3.5" /></button>
            <button
              v-if="row.status === 'pending'"
              class="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-amber-500"
              :title="t('jobCancel')"
              @click="cancel(row)"
            ><X class="w-3.5 h-3.5" /></button>
            <button
              class="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-red-500"
              :title="t('delete')"
              @click="remove(row)"
            ><Trash2 class="w-3.5 h-3.5" /></button>
          </span>
        </div>
      </div>
    </div>

    <!-- Pagination -->
    <div v-if="totalPages > 1" class="flex items-center justify-center gap-3">
      <button class="btn-secondary text-sm" :disabled="page === 0" @click="page--">
        <ChevronLeft class="w-4 h-4" />
      </button>
      <span class="text-sm text-muted-foreground">{{ page + 1 }} / {{ totalPages }}</span>
      <button class="btn-secondary text-sm" :disabled="page + 1 >= totalPages" @click="page++">
        <ChevronRight class="w-4 h-4" />
      </button>
    </div>

    <!-- Detail modal -->
    <div
      v-if="selected"
      class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
      @click.self="selected = null"
    >
      <div class="bg-background border border-border rounded-lg max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col">
        <div class="px-5 py-3 border-b border-border flex items-center justify-between">
          <div class="flex items-center gap-3">
            <span class="text-xs font-mono text-muted-foreground">#{{ selected.id }}</span>
            <span class="font-semibold">{{ selected.type }}</span>
            <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full" :class="statusClass(selected.status)">{{ t(`jobStatus_${selected.status}`) }}</span>
          </div>
          <button class="p-1 rounded hover:bg-accent" @click="selected = null"><X class="w-4 h-4" /></button>
        </div>
        <div class="p-5 overflow-y-auto flex flex-col gap-4 text-sm">
          <div class="grid grid-cols-2 gap-3 text-xs">
            <div><div class="text-muted-foreground">{{ t('jobAttempts') }}</div><div class="font-mono">{{ selected.attempts }} / {{ selected.max_attempts }}</div></div>
            <div><div class="text-muted-foreground">{{ t('jobRunAt') }}</div><div class="font-mono">{{ fmtDateTime(new Date(selected.run_at)) }}</div></div>
            <div><div class="text-muted-foreground">{{ t('jobCreated') }}</div><div class="font-mono">{{ fmtDateTime(new Date(selected.created_at)) }}</div></div>
            <div v-if="selected.started_at"><div class="text-muted-foreground">{{ t('jobStarted') }}</div><div class="font-mono">{{ fmtDateTime(new Date(selected.started_at)) }}</div></div>
            <div v-if="selected.completed_at"><div class="text-muted-foreground">{{ t('jobCompleted') }}</div><div class="font-mono">{{ fmtDateTime(new Date(selected.completed_at)) }}</div></div>
          </div>
          <div>
            <div class="text-xs text-muted-foreground mb-1">{{ t('jobPayload') }}</div>
            <pre class="text-[11px] bg-surface border border-border rounded p-2 overflow-x-auto">{{ JSON.stringify(selected.payload, null, 2) }}</pre>
          </div>
          <div v-if="selected.result">
            <div class="text-xs text-muted-foreground mb-1">{{ t('jobResult') }}</div>
            <pre class="text-[11px] bg-surface border border-border rounded p-2 overflow-x-auto">{{ JSON.stringify(selected.result, null, 2) }}</pre>
          </div>
          <div v-if="selected.error">
            <div class="text-xs text-muted-foreground mb-1">{{ t('jobError') }}</div>
            <pre class="text-[11px] bg-red-500/10 border border-red-500/30 text-red-400 rounded p-2 overflow-x-auto whitespace-pre-wrap">{{ selected.error }}</pre>
          </div>
        </div>
      </div>
    </div>

    <!-- Create modal -->
    <div
      v-if="showCreate"
      class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
      @click.self="showCreate = false"
    >
      <div class="bg-background border border-border rounded-lg max-w-md w-full">
        <div class="px-5 py-3 border-b border-border flex items-center justify-between">
          <span class="font-semibold flex items-center gap-2"><Play class="w-4 h-4" /> {{ t('jobNew') }}</span>
          <button class="p-1 rounded hover:bg-accent" @click="showCreate = false"><X class="w-4 h-4" /></button>
        </div>
        <div class="p-5 flex flex-col gap-3 text-sm">
          <div>
            <label class="text-xs text-muted-foreground">{{ t('jobType') }}</label>
            <select v-model="newType" class="input-field w-full mt-1">
              <option v-for="ty in types" :key="ty" :value="ty">{{ ty }}</option>
            </select>
          </div>
          <div>
            <label class="text-xs text-muted-foreground">{{ t('jobPayload') }} (JSON)</label>
            <textarea v-model="newPayload" rows="5" class="input-field w-full mt-1 font-mono text-xs" />
          </div>
          <div v-if="createError" class="text-xs text-red-400">{{ createError }}</div>
          <div class="flex justify-end gap-2">
            <button class="btn-secondary text-sm" @click="showCreate = false">{{ t('cancel') }}</button>
            <button class="btn-primary text-sm" @click="createJob">{{ t('jobEnqueue') }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
