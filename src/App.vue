<script setup lang="ts">
import { Gamepad2, Shield, ShieldAlert, LogOut, Sun, Moon, Menu, X, Home, LogIn, Lock, Globe, Settings, Swords, Info, Radio, ChevronDown, Check, LayoutDashboard, Bell, User, Newspaper, Calendar, Trophy, Medal, Ban, Megaphone, Coins } from 'lucide-vue-next'
import { useRoute, useRouter } from 'vue-router'
import { onMounted, ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDraftStore } from '@/composables/useDraftStore'
import { useQueueStore } from '@/composables/useQueueStore'
import { useApi, onBannedAction } from '@/composables/useApi'
import { useNavStore, type NavItem, type NavRoot } from '@/composables/useNavStore'
import { fmtDateOnly } from '@/utils/format'
import GlobalSearch from '@/components/common/GlobalSearch.vue'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import AppFooter from '@/components/common/AppFooter.vue'
import QueueStatusOverlay from '@/components/common/QueueStatusOverlay.vue'
import ReadyCheckModal from '@/components/common/ReadyCheckModal.vue'
import UpdateAvailableModal from '@/components/common/UpdateAvailableModal.vue'
import InputGroup from '@/components/common/InputGroup.vue'
import LeftSidebar from '@/components/common/LeftSidebar.vue'
import RightSidebar from '@/components/common/RightSidebar.vue'
import { setLocale } from '@/i18n'
import { getSocket } from '@/composables/useSocket'

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const store = useDraftStore()
const queue = useQueueStore()
const navStore = useNavStore()
navStore.load().catch(() => {})

// Map of icon name -> lucide component for data-driven nav.
const ICON_MAP: Record<string, any> = {
  Home, Swords, Calendar, Newspaper, Trophy, Medal, Settings, Shield, User, Radio,
}

function iconFor(name: string) {
  return ICON_MAP[name] || Swords
}

function labelFor(item: NavItem): string {
  if (item.labels) {
    const cur = (locale.value as 'en' | 'lv' | 'lt')
    const fromLabels = item.labels[cur] || item.labels.en
    if (fromLabels) return fromLabels
  }
  if (item.label_key) return t(item.label_key)
  return item.path || '?'
}

function isActive(item: NavItem): boolean {
  if (item.active_match) {
    try {
      return new RegExp(item.active_match).test(route.path)
    } catch {
      return route.path.startsWith(item.active_match)
    }
  }
  return route.path === item.path
}

function isAnyActive(root: NavRoot): boolean {
  if (isActive(root)) return true
  return root.children.some(c => isActive(c))
}

// Group children by column_group label. Items without a group go into the
// blank group at index 0 so they still render.
function groupChildren(children: NavItem[]): Array<{ label: string; items: NavItem[] }> {
  const groups: Array<{ label: string; items: NavItem[] }> = []
  const idx = new Map<string, number>()
  for (const c of children) {
    const key = c.column_group || ''
    if (!idx.has(key)) {
      idx.set(key, groups.length)
      groups.push({ label: key, items: [] })
    }
    groups[idx.get(key)!].items.push(c)
  }
  return groups
}

const openDropdownId = ref<number | null>(null)
let dropdownCloseTimer: ReturnType<typeof setTimeout> | null = null

function openDropdown(id: number) {
  if (dropdownCloseTimer) {
    clearTimeout(dropdownCloseTimer)
    dropdownCloseTimer = null
  }
  openDropdownId.value = id
}
function scheduleCloseDropdown() {
  if (dropdownCloseTimer) clearTimeout(dropdownCloseTimer)
  dropdownCloseTimer = setTimeout(() => { openDropdownId.value = null }, 120)
}
function toggleDropdown(id: number) {
  openDropdownId.value = openDropdownId.value === id ? null : id
}
function closeDropdown() {
  if (dropdownCloseTimer) clearTimeout(dropdownCloseTimer)
  openDropdownId.value = null
}

watch(() => route.path, () => closeDropdown())

const isDark = ref(localStorage.getItem('draft_theme') !== 'light')

function toggleTheme() {
  isDark.value = !isDark.value
  document.documentElement.classList.toggle('dark', isDark.value)
  localStorage.setItem('draft_theme', isDark.value ? 'dark' : 'light')
}

