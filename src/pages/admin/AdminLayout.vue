<script setup lang="ts">
import { Newspaper, Users, Trophy, ChevronRight, Settings, ShieldCheck, Bot, Gamepad2, Star, Zap, Swords, Activity, Medal, Shield, BarChart3 } from 'lucide-vue-next'
import { computed, ref, onBeforeUnmount } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useDraftStore } from '@/composables/useDraftStore'

const { t } = useI18n()
const route = useRoute()
const store = useDraftStore()

const SIDEBAR_DEFAULT = 224
const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 480
const SIDEBAR_STORAGE_KEY = 'admin_sidebar_width'

const sidebarWidth = ref(loadStoredWidth())

function loadStoredWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_STORAGE_KEY)
    if (!raw) return SIDEBAR_DEFAULT
    const n = parseInt(raw, 10)
    if (!Number.isFinite(n)) return SIDEBAR_DEFAULT
    return Math.min(Math.max(n, SIDEBAR_MIN), SIDEBAR_MAX)
  } catch {
    return SIDEBAR_DEFAULT
  }
}

let dragStartX = 0
let dragStartWidth = 0

function startResize(e: MouseEvent) {
  dragStartX = e.clientX
  dragStartWidth = sidebarWidth.value
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onResize)
  window.addEventListener('mouseup', stopResize)
  e.preventDefault()
}

function onResize(e: MouseEvent) {
  const next = dragStartWidth + (e.clientX - dragStartX)
  sidebarWidth.value = Math.min(Math.max(next, SIDEBAR_MIN), SIDEBAR_MAX)
}

function stopResize() {
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  window.removeEventListener('mousemove', onResize)
  window.removeEventListener('mouseup', stopResize)
  try { localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarWidth.value)) } catch {}
}

function resetWidth() {
  sidebarWidth.value = SIDEBAR_DEFAULT
  try { localStorage.setItem(SIDEBAR_STORAGE_KEY, String(SIDEBAR_DEFAULT)) } catch {}
}

onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onResize)
  window.removeEventListener('mouseup', stopResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
})

const allNav = [
  { labelKey: 'adminCompetitions', icon: Trophy, path: '/admin/competitions', permissions: ['manage_competitions', 'manage_own_competitions'] },
  { labelKey: 'users', icon: Users, path: '/admin/users', permissions: ['manage_users'] },
  { labelKey: 'newsAnnouncements', icon: Newspaper, path: '/admin/news', permissions: ['manage_news'] },
  { labelKey: 'siteSettings', icon: Settings, path: '/admin/settings', permissions: ['manage_site_settings'] },
  { labelKey: 'permissionGroups', icon: ShieldCheck, path: '/admin/permissions', permissions: ['manage_permissions'] },
  { labelKey: 'lobbyBots', icon: Bot, path: '/admin/bots', permissions: ['manage_bots'] },
  { labelKey: 'adminGames', icon: Gamepad2, path: '/admin/games', permissions: ['manage_games'] },
  { labelKey: 'adminFantasy', icon: Star, path: '/admin/fantasy', permissions: ['manage_competitions', 'manage_own_competitions'] },
  { labelKey: 'adminXpLog', icon: Zap, path: '/admin/xp-log', permissions: ['manage_users'] },
  { labelKey: 'adminQueuePools', icon: Swords, path: '/admin/queue', permissions: ['manage_queue_pools'] },
  { labelKey: 'adminSeasons', icon: Medal, path: '/admin/seasons', permissions: ['manage_seasons'] },
  { labelKey: 'adminMmrVerifications', icon: Shield, path: '/admin/mmr-verifications', permissions: ['manage_mmr_verifications'] },
  { labelKey: 'adminJobs', icon: Activity, path: '/admin/jobs', permissions: ['manage_jobs'] },
  { labelKey: 'adminRequestStats', icon: BarChart3, path: '/admin/request-stats', permissions: ['view_request_stats'] },
]

const adminNav = computed(() =>
  allNav.filter(item => item.permissions.some(p => store.hasPerm(p)))
)
</script>

<template>
  <div class="flex flex-1 overflow-hidden">
    <!-- Sidebar -->
    <aside
      class="hidden md:flex flex-col bg-sidebar border-r border-sidebar-border shrink-0 relative"
      :style="{ width: sidebarWidth + 'px' }"
    >
      <div class="px-4 py-4 border-b border-sidebar-border">
        <h2 class="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{{ t('adminPanel') }}</h2>
      </div>
      <nav class="flex flex-col gap-0.5 p-2 overflow-y-auto">
        <router-link
          v-for="item in adminNav"
          :key="item.path"
          :to="item.path"
          class="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors"
          :class="route.path.startsWith(item.path)
            ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
            : 'text-sidebar-foreground hover:bg-accent'"
        >
          <component :is="item.icon" class="w-4 h-4 shrink-0" />
          <span class="truncate">{{ t(item.labelKey) }}</span>
        </router-link>
      </nav>
      <!-- Resize handle -->
      <div
        class="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-primary/40 active:bg-primary/60 transition-colors group"
        :title="t('adminSidebarResizeHint')"
        @mousedown="startResize"
        @dblclick="resetWidth"
      >
        <div class="absolute inset-y-0 -right-1 w-3" />
      </div>
    </aside>

    <!-- Mobile admin nav -->
    <div class="md:hidden flex items-center gap-1 px-4 py-2 border-b border-border bg-accent/30 w-full absolute z-10">
      <router-link
        v-for="item in adminNav"
        :key="item.path"
        :to="item.path"
        class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors"
        :class="route.path.startsWith(item.path)
          ? 'bg-primary text-primary-foreground font-medium'
          : 'text-muted-foreground hover:bg-accent'"
      >
        <component :is="item.icon" class="w-3.5 h-3.5" />
        {{ t(item.labelKey) }}
      </router-link>
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto">
      <div class="md:hidden h-11"></div>
      <router-view />
    </div>
  </div>
</template>
