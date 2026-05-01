<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { Radio, Clock } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import { useDotaConstants } from '@/composables/useDotaConstants'
import { getSocket } from '@/composables/useSocket'

interface LivePlayer {
  account_id: number | null
  team: 'radiant' | 'dire'
  hero_id: number
  level: number
  kills: number
  deaths: number
  assists: number
  last_hits: number
  denies: number
  net_worth: number
  gold: number
  items: number[]
}
interface LiveSnapshot {
  radiant_score: number | null
  dire_score: number | null
  game_time: number | null
  game_state: number | null
  players: LivePlayer[]
  updated_at: number
}

interface RosterPlayer {
  // Either steamId (queue path) or steam_id (tournament path) — accept both.
  steamId?: string | null
  steam_id?: string | null
  // Display name
  name?: string
}

const props = defineProps<{
  // matches.id — the canonical key the live poller uses.
  matchId: number
  // Display rosters for each team. account_id ↔ steamId mapping is done locally.
  team1Players: RosterPlayer[]
  team2Players: RosterPlayer[]
  // Optional team labels — fallback to "Radiant" / "Dire" when missing.
  team1Name?: string
  team2Name?: string
}>()

const { t } = useI18n()
const api = useApi()
const dota = useDotaConstants()
dota.loadConstants()

const live = ref<LiveSnapshot | null>(null)
const now = ref(Date.now())
let nowTicker: ReturnType<typeof setInterval> | null = null

const liveStale = computed(() => {
  if (!live.value) return true
  return now.value - live.value.updated_at > 30_000
})

const liveByAccountId = computed<Record<number, LivePlayer>>(() => {
  const map: Record<number, LivePlayer> = {}
  for (const p of (live.value?.players || [])) {
    if (p.account_id) map[p.account_id] = p
  }
  return map
})

function liveForRosterPlayer(rosterPlayer: any): LivePlayer | null {
  const steamId64 = rosterPlayer?.steamId || rosterPlayer?.steam_id
  if (!steamId64) return null
  // SteamID64 base offset = 76561197960265728. Use BigInt to avoid Number
  // precision loss past 2^53.
  try {
    const accountId = Number(BigInt(steamId64) - 76561197960265728n)
    if (!Number.isFinite(accountId) || accountId <= 0) return null
    return liveByAccountId.value[accountId] || null
  } catch {
    return null
  }
}

function fmtGameTime(seconds: number | null): string {
  if (seconds == null) return '--:--'
  const negative = seconds < 0
  const s = Math.abs(seconds)
  const m = Math.floor(s / 60)
  const ss = s % 60
  const out = `${m}:${ss.toString().padStart(2, '0')}`
  return negative ? `-${out}` : out
}

function gameStateLabel(state: number | null): string {
  switch (state) {
    case 1: return t('liveStateInit')
    case 2: return t('liveStateWaitForPlayers')
    case 3: return t('liveStateHeroSelection')
    case 4: return t('liveStateStrategyTime')
    case 5: return t('liveStatePlaying')
    case 6: return t('liveStatePostGame')
    default: return ''
  }
}

function onLiveStats(payload: any) {
  if (!payload) return
  if (Number(payload.matchId) !== props.matchId) return
  // Strip routing fields, keep snapshot fields.
  const { matchId: _m, queueMatchId: _qmid, ...snap } = payload
  live.value = snap as LiveSnapshot
  now.value = Date.now()
}

// Server signals the poller stopped (game ended, server restart, bootstrap
// gave up) — clear the banner instead of letting it sit and fade to "Stale".
function onLiveStatsEnd(payload: any) {
  if (!payload) return
  if (Number(payload.matchId) !== props.matchId) return
  live.value = null
}

// On every (re)connect, refetch the snapshot. After a server deploy or
// network blip, the in-memory snapshot can be 30s+ stale before the next
// broadcast arrives — refetching closes that window. Skip the very first
// connect since onMounted already fetches.
let connectsSeen = 0
async function onConnect() {
  connectsSeen++
  if (connectsSeen <= 1) return
  try {
    const snap = await api.getMatchLive(props.matchId)
    live.value = snap || null
    now.value = Date.now()
  } catch { /* still polling will fix it on next tick */ }
}

onMounted(async () => {
  // Initial fetch so refresh / late-join doesn't go blank for ~12s.
  try {
    const snap = await api.getMatchLive(props.matchId)
    if (snap) live.value = snap
  } catch { /* not running yet — broadcasts will fill in */ }

  const sock = getSocket()
  sock?.on('home:liveStats', onLiveStats)
  sock?.on('home:liveStatsEnd', onLiveStatsEnd)
  sock?.on('connect', onConnect)
  // Count an existing-connected socket as the "first" connect so future
  // reconnects do trigger a refetch.
  if (sock?.connected) connectsSeen = 1
  nowTicker = setInterval(() => { now.value = Date.now() }, 1000)
})