if (isDark.value) {
  document.documentElement.classList.add('dark')
}

const showClaimAdmin = ref(false)
const adminPassword = ref('')
const claimError = ref('')
const showClaimAdminButton = ref(false)
const showLangMenu = ref(false)
const showUserMenu = ref(false)
// Hydrate from the SWR cache synchronously so the first render already shows
// the right logo / banner / site name — no flash of empty values before
// onMounted's fetch resolves.
const _cachedSiteSettings = (() => {
  try { return JSON.parse(localStorage.getItem('draft_site_settings_v1') || 'null') || {} }
  catch { return {} }
})()
const customSiteName = ref(_cachedSiteSettings.site_name || '')
const customLogoUrl = ref(_cachedSiteSettings.site_logo_url || '')
const discordUrl = ref(_cachedSiteSettings.site_discord_url || '')
const heroBannerUrl = ref(_cachedSiteSettings.site_hero_banner_url || '')
const topbarEnabled = ref<boolean>(_cachedSiteSettings.site_topbar_enabled === true)
const topbarHtml = ref<string>(_cachedSiteSettings.site_topbar_html || '')
const topbarColor = ref<string>(_cachedSiteSettings.site_topbar_color || 'info')

const languages = [
  { code: 'en', label: 'English' },
  { code: 'lt', label: 'Lietuvių' },
  { code: 'lv', label: 'Latviešu' },
  { code: 'ru', label: 'Русский' },
]

function switchLang(code: string) {
  setLocale(code)
  showLangMenu.value = false
}

onMounted(async () => {
  store.initSocket()
  // Don't fetch the full competitions list here — it's slow (per-comp status
  // sync + large JSONB fields). Pages that need the list (CompetitionsPage,
  // AdminCompetitionsPage, AdminFantasyPage) fetch on their own mount.
  // CompetitionLayout populates the single current comp via fetchCompData.

  // Refs were already hydrated from cache at setup time; this fetches the
  // fresh payload in the background and reapplies if anything changed.
  useApi().getSiteSettingsCached().fresh.then(data => {
    customSiteName.value = data.site_name || ''
    customLogoUrl.value = data.site_logo_url || ''
    discordUrl.value = data.site_discord_url || ''
    heroBannerUrl.value = data.site_hero_banner_url || ''
    topbarEnabled.value = data.site_topbar_enabled === true
    topbarHtml.value = data.site_topbar_html || ''
    topbarColor.value = data.site_topbar_color || 'info'
    if (data.site_name) document.title = data.site_name
    if (data.site_logo_url) {
      const favicon = document.getElementById('favicon') as HTMLLinkElement
      if (favicon) {
        favicon.href = data.site_logo_url
        favicon.type = 'image/png'
      }
    }
  }).catch(() => {})

  const params = new URLSearchParams(window.location.search)

  if (params.has('admin')) {
    showClaimAdminButton.value = true
    const url = new URL(window.location.href)
    url.searchParams.delete('admin')
    window.history.replaceState({}, '', url.pathname + url.search)
  }

  const authToken = params.get('authToken')
  const steamError = params.get('steam_error')

  if (authToken) {
    await store.loginWithAuthToken(authToken)
    const url = new URL(window.location.href)
    url.searchParams.delete('authToken')
    window.history.replaceState({}, '', url.pathname + url.search)
    return
  }

  if (steamError) {
    const key = steamError as keyof typeof messages
    const messages = {
      registration_disabled: t('steamErrors.registration_disabled'),
      validation_failed: t('steamErrors.validation_failed'),
      invalid_id: t('steamErrors.invalid_id'),
      server_error: t('steamErrors.server_error'),
    }
    store.error.value = messages[key] || t('steamErrors.default')
    const url = new URL(window.location.href)
    url.searchParams.delete('steam_error')
    window.history.replaceState({}, '', url.pathname + url.search)
    return
  }

  await store.restoreAuth()

  // After auth is restored, ask the server for the current player's queue/match
  // state so we can restore the "finding match" overlay on page refresh or
  // when loading the app on a non-queue page.
  if (store.currentUser.value) {
    queue.fetchPools().then(() => queue.requestMyState())
  }
})

