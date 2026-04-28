<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Search, User as UserIcon, Swords, Loader2, Trophy } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'

interface PlayerHit {
  id: number
  name: string
  steam_name: string
  avatar_url: string | null
  steam_id: string | null
  mmr: number
  is_banned: boolean
}
interface MatchHit {
  type: 'queue' | 'tournament' | 'dotabuff'
  id: number | string
  path: string | null
  label: string
  subtitle: string | null
  status: string | null
  date: string | null
}
interface CompetitionHit {
  id: number
  name: string
  status: string | null
  starts_at: string | null
  competition_type: string | null
  path: string
}

const { t } = useI18n()
const router = useRouter()
const api = useApi()

const query = ref('')
const players = ref<PlayerHit[]>([])
const matches = ref<MatchHit[]>([])
const competitions = ref<CompetitionHit[]>([])
const open = ref(false)
const loading = ref(false)
const activeIdx = ref(-1)
const inputEl = ref<HTMLInputElement | null>(null)
const wrapperEl = ref<HTMLDivElement | null>(null)

let debounceTimer: ReturnType<typeof setTimeout> | null = null

const flatHits = computed(() => {
  const out: Array<{ kind: 'player' | 'match' | 'competition'; data: PlayerHit | MatchHit | CompetitionHit }> = []
  for (const p of players.value) out.push({ kind: 'player', data: p })
  for (const c of competitions.value) out.push({ kind: 'competition', data: c })
  for (const m of matches.value) out.push({ kind: 'match', data: m })
  return out
})

const hasResults = computed(() => flatHits.value.length > 0)
const showDropdown = computed(() => open.value && (query.value.trim().length >= 2 || loading.value))

watch(query, (q) => {
  if (debounceTimer) clearTimeout(debounceTimer)
  activeIdx.value = -1
  if (!q || q.trim().length < 2) {
    players.value = []
    matches.value = []
    competitions.value = []
    return
  }
  loading.value = true
  debounceTimer = setTimeout(async () => {
    try {
      const res = await api.search(q.trim(), 8)
      players.value = res.players || []
      matches.value = res.matches || []
      competitions.value = res.competitions || []
    } catch {
      players.value = []
      matches.value = []
      competitions.value = []
    } finally {
      loading.value = false
    }
  }, 200)
})

function navigateHit(hit: { kind: 'player' | 'match' | 'competition'; data: PlayerHit | MatchHit | CompetitionHit }) {
  if (hit.kind === 'player') {
    const p = hit.data as PlayerHit
    router.push({ name: 'player-profile', params: { id: p.id } })
  } else if (hit.kind === 'competition') {
    const c = hit.data as CompetitionHit
    router.push(c.path)
  } else {
    const m = hit.data as MatchHit
    if (m.path) router.push(m.path)
  }
  close()
}

function open_() {
  open.value = true
}

function close() {
  open.value = false
  query.value = ''
  players.value = []
  matches.value = []
  competitions.value = []
}

function handleKey(e: KeyboardEvent) {
  if (!showDropdown.value) return
  const max = flatHits.value.length
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIdx.value = max === 0 ? -1 : (activeIdx.value + 1) % max
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIdx.value = max === 0 ? -1 : (activeIdx.value - 1 + max) % max
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const idx = activeIdx.value >= 0 ? activeIdx.value : 0
    if (flatHits.value[idx]) navigateHit(flatHits.value[idx])
  } else if (e.key === 'Escape') {
    close()
    inputEl.value?.blur()
  }
}

function onDocClick(e: MouseEvent) {
  if (!wrapperEl.value) return
  if (!wrapperEl.value.contains(e.target as Node)) close()
}

function onGlobalKey(e: KeyboardEvent) {
  // Ctrl/Cmd + K focuses the search
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    inputEl.value?.focus()
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onDocClick)
  window.addEventListener('keydown', onGlobalKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick)
  window.removeEventListener('keydown', onGlobalKey)
  if (debounceTimer) clearTimeout(debounceTimer)
})

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)
const shortcutLabel = isMac ? '⌘K' : 'Ctrl+K'
</script>

