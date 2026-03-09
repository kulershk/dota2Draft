<script setup lang="ts">
import { Gamepad2, Shield, LogOut, Sun, Moon, Menu, X, Home, LogIn, Lock, Globe, Settings, Swords } from 'lucide-vue-next'
import { useRoute, useRouter } from 'vue-router'
import { onMounted, ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDraftStore } from '@/composables/useDraftStore'
import { useApi } from '@/composables/useApi'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import InputGroup from '@/components/common/InputGroup.vue'
import { setLocale } from '@/i18n'

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const store = useDraftStore()

const isDark = ref(localStorage.getItem('draft_theme') === 'dark')

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
const customSiteName = ref('')
const customLogoUrl = ref('')

const languages = [
  { code: 'en', label: 'English' },
  { code: 'lt', label: 'Lietuvių' },
  { code: 'lv', label: 'Latviešu' },
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

const mobileMenuOpen = ref(false)

const isLoggedIn = computed(() => !!store.currentUser.value)

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
  <div class="flex flex-col h-screen bg-background">
    <!-- Top Navigation Bar -->
    <header class="bg-sidebar border-b border-sidebar-border">
      <div class="max-w-[1440px] mx-auto w-full flex items-center justify-between px-4 md:px-6 py-2.5">
        <!-- Left: Logo + Nav -->
        <div class="flex items-center gap-6">
          <router-link to="/" class="flex items-center gap-2.5">
            <img v-if="customLogoUrl" :src="customLogoUrl" class="w-8 h-8 rounded object-contain" />
            <div v-else class="w-8 h-8 rounded bg-primary flex items-center justify-center">
              <Gamepad2 class="w-4 h-4 text-primary-foreground" />
            </div>
            <span class="text-sm font-semibold text-foreground hidden sm:inline">{{ customSiteName || t('appTitle') }}</span>
          </router-link>
          <router-link to="/competitions" class="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors" :class="route.path === '/competitions' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'">
            <Swords class="w-3.5 h-3.5" />
            {{ t('competitions') }}
          </router-link>
        </div>
        <!-- Right: User info + actions -->
        <div class="flex items-center gap-2">
          <router-link v-if="store.canAccessAdmin.value" to="/admin" class="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors" :class="route.path.startsWith('/admin') ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'">
            <Shield class="w-3.5 h-3.5" />
            {{ t('admin') }}
          </router-link>
          <button v-if="isLoggedIn && !store.isAdmin.value && showClaimAdminButton" class="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors" @click="showClaimAdmin = true">
            <Lock class="w-3.5 h-3.5" />
            {{ t('claimAdmin') }}
          </button>
          <template v-if="isLoggedIn">
            <router-link to="/settings" class="p-1.5 rounded hover:bg-accent" :title="t('settingsTitle')">
              <Settings class="w-4 h-4 text-muted-foreground" />
            </router-link>
            <div class="flex items-center gap-2 hidden sm:flex">
              <img v-if="store.currentUser.value?.avatar_url" :src="store.currentUser.value.avatar_url" class="w-6 h-6 rounded-full" />
              <span class="text-xs text-muted-foreground">{{ userRoleLabel }}: {{ store.currentUser.value?.name }}</span>
            </div>
          </template>
          <!-- Language switcher -->
          <div class="relative">
            <button class="p-1.5 rounded hover:bg-accent" :title="t('language')" @click="showLangMenu = !showLangMenu">
              <Globe class="w-4 h-4 text-muted-foreground" />
            </button>
            <div v-if="showLangMenu" class="absolute right-0 top-full mt-1 bg-card border border-border rounded-lg shadow-lg py-1 z-50 min-w-[120px]">
              <button
                v-for="lang in languages"
                :key="lang.code"
                class="w-full text-left px-3 py-1.5 text-sm hover:bg-accent transition-colors"
                :class="locale === lang.code ? 'text-primary font-medium' : 'text-foreground'"
                @click="switchLang(lang.code)"
              >
                {{ lang.label }}
              </button>
            </div>
          </div>
          <button class="p-1.5 rounded hover:bg-accent" :title="isDark ? t('lightMode') : t('darkMode')" @click="toggleTheme">
            <Moon v-if="!isDark" class="w-4 h-4 text-muted-foreground" />
            <Sun v-else class="w-4 h-4 text-muted-foreground" />
          </button>
          <button v-if="!isLoggedIn" class="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors" @click="loginWithSteam">
            <LogIn class="w-3.5 h-3.5" />
            {{ t('loginWithSteam') }}
          </button>
          <button v-else class="p-1.5 rounded hover:bg-accent" :title="t('logout')" @click="handleLogout">
            <LogOut class="w-4 h-4 text-muted-foreground" />
          </button>
          <!-- Mobile hamburger -->
          <button class="md:hidden p-1.5 rounded hover:bg-accent" @click="mobileMenuOpen = !mobileMenuOpen">
            <X v-if="mobileMenuOpen" class="w-5 h-5 text-foreground" />
            <Menu v-else class="w-5 h-5 text-foreground" />
          </button>
        </div>
      </div>
      <!-- Mobile Nav Dropdown -->
      <nav v-if="mobileMenuOpen" class="md:hidden flex flex-col gap-1 px-3 py-2 border-t border-sidebar-border">
        <router-link to="/" class="flex items-center gap-3 px-3 py-2.5 rounded text-sm text-sidebar-foreground hover:bg-accent" @click="mobileMenuOpen = false">
          <Home class="w-[18px] h-[18px]" />
          {{ t('home') }}
        </router-link>
        <router-link to="/competitions" class="flex items-center gap-3 px-3 py-2.5 rounded text-sm text-sidebar-foreground hover:bg-accent" @click="mobileMenuOpen = false">
          <Swords class="w-[18px] h-[18px]" />
          {{ t('competitions') }}
        </router-link>
        <router-link v-if="isLoggedIn" to="/settings" class="flex items-center gap-3 px-3 py-2.5 rounded text-sm text-sidebar-foreground hover:bg-accent" @click="mobileMenuOpen = false">
          <Settings class="w-[18px] h-[18px]" />
          {{ t('settingsTitle') }}
        </router-link>
        <router-link
          v-if="store.canAccessAdmin.value"
          to="/admin"
          class="flex items-center gap-3 px-3 py-2.5 rounded text-sm transition-colors"
          :class="route.path.startsWith('/admin')
            ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
            : 'text-sidebar-foreground hover:bg-accent'"
          @click="mobileMenuOpen = false"
        >
          <Shield class="w-[18px] h-[18px]" />
          {{ t('adminPanel') }}
        </router-link>
        <button v-if="!isLoggedIn" class="flex items-center gap-3 px-3 py-2.5 rounded text-sm text-sidebar-foreground hover:bg-accent" @click="loginWithSteam(); mobileMenuOpen = false">
          <LogIn class="w-[18px] h-[18px]" />
          {{ t('loginWithSteam') }}
        </button>
      </nav>
    </header>

    <!-- Main Content -->
    <main class="flex-1 overflow-hidden flex flex-col" :class="(route.path.startsWith('/admin') || route.path.startsWith('/c/')) ? '' : 'overflow-y-auto'">
      <router-view />
      <!-- Footer (only on public pages) -->
      <footer v-if="!route.path.startsWith('/admin') && !route.path.startsWith('/c/')" class="mt-auto border-t border-border bg-sidebar">
        <div class="max-w-[1440px] mx-auto px-4 md:px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div class="flex items-center gap-2">
            <img v-if="customLogoUrl" :src="customLogoUrl" class="w-6 h-6 rounded object-contain" />
            <div v-else class="w-6 h-6 rounded bg-primary flex items-center justify-center">
              <Gamepad2 class="w-3 h-3 text-primary-foreground" />
            </div>
            <span class="text-xs font-semibold text-foreground">{{ customSiteName || t('appTitle') }}</span>
          </div>
          <p class="text-xs text-muted-foreground">&copy; {{ new Date().getFullYear() }} {{ customSiteName || t('appTitle') }}. {{ t('allRightsReserved') }}</p>
        </div>
      </footer>
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
