<script setup lang="ts">
import { Newspaper, Users, Trophy, ChevronRight, Settings, ShieldCheck, Bot, Gamepad2, Star, Zap, Swords, Activity, Medal, Shield, BarChart3, Menu as MenuIcon } from 'lucide-vue-next'
import { computed, ref, onBeforeUnmount, onMounted } from 'vue'
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

const CONTENT_DEFAULT = 1200
const CONTENT_MIN = 600
const CONTENT_MAX = 2400
const CONTENT_STORAGE_KEY = 'admin_content_max_width'

const sidebarWidth = ref(loadStored(SIDEBAR_STORAGE_KEY, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX))
const contentMaxWidth = ref(loadStored(CONTENT_STORAGE_KEY, CONTENT_DEFAULT, CONTENT_MIN, CONTENT_MAX))
const viewportWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1920)

function loadStored(key: string, def: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return def
    const n = parseInt(raw, 10)
    if (!Number.isFinite(n)) return def
    return Math.min(Math.max(n, min), max)
  } catch {
    return def
  }
}

// Effective max width clamped to current viewport so the handle stays visible.
const effectiveContentMax = computed(() => {
  const room = Math.max(CONTENT_MIN, viewportWidth.value - sidebarWidth.value - 24)
  return Math.min(contentMaxWidth.value, room)
})

let dragStartX = 0
let dragStartSidebar = 0
let dragStartContent = 0

function startSidebarResize(e: MouseEvent) {
  dragStartX = e.clientX
  dragStartSidebar = sidebarWidth.value
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onSidebarResize)
  window.addEventListener('mouseup', stopSidebarResize)
  e.preventDefault()
}

function onSidebarResize(e: MouseEvent) {
  const next = dragStartSidebar + (e.clientX - dragStartX)
  sidebarWidth.value = Math.min(Math.max(next, SIDEBAR_MIN), SIDEBAR_MAX)
}

function stopSidebarResize() {
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  window.removeEventListener('mousemove', onSidebarResize)
  window.removeEventListener('mouseup', stopSidebarResize)
  try { localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarWidth.value)) } catch {}
}

function resetSidebar() {
  sidebarWidth.value = SIDEBAR_DEFAULT
  try { localStorage.setItem(SIDEBAR_STORAGE_KEY, String(SIDEBAR_DEFAULT)) } catch {}
}

function startContentResize(e: MouseEvent) {
  dragStartX = e.clientX
  dragStartContent = contentMaxWidth.value
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onContentResize)
  window.addEventListener('mouseup', stopContentResize)
  e.preventDefault()
}

function onContentResize(e: MouseEvent) {
  const next = dragStartContent + (e.clientX - dragStartX)
  contentMaxWidth.value = Math.min(Math.max(next, CONTENT_MIN), CONTENT_MAX)
}

function stopContentResize() {
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  window.removeEventListener('mousemove', onContentResize)
  window.removeEventListener('mouseup', stopContentResize)
  try { localStorage.setItem(CONTENT_STORAGE_KEY, String(contentMaxWidth.value)) } catch {}
}

function resetContent() {
  contentMaxWidth.value = CONTENT_DEFAULT
  try { localStorage.setItem(CONTENT_STORAGE_KEY, String(CONTENT_DEFAULT)) } catch {}
}

function onWindowResize() {
  viewportWidth.value = window.innerWidth
}

onMounted(() => {
  window.addEventListener('resize', onWindowResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onSidebarResize)
  window.removeEventListener('mouseup', stopSidebarResize)
  window.removeEventListener('mousemove', onContentResize)
  window.removeEventListener('mouseup', stopContentResize)
  window.removeEventListener('resize', onWindowResize)
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
  { labelKey: 'adminFantasy', icon: Star, path: '/admin/fantasy', permissions: ['manage_fantasy'] },
  { labelKey: 'adminXpLog', icon: Zap, path: '/admin/xp-log', permissions: ['manage_xp_log'] },
  { labelKey: 'adminQueuePools', icon: Swords, path: '/admin/queue', permissions: ['manage_queue_pools'] },
  { labelKey: 'adminSeasons', icon: Medal, path: '/admin/seasons', permissions: ['manage_seasons'] },
  { labelKey: 'adminMmrVerifications', icon: Shield, path: '/admin/mmr-verifications', permissions: ['manage_mmr_verifications'] },
  { labelKey: 'adminJobs', icon: Activity, path: '/admin/jobs', permissions: ['manage_jobs'] },
  { labelKey: 'adminRequestStats', icon: BarChart3, path: '/admin/request-stats', permissions: ['view_request_stats'] },
  { labelKey: 'adminMenu', icon: MenuIcon, path: '/admin/menu', permissions: ['manage_menu'] },
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
      <!-- Sidebar resize handle -->
      <div
        class="absolute top-0 -right-1 h-full w-3 cursor-col-resize group flex items-center justify-center z-10"
        :title="t('adminSidebarResizeHint')"
        @mousedown="startSidebarResize"
        @dblclick="resetSidebar"
      >
        <div class="w-px h-full bg-sidebar-border group-hover:w-1 group-hover:bg-primary group-active:bg-primary transition-all" />
        <div class="absolute h-12 w-1 rounded-full bg-muted-foreground/30 group-hover:bg-primary/70 transition-colors" />
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
    <div
      class="flex-1 overflow-y-auto relative"
      :style="{ '--admin-content-max': effectiveContentMax + 'px' }"
    >
      <div class="md:hidden h-11"></div>
      <router-view />
      <!-- Content resize handle (desktop only) -->
      <div
        class="hidden md:flex absolute top-0 bottom-0 w-3 cursor-col-resize group items-center justify-center z-10"
        :style="{ left: (effectiveContentMax - 6) + 'px' }"
        :title="t('adminContentResizeHint')"
        @mousedown="startContentResize"
        @dblclick="resetContent"
      >
        <div class="w-px h-full bg-border group-hover:w-1 group-hover:bg-primary group-active:bg-primary transition-all" />
        <div class="absolute h-12 w-1 rounded-full bg-muted-foreground/20 group-hover:bg-primary/70 transition-colors" />
      </div>
    </div>
  </div>
</template>
