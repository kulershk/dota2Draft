<script setup lang="ts">
import { BarChart3, RefreshCw, Activity } from 'lucide-vue-next'
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

type Period = '1h' | '24h' | '7d' | '14d'
const period = ref<Period>('24h')
const autoRefresh = ref(true)
const loading = ref(false)

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

const summary = ref<Summary | null>(null)
const topRoutes = ref<RouteRow[]>([])
const topUsers = ref<UserRow[]>([])
const topIps = ref<IpRow[]>([])
const socketEvents = ref<SocketRow[]>([])
const timeseries = ref<{ bucket: string; rows: TimeseriesRow[] }>({ bucket: 'hour', rows: [] })

let refreshTimer: ReturnType<typeof setInterval> | null = null

async function loadAll() {
  loading.value = true
  try {
    const [s, routes, users, ips, sockets, ts] = await Promise.all([
      api.getRequestStatsSummary(period.value),
      api.getRequestStatsTopRoutes(period.value, 20),
      api.getRequestStatsTopUsers(period.value, 20),
      api.getRequestStatsTopIps(period.value, 20),
      api.getSocketEventStats(period.value, 50),
      api.getRequestStatsTimeseries(period.value),
    ])
    summary.value = s
    topRoutes.value = routes
    topUsers.value = users
    topIps.value = ips
    socketEvents.value = sockets
    timeseries.value = ts
  } catch (e) {
    console.error(e)
  } finally {
    loading.value = false
  }
}

watch(period, () => loadAll())

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
      <div class="flex items-center gap-2">
        <select v-model="period" class="input-field w-32">
          <option value="1h">{{ t('statsPeriod1h') }}</option>
          <option value="24h">{{ t('statsPeriod24h') }}</option>
          <option value="7d">{{ t('statsPeriod7d') }}</option>
          <option value="14d">{{ t('statsPeriod14d') }}</option>
        </select>
        <label class="text-xs text-muted-foreground flex items-center gap-1.5">
          <input v-model="autoRefresh" type="checkbox" /> {{ t('autoRefresh') }}
        </label>
        <button class="btn-secondary text-sm flex items-center gap-1.5" :disabled="loading" @click="loadAll">
          <RefreshCw class="w-4 h-4" :class="loading ? 'animate-spin' : ''" /> {{ t('refresh') }}
        </button>
      </div>
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

    <!-- Top users + Top IPs -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
      <div class="card p-0 overflow-hidden">
        <div class="px-4 py-3 border-b border-border flex items-center gap-2">
          <h3 class="text-sm font-semibold text-foreground">{{ t('statsTopUsers') }}</h3>
          <span class="text-xs text-muted-foreground">({{ topUsers.length }})</span>
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
            <tr v-for="u in topUsers" :key="u.user_id ?? -1" class="border-t border-border hover:bg-accent/30">
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

      <div class="card p-0 overflow-hidden">
        <div class="px-4 py-3 border-b border-border flex items-center gap-2">
          <h3 class="text-sm font-semibold text-foreground">{{ t('statsTopIps') }}</h3>
          <span class="text-xs text-muted-foreground">({{ topIps.length }})</span>
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
            <tr v-for="ip in topIps" :key="ip.ip" class="border-t border-border hover:bg-accent/30">
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
