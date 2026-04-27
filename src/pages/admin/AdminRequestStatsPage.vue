<script setup lang="ts">
import { BarChart3, RefreshCw, Activity, X, Filter } from 'lucide-vue-next'
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'
import { fmtDateTime } from '@/utils/format'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js'
import { Line, Bar } from 'vue-chartjs'

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, Title, Tooltip, Legend, Filler)

const { t } = useI18n()
const api = useApi()

type Period = '1h' | '24h' | '7d' | '14d' | '30d' | '90d' | 'all' | 'custom'
const period = ref<Period>('24h')
const customFrom = ref<string>('')
const customTo = ref<string>('')
const autoRefresh = ref(true)
const loading = ref(false)

type Filter = { kind: 'user'; userId: number; label: string } | { kind: 'ip'; ip: string; label: string }
const filter = ref<Filter | null>(null)

type Summary = {
  period: string
  requests: { total: number; unique_users: number; unique_ips: number; avg_ms: number; p95_ms: number }
  status_breakdown: { klass: number; count: number }[]
  socket: { total: number; unique_users: number }
}
type RouteRow = { method: string; path: string; count: number; avg_ms: number; p95_ms: number; errors: number }
type UserRow = { user_id: number | null; name: string; avatar_url: string | null; count: number; errors: number; last_seen: string }
type IpRow = { ip: string; count: number; unique_users: number; errors: number; last_seen: string }
type SocketRow = { event: string; count: number; unique_users: number }
type TimeseriesRow = { bucket: string; count: number; errors: number; avg_ms: number }
type RecentRow = {
  ts: string; method: string; path: string; status: number; duration_ms: number;
  user_id: number | null; ip: string | null; user_agent: string | null; user_name: string | null
}
type PageRow = { path: string; count: number; unique_users: number }
type RecentPageRow = { ts: string; path: string }

const summary = ref<Summary | null>(null)
const topRoutes = ref<RouteRow[]>([])
const topUsers = ref<UserRow[]>([])
const topIps = ref<IpRow[]>([])
const socketEvents = ref<SocketRow[]>([])
const timeseries = ref<{ bucket: string; rows: TimeseriesRow[] }>({ bucket: 'hour', rows: [] })
const recentRequests = ref<RecentRow[]>([])
const topPages = ref<PageRow[]>([])
const recentPages = ref<RecentPageRow[]>([])

let refreshTimer: ReturnType<typeof setInterval> | null = null

const filterOpts = computed(() => {
  if (!filter.value) return {}
  if (filter.value.kind === 'user') return { userId: filter.value.userId }
  return { ip: filter.value.ip }
})

const rangeOpts = computed<{ from?: string; to?: string }>(() => {
  if (period.value !== 'custom') return {}
  const out: { from?: string; to?: string } = {}
  if (customFrom.value) {
    const d = new Date(customFrom.value)
    if (!isNaN(d.getTime())) out.from = d.toISOString()
  }
  if (customTo.value) {
    const d = new Date(customTo.value)
    if (!isNaN(d.getTime())) out.to = d.toISOString()
  }
  return out
})

const customRangeReady = computed(() => period.value !== 'custom' || !!(rangeOpts.value.from && rangeOpts.value.to))

