<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Medal, Trophy, ChevronLeft, ChevronDown, ChevronRight, BadgeCheck } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import { getSocket } from '@/composables/useSocket'

interface Season {
  id: number
  name: string
  slug: string
  description: string | null
  starts_at: string | null
  ends_at: string | null
  is_active: boolean
  settings: Record<string, any>
  player_count: number
  match_count: number
}

interface LeaderGroupRef {
  group_id: number
  name: string
  border_color: string
  captains_drawn_from: boolean
}
interface LeaderRow {
  player_id: number
  display_name: string
  name: string
  avatar_url: string | null
  mmr: number
  mmr_verified_at: string | null
  groups: LeaderGroupRef[]
  points: number
  peak_points: number
  games_played: number
  wins: number
  losses: number
  current_winstreak: number
  last_match_at: string | null
}

interface FridayPlayer {
  player_id: number
  display_name: string
  name: string
  avatar_url: string | null
  mmr: number
  mmr_verified_at: string | null
  net_points: number
  games: number
  wins: number
  losses: number
  place: number | null
  bonus: number
}
interface FridayDay {
  date: string
  players: FridayPlayer[]
}

const { t } = useI18n()
const route = useRoute()
const api = useApi()

const slug = computed(() => String(route.params.slug || ''))

const season = ref<Season | null>(null)
const rows = ref<LeaderRow[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

// Fridays tab — only shown when the season has an inhouse-enabled pool.
const tab = ref<'overall' | 'fridays'>('overall')
const fridaysEnabled = ref(false)
const fridays = ref<FridayDay[]>([])
const expandedDates = ref<Set<string>>(new Set())
const showAllDates = ref<Set<string>>(new Set())

async function load() {
  loading.value = true
  error.value = null
  try {
    const [s, rs, fr] = await Promise.all([
      api.getPublicSeason(slug.value),
      api.getSeasonLeaderboard(slug.value, { limit: 200 }),
      // A Fridays failure must not blank the leaderboard.
      api.getSeasonFridays(slug.value).catch(() => ({ enabled: false, fridays: [] })),
    ])
    season.value = s
    rows.value = rs
    fridaysEnabled.value = !!fr?.enabled
    fridays.value = fr?.fridays || []
    // Expand the most recent Friday by default so the latest result is visible.
    expandedDates.value = new Set(fridays.value.length ? [fridays.value[0].date] : [])
    showAllDates.value = new Set()
    if (!fridaysEnabled.value) tab.value = 'overall'
  } catch (e: any) {
    error.value = e.message || 'Failed to load season'
  } finally {
    loading.value = false
  }
}

function fmtFridayDate(d: string): string {
  // d is a Europe/Riga calendar date 'YYYY-MM-DD'; midday avoids any TZ rollover.
  return new Date(d + 'T12:00:00').toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'short', day: 'numeric',
  })
}
function fmtNet(n: number): string {
  const r = Math.round(Number(n) || 0)
  return (r > 0 ? '+' : '') + r
}
function netClass(n: number): string {
  return n > 0 ? 'text-green-500' : n < 0 ? 'text-red-500' : 'text-muted-foreground'
}
function medal(place: number | null): string {
  return place === 1 ? '🥇' : place === 2 ? '🥈' : place === 3 ? '🥉' : ''
}
function podiumOf(day: FridayDay): FridayPlayer[] { return day.players.filter(p => p.place != null) }
function restOf(day: FridayDay): FridayPlayer[] { return day.players.filter(p => p.place == null) }
function dayWinner(day: FridayDay): FridayPlayer | null {
  const top = day.players[0]
  return top && top.net_points > 0 ? top : null
}
function isExpanded(d: string): boolean { return expandedDates.value.has(d) }
function isShowAll(d: string): boolean { return showAllDates.value.has(d) }
function toggleDate(d: string) {
  const s = new Set(expandedDates.value)
  s.has(d) ? s.delete(d) : s.add(d)
  expandedDates.value = s
}
function toggleShowAll(d: string) {
  const s = new Set(showAllDates.value)
  s.has(d) ? s.delete(d) : s.add(d)
  showAllDates.value = s
}