// If the user gets logged in later (e.g. Steam redirect), also sync then.
watch(() => store.currentUser.value?.id, (uid) => {
  if (uid) queue.fetchPools().then(() => queue.requestMyState())
})

// Auto-navigate to /queue when a match is found while the user is on another
// page — skip if they're already on /queue.
watch(() => queue.activeMatch.value, (m, prev) => {
  if (m && !prev && route.path !== '/queue') {
    router.push('/queue')
  }
})

const mainRef = ref<HTMLElement | null>(null)

watch(() => route.path, () => {
  if (mainRef.value) mainRef.value.scrollTop = 0
  // Track activity for admin panel
  try {
    const pageName = String(route.name || route.path)
    getSocket().emit('activity', { page: pageName, path: route.path })
  } catch {}
}, { immediate: true })

const mobileMenuOpen = ref(false)

const isLoggedIn = computed(() => !!store.currentUser.value)

const topbarPageLabel = computed(() => {
  if (route.path === '/') return ''
  const name = route.name?.toString() || ''
  if (!name) return ''
  return name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
})

// MMR verification nudge banner — shown above the header for any logged-in
// user whose MMR has never been verified. Dismissible per browser session.
const MMR_BANNER_KEY = 'mmr_verify_banner_dismissed'
const mmrBannerDismissed = ref(sessionStorage.getItem(MMR_BANNER_KEY) === '1')
const showMmrBanner = computed(() =>
  isLoggedIn.value
  && !store.currentUser.value?.mmr_verified_at
  && !mmrBannerDismissed.value
  && route.path !== '/settings'
)
function dismissMmrBanner() {
  mmrBannerDismissed.value = true
  sessionStorage.setItem(MMR_BANNER_KEY, '1')
}

// Admin-controlled top-bar notification. Dismiss key includes a short hash of
// the current HTML so editing the message re-shows the banner for everyone
// who already dismissed the previous version.
const TOPBAR_DISMISS_PREFIX = 'site_topbar_dismissed_v1:'
function topbarHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return Math.abs(h).toString(36)
}
const topbarDismissed = ref(false)
function checkTopbarDismissed() {
  const key = TOPBAR_DISMISS_PREFIX + topbarHash(topbarHtml.value)
  topbarDismissed.value = sessionStorage.getItem(key) === '1'
}
checkTopbarDismissed()
watch(topbarHtml, checkTopbarDismissed)
const showTopbar = computed(() =>
  topbarEnabled.value && !!topbarHtml.value.trim() && !topbarDismissed.value,
)
function dismissTopbar() {
  topbarDismissed.value = true
  const key = TOPBAR_DISMISS_PREFIX + topbarHash(topbarHtml.value)
  sessionStorage.setItem(key, '1')
}
const topbarBgClass = computed(() => {
  switch (topbarColor.value) {
    case 'success': return 'bg-green-500/15 border-b border-green-500/40 text-green-100'
    case 'warning': return 'bg-amber-500/15 border-b border-amber-500/40 text-amber-100'
    case 'danger':  return 'bg-red-500/15 border-b border-red-500/40 text-red-100'
    case 'info':
    default:        return 'bg-blue-500/15 border-b border-blue-500/40 text-blue-100'
  }
})

const myMatchCount = ref(0)

async function fetchMyMatchCount() {
  if (!store.currentUser.value) { myMatchCount.value = 0; return }
  try {
    const data = await useApi().getMyUpcomingMatchCount()
    myMatchCount.value = data.count || 0
  } catch { myMatchCount.value = 0 }
}

watch(() => store.currentUser.value, (user) => {
  if (user) fetchMyMatchCount()
  else myMatchCount.value = 0
}, { immediate: true })

const userRoleLabel = computed(() => {
  if (!store.currentUser.value) return t('spectator')
  const parts: string[] = []
  if (store.compUser.value?.captain) parts.push(t('captain'))
  if (store.currentUser.value.is_admin) parts.push(t('admin'))
  return parts.length > 0 ? parts.join(' / ') : t('player')
})

function loginWithSteam() {
  window.location.href = '/api/auth/steam'
}