<template>
  <div ref="wrapperEl" class="relative w-full max-w-[280px]">
    <div class="relative flex items-center">
      <Search class="absolute left-3 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
      <input
        ref="inputEl"
        v-model="query"
        type="text"
        :placeholder="t('searchPlaceholder')"
        class="w-full pl-9 pr-12 py-1.5 bg-card border border-border rounded-lg text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30 transition-colors"
        @focus="open_"
        @keydown="handleKey"
      />
      <span class="absolute right-2 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-muted text-muted-foreground border border-border pointer-events-none hidden sm:inline">
        {{ shortcutLabel }}
      </span>
    </div>

    <!-- Dropdown -->
    <div
      v-if="showDropdown"
      class="absolute right-0 left-0 top-full mt-2 rounded-xl bg-card border border-border shadow-lg shadow-black/30 z-50 max-h-[480px] overflow-y-auto"
    >
      <div v-if="loading && !hasResults" class="flex items-center justify-center gap-2 px-4 py-6 text-xs text-muted-foreground">
        <Loader2 class="w-3.5 h-3.5 animate-spin" />
        {{ t('loading') }}
      </div>
      <div v-else-if="!hasResults && query.length >= 2" class="px-4 py-6 text-center text-xs text-muted-foreground">
        {{ t('searchNoResults') }}
      </div>
      <template v-else>
        <!-- Players section -->
        <div v-if="players.length > 0">
          <div class="px-3 py-2 text-[10px] font-mono font-semibold uppercase tracking-wider text-text-tertiary border-b border-border">
            {{ t('searchPlayers') }}
          </div>
          <button
            v-for="(p, i) in players" :key="`p-${p.id}`"
            class="w-full flex items-center gap-3 px-3 py-2 text-left transition-colors"
            :class="activeIdx === i ? 'bg-accent' : 'hover:bg-accent/40'"
            @mouseenter="activeIdx = i"
            @click="navigateHit({ kind: 'player', data: p })"
          >
            <div class="w-7 h-7 rounded-full overflow-hidden bg-muted shrink-0 flex items-center justify-center">
              <img v-if="p.avatar_url" :src="p.avatar_url" class="w-full h-full object-cover" />
              <UserIcon v-else class="w-3.5 h-3.5 text-muted-foreground" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-1.5">
                <span class="text-sm font-medium text-foreground truncate">{{ p.name }}</span>
                <span v-if="p.is_banned" class="px-1.5 py-0 rounded text-[9px] font-bold bg-red-500/15 text-red-400 uppercase shrink-0">{{ t('banned') }}</span>
              </div>
              <div class="text-[11px] text-muted-foreground truncate">{{ p.mmr }} MMR · ID {{ p.id }}</div>
            </div>
          </button>
        </div>
        <!-- Competitions section -->
        <div v-if="competitions.length > 0">
          <div class="px-3 py-2 text-[10px] font-mono font-semibold uppercase tracking-wider text-text-tertiary border-b border-border">
            {{ t('searchCompetitions') }}
          </div>
          <button
            v-for="(c, i) in competitions" :key="`c-${c.id}`"
            class="w-full flex items-center gap-3 px-3 py-2 text-left transition-colors"
            :class="activeIdx === (players.length + i) ? 'bg-accent' : 'hover:bg-accent/40'"
            @mouseenter="activeIdx = players.length + i"
            @click="navigateHit({ kind: 'competition', data: c })"
          >
            <div class="w-7 h-7 rounded-md bg-muted shrink-0 flex items-center justify-center">
              <Trophy class="w-3.5 h-3.5 text-muted-foreground" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium text-foreground truncate">{{ c.name }}</div>
              <div class="text-[11px] text-muted-foreground truncate">
                <span v-if="c.competition_type">{{ c.competition_type }}</span>
                <span v-if="c.status" class="ml-1 uppercase tracking-wider">{{ c.competition_type ? '· ' : '' }}{{ c.status }}</span>
              </div>
            </div>
          </button>
        </div>
        <!-- Matches section -->
        <div v-if="matches.length > 0">
          <div class="px-3 py-2 text-[10px] font-mono font-semibold uppercase tracking-wider text-text-tertiary border-b border-border">
            {{ t('searchMatches') }}
          </div>
          <button
            v-for="(m, i) in matches" :key="`m-${m.type}-${m.id}`"
            class="w-full flex items-center gap-3 px-3 py-2 text-left transition-colors"
            :class="activeIdx === (players.length + competitions.length + i) ? 'bg-accent' : 'hover:bg-accent/40'"
            :disabled="!m.path"
            @mouseenter="activeIdx = players.length + competitions.length + i"
            @click="navigateHit({ kind: 'match', data: m })"
          >
            <div class="w-7 h-7 rounded-md bg-muted shrink-0 flex items-center justify-center">
              <Swords class="w-3.5 h-3.5 text-muted-foreground" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium text-foreground truncate">{{ m.label }}</div>
              <div class="text-[11px] text-muted-foreground truncate">
                <span v-if="m.subtitle">{{ m.subtitle }}</span>
                <span v-if="m.status" class="ml-1 uppercase tracking-wider">· {{ m.status }}</span>
              </div>
            </div>
          </button>
        </div>
      </template>
    </div>
  </div>
</template>