onBeforeUnmount(() => {
  const sock = getSocket()
  sock?.off('home:liveStats', onLiveStats)
  sock?.off('home:liveStatsEnd', onLiveStatsEnd)
  sock?.off('connect', onConnect)
  if (nowTicker) clearInterval(nowTicker)
})
</script>

<template>
  <div v-if="live" class="card overflow-hidden mb-5 transition-opacity" :class="liveStale ? 'opacity-60' : 'opacity-100'">
    <div class="px-5 py-3 flex items-center gap-3 border-b border-border/30 bg-gradient-to-r from-red-500/10 via-transparent to-transparent">
      <span class="flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
            :class="liveStale ? 'bg-muted/40 text-muted-foreground' : 'bg-red-500/15 text-red-400'">
        <Radio class="w-3 h-3" :class="!liveStale && 'animate-pulse'" />
        {{ liveStale ? t('liveStale') : t('matchLive') }}
      </span>
      <span v-if="gameStateLabel(live.game_state)" class="text-xs text-muted-foreground">{{ gameStateLabel(live.game_state) }}</span>
      <span class="ml-auto flex items-center gap-1 font-mono text-sm tabular-nums">
        <Clock class="w-3.5 h-3.5 text-muted-foreground" />
        {{ fmtGameTime(live.game_time) }}
      </span>
    </div>
    <div class="px-5 py-4 flex items-center justify-center gap-6">
      <div class="text-right">
        <div class="text-[10px] uppercase tracking-wider font-bold text-green-400">{{ team1Name || t('queueRadiant') }}</div>
        <div class="text-3xl font-bold tabular-nums leading-none mt-1">{{ live.radiant_score ?? '–' }}</div>
      </div>
      <div class="text-xs text-muted-foreground/40 font-bold">VS</div>
      <div class="text-left">
        <div class="text-[10px] uppercase tracking-wider font-bold text-red-400">{{ team2Name || t('queueDire') }}</div>
        <div class="text-3xl font-bold tabular-nums leading-none mt-1">{{ live.dire_score ?? '–' }}</div>
      </div>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border/30 border-t border-border/30">
      <div class="flex flex-col">
        <div v-for="p in team1Players" :key="`r-${p.steamId || p.steam_id}-${p.name}`"
          class="flex items-center gap-2.5 px-4 py-2 hover:bg-accent/20 transition-colors">
          <img v-if="liveForRosterPlayer(p) && dota.heroImg(liveForRosterPlayer(p)!.hero_id)"
            :src="dota.heroImg(liveForRosterPlayer(p)!.hero_id)"
            class="w-10 h-6 rounded object-cover shrink-0"
            :title="dota.heroName(liveForRosterPlayer(p)!.hero_id)" />
          <div v-else class="w-10 h-6 rounded bg-muted/40 shrink-0" />
          <span class="text-xs font-medium truncate flex-1 min-w-0">{{ p.name }}</span>
          <span v-if="liveForRosterPlayer(p)" class="text-[10px] tabular-nums text-amber-400 font-semibold">
            {{ liveForRosterPlayer(p)!.level }}
          </span>
          <span v-if="liveForRosterPlayer(p)" class="text-[11px] tabular-nums font-mono">
            {{ liveForRosterPlayer(p)!.kills }}/{{ liveForRosterPlayer(p)!.deaths }}/{{ liveForRosterPlayer(p)!.assists }}
          </span>
          <span v-if="liveForRosterPlayer(p)" class="text-[10px] tabular-nums text-muted-foreground w-12 text-right">
            {{ Math.round(liveForRosterPlayer(p)!.net_worth / 100) / 10 }}k
          </span>
        </div>
      </div>
      <div class="flex flex-col">
        <div v-for="p in team2Players" :key="`d-${p.steamId || p.steam_id}-${p.name}`"
          class="flex items-center gap-2.5 px-4 py-2 hover:bg-accent/20 transition-colors">
          <img v-if="liveForRosterPlayer(p) && dota.heroImg(liveForRosterPlayer(p)!.hero_id)"
            :src="dota.heroImg(liveForRosterPlayer(p)!.hero_id)"
            class="w-10 h-6 rounded object-cover shrink-0"
            :title="dota.heroName(liveForRosterPlayer(p)!.hero_id)" />
          <div v-else class="w-10 h-6 rounded bg-muted/40 shrink-0" />
          <span class="text-xs font-medium truncate flex-1 min-w-0">{{ p.name }}</span>
          <span v-if="liveForRosterPlayer(p)" class="text-[10px] tabular-nums text-amber-400 font-semibold">
            {{ liveForRosterPlayer(p)!.level }}
          </span>
          <span v-if="liveForRosterPlayer(p)" class="text-[11px] tabular-nums font-mono">
            {{ liveForRosterPlayer(p)!.kills }}/{{ liveForRosterPlayer(p)!.deaths }}/{{ liveForRosterPlayer(p)!.assists }}
          </span>
          <span v-if="liveForRosterPlayer(p)" class="text-[10px] tabular-nums text-muted-foreground w-12 text-right">
            {{ Math.round(liveForRosterPlayer(p)!.net_worth / 100) / 10 }}k
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