function fmtPoints(p: number): string {
  return Math.round(Number(p) || 0).toString()
}
function fmtRange(s: Season): string {
  const a = s.starts_at ? new Date(s.starts_at).toLocaleDateString() : '—'
  const b = s.ends_at   ? new Date(s.ends_at  ).toLocaleDateString() : '—'
  return `${a} → ${b}`
}
// Avatar ring colour comes from the player's highest-priority custom
// group on this season (server already orders them captains_drawn_from
// DESC > min_per_match DESC > id ASC). We use boxShadow inset to render
// the colour since border_color is a per-row arbitrary CSS colour and
// Tailwind ring-* utilities can't express that dynamically.
function avatarRingStyle(row: LeaderRow): Record<string, string> {
  const top = (row.groups || [])[0]
  if (!top) return {}
  return { boxShadow: `0 0 0 2px ${top.border_color}` }
}
function avatarRingTitle(row: LeaderRow): string {
  return (row.groups || []).map(g => g.name).join(', ')
}
// Unique groups across the visible page — drives the legend.
const visibleGroups = computed(() => {
  const map = new Map<number, LeaderGroupRef>()
  for (const r of rows.value) {
    for (const g of (r.groups || [])) {
      if (!map.has(g.group_id)) map.set(g.group_id, g)
    }
  }
  return [...map.values()]
})

let socketHandler: ((p: any) => void) | null = null
function attachSocket() {
  const s = getSocket()
  if (!s) return
  socketHandler = (p: any) => {
    if (!season.value) return
    if (p?.seasonId === season.value.id) load()
  }
  s.on('season:rankUpdated', socketHandler)
}
function detachSocket() {
  const s = getSocket()
  if (s && socketHandler) s.off('season:rankUpdated', socketHandler)
}

watch(slug, load)
onMounted(() => { load(); attachSocket() })
onUnmounted(detachSocket)
</script>

