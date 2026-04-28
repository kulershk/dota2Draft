<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Network, RefreshCw, AlertTriangle, ExternalLink, Search } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import { fmtDateTime } from '@/utils/format'

interface OtherUserOnIp {
  user_id: number
  name: string
  avatar_url: string | null
  request_count: number
}
interface UserIp {
  ip: string
  request_count: number
  first_seen: string
  last_seen: string
  other_users: OtherUserOnIp[]
}
interface LinkedUser {
  user_id: number
  name: string
  avatar_url: string | null
  steam_id: string | null
  is_banned: boolean
  mmr: number
  shared_request_count: number
  shared_ip_count: number
  shared_ips: string[]
  last_seen: string
}
interface Inspection {
  user: { id: number; name: string; avatar_url: string | null; steam_id: string | null; is_banned: boolean; mmr: number }
  days: number
  user_ips: UserIp[]
  linked_users: LinkedUser[]
}

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const api = useApi()

const userId = computed(() => Number(route.params.id))
const days = ref<7 | 30 | 90 | 365>(30)
const data = ref<Inspection | null>(null)
const loading = ref(false)

async function load() {
  if (!Number.isFinite(userId.value)) return
  loading.value = true
  try {
    data.value = await api.getMultiAccountInspection(userId.value, { days: days.value, limit: 50 })
  } catch (e) {
    console.error(e)
    data.value = null
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch([userId, days], load)

// Suspicion score: simple heuristic — number of linked accounts that share
// 2+ IPs scaled with shared request volume. Capped at 100.
const suspicionScore = computed(() => {
  if (!data.value) return 0
  const strongLinks = data.value.linked_users.filter(u => u.shared_ip_count >= 2).length
  const totalShared = data.value.linked_users.reduce((s, u) => s + u.shared_request_count, 0)
  const score = Math.min(100, strongLinks * 25 + Math.min(50, totalShared / 100))
  return Math.round(score)
})

const suspicionLevel = computed<'low' | 'medium' | 'high'>(() => {
  const s = suspicionScore.value
  if (s >= 60) return 'high'
  if (s >= 30) return 'medium'
  return 'low'
})

// SVG web diagram — top 5 IPs and top 8 linked users.
const diagramIps = computed(() => (data.value?.user_ips || []).slice(0, 5))
const diagramLinks = computed(() => (data.value?.linked_users || []).slice(0, 8))

const W = 800
const H = 460
const userPos = { x: 80, y: H / 2 }
const ipColX = 380
const linkColX = 720

function ipPos(i: number, total: number) {
  if (total === 1) return { x: ipColX, y: H / 2 }
  const usable = H - 80
  return { x: ipColX, y: 40 + (i / (total - 1)) * usable }
}
function linkPos(i: number, total: number) {
  if (total === 1) return { x: linkColX, y: H / 2 }
  const usable = H - 80
  return { x: linkColX, y: 40 + (i / (total - 1)) * usable }
}

// Maximum request count, used to scale line widths.
const maxRequestCount = computed(() => {
  let m = 1
  for (const ip of diagramIps.value) m = Math.max(m, ip.request_count)
  return m
})

function lineWidth(count: number, max: number): number {
  return 1 + (count / max) * 4 // 1-5 px
}

function bezier(from: { x: number; y: number }, to: { x: number; y: number }) {
  const cx1 = from.x + (to.x - from.x) * 0.5
  const cx2 = to.x - (to.x - from.x) * 0.5
  return `M ${from.x} ${from.y} C ${cx1} ${from.y}, ${cx2} ${to.y}, ${to.x} ${to.y}`
}

// For each IP, find which linked-user diagram nodes touch it (so we draw
// IP -> linkedUser edges).
function indexOfLinkUser(uid: number): number {
  return diagramLinks.value.findIndex(l => l.user_id === uid)
}

function inspect(uid: number) {
  router.push({ name: 'admin-multi-account', params: { id: uid } })
}
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[var(--admin-content-max,1400px)] w-full">
    <!-- Header -->
    <div class="flex items-start justify-between gap-4 flex-wrap">
      <div>
        <h1 class="text-2xl font-semibold text-foreground flex items-center gap-2">
          <Network class="w-5 h-5 text-primary" />
          {{ t('multiAccountTitle') }}
        </h1>
        <p class="text-sm text-muted-foreground mt-1">{{ t('multiAccountDesc') }}</p>
      </div>
      <div class="flex items-center gap-2">
        <select v-model.number="days" class="input-field w-32">
          <option :value="7">{{ t('statsPeriod7d') }}</option>
          <option :value="30">{{ t('statsPeriod30d') }}</option>
          <option :value="90">{{ t('statsPeriod90d') }}</option>
          <option :value="365">{{ t('multiAccount365d') }}</option>
        </select>
        <button class="btn-secondary text-sm flex items-center gap-1.5" :disabled="loading" @click="load">
          <RefreshCw class="w-4 h-4" :class="loading ? 'animate-spin' : ''" /> {{ t('refresh') }}
        </button>
      </div>
    </div>

    <div v-if="loading && !data" class="card p-6 text-center text-muted-foreground">{{ t('loading') }}</div>
    <div v-else-if="!data" class="card p-6 text-center text-muted-foreground">{{ t('multiAccountNoData') }}</div>

    <template v-else>
      <!-- Target user + summary -->
      <div class="card p-4 flex items-center gap-4">
        <div class="w-14 h-14 rounded-full overflow-hidden bg-muted shrink-0 flex items-center justify-center">
          <img v-if="data.user.avatar_url" :src="data.user.avatar_url" class="w-full h-full object-cover" />
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-lg font-semibold text-foreground">{{ data.user.name }}</span>
            <span v-if="data.user.is_banned" class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-500/15 text-red-400 uppercase">{{ t('banned') }}</span>
          </div>
          <div class="text-xs text-muted-foreground mt-0.5">
            ID {{ data.user.id }} · {{ data.user.mmr }} MMR
            <a v-if="data.user.steam_id" :href="`https://steamcommunity.com/profiles/${data.user.steam_id}`" target="_blank" rel="noopener" class="ml-2 inline-flex items-center gap-0.5 hover:text-primary">Steam <ExternalLink class="w-3 h-3" /></a>
          </div>
        </div>
      </div>

      <!-- Stat cards -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div class="card px-4 py-3">
          <div class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t('multiAccountIpsUsed') }}</div>
          <div class="text-2xl font-bold tabular-nums mt-1">{{ data.user_ips.length }}</div>
        </div>
        <div class="card px-4 py-3">
          <div class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t('multiAccountLinkedAccounts') }}</div>
          <div class="text-2xl font-bold tabular-nums mt-1">{{ data.linked_users.length }}</div>
        </div>
        <div class="card px-4 py-3">
          <div class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t('multiAccountTopSharedIp') }}</div>
          <div class="text-sm font-mono font-bold mt-1 truncate" :title="data.user_ips[0]?.ip">{{ data.user_ips[0]?.ip || '—' }}</div>
          <div v-if="data.user_ips[0]" class="text-[11px] text-muted-foreground mt-0.5">{{ data.user_ips[0].other_users.length }} {{ t('multiAccountSharedWith') }}</div>
        </div>
        <div class="card px-4 py-3" :class="suspicionLevel === 'high' ? 'border-red-500/40' : suspicionLevel === 'medium' ? 'border-amber-500/40' : ''">
          <div class="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
            <AlertTriangle v-if="suspicionLevel === 'high'" class="w-3 h-3 text-red-400" />
            <AlertTriangle v-else-if="suspicionLevel === 'medium'" class="w-3 h-3 text-amber-400" />
            {{ t('multiAccountSuspicion') }}
          </div>
          <div class="text-2xl font-bold tabular-nums mt-1" :class="suspicionLevel === 'high' ? 'text-red-400' : suspicionLevel === 'medium' ? 'text-amber-400' : ''">{{ suspicionScore }}</div>
          <div class="text-[11px] text-muted-foreground mt-0.5">{{ t(`multiAccountSuspicion_${suspicionLevel}`) }}</div>
        </div>
      </div>

      <!-- SVG web diagram -->
      <div v-if="data.user_ips.length > 0 && data.linked_users.length > 0" class="card p-4 overflow-x-auto">
        <h3 class="text-sm font-semibold text-foreground mb-3">{{ t('multiAccountWeb') }}</h3>
        <svg :viewBox="`0 0 ${W} ${H}`" class="w-full max-w-full" :style="{ minWidth: '800px', height: H + 'px' }">
          <!-- Lines: user -> ip -->
          <path
            v-for="(ip, i) in diagramIps" :key="`u-ip-${i}`"
            :d="bezier(userPos, ipPos(i, diagramIps.length))"
            :stroke-width="lineWidth(ip.request_count, maxRequestCount)"
            stroke="rgb(99, 102, 241)" stroke-opacity="0.5" fill="none"
          />
          <!-- Lines: ip -> linked user -->
          <template v-for="(ip, i) in diagramIps" :key="`ip-lines-${i}`">
            <template v-for="(other) in ip.other_users" :key="`ip-${i}-${other.user_id}`">
              <path
                v-if="indexOfLinkUser(other.user_id) >= 0"
                :d="bezier(ipPos(i, diagramIps.length), linkPos(indexOfLinkUser(other.user_id), diagramLinks.length))"
                :stroke-width="lineWidth(other.request_count, maxRequestCount)"
                stroke="rgb(239, 68, 68)" stroke-opacity="0.4" fill="none"
              />
            </template>
          </template>

          <!-- Center user node -->
          <g :transform="`translate(${userPos.x}, ${userPos.y})`">
            <circle r="32" fill="rgb(99, 102, 241)" fill-opacity="0.2" stroke="rgb(99, 102, 241)" stroke-width="2" />
            <text text-anchor="middle" dy="-46" class="fill-foreground text-[11px] font-semibold">{{ data.user.name }}</text>
            <text text-anchor="middle" dy="6" class="fill-foreground text-[10px] font-mono">#{{ data.user.id }}</text>
          </g>

          <!-- IP nodes -->
          <g v-for="(ip, i) in diagramIps" :key="`ip-node-${i}`" :transform="`translate(${ipPos(i, diagramIps.length).x}, ${ipPos(i, diagramIps.length).y})`">
            <rect x="-90" y="-18" width="180" height="36" rx="8" fill="rgb(15, 23, 42)" stroke="rgb(71, 85, 105)" />
            <text text-anchor="middle" dy="-2" class="fill-foreground text-[10px] font-mono">{{ ip.ip.length > 22 ? ip.ip.slice(0, 19) + '…' : ip.ip }}</text>
            <text text-anchor="middle" dy="12" class="fill-muted-foreground text-[10px]">{{ ip.request_count }} req · {{ ip.other_users.length }} other(s)</text>
          </g>

          <!-- Linked user nodes -->
          <g
            v-for="(lu, i) in diagramLinks" :key="`link-node-${i}`"
            :transform="`translate(${linkPos(i, diagramLinks.length).x}, ${linkPos(i, diagramLinks.length).y})`"
            class="cursor-pointer"
            @click="inspect(lu.user_id)"
          >
            <circle r="22" :fill="lu.is_banned ? 'rgb(239, 68, 68)' : 'rgb(34, 197, 94)'" fill-opacity="0.18" :stroke="lu.is_banned ? 'rgb(239, 68, 68)' : 'rgb(34, 197, 94)'" stroke-width="1.5" />
            <text text-anchor="middle" dy="-30" class="fill-foreground text-[10px] font-semibold">{{ lu.name.length > 18 ? lu.name.slice(0, 15) + '…' : lu.name }}</text>
            <text text-anchor="middle" dy="4" class="fill-foreground text-[10px] font-mono">{{ lu.shared_ip_count }}🔗</text>
          </g>
        </svg>
        <p class="text-[11px] text-muted-foreground mt-2">{{ t('multiAccountWebHint') }}</p>
      </div>

      <!-- Linked accounts table -->
      <div class="card p-0 overflow-hidden">
        <div class="px-4 py-3 border-b border-border flex items-center gap-2">
          <h3 class="text-sm font-semibold text-foreground">{{ t('multiAccountLinkedAccounts') }}</h3>
          <span class="text-xs text-muted-foreground">({{ data.linked_users.length }})</span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-surface text-[11px] font-semibold font-mono uppercase tracking-wider text-text-tertiary">
              <tr>
                <th class="text-left px-4 py-2.5">{{ t('statsUser') }}</th>
                <th class="text-left px-4 py-2.5">{{ t('multiAccountSharedIps') }}</th>
                <th class="text-right px-4 py-2.5 w-24">{{ t('multiAccountSharedReqs') }}</th>
                <th class="text-right px-4 py-2.5 w-32">{{ t('statsLastSeen') }}</th>
                <th class="text-right px-4 py-2.5 w-24"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="lu in data.linked_users" :key="lu.user_id" class="border-t border-border hover:bg-accent/30">
                <td class="px-4 py-2 flex items-center gap-2">
                  <img v-if="lu.avatar_url" :src="lu.avatar_url" class="w-6 h-6 rounded-full" />
                  <div class="flex flex-col">
                    <span class="text-foreground font-medium">{{ lu.name }}</span>
                    <span class="text-[11px] text-muted-foreground">ID {{ lu.user_id }} · {{ lu.mmr }} MMR</span>
                  </div>
                  <span v-if="lu.is_banned" class="px-1.5 py-0 rounded text-[9px] font-bold bg-red-500/15 text-red-400 uppercase ml-1">{{ t('banned') }}</span>
                </td>
                <td class="px-4 py-2">
                  <div class="flex flex-wrap gap-1">
                    <span v-for="ip in lu.shared_ips" :key="ip" class="px-1.5 py-0.5 rounded font-mono text-[10px] bg-muted/50 text-muted-foreground">{{ ip }}</span>
                  </div>
                  <span class="text-[11px] text-muted-foreground mt-0.5 inline-block">{{ lu.shared_ip_count }} {{ t('multiAccountSharedIpCount') }}</span>
                </td>
                <td class="px-4 py-2 text-right tabular-nums">{{ lu.shared_request_count.toLocaleString() }}</td>
                <td class="px-4 py-2 text-right text-xs text-muted-foreground">{{ fmtDateTime(new Date(lu.last_seen)) }}</td>
                <td class="px-4 py-2 text-right">
                  <button class="btn-ghost text-xs flex items-center gap-1 ml-auto" :title="t('multiAccountInspect')" @click="inspect(lu.user_id)">
                    <Search class="w-3.5 h-3.5" /> {{ t('multiAccountInspect') }}
                  </button>
                </td>
              </tr>
              <tr v-if="data.linked_users.length === 0">
                <td colspan="5" class="px-4 py-6 text-center text-muted-foreground">{{ t('multiAccountNoLinks') }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- All IPs table -->
      <div class="card p-0 overflow-hidden">
        <div class="px-4 py-3 border-b border-border flex items-center gap-2">
          <h3 class="text-sm font-semibold text-foreground">{{ t('multiAccountAllIps') }}</h3>
          <span class="text-xs text-muted-foreground">({{ data.user_ips.length }})</span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-surface text-[11px] font-semibold font-mono uppercase tracking-wider text-text-tertiary">
              <tr>
                <th class="text-left px-4 py-2.5">{{ t('statsIp') }}</th>
                <th class="text-right px-4 py-2.5 w-24">{{ t('statsRequests') }}</th>
                <th class="text-left px-4 py-2.5">{{ t('multiAccountAlsoUsedBy') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="ip in data.user_ips" :key="ip.ip" class="border-t border-border hover:bg-accent/30 align-top">
                <td class="px-4 py-2 font-mono text-xs">{{ ip.ip }}</td>
                <td class="px-4 py-2 text-right tabular-nums">{{ ip.request_count.toLocaleString() }}</td>
                <td class="px-4 py-2">
                  <div class="flex flex-wrap gap-1.5">
                    <button
                      v-for="other in ip.other_users" :key="other.user_id"
                      class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted/50 hover:bg-accent text-[11px] transition-colors"
                      :title="`${other.request_count} req`"
                      @click="inspect(other.user_id)"
                    >
                      <img v-if="other.avatar_url" :src="other.avatar_url" class="w-4 h-4 rounded-full" />
                      <span>{{ other.name }}</span>
                      <span class="text-muted-foreground">· {{ other.request_count }}</span>
                    </button>
                    <span v-if="ip.other_users.length === 0" class="text-[11px] text-muted-foreground italic">{{ t('multiAccountNoOthers') }}</span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>
