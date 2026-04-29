<script setup lang="ts">
import { Gamepad2, Shield, ShieldAlert, LogOut, Sun, Moon, Menu, X, Home, LogIn, Lock, Globe, Settings, Swords, Info, Radio, ChevronDown, Check, LayoutDashboard, Bell, User, Newspaper, Calendar, Trophy, Medal, Ban } from 'lucide-vue-next'
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
const customSiteName = ref('')
const customLogoUrl = ref('')
const discordUrl = ref('')
const heroBannerUrl = ref('')

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

  useApi().getSiteSettings().then(data => {
    customSiteName.value = data.site_name || ''
    customLogoUrl.value = data.site_logo_url || ''
    discordUrl.value = data.site_discord_url || ''
    heroBannerUrl.value = data.site_hero_banner_url || ''
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

    <!-- Top Navigation Bar -->
    <header class="bg-muted border-b border-border" @click="showLangMenu = false; showUserMenu = false">
      <div class="max-w-[1400px] mx-auto w-full flex items-center justify-between px-4 md:px-8 h-14">
        <!-- Left: Logo + Divider + Nav Links -->
        <div class="flex items-center gap-7 h-full">
          <router-link to="/" class="flex items-center gap-2.5">
            <img v-if="customLogoUrl" :src="customLogoUrl" class="w-[52px] h-[52px] rounded-md object-contain" />
            <div v-else class="w-[52px] h-[52px] rounded-md bg-primary flex items-center justify-center">
              <Gamepad2 class="w-7 h-7 text-primary-foreground" />
            </div>
          </router-link>
          <div class="w-px h-6 bg-border hidden sm:block" />
          <nav class="hidden sm:flex items-center gap-1 h-full">
            <template v-for="root in navStore.tree.value" :key="root.id">
              <!-- Item without children: simple link (or label if no path) -->
              <template v-if="root.children.length === 0">
                <a
                  v-if="root.is_external && root.path"
                  :href="root.path"
                  target="_blank"
                  rel="noopener"
                  class="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] tracking-wide transition-colors text-muted-foreground hover:text-foreground border border-transparent"
                >
                  <component :is="iconFor(root.icon)" class="w-[15px] h-[15px]" />
                  {{ labelFor(root) }}
                </a>
                <router-link
                  v-else-if="root.path"
                  :to="root.path"
                  class="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] tracking-wide transition-colors"
                  :class="isActive(root)
                    ? 'bg-primary/15 text-primary font-semibold border border-primary/30'
                    : 'text-muted-foreground hover:text-foreground border border-transparent'"
                >
                  <component :is="iconFor(root.icon)" class="w-[15px] h-[15px]" />
                  {{ labelFor(root) }}
                  <span v-if="root.badge === 'my-matches' && myMatchCount > 0" class="inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full px-1 text-[10px] font-bold bg-primary text-primary-foreground">{{ myMatchCount }}</span>
                </router-link>
                <span
                  v-else
                  class="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] tracking-wide text-muted-foreground/60 border border-transparent select-none"
                >
                  <component :is="iconFor(root.icon)" class="w-[15px] h-[15px]" />
                  {{ labelFor(root) }}
                </span>
              </template>

              <!-- Item with children: dropdown trigger -->
              <div
                v-else
                class="relative h-full flex items-center"
                @mouseenter="openDropdown(root.id)"
                @mouseleave="scheduleCloseDropdown"
              >
                <router-link
                  v-if="root.path"
                  :to="root.path"
                  class="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] tracking-wide transition-colors"
                  :class="isAnyActive(root) || openDropdownId === root.id
                    ? 'bg-primary/15 text-primary font-semibold border border-primary/30'
                    : 'text-muted-foreground hover:text-foreground border border-transparent'"
                  @click="toggleDropdown(root.id)"
                >
                  <component :is="iconFor(root.icon)" class="w-[15px] h-[15px]" />
                  {{ labelFor(root) }}
                  <ChevronDown
                    class="w-3.5 h-3.5 transition-transform"
                    :class="openDropdownId === root.id ? 'rotate-180' : ''"
                  />
                </router-link>
                <button
                  v-else
                  type="button"
                  class="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] tracking-wide transition-colors"
                  :class="isAnyActive(root) || openDropdownId === root.id
                    ? 'bg-primary/15 text-primary font-semibold border border-primary/30'
                    : 'text-muted-foreground hover:text-foreground border border-transparent'"
                  @click="toggleDropdown(root.id)"
                >
                  <component :is="iconFor(root.icon)" class="w-[15px] h-[15px]" />
                  {{ labelFor(root) }}
                  <ChevronDown
                    class="w-3.5 h-3.5 transition-transform"
                    :class="openDropdownId === root.id ? 'rotate-180' : ''"
                  />
                </button>

                <!-- Dropdown panel -->
                <div
                  v-if="openDropdownId === root.id"
                  class="absolute left-0 top-full mt-2 rounded-xl bg-card border border-border shadow-lg shadow-black/40 z-40"
                  :style="{ minWidth: groupChildren(root.children).length > 1 ? '520px' : '240px' }"
                  @mouseenter="openDropdown(root.id)"
                  @mouseleave="scheduleCloseDropdown"
                  @click="closeDropdown"
                >
                  <div class="grid p-3 gap-3" :style="{ gridTemplateColumns: `repeat(${groupChildren(root.children).length}, minmax(0, 1fr))` }">
                    <div v-for="(group, gi) in groupChildren(root.children)" :key="gi" class="flex flex-col gap-1 min-w-[200px]">
                      <p v-if="group.label" class="px-2 pt-1 pb-1 text-[10px] font-mono font-semibold uppercase tracking-[1.5px] text-text-tertiary">
                        {{ group.label }}
                      </p>
                      <template v-for="child in group.items" :key="child.id">
                        <a
                          v-if="child.is_external && child.path"
                          :href="child.path"
                          target="_blank"
                          rel="noopener"
                          class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                        >
                          <component :is="iconFor(child.icon)" class="w-4 h-4 shrink-0" />
                          <span class="flex-1 truncate">{{ labelFor(child) }}</span>
                        </a>
                        <router-link
                          v-else-if="child.path"
                          :to="child.path"
                          class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors"
                          :class="isActive(child)
                            ? 'bg-primary/10 text-primary'
                            : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground'"
                        >
                          <component :is="iconFor(child.icon)" class="w-4 h-4 shrink-0" />
                          <span class="flex-1 truncate">{{ labelFor(child) }}</span>
                        </router-link>
                        <span
                          v-else
                          class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground/60 select-none"
                        >
                          <component :is="iconFor(child.icon)" class="w-4 h-4 shrink-0" />
                          <span class="flex-1 truncate">{{ labelFor(child) }}</span>
                        </span>
                      </template>
                    </div>
                  </div>
                </div>
              </div>
            </template>
          </nav>
        </div>

        <!-- Right: Live + Divider + Lang + Divider + User -->
        <div class="flex items-center gap-4 h-full">
          <!-- Claim admin (hidden unless ?admin) -->
          <button v-if="isLoggedIn && !store.isAdmin.value && showClaimAdminButton" class="text-xs text-muted-foreground hover:text-foreground transition-colors" @click="showClaimAdmin = true">
            <Lock class="w-3.5 h-3.5" />
          </button>

          <!-- Global search (desktop only — mobile gets it inside the menu) -->
          <div class="hidden md:block">
            <GlobalSearch />
          </div>

          <!-- Language -->
          <div class="relative hidden sm:block">
            <button
              class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
              @click.stop="showLangMenu = !showLangMenu; showUserMenu = false"
            >
              <Globe class="w-3.5 h-3.5 text-text-tertiary" />
              {{ locale.toUpperCase() }}
              <ChevronDown class="w-3 h-3 text-text-tertiary" />
            </button>
            <!-- Language Dropdown -->
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

          <div class="w-px h-6 bg-border hidden sm:block" />

          <!-- User Area -->
          <template v-if="isLoggedIn">
            <div class="relative">
              <button
                class="flex items-center gap-2.5 cursor-pointer"
                @click.stop="showUserMenu = !showUserMenu; showLangMenu = false"
              >
                <div class="relative w-8 h-8 rounded-full overflow-hidden border-[1.5px] border-primary/40">
                  <img v-if="store.currentUser.value?.avatar_url" :src="store.currentUser.value.avatar_url" class="w-full h-full object-cover" />
                  <div v-else class="w-full h-full bg-card flex items-center justify-center">
                    <User class="w-4 h-4 text-primary" />
                  </div>
                </div>
                <div class="hidden sm:flex flex-col">
                  <span class="text-sm font-medium text-foreground leading-tight">{{ store.currentUser.value?.name }}</span>
                  <span class="text-[9px] font-semibold font-mono text-primary">{{ userRoleLabel }}</span>
                </div>
                <ChevronDown class="w-3.5 h-3.5 text-text-tertiary hidden sm:block" />
              </button>

              <!-- User Dropdown -->
              <div v-if="showUserMenu" class="absolute right-0 top-full mt-2 rounded-xl bg-muted border border-border shadow-lg shadow-black/30 z-50 w-56" @click.stop>
                <!-- User header -->
                <div class="flex items-center gap-3 px-4 py-3 border-b border-border">
                  <div class="w-9 h-9 rounded-full overflow-hidden border-[1.5px] border-primary/40 shrink-0">
                    <img v-if="store.currentUser.value?.avatar_url" :src="store.currentUser.value.avatar_url" class="w-full h-full object-cover" />
                    <div v-else class="w-full h-full bg-card flex items-center justify-center">
                      <User class="w-[18px] h-[18px] text-primary" />
                    </div>
                  </div>
                  <div class="flex flex-col min-w-0">
                    <span class="text-sm font-semibold text-foreground truncate">{{ store.currentUser.value?.name }}</span>
                    <span class="text-[11px] text-text-tertiary truncate">{{ store.currentUser.value?.steam_id }}</span>
                  </div>
                </div>
                <!-- Role badge -->
                <div v-if="store.currentUser.value?.is_admin" class="px-4 py-2 border-b border-border">
                  <span class="badge-accent">ADMIN</span>
                </div>
                <!-- Menu items -->
                <div class="py-1">
                  <router-link v-if="store.currentUser.value?.id" :to="{ name: 'player-profile', params: { id: store.currentUser.value.id } }" class="flex items-center gap-3 px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground hover:bg-card/50 transition-colors" @click="showUserMenu = false">
                    <User class="w-4 h-4" />
                    {{ t('myProfile') }}
                  </router-link>
                  <router-link to="/settings" class="flex items-center gap-3 px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground hover:bg-card/50 transition-colors" @click="showUserMenu = false">
                    <Settings class="w-4 h-4" />
                    {{ t('settingsTitle') }}
                  </router-link>
                  <router-link v-if="store.canAccessAdmin.value" to="/admin" class="flex items-center gap-3 px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground hover:bg-card/50 transition-colors" @click="showUserMenu = false">
                    <Shield class="w-4 h-4" />
                    {{ t('adminPanel') || 'Admin Panel' }}
                  </router-link>
                  <button class="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground hover:bg-card/50 transition-colors" @click="toggleTheme">
                    <Moon v-if="isDark" class="w-4 h-4" />
                    <Sun v-else class="w-4 h-4" />
                    {{ isDark ? t('lightMode') : t('darkMode') }}
                  </button>
                </div>
                <!-- Sign out -->
                <div class="h-px bg-border" />
                <button class="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-destructive hover:bg-card/50 transition-colors" @click="handleLogout(); showUserMenu = false">
                  <LogOut class="w-4 h-4" />
                  {{ t('logout') }}
                </button>
              </div>
            </div>
          </template>
          <template v-else>
            <button class="p-1.5 rounded hover:bg-accent" :title="isDark ? t('lightMode') : t('darkMode')" @click="toggleTheme">
              <Moon v-if="isDark" class="w-4 h-4 text-muted-foreground" />
              <Sun v-else class="w-4 h-4 text-muted-foreground" />
            </button>
            <button class="flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors" @click="loginWithSteam">
              <LogIn class="w-4 h-4" />
              {{ t('loginWithSteam') }}
            </button>
          </template>

          <!-- Mobile hamburger -->
          <button class="md:hidden p-1.5 rounded hover:bg-accent" @click="mobileMenuOpen = !mobileMenuOpen">
            <X v-if="mobileMenuOpen" class="w-5 h-5 text-foreground" />
            <Menu v-else class="w-5 h-5 text-foreground" />
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