<template>
  <div class="max-w-[1100px] mx-auto px-4 md:px-8 py-6 flex-1 w-full">
    <router-link :to="{ name: 'seasons' }" class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-3">
      <ChevronLeft class="w-3.5 h-3.5" />
      {{ t('seasonsPageTitle') }}
    </router-link>

    <div v-if="loading" class="text-sm text-muted-foreground">{{ t('loading') }}…</div>
    <div v-else-if="error" class="card p-4 border border-destructive/40 text-destructive text-sm">{{ error }}</div>
    <template v-else-if="season">
      <div class="flex items-start gap-3 mb-2">
        <Medal class="w-6 h-6 text-primary mt-1" />
        <div class="flex-1 min-w-0">
          <h1 class="text-2xl font-bold">{{ season.name }}</h1>
          <p v-if="season.description" class="text-sm text-muted-foreground">{{ season.description }}</p>
        </div>
      </div>

      <div class="flex flex-wrap gap-2 text-[11px] font-mono text-muted-foreground mb-5">
        <span class="px-2 py-1 rounded bg-accent/40">{{ fmtRange(season) }}</span>
        <span class="px-2 py-1 rounded bg-accent/40">{{ season.player_count }} {{ t('players') }}</span>
        <span class="px-2 py-1 rounded bg-accent/40">{{ season.match_count }} {{ t('seasonMatches') }}</span>
        <span v-if="season.is_active" class="px-2 py-1 rounded bg-green-500/15 text-green-500">{{ t('seasonStatus_active') }}</span>
        <span v-else class="px-2 py-1 rounded bg-muted/40">{{ t('seasonStatus_ended') }}</span>
      </div>

      <!-- Tabs — the Fridays tab only exists when this season runs an inhouse competition. -->
      <div v-if="fridaysEnabled" class="flex items-center gap-1 mb-4 border-b border-border/40">
        <button
          class="px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors"
          :class="tab === 'overall' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
          @click="tab = 'overall'"
        >{{ t('seasonTabOverall') }}</button>
        <button
          class="px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors"
          :class="tab === 'fridays' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
          @click="tab = 'fridays'"
        >{{ t('seasonTabFridays') }}</button>
      </div>

      <!-- ─── OVERALL TAB ─── -->
      <template v-if="tab === 'overall'">
      <div v-if="rows.length === 0" class="card p-8 text-center text-muted-foreground">
        <Trophy class="w-10 h-10 mx-auto mb-3 opacity-40" />
        <p class="text-sm">{{ t('seasonLeaderboardEmpty') }}</p>
      </div>
      <div v-else class="card overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th class="text-right px-4 py-2.5 w-12">#</th>
              <th class="text-left px-4 py-2.5">{{ t('player') }}</th>
              <th class="text-right px-4 py-2.5">{{ t('seasonPoints') }}</th>
              <th class="text-right px-4 py-2.5 hidden md:table-cell">{{ t('seasonPeak') }}</th>
              <th class="text-right px-4 py-2.5">{{ t('seasonGames') }}</th>
              <th class="text-right px-4 py-2.5">W / L</th>
              <th class="text-right px-4 py-2.5 hidden md:table-cell">{{ t('seasonStreak') }}</th>
            </tr>
          </thead>
          <tbody>
            <router-link
              v-for="(row, i) in rows" :key="row.player_id"
              :to="{ name: 'player-profile', params: { id: row.player_id } }"
              custom v-slot="{ navigate }"
            >
              <tr class="border-t border-border/40 hover:bg-accent/20 cursor-pointer" @click="navigate">
                <td class="px-4 py-2.5 text-right font-mono tabular-nums" :class="i < 3 ? 'text-amber-400 font-bold' : 'text-muted-foreground'">{{ i + 1 }}</td>
                <td class="px-4 py-2.5">
                  <div class="flex items-center gap-2">
                    <img
                      v-if="row.avatar_url"
                      :src="row.avatar_url"
                      class="w-7 h-7 rounded-full object-cover"
                      :style="avatarRingStyle(row)"
                      :title="avatarRingTitle(row) || undefined"
                    />
                    <div
                      v-else
                      class="w-7 h-7 rounded-full bg-accent"
                      :style="avatarRingStyle(row)"
                      :title="avatarRingTitle(row) || undefined"
                    />
                    <span class="font-semibold">{{ row.display_name }}</span>
                    <BadgeCheck v-if="row.mmr_verified_at" class="w-4 h-4 text-cyan-400 shrink-0" :title="t('mmrVerifiedTooltip')" />
                    <span class="text-[11px] text-muted-foreground font-mono tabular-nums">{{ row.mmr }} MMR</span>
                  </div>
                </td>
                <td class="px-4 py-2.5 text-right font-mono font-bold tabular-nums">{{ fmtPoints(row.points) }}</td>
                <td class="px-4 py-2.5 text-right font-mono text-muted-foreground tabular-nums hidden md:table-cell">{{ fmtPoints(row.peak_points) }}</td>
                <td class="px-4 py-2.5 text-right font-mono tabular-nums">{{ row.games_played }}</td>
                <td class="px-4 py-2.5 text-right font-mono tabular-nums">
                  <span class="text-green-500">{{ row.wins }}</span>
                  <span class="text-muted-foreground"> / </span>
                  <span class="text-red-500">{{ row.losses }}</span>
                </td>
                <td class="px-4 py-2.5 text-right font-mono tabular-nums hidden md:table-cell">
                  <span v-if="(row.current_winstreak || 0) > 0" class="text-orange-400 font-semibold">🔥 {{ row.current_winstreak }}</span>
                  <span v-else-if="(row.current_winstreak || 0) < 0" class="text-blue-400 font-semibold">🧊 {{ Math.abs(row.current_winstreak) }}</span>
                  <span v-else class="text-muted-foreground">—</span>
                </td>
              </tr>
            </router-link>
          </tbody>
        </table>
      </div>

      <div
        v-if="visibleGroups.length"
        class="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-muted-foreground"
      >
        <span v-for="g in visibleGroups" :key="g.group_id" class="flex items-center gap-1.5">
          <span class="inline-block w-3 h-3 rounded-full" :style="{ boxShadow: `0 0 0 2px ${g.border_color}` }"></span>
          {{ g.name }}
        </span>
      </div>
      </template>

      <!-- ─── FRIDAYS TAB ─── -->
      <template v-else>
        <div v-if="fridays.length === 0" class="card p-8 text-center text-muted-foreground">
          <Trophy class="w-10 h-10 mx-auto mb-3 opacity-40" />
          <p class="text-sm">{{ t('seasonFridaysEmpty') }}</p>
        </div>
        <div v-else class="flex flex-col gap-2">
          <div v-for="day in fridays" :key="day.date" class="card overflow-hidden">
            <!-- Day header — click to collapse/expand. Collapsed shows the winner. -->
            <button
              class="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-accent/20"
              @click="toggleDate(day.date)"
            >
              <component :is="isExpanded(day.date) ? ChevronDown : ChevronRight" class="w-4 h-4 text-muted-foreground shrink-0" />
              <span class="font-semibold text-sm">{{ fmtFridayDate(day.date) }}</span>
              <span v-if="!isExpanded(day.date) && dayWinner(day)" class="text-xs text-muted-foreground ml-auto truncate">
                {{ t('seasonFridayWonBy', { name: dayWinner(day)!.display_name, pts: fmtNet(dayWinner(day)!.net_points) }) }}
              </span>
            </button>

            <div v-if="isExpanded(day.date)" class="border-t border-border/40">
              <!-- Podium (always shown when expanded) -->
              <router-link
                v-for="p in podiumOf(day)" :key="p.player_id"
                :to="{ name: 'player-profile', params: { id: p.player_id } }"
                class="flex items-center gap-2 px-4 py-2 hover:bg-accent/20"
              >
                <span class="w-6 text-center text-base shrink-0">{{ medal(p.place) }}</span>
                <img v-if="p.avatar_url" :src="p.avatar_url" class="w-7 h-7 rounded-full object-cover shrink-0" />
                <div v-else class="w-7 h-7 rounded-full bg-accent shrink-0" />
                <span class="font-semibold text-sm truncate">{{ p.display_name }}</span>
                <BadgeCheck v-if="p.mmr_verified_at" class="w-4 h-4 text-cyan-400 shrink-0" :title="t('mmrVerifiedTooltip')" />
                <span class="ml-auto font-mono tabular-nums font-bold text-sm" :class="netClass(p.net_points)">{{ fmtNet(p.net_points) }}</span>
                <span class="font-mono tabular-nums text-xs w-12 text-right shrink-0">
                  <span class="text-green-500">{{ p.wins }}</span><span class="text-muted-foreground">-</span><span class="text-red-500">{{ p.losses }}</span>
                </span>
                <span class="w-12 text-right shrink-0">
                  <span v-if="p.bonus" class="text-[11px] text-amber-400 font-semibold" :title="t('seasonFridayBonusTooltip')">+{{ p.bonus }}★</span>
                </span>
              </router-link>

              <!-- Full standings (everyone beyond the podium), behind a toggle -->
              <button
                v-if="restOf(day).length"
                class="w-full text-center text-xs text-muted-foreground hover:text-foreground py-2 border-t border-border/40"
                @click="toggleShowAll(day.date)"
              >
                {{ isShowAll(day.date) ? t('seasonFridayShowLess') : t('seasonFridayShowAll', { n: day.players.length }) }}
              </button>
              <template v-if="isShowAll(day.date)">
                <router-link
                  v-for="(p, idx) in restOf(day)" :key="p.player_id"
                  :to="{ name: 'player-profile', params: { id: p.player_id } }"
                  class="flex items-center gap-2 px-4 py-2 bg-muted/10 hover:bg-accent/20 border-t border-border/30"
                >
                  <span class="w-6 text-center text-xs text-muted-foreground font-mono tabular-nums shrink-0">{{ podiumOf(day).length + idx + 1 }}</span>
                  <img v-if="p.avatar_url" :src="p.avatar_url" class="w-6 h-6 rounded-full object-cover shrink-0" />
                  <div v-else class="w-6 h-6 rounded-full bg-accent shrink-0" />
                  <span class="text-sm truncate">{{ p.display_name }}</span>
                  <BadgeCheck v-if="p.mmr_verified_at" class="w-3.5 h-3.5 text-cyan-400 shrink-0" :title="t('mmrVerifiedTooltip')" />
                  <span class="ml-auto font-mono tabular-nums text-sm" :class="netClass(p.net_points)">{{ fmtNet(p.net_points) }}</span>
                  <span class="font-mono tabular-nums text-xs w-12 text-right shrink-0">
                    <span class="text-green-500">{{ p.wins }}</span><span class="text-muted-foreground">-</span><span class="text-red-500">{{ p.losses }}</span>
                  </span>
                  <span class="w-12 shrink-0"></span>
                </router-link>
              </template>
            </div>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>