async function loadAll() {
  if (!customRangeReady.value) return
  loading.value = true
  try {
    const opts = { ...filterOpts.value, ...rangeOpts.value }
    const range = rangeOpts.value
    const calls: Promise<any>[] = [
      api.getRequestStatsSummary(period.value, opts),
      api.getRequestStatsTopRoutes(period.value, { limit: 20, ...opts }),
      api.getSocketEventStats(period.value, {
        limit: 50,
        ...range,
        ...(filter.value?.kind === 'user' ? { userId: filter.value.userId } : {}),
      }),
      api.getRequestStatsTimeseries(period.value, opts),
    ]
    // Top users only when not already filtered to one user
    if (filter.value?.kind !== 'user') {
      calls.push(api.getRequestStatsTopUsers(period.value, {
        limit: 20,
        ...range,
        ...(filter.value?.kind === 'ip' ? { ip: filter.value.ip } : {}),
      }))
    } else {
      calls.push(Promise.resolve([]))
    }
    // Top IPs only when not already filtered to one IP
    if (filter.value?.kind !== 'ip') {
      calls.push(api.getRequestStatsTopIps(period.value, {
        limit: 20,
        ...range,
        ...(filter.value?.kind === 'user' ? { userId: filter.value.userId } : {}),
      }))
    } else {
      calls.push(Promise.resolve([]))
    }
    // Recent requests only when filtered
    if (filter.value) {
      calls.push(api.getRequestStatsRecentRequests(period.value, { ...opts, limit: 100 }))
    } else {
      calls.push(Promise.resolve([]))
    }
    // Top pages — uses userId filter when scoped to a user; IP filter not applicable
    calls.push(api.getRequestStatsTopPages(period.value, {
      limit: 20,
      ...range,
      ...(filter.value?.kind === 'user' ? { userId: filter.value.userId } : {}),
    }))
    // Recent pages — only when filtered to a specific user
    if (filter.value?.kind === 'user') {
      calls.push(api.getRequestStatsRecentPages(period.value, { userId: filter.value.userId, limit: 100, ...range }))
    } else {
      calls.push(Promise.resolve([]))
    }

    const [s, routes, sockets, ts, users, ips, recent, pages, recentPg] = await Promise.all(calls)
    summary.value = s
    topRoutes.value = routes
    socketEvents.value = sockets
    timeseries.value = ts
    topUsers.value = users
    topIps.value = ips
    recentRequests.value = recent
    topPages.value = pages
    recentPages.value = recentPg
  } catch (e) {
    console.error(e)
  } finally {
    loading.value = false
  }
}

function selectUser(u: UserRow) {
  if (!u.user_id) return
  filter.value = { kind: 'user', userId: u.user_id, label: u.name }
}

function selectIp(ip: IpRow) {
  filter.value = { kind: 'ip', ip: ip.ip, label: ip.ip }
}

function clearFilter() {
  filter.value = null
}

watch([period, filter], () => loadAll(), { deep: true })

onMounted(() => {
  loadAll()
  refreshTimer = setInterval(() => { if (autoRefresh.value) loadAll() }, 15_000)
})
onUnmounted(() => { if (refreshTimer) clearInterval(refreshTimer) })

const errorRatePct = computed(() => {
  const r = summary.value?.requests
  if (!r || !r.total) return 0
  const errors = (summary.value?.status_breakdown || [])
    .filter(s => s.klass >= 4)
    .reduce((sum, s) => sum + s.count, 0)
  return Math.round((errors / r.total) * 1000) / 10
})

function fmtBucketLabel(iso: string, bucket: string): string {
  const d = new Date(iso)
  if (bucket === 'minute') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (bucket === 'hour') return d.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit' })
  return d.toLocaleDateString([], { month: 'short', day: '2-digit' })
}

const lineChartData = computed(() => {
  const labels = timeseries.value.rows.map(r => fmtBucketLabel(r.bucket, timeseries.value.bucket))
  return {
    labels,
    datasets: [
      {
        label: t('statsRequests'),
        data: timeseries.value.rows.map(r => r.count),
        borderColor: 'rgb(99, 102, 241)',
        backgroundColor: 'rgba(99, 102, 241, 0.15)',
        tension: 0.3,
        fill: true,
        pointRadius: 2,
      },
      {
        label: t('statsErrors'),
        data: timeseries.value.rows.map(r => r.errors),
        borderColor: 'rgb(239, 68, 68)',
        backgroundColor: 'rgba(239, 68, 68, 0.15)',
        tension: 0.3,
        fill: true,
        pointRadius: 2,
      },
    ],
  }
})

const lineChartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { labels: { color: 'rgb(156, 163, 175)' } },
    tooltip: { mode: 'index' as const, intersect: false },
  },
  scales: {
    x: { ticks: { color: 'rgb(156, 163, 175)', maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }, grid: { color: 'rgba(156, 163, 175, 0.1)' } },
    y: { beginAtZero: true, ticks: { color: 'rgb(156, 163, 175)' }, grid: { color: 'rgba(156, 163, 175, 0.1)' } },
  },
  interaction: { mode: 'nearest' as const, axis: 'x' as const, intersect: false },
}))

const statusChartData = computed(() => {
  const buckets = [2, 3, 4, 5]
  const counts = buckets.map(k => summary.value?.status_breakdown.find(s => s.klass === k)?.count || 0)
  return {
    labels: buckets.map(k => `${k}xx`),
    datasets: [{
      label: t('statsRequests'),
      data: counts,
      backgroundColor: ['rgb(34, 197, 94)', 'rgb(59, 130, 246)', 'rgb(234, 179, 8)', 'rgb(239, 68, 68)'],
      borderRadius: 4,
    }],
  }
})

const barChartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { display: false } },
  scales: {
    x: { ticks: { color: 'rgb(156, 163, 175)' }, grid: { display: false } },
    y: { beginAtZero: true, ticks: { color: 'rgb(156, 163, 175)' }, grid: { color: 'rgba(156, 163, 175, 0.1)' } },
  },
}))

function methodBadge(m: string): string {
  switch (m) {
    case 'GET': return 'bg-blue-500/15 text-blue-400'
    case 'POST': return 'bg-green-500/15 text-green-400'
    case 'PUT': case 'PATCH': return 'bg-yellow-500/15 text-yellow-400'
    case 'DELETE': return 'bg-red-500/15 text-red-400'
    default: return 'bg-accent text-muted-foreground'
  }
}

function statusBadge(s: number): string {
  if (s >= 500) return 'text-red-400'
  if (s >= 400) return 'text-yellow-400'
  if (s >= 300) return 'text-blue-400'
  return 'text-green-400'
}
</script>

