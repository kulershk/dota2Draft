<script setup lang="ts">
import { Gamepad2, Shield, LogOut, Sun, Moon, Menu, X, Home, LogIn, Lock, Globe, Settings, Swords, Info, Radio, ChevronDown, Check, LayoutDashboard, Bell, User, Newspaper, Calendar, Trophy } from 'lucide-vue-next'
import { useRoute, useRouter } from 'vue-router'
import { onMounted, ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDraftStore } from '@/composables/useDraftStore'
import { useApi } from '@/composables/useApi'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import AppFooter from '@/components/common/AppFooter.vue'
import InputGroup from '@/components/common/InputGroup.vue'
import { setLocale } from '@/i18n'
import { getSocket } from '@/composables/useSocket'

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const store = useDraftStore()

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
  store.fetchCompetitions()

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
</script>

<template>
  <div class="flex flex-col h-screen bg-background" @click="showLangMenu = false; showUserMenu = false">
    <!-- Top Navigation Bar -->
    <header class="bg-muted border-b border-border" @click="showLangMenu = false; showUserMenu = false">
      <div class="max-w-[1200px] mx-auto w-full flex items-center justify-between px-4 md:px-8 h-14">
        <!-- Left: Logo + Divider + Nav Links -->
        <div class="flex items-center gap-7 h-full">
          <router-link to="/" class="flex items-center gap-2.5">
            <img v-if="customLogoUrl" :src="customLogoUrl" class="w-7 h-7 rounded-md object-contain" />
            <div v-else class="w-7 h-7 rounded-md bg-primary flex items-center justify-center">
              <Gamepad2 class="w-4 h-4 text-primary-foreground" />
            </div>
            <span class="text-lg font-extrabold text-foreground tracking-tight hidden sm:inline">{{ customSiteName || t('appTitle') }}</span>
          </router-link>
          <div class="w-px h-6 bg-border hidden sm:block" />
          <nav class="hidden sm:flex items-center gap-1 h-full">
            <router-link
              to="/competitions"
              class="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] tracking-wide transition-colors"
              :class="route.path === '/competitions' || route.path.startsWith('/c/')
                ? 'bg-primary/15 text-primary font-semibold border border-primary/30'
                : 'text-muted-foreground hover:text-foreground'"
            >
              <Swords class="w-[15px] h-[15px]" />
              {{ t('competitions') }}
            </router-link>
            <router-link
              to="/matches"
              class="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] tracking-wide transition-colors"
              :class="route.path === '/matches'
                ? 'bg-primary/15 text-primary font-semibold border border-primary/30'
                : 'text-muted-foreground hover:text-foreground'"
            >
              <Calendar class="w-[15px] h-[15px]" />
              {{ t('navMatches') }}
              <span v-if="myMatchCount > 0" class="inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full px-1 text-[10px] font-bold bg-primary text-primary-foreground">{{ myMatchCount }}</span>
            </router-link>
            <router-link
              to="/news"
              class="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] tracking-wide transition-colors"
              :class="route.path.startsWith('/news')
                ? 'bg-primary/15 text-primary font-semibold border border-primary/30'
                : 'text-muted-foreground hover:text-foreground'"
            >
              <Newspaper class="w-[15px] h-[15px]" />
              {{ t('newsNav') }}
            </router-link>
            <router-link
              to="/leaderboard"
              class="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] tracking-wide transition-colors"
              :class="route.path === '/leaderboard'
                ? 'bg-primary/15 text-primary font-semibold border border-primary/30'
                : 'text-muted-foreground hover:text-foreground'"
            >
              <Trophy class="w-[15px] h-[15px]" />
              {{ t('leaderboard') }}
            </router-link>
          </nav>
        </div>

        <!-- Right: Live + Divider + Lang + Divider + User -->
        <div class="flex items-center gap-4 h-full">
          <!-- Claim admin (hidden unless ?admin) -->
          <button v-if="isLoggedIn && !store.isAdmin.value && showClaimAdminButton" class="text-xs text-muted-foreground hover:text-foreground transition-colors" @click="showClaimAdmin = true">
            <Lock class="w-3.5 h-3.5" />
          </button>

          <!-- Discord -->
          <a v-if="discordUrl" :href="discordUrl" target="_blank" rel="noopener noreferrer" class="hidden sm:flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-[#5865F2] transition-colors" title="Discord">
            <svg class="w-4.5 h-4.5" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
          </a>

          <div class="w-px h-6 bg-border hidden sm:block" />

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
        <router-link to="/" class="flex items-center gap-3 px-3 py-2.5 rounded text-sm text-muted-foreground hover:bg-accent hover:text-foreground" @click="mobileMenuOpen = false">
          <Home class="w-[18px] h-[18px]" />
          {{ t('home') }}
        </router-link>
        <router-link to="/competitions" class="flex items-center gap-3 px-3 py-2.5 rounded text-sm text-muted-foreground hover:bg-accent hover:text-foreground" @click="mobileMenuOpen = false">
          <Swords class="w-[18px] h-[18px]" />
          {{ t('competitions') }}
        </router-link>
        <router-link to="/matches" class="flex items-center gap-3 px-3 py-2.5 rounded text-sm text-muted-foreground hover:bg-accent hover:text-foreground" @click="mobileMenuOpen = false">
          <Calendar class="w-[18px] h-[18px]" />
          {{ t('navMatches') }}
          <span v-if="myMatchCount > 0" class="inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full px-1 text-[10px] font-bold bg-primary text-primary-foreground">{{ myMatchCount }}</span>
        </router-link>
        <router-link to="/news" class="flex items-center gap-3 px-3 py-2.5 rounded text-sm text-muted-foreground hover:bg-accent hover:text-foreground" @click="mobileMenuOpen = false">
          <Newspaper class="w-[18px] h-[18px]" />
          {{ t('newsNav') }}
        </router-link>
        <router-link to="/leaderboard" class="flex items-center gap-3 px-3 py-2.5 rounded text-sm text-muted-foreground hover:bg-accent hover:text-foreground" @click="mobileMenuOpen = false">
          <Trophy class="w-[18px] h-[18px]" />
          {{ t('leaderboard') }}
        </router-link>
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