function handleLogout() {
  store.logout()
  if (route.path.startsWith('/admin')) {
    router.push('/')
  }
}

async function handleClaimAdmin() {
  claimError.value = ''
  try {
    await store.claimAdmin(adminPassword.value)
    adminPassword.value = ''
    showClaimAdmin.value = false
  } catch {
    claimError.value = t('invalidAdminPassword')
  }
}

// Briefly emphasize the banned banner when a write action is rejected.
const banFlash = ref(false)
let banFlashTimer: ReturnType<typeof setTimeout> | null = null
onMounted(() => {
  const off = onBannedAction(() => {
    banFlash.value = true
    if (banFlashTimer) clearTimeout(banFlashTimer)
    banFlashTimer = setTimeout(() => { banFlash.value = false }, 2000)
  })
  return off
})
</script>

<template>
  <div class="flex flex-col h-screen bg-background" @click="showLangMenu = false; showUserMenu = false">
    <!-- Banned-account banner — sticky at the top whenever the current user is banned. -->
    <div
      v-if="store.currentUser.value?.is_banned"
      class="border-b transition-colors"
      :class="banFlash
        ? 'bg-red-500/40 border-red-500/80 animate-pulse'
        : 'bg-red-500/20 border-red-500/40'"
    >
      <div class="max-w-[1400px] mx-auto w-full flex items-center gap-3 px-4 md:px-8 py-2.5">
        <Ban class="w-5 h-5 text-red-400 shrink-0" />
        <div class="flex-1 min-w-0">
          <p class="text-sm font-semibold text-red-100">{{ t('bannedBannerTitle') }}</p>
          <p class="text-xs text-red-200/90 mt-0.5">
            <template v-if="store.currentUser.value?.banned_reason">
              {{ t('banReason') }}: <span class="italic">"{{ store.currentUser.value.banned_reason }}"</span>
            </template>
            <template v-else>{{ t('bannedBannerNoReason') }}</template>
            <template v-if="store.currentUser.value?.banned_by_name || store.currentUser.value?.banned_at">
              <span class="text-red-300/70 ml-2">·</span>
              <span class="text-red-300/70 ml-2" v-if="store.currentUser.value?.banned_by_name">{{ t('bannedBy') }} {{ store.currentUser.value.banned_by_name }}</span>
              <span class="text-red-300/70 ml-1" v-if="store.currentUser.value?.banned_at">{{ store.currentUser.value?.banned_by_name ? '·' : '' }} {{ fmtDateOnly(new Date(store.currentUser.value.banned_at)) }}</span>
            </template>
          </p>
        </div>
      </div>
    </div>

    <!-- Admin top-bar notification — site-wide, dismissible per session.
         Editing the message in /admin/settings re-shows it (key includes
         a hash of the html). -->
    <div v-if="showTopbar" :class="topbarBgClass">
      <div class="max-w-[1400px] mx-auto w-full flex items-start gap-3 px-4 md:px-8 py-2.5">
        <Megaphone class="w-4 h-4 mt-0.5 shrink-0 opacity-80" />
        <div
          v-safe-html="topbarHtml"
          class="topbar-content flex-1 text-sm leading-snug min-w-0 prose prose-sm prose-invert max-w-none"
        />
        <button
          class="shrink-0 opacity-70 hover:opacity-100 -mt-0.5"
          :title="t('dismiss')"
          @click="dismissTopbar"
        >
          <X class="w-4 h-4" />
        </button>
      </div>
    </div>

    <!-- MMR verification nudge — only for logged-in unverified players, dismissible per session -->
    <div v-if="showMmrBanner" class="bg-amber-500/15 border-b border-amber-500/30">
      <div class="max-w-[1400px] mx-auto w-full flex items-center gap-3 px-4 md:px-8 py-2">
        <ShieldAlert class="w-4 h-4 text-amber-400 shrink-0" />
        <p class="text-xs text-amber-100 flex-1">
          {{ t('mmrBannerText') }}
          <router-link to="/settings" class="text-amber-300 font-bold underline hover:text-amber-200 ml-1">
            {{ t('mmrBannerCta') }}
          </router-link>
        </p>
        <button
          type="button"
          class="p-1 rounded hover:bg-amber-500/15 text-amber-400/70 hover:text-amber-300 transition-colors shrink-0"
          :title="t('dismiss')"
          @click="dismissMmrBanner"
        >
          <X class="w-3.5 h-3.5" />
        </button>
      </div>
    </div>

    <!-- Shell: sidebar (desktop) + main column -->
    <div class="flex flex-row flex-1 min-h-0">
      <LeftSidebar
        :site-name="customSiteName"
        :logo-url="customLogoUrl"
        :is-dark="isDark"
        :is-logged-in="isLoggedIn"
        :my-match-count="myMatchCount"
        @toggle-theme="toggleTheme"
        @login="loginWithSteam"
        @logout="handleLogout"
      />
      <div class="flex-1 flex flex-col min-w-0">
    <!-- Top Bar (Pencil v7U1o style) -->
    <header
      class="border-b shrink-0"
      style="background:#0F172A;border-color:#1E293B"
      @click="showLangMenu = false; showUserMenu = false"
    >
      <div class="flex items-center h-[52px] px-6 gap-4">
        <!-- Left: hamburger (mobile) + breadcrumb (desktop) -->
        <div class="flex items-center gap-3 min-w-0">
          <button class="md:hidden p-1.5 rounded hover:bg-accent" @click="mobileMenuOpen = !mobileMenuOpen">
            <X v-if="mobileMenuOpen" class="w-5 h-5 text-foreground" />
            <Menu v-else class="w-5 h-5 text-foreground" />
          </button>
          <div class="hidden md:flex items-center gap-3 min-w-0">
            <router-link
              to="/"
              class="flex items-center gap-1.5 text-[14px] font-semibold transition-colors"
              :style="{ color: route.path === '/' ? '#F1F5F9' : '#94A3B8' }"
            >
              <Home class="w-3.5 h-3.5" />
              {{ t('home') }}
            </router-link>
            <template v-if="topbarPageLabel">
              <span class="text-[13px]" style="color:#475569">/</span>
              <span class="text-[13px] font-medium truncate" style="color:#22D3EE">{{ topbarPageLabel }}</span>
            </template>
          </div>
        </div>

        <!-- Center: search -->
        <div class="hidden md:flex flex-1 max-w-[960px] mx-auto">
          <GlobalSearch class="w-full" />
        </div>

        <!-- Right: bell + lang pill + divider + wallet -->
        <div class="flex items-center gap-3 shrink-0">
          <button v-if="isLoggedIn && !store.isAdmin.value && showClaimAdminButton" class="text-xs text-muted-foreground hover:text-foreground transition-colors" @click="showClaimAdmin = true">
            <Lock class="w-3.5 h-3.5" />
          </button>

          <!-- Bell (placeholder) -->
          <button
            class="hidden sm:flex relative w-9 h-9 rounded-md items-center justify-center transition-colors hover:bg-white/5"
            style="background:#0F172A;box-shadow:inset 0 0 0 1px #1E293B"
            :title="t('notifications')"
          >
            <Bell class="w-4 h-4" style="color:#94A3B8" />
            <span class="absolute w-2 h-2 rounded-full" style="top:7px;right:7px;background:#EF4444;box-shadow:0 0 0 2px #0F172A" />
          </button>

          <!-- Language pill -->
          <div class="relative hidden sm:block">
            <button
              class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-bold transition-colors hover:bg-white/5"
              style="background:#0F172A;box-shadow:inset 0 0 0 1px #1E293B;color:#F1F5F9"
              @click.stop="showLangMenu = !showLangMenu; showUserMenu = false"
            >
              <Globe class="w-3 h-3" style="color:#94A3B8" />
              {{ locale.toUpperCase() }}
            </button>
            <div v-if="showLangMenu" class="absolute right-0 top-full mt-2 rounded-xl bg-muted border border-border shadow-lg shadow-black/30 py-3 z-50 w-40" @click.stop>
              <div class="px-3.5 pb-2">
                <span class="text-[11px] font-semibold text-text-tertiary tracking-wider">Language</span>
              </div>
              <div class="h-px bg-border" />
              <button
                v-for="lang in languages"
                :key="lang.code"
                class="w-full flex items-center justify-between px-3.5 py-2 text-sm hover:bg-card/50 transition-colors rounded-md mx-0"
                @click="switchLang(lang.code)"
              >
                <div class="flex items-center gap-2">
                  <Check v-if="locale === lang.code" class="w-3.5 h-3.5 text-primary" />
                  <div v-else class="w-3.5 h-3.5" />
                  <span :class="locale === lang.code ? 'text-primary font-medium' : 'text-muted-foreground'">{{ lang.label }}</span>
                </div>
                <span class="text-[11px] font-mono" :class="locale === lang.code ? 'text-primary' : 'text-text-tertiary'">{{ lang.code.toUpperCase() }}</span>
              </button>
            </div>
          </div>

          <div class="w-px h-6 hidden sm:block" style="background:#1E293B" />

          <!-- Wallet (dotacoins) — or Login when logged out -->
          <div
            v-if="isLoggedIn"
            class="hidden sm:flex items-center gap-2 rounded-md px-3 py-1.5"
            style="background:#0F172A;box-shadow:inset 0 0 0 1px #1E293B"
            :title="t('dotacoins')"
          >
            <Coins class="w-3.5 h-3.5" style="color:#FACC15" />
            <span class="text-[12px] font-bold font-mono" style="color:#F1F5F9">{{ (store.currentUser.value?.dotacoins || 0).toLocaleString() }}</span>
          </div>
          <button
            v-else
            class="hidden sm:flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            @click="loginWithSteam"
          >
            <LogIn class="w-4 h-4" />
            {{ t('loginWithSteam') }}
          </button>
        </div>
      </div>
      <!-- Mobile Nav Dropdown -->
      <nav v-if="mobileMenuOpen" class="md:hidden flex flex-col gap-1 px-3 py-2 border-t border-border">
        <div class="px-1 pt-1 pb-2">
          <GlobalSearch />
        </div>
        <router-link to="/" class="flex items-center gap-3 px-3 py-2.5 rounded text-sm text-muted-foreground hover:bg-accent hover:text-foreground" @click="mobileMenuOpen = false">
          <Home class="w-[18px] h-[18px]" />
          {{ t('home') }}
        </router-link>
        <template v-for="root in navStore.tree.value" :key="root.id">
          <a
            v-if="root.is_external && root.path"
            :href="root.path"
            target="_blank"
            rel="noopener"
            class="flex items-center gap-3 px-3 py-2.5 rounded text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            @click="mobileMenuOpen = false"
          >
            <component :is="iconFor(root.icon)" class="w-[18px] h-[18px]" />
            {{ labelFor(root) }}
          </a>
          <template v-else>
            <router-link
              v-if="root.path"
              :to="root.path"
              class="flex items-center gap-3 px-3 py-2.5 rounded text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              @click="mobileMenuOpen = false"
            >
              <component :is="iconFor(root.icon)" class="w-[18px] h-[18px]" />
              {{ labelFor(root) }}
              <span v-if="root.badge === 'my-matches' && myMatchCount > 0" class="inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full px-1 text-[10px] font-bold bg-primary text-primary-foreground">{{ myMatchCount }}</span>
            </router-link>
            <div
              v-else
              class="flex items-center gap-3 px-3 py-2.5 text-sm font-semibold text-muted-foreground/80 uppercase tracking-wider"
            >
              <component :is="iconFor(root.icon)" class="w-[18px] h-[18px]" />
              {{ labelFor(root) }}
            </div>
            <!-- Mobile children: indented under their parent -->
            <template v-for="child in root.children" :key="child.id">
              <a
                v-if="child.is_external && child.path"
                :href="child.path"
                target="_blank"
                rel="noopener"
                class="flex items-center gap-3 pl-9 pr-3 py-2 rounded text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                @click="mobileMenuOpen = false"
              >
                <component :is="iconFor(child.icon)" class="w-[15px] h-[15px]" />
                {{ labelFor(child) }}
              </a>
              <router-link
                v-else-if="child.path"
                :to="child.path"
                class="flex items-center gap-3 pl-9 pr-3 py-2 rounded text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                @click="mobileMenuOpen = false"
              >
                <component :is="iconFor(child.icon)" class="w-[15px] h-[15px]" />
                {{ labelFor(child) }}
              </router-link>
              <span
                v-else
                class="flex items-center gap-3 pl-9 pr-3 py-2 text-xs text-muted-foreground/60 select-none"
              >
                <component :is="iconFor(child.icon)" class="w-[15px] h-[15px]" />
                {{ labelFor(child) }}
              </span>
            </template>
          </template>
        </template>
        <router-link v-if="isLoggedIn" to="/settings" class="flex items-center gap-3 px-3 py-2.5 rounded text-sm text-muted-foreground hover:bg-accent hover:text-foreground" @click="mobileMenuOpen = false">
          <Settings class="w-[18px] h-[18px]" />
          {{ t('settingsTitle') }}
        </router-link>
        <router-link v-if="store.canAccessAdmin.value" to="/admin" class="flex items-center gap-3 px-3 py-2.5 rounded text-sm text-muted-foreground hover:bg-accent hover:text-foreground" @click="mobileMenuOpen = false">
          <Shield class="w-[18px] h-[18px]" />
          {{ t('adminPanel') }}
        </router-link>
        <button v-if="!isLoggedIn" class="flex items-center gap-3 px-3 py-2.5 rounded text-sm text-muted-foreground hover:bg-accent hover:text-foreground" @click="loginWithSteam(); mobileMenuOpen = false">
          <LogIn class="w-[18px] h-[18px]" />
          {{ t('loginWithSteam') }}
        </button>
        <button v-else class="flex items-center gap-3 px-3 py-2.5 rounded text-sm text-destructive hover:bg-accent" @click="handleLogout(); mobileMenuOpen = false">
          <LogOut class="w-[18px] h-[18px]" />
          {{ t('logout') }}
        </button>
      </nav>
    </header>

    <!-- Main Content -->
    <main ref="mainRef" class="flex-1 overflow-hidden flex flex-col relative" :class="(route.path.startsWith('/admin') || route.path.startsWith('/c/')) ? '' : 'overflow-y-auto'">
      <!-- Background image (homepage only) -->
      <div v-if="heroBannerUrl && route.path === '/'" class="absolute inset-x-0 top-0 h-[40vh] overflow-hidden pointer-events-none z-0">
        <img :src="heroBannerUrl" class="w-full h-full object-cover" />
        <div class="absolute inset-0 bg-gradient-to-b from-background/60 via-background/40 to-background" />
      </div>
      <!-- Top gradient (all pages except homepage and admin) -->
      <div v-else-if="!route.path.startsWith('/admin')" class="absolute inset-x-0 top-0 h-48 bg-gradient-to-b from-muted to-background pointer-events-none z-0" />
      <router-view class="relative z-[1]" />
      <!-- Footer (only on public pages) -->
      <AppFooter v-if="!route.path.startsWith('/admin') && !route.path.startsWith('/c/')" class="mt-auto relative z-[1]" />
    </main>
      </div>
      <RightSidebar />
    </div>

    <!-- Global queue status overlay (hidden while on /queue) -->
    <QueueStatusOverlay />

    <!-- Global ready-check modal (visible on any route) -->
    <ReadyCheckModal />

    <!-- Global update-available modal (shown when server version changes mid-session) -->
    <UpdateAvailableModal />

    <!-- Claim Admin Modal -->
    <ModalOverlay :show="showClaimAdmin" @close="showClaimAdmin = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('claimAdminAccess') }}</h2>
        <p class="text-sm text-muted-foreground mt-1">{{ t('claimAdminDesc') }}</p>
      </div>
      <form class="px-7 py-5 flex flex-col gap-5" @submit.prevent="handleClaimAdmin">
        <InputGroup :label="t('adminPassword')" :model-value="adminPassword" :placeholder="t('enterAdminPassword')" type="password" @update:model-value="adminPassword = $event" />
        <p v-if="claimError" class="text-sm text-red-500">{{ claimError }}</p>
      </form>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" @click="handleClaimAdmin">
          <Shield class="w-4 h-4" />
          {{ t('claimAdmin') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showClaimAdmin = false">
          {{ t('cancel') }}
        </button>
      </div>
    </ModalOverlay>
  </div>
</template>