<template>
  <div class="p-6 flex flex-col gap-5 max-w-[1400px]">
    <!-- Header -->
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold text-foreground flex items-center gap-2">
          <BarChart3 class="w-5 h-5 text-primary" />
          {{ t('adminRequestStats') }}
        </h1>
        <p class="text-sm text-muted-foreground mt-1">{{ t('adminRequestStatsDesc') }}</p>
      </div>
      <div class="flex items-center gap-2 flex-wrap justify-end">
        <select v-model="period" class="input-field w-40">
          <option value="1h">{{ t('statsPeriod1h') }}</option>
          <option value="24h">{{ t('statsPeriod24h') }}</option>
          <option value="7d">{{ t('statsPeriod7d') }}</option>
          <option value="14d">{{ t('statsPeriod14d') }}</option>
          <option value="30d">{{ t('statsPeriod30d') }}</option>
          <option value="90d">{{ t('statsPeriod90d') }}</option>
          <option value="all">{{ t('statsPeriodAll') }}</option>
          <option value="custom">{{ t('statsPeriodCustom') }}</option>
        </select>
        <template v-if="period === 'custom'">
          <input
            v-model="customFrom"
            type="datetime-local"
            class="input-field text-xs w-44"
            :placeholder="t('statsFrom')"
            :title="t('statsFrom')"
          />
          <input
            v-model="customTo"
            type="datetime-local"
            class="input-field text-xs w-44"
            :placeholder="t('statsTo')"
            :title="t('statsTo')"
          />
          <button class="btn-secondary text-xs" :disabled="!customRangeReady || loading" @click="loadAll">
            {{ t('statsApply') }}
          </button>
        </template>
        <label class="text-xs text-muted-foreground flex items-center gap-1.5">
          <input v-model="autoRefresh" type="checkbox" /> {{ t('autoRefresh') }}
        </label>
        <button class="btn-secondary text-sm flex items-center gap-1.5" :disabled="loading" @click="loadAll">
          <RefreshCw class="w-4 h-4" :class="loading ? 'animate-spin' : ''" /> {{ t('refresh') }}
        </button>
      </div>
    </div>

    <!-- Filter chip -->
    <div v-if="filter" class="flex items-center gap-2 px-3 py-2 rounded-md bg-primary/10 border border-primary/30">
      <Filter class="w-4 h-4 text-primary shrink-0" />
      <span class="text-sm text-foreground">
        {{ filter.kind === 'user' ? t('statsFilteringUser') : t('statsFilteringIp') }}:
        <span class="font-semibold">{{ filter.label }}</span>
      </span>
      <button class="ml-auto p-1 rounded hover:bg-accent" :title="t('statsClearFilter')" @click="clearFilter">
        <X class="w-4 h-4" />
      </button>
    </div>

    <!-- Summary cards -->
    <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
      <div class="card px-4 py-3">
        <div class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t('statsTotal') }}</div>
        <div class="text-2xl font-bold tabular-nums mt-1">{{ summary?.requests.total.toLocaleString() ?? '—' }}</div>
      </div>
      <div class="card px-4 py-3">
        <div class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t('statsErrorRate') }}</div>
        <div class="text-2xl font-bold tabular-nums mt-1" :class="errorRatePct > 5 ? 'text-red-400' : ''">{{ errorRatePct }}%</div>
      </div>
      <div class="card px-4 py-3">
        <div class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t('statsAvgMs') }}</div>
        <div class="text-2xl font-bold tabular-nums mt-1">{{ summary?.requests.avg_ms ?? '—' }}<span class="text-sm text-muted-foreground">ms</span></div>
      </div>
      <div class="card px-4 py-3">
        <div class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t('statsP95Ms') }}</div>
        <div class="text-2xl font-bold tabular-nums mt-1">{{ summary?.requests.p95_ms ?? '—' }}<span class="text-sm text-muted-foreground">ms</span></div>
      </div>
      <div class="card px-4 py-3">
        <div class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t('statsUniqueUsers') }}</div>
        <div class="text-2xl font-bold tabular-nums mt-1">{{ summary?.requests.unique_users ?? '—' }}</div>
        <div class="text-[11px] text-muted-foreground mt-0.5">{{ summary?.requests.unique_ips ?? 0 }} {{ t('statsIps') }}</div>
      </div>
    </div>

    <!-- Charts row -->
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-3">
      <div class="card p-4 lg:col-span-2">
        <h3 class="text-sm font-semibold text-foreground mb-3">{{ t('statsRequestsOverTime') }}</h3>
        <div class="h-64">
          <Line :data="lineChartData" :options="lineChartOptions" />
        </div>
      </div>
      <div class="card p-4">
        <h3 class="text-sm font-semibold text-foreground mb-3">{{ t('statsStatusBreakdown') }}</h3>
        <div class="h-64">
          <Bar :data="statusChartData" :options="barChartOptions" />
        </div>
      </div>
    </div>

    <!-- Top routes -->
    <div class="card p-0 overflow-hidden">
      <div class="px-4 py-3 border-b border-border flex items-center gap-2">
        <h3 class="text-sm font-semibold text-foreground">{{ t('statsTopRoutes') }}</h3>
        <span class="text-xs text-muted-foreground">({{ topRoutes.length }})</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-surface text-[11px] font-semibold font-mono uppercase tracking-wider text-text-tertiary">
            <tr>
              <th class="text-left px-4 py-2.5 w-20">{{ t('statsMethod') }}</th>
              <th class="text-left px-4 py-2.5">{{ t('statsPath') }}</th>
              <th class="text-right px-4 py-2.5 w-24">{{ t('statsCount') }}</th>
              <th class="text-right px-4 py-2.5 w-24">{{ t('statsErrors') }}</th>
              <th class="text-right px-4 py-2.5 w-24">{{ t('statsAvg') }}</th>
              <th class="text-right px-4 py-2.5 w-24">{{ t('statsP95') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in topRoutes" :key="i" class="border-t border-border hover:bg-accent/30">
              <td class="px-4 py-2"><span class="px-1.5 py-0.5 rounded text-[11px] font-mono font-semibold" :class="methodBadge(r.method)">{{ r.method }}</span></td>
              <td class="px-4 py-2 font-mono text-xs text-foreground">{{ r.path }}</td>
              <td class="px-4 py-2 text-right tabular-nums">{{ r.count.toLocaleString() }}</td>
              <td class="px-4 py-2 text-right tabular-nums" :class="r.errors > 0 ? 'text-red-400' : 'text-muted-foreground'">{{ r.errors }}</td>
              <td class="px-4 py-2 text-right tabular-nums text-muted-foreground">{{ r.avg_ms }}ms</td>
              <td class="px-4 py-2 text-right tabular-nums text-muted-foreground">{{ r.p95_ms }}ms</td>
            </tr>
            <tr v-if="topRoutes.length === 0">
              <td colspan="6" class="px-4 py-6 text-center text-muted-foreground">{{ t('statsEmpty') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Top pages -->
    <div class="card p-0 overflow-hidden">
      <div class="px-4 py-3 border-b border-border flex items-center gap-2">
        <h3 class="text-sm font-semibold text-foreground">{{ t('statsTopPages') }}</h3>
        <span class="text-xs text-muted-foreground">({{ topPages.length }})</span>
        <span class="ml-auto text-[11px] text-muted-foreground">{{ t('statsTopPagesHint') }}</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-surface text-[11px] font-semibold font-mono uppercase tracking-wider text-text-tertiary">
            <tr>
              <th class="text-left px-4 py-2.5">{{ t('statsPagePath') }}</th>
              <th class="text-right px-4 py-2.5 w-24">{{ t('statsCount') }}</th>
              <th class="text-right px-4 py-2.5 w-32">{{ t('statsUniqueUsers') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(p, i) in topPages" :key="i" class="border-t border-border hover:bg-accent/30">
              <td class="px-4 py-2 font-mono text-xs text-foreground">{{ p.path }}</td>
              <td class="px-4 py-2 text-right tabular-nums">{{ p.count.toLocaleString() }}</td>
              <td class="px-4 py-2 text-right tabular-nums text-muted-foreground">{{ p.unique_users }}</td>
            </tr>
            <tr v-if="topPages.length === 0">
              <td colspan="3" class="px-4 py-6 text-center text-muted-foreground">{{ t('statsEmpty') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Top users + Top IPs -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
      <div v-if="filter?.kind !== 'user'" class="card p-0 overflow-hidden">
        <div class="px-4 py-3 border-b border-border flex items-center gap-2">
          <h3 class="text-sm font-semibold text-foreground">{{ t('statsTopUsers') }}</h3>
          <span class="text-xs text-muted-foreground">({{ topUsers.length }})</span>
          <span class="ml-auto text-[11px] text-muted-foreground">{{ t('statsClickToFilter') }}</span>
        </div>
        <table class="w-full text-sm">
          <thead class="bg-surface text-[11px] font-semibold font-mono uppercase tracking-wider text-text-tertiary">
            <tr>
              <th class="text-left px-4 py-2.5">{{ t('statsUser') }}</th>
              <th class="text-right px-4 py-2.5 w-20">{{ t('statsCount') }}</th>
              <th class="text-right px-4 py-2.5 w-20">{{ t('statsErrors') }}</th>
              <th class="text-right px-4 py-2.5 w-32">{{ t('statsLastSeen') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="u in topUsers"
              :key="u.user_id ?? -1"
              class="border-t border-border"
              :class="u.user_id ? 'hover:bg-accent/30 cursor-pointer' : ''"
              @click="u.user_id && selectUser(u)"
            >
              <td class="px-4 py-2 flex items-center gap-2">
                <img v-if="u.avatar_url" :src="u.avatar_url" class="w-5 h-5 rounded-full" />
                <span class="text-foreground">{{ u.name }}</span>
                <span v-if="!u.user_id" class="text-[10px] uppercase tracking-wider text-muted-foreground">{{ t('statsAnon') }}</span>
              </td>
              <td class="px-4 py-2 text-right tabular-nums">{{ u.count.toLocaleString() }}</td>
              <td class="px-4 py-2 text-right tabular-nums" :class="u.errors > 0 ? 'text-red-400' : 'text-muted-foreground'">{{ u.errors }}</td>
              <td class="px-4 py-2 text-right text-xs text-muted-foreground">{{ fmtDateTime(new Date(u.last_seen)) }}</td>
            </tr>
            <tr v-if="topUsers.length === 0">
              <td colspan="4" class="px-4 py-6 text-center text-muted-foreground">{{ t('statsEmpty') }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="filter?.kind !== 'ip'" class="card p-0 overflow-hidden">
        <div class="px-4 py-3 border-b border-border flex items-center gap-2">
          <h3 class="text-sm font-semibold text-foreground">{{ t('statsTopIps') }}</h3>
          <span class="text-xs text-muted-foreground">({{ topIps.length }})</span>
          <span class="ml-auto text-[11px] text-muted-foreground">{{ t('statsClickToFilter') }}</span>
        </div>
        <table class="w-full text-sm">
          <thead class="bg-surface text-[11px] font-semibold font-mono uppercase tracking-wider text-text-tertiary">
            <tr>
              <th class="text-left px-4 py-2.5">{{ t('statsIp') }}</th>
              <th class="text-right px-4 py-2.5 w-20">{{ t('statsCount') }}</th>
              <th class="text-right px-4 py-2.5 w-20">{{ t('statsUsers') }}</th>
              <th class="text-right px-4 py-2.5 w-20">{{ t('statsErrors') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="ip in topIps"
              :key="ip.ip"
              class="border-t border-border hover:bg-accent/30 cursor-pointer"
              @click="selectIp(ip)"
            >
              <td class="px-4 py-2 font-mono text-xs">{{ ip.ip }}</td>
              <td class="px-4 py-2 text-right tabular-nums">{{ ip.count.toLocaleString() }}</td>
              <td class="px-4 py-2 text-right tabular-nums text-muted-foreground">{{ ip.unique_users }}</td>
              <td class="px-4 py-2 text-right tabular-nums" :class="ip.errors > 0 ? 'text-red-400' : 'text-muted-foreground'">{{ ip.errors }}</td>
            </tr>
            <tr v-if="topIps.length === 0">
              <td colspan="4" class="px-4 py-6 text-center text-muted-foreground">{{ t('statsEmpty') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Recent requests (only when filtered) -->
    <div v-if="filter" class="card p-0 overflow-hidden">
      <div class="px-4 py-3 border-b border-border flex items-center gap-2">
        <h3 class="text-sm font-semibold text-foreground">{{ t('statsRecentRequests') }}</h3>
        <span class="text-xs text-muted-foreground">({{ recentRequests.length }})</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-surface text-[11px] font-semibold font-mono uppercase tracking-wider text-text-tertiary">
            <tr>
              <th class="text-left px-4 py-2.5 w-44">{{ t('statsTime') }}</th>
              <th class="text-left px-4 py-2.5 w-20">{{ t('statsMethod') }}</th>
              <th class="text-left px-4 py-2.5">{{ t('statsPath') }}</th>
              <th class="text-right px-4 py-2.5 w-20">{{ t('statsStatus') }}</th>
              <th class="text-right px-4 py-2.5 w-20">{{ t('statsMs') }}</th>
              <th class="text-left px-4 py-2.5 w-32">{{ filter.kind === 'user' ? t('statsIp') : t('statsUser') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in recentRequests" :key="i" class="border-t border-border hover:bg-accent/30">
              <td class="px-4 py-2 text-xs text-muted-foreground">{{ fmtDateTime(new Date(r.ts)) }}</td>
              <td class="px-4 py-2"><span class="px-1.5 py-0.5 rounded text-[11px] font-mono font-semibold" :class="methodBadge(r.method)">{{ r.method }}</span></td>
              <td class="px-4 py-2 font-mono text-xs text-foreground truncate max-w-[400px]">{{ r.path }}</td>
              <td class="px-4 py-2 text-right tabular-nums font-semibold" :class="statusBadge(r.status)">{{ r.status }}</td>
              <td class="px-4 py-2 text-right tabular-nums text-muted-foreground">{{ r.duration_ms }}</td>
              <td class="px-4 py-2 text-xs text-muted-foreground truncate">
                {{ filter.kind === 'user' ? (r.ip || '—') : (r.user_name || '(anon)') }}
              </td>
            </tr>
            <tr v-if="recentRequests.length === 0">
              <td colspan="6" class="px-4 py-6 text-center text-muted-foreground">{{ t('statsEmpty') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Recent pages (only when filtered to a user) -->
    <div v-if="filter?.kind === 'user'" class="card p-0 overflow-hidden">
      <div class="px-4 py-3 border-b border-border flex items-center gap-2">
        <h3 class="text-sm font-semibold text-foreground">{{ t('statsRecentPages') }}</h3>
        <span class="text-xs text-muted-foreground">({{ recentPages.length }})</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-surface text-[11px] font-semibold font-mono uppercase tracking-wider text-text-tertiary">
            <tr>
              <th class="text-left px-4 py-2.5 w-44">{{ t('statsTime') }}</th>
              <th class="text-left px-4 py-2.5">{{ t('statsPagePath') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(p, i) in recentPages" :key="i" class="border-t border-border hover:bg-accent/30">
              <td class="px-4 py-2 text-xs text-muted-foreground">{{ fmtDateTime(new Date(p.ts)) }}</td>
              <td class="px-4 py-2 font-mono text-xs text-foreground truncate max-w-[600px]">{{ p.path }}</td>
            </tr>
            <tr v-if="recentPages.length === 0">
              <td colspan="2" class="px-4 py-6 text-center text-muted-foreground">{{ t('statsEmpty') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Socket events -->
    <div class="card p-0 overflow-hidden">
      <div class="px-4 py-3 border-b border-border flex items-center gap-2">
        <Activity class="w-4 h-4 text-primary" />
        <h3 class="text-sm font-semibold text-foreground">{{ t('statsSocketEvents') }}</h3>
        <span class="text-xs text-muted-foreground">({{ socketEvents.length }})</span>
        <span class="ml-auto text-xs text-muted-foreground">{{ summary?.socket.total.toLocaleString() ?? 0 }} {{ t('statsTotal').toLowerCase() }}</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-surface text-[11px] font-semibold font-mono uppercase tracking-wider text-text-tertiary">
            <tr>
              <th class="text-left px-4 py-2.5">{{ t('statsEvent') }}</th>
              <th class="text-right px-4 py-2.5 w-32">{{ t('statsCount') }}</th>
              <th class="text-right px-4 py-2.5 w-32">{{ t('statsUniqueUsers') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="ev in socketEvents" :key="ev.event" class="border-t border-border hover:bg-accent/30">
              <td class="px-4 py-2 font-mono text-xs">{{ ev.event }}</td>
              <td class="px-4 py-2 text-right tabular-nums">{{ ev.count.toLocaleString() }}</td>
              <td class="px-4 py-2 text-right tabular-nums text-muted-foreground">{{ ev.unique_users }}</td>
            </tr>
            <tr v-if="socketEvents.length === 0">
              <td colspan="3" class="px-4 py-6 text-center text-muted-foreground">{{ t('statsEmpty') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
