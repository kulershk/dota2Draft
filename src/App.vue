<script setup lang="ts">
import { Gamepad2, Shield, Users, Gavel, Trophy, Lock, LogOut, Sun, Moon, Menu, X, Home } from 'lucide-vue-next'
import { useRoute, useRouter } from 'vue-router'
import { onMounted, ref, computed } from 'vue'
import { useDraftStore } from '@/composables/useDraftStore'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import InputGroup from '@/components/common/InputGroup.vue'

const route = useRoute()
const router = useRouter()
const store = useDraftStore()

const isDark = ref(localStorage.getItem('draft_theme') === 'dark')

function toggleTheme() {
  isDark.value = !isDark.value
  document.documentElement.classList.toggle('dark', isDark.value)
  localStorage.setItem('draft_theme', isDark.value ? 'dark' : 'light')
}

// Apply saved theme on load
if (isDark.value) {
  document.documentElement.classList.add('dark')
}

const showLoginModal = ref(false)
const loginTab = ref<'captain' | 'admin'>('captain')
const adminPassword = ref('')
const captainName = ref('')
const captainPassword = ref('')
const loginError = ref('')

onMounted(async () => {
  store.initSocket()
  store.fetchAll()

  // Check for auto-login token in URL first
  const token = new URLSearchParams(window.location.search).get('token')
  if (token) {
    try {
      await store.loginWithToken(token)
      const url = new URL(window.location.href)
      url.searchParams.delete('token')
      window.history.replaceState({}, '', url.pathname + url.search)
      router.push('/auction')
      return
    } catch {
      // Invalid token, ignore
    }
  }

  // Restore previous session
  await store.restoreAuth()
})

const navItems = computed(() => [
  { label: 'Home', icon: Home, path: '/' },
  { label: 'Player Pool', icon: Users, path: '/players' },
  { label: 'Live Auction', icon: Gavel, path: '/auction' },
  { label: 'Results', icon: Trophy, path: '/results' },
])

const mobileMenuOpen = ref(false)

const isLoggedIn = computed(() => store.isAdmin.value || !!store.currentCaptain.value)

const userRoleLabel = computed(() => {
  if (store.currentCaptain.value && store.isAdmin.value) return 'Captain (Admin)'
  if (store.isAdmin.value) return 'Admin'
  if (store.currentCaptain.value) return 'Captain'
  return 'Viewer'
})

const userNameLabel = computed(() => {
  if (store.currentCaptain.value) return store.currentCaptain.value.name
  if (store.isAdmin.value) return 'Lobby Host'
  return 'Spectator'
})

function openLoginModal() {
  loginError.value = ''
  adminPassword.value = ''
  captainName.value = ''
  captainPassword.value = ''
  showLoginModal.value = true
}

async function handleLogin() {
  loginError.value = ''
  try {
    if (loginTab.value === 'admin') {
      await store.loginAdmin(adminPassword.value)
      adminPassword.value = ''
      showLoginModal.value = false
      router.push('/admin')
    } else {
      await store.loginCaptain(captainName.value, captainPassword.value)
      captainName.value = ''
      captainPassword.value = ''
      showLoginModal.value = false
      router.push('/auction')
    }
  } catch {
    loginError.value = loginTab.value === 'admin' ? 'Invalid admin password' : 'Invalid captain name or password'
  }
}

function handleLogout() {
  if (store.currentCaptain.value) {
    store.logoutCaptain()
  }
  store.logoutAdmin()
  if (route.path.startsWith('/admin')) {
    router.push('/')
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
          <div class="flex items-center gap-2.5">
            <div class="w-8 h-8 rounded bg-primary flex items-center justify-center">
              <Gamepad2 class="w-4 h-4 text-primary-foreground" />
            </div>
            <span class="text-sm font-semibold text-foreground hidden sm:inline">DOTA2 DRAFT</span>
          </div>
          <!-- Desktop Nav Links -->
          <nav class="hidden md:flex items-center gap-1">
            <router-link
              v-for="item in navItems"
              :key="item.path"
              :to="item.path"
              class="flex items-center gap-2 px-3 py-1.5 rounded text-sm transition-colors"
              :class="(item.path === '/' ? route.path === '/' : route.path.startsWith(item.path))
                ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                : 'text-sidebar-foreground hover:bg-accent'"
            >
              <component :is="item.icon" class="w-4 h-4" />
              {{ item.label }}
            </router-link>
          </nav>
        </div>
        <!-- Right: User info + actions -->
        <div class="flex items-center gap-2">
          <router-link v-if="store.isAdmin.value" to="/admin" class="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors" :class="route.path.startsWith('/admin') ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'">
            <Shield class="w-3.5 h-3.5" />
            Admin
          </router-link>
          <span class="text-xs text-muted-foreground hidden sm:inline">{{ userRoleLabel }}: {{ userNameLabel }}</span>
          <button class="p-1.5 rounded hover:bg-accent" :title="isDark ? 'Light mode' : 'Dark mode'" @click="toggleTheme">
            <Moon v-if="!isDark" class="w-4 h-4 text-muted-foreground" />
            <Sun v-else class="w-4 h-4 text-muted-foreground" />
          </button>
          <button v-if="!isLoggedIn" class="p-1.5 rounded hover:bg-accent" title="Login" @click="openLoginModal">
            <Lock class="w-4 h-4 text-muted-foreground" />
          </button>
          <button v-else class="p-1.5 rounded hover:bg-accent" title="Logout" @click="handleLogout">
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
        <router-link
          v-for="item in navItems"
          :key="item.path"
          :to="item.path"
          class="flex items-center gap-3 px-3 py-2.5 rounded text-sm transition-colors"
          :class="route.path === item.path
            ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
            : 'text-sidebar-foreground hover:bg-accent'"
          @click="mobileMenuOpen = false"
        >
          <component :is="item.icon" class="w-[18px] h-[18px]" />
          {{ item.label }}
        </router-link>
        <router-link
          v-if="store.isAdmin.value"
          to="/admin"
          class="flex items-center gap-3 px-3 py-2.5 rounded text-sm transition-colors"
          :class="route.path.startsWith('/admin')
            ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
            : 'text-sidebar-foreground hover:bg-accent'"
          @click="mobileMenuOpen = false"
        >
          <Shield class="w-[18px] h-[18px]" />
          Admin Panel
        </router-link>
      </nav>
    </header>

    <!-- Main Content -->
    <main class="flex-1 overflow-hidden flex flex-col" :class="route.path.startsWith('/admin') ? '' : 'overflow-y-auto'">
      <router-view />
    </main>

    <!-- Login Modal -->
    <ModalOverlay :show="showLoginModal" @close="showLoginModal = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">Login</h2>
        <p class="text-sm text-muted-foreground mt-1">Sign in as a captain to bid, or as admin to manage the draft.</p>
      </div>
      <!-- Tabs -->
      <div class="flex border-b border-border">
        <button
          class="flex-1 py-3 text-sm font-medium text-center transition-colors"
          :class="loginTab === 'captain' ? 'text-primary border-b-2 border-primary' : 'text-muted-foreground hover:text-foreground'"
          @click="loginTab = 'captain'; loginError = ''"
        >Captain</button>
        <button
          class="flex-1 py-3 text-sm font-medium text-center transition-colors"
          :class="loginTab === 'admin' ? 'text-primary border-b-2 border-primary' : 'text-muted-foreground hover:text-foreground'"
          @click="loginTab = 'admin'; loginError = ''"
        >Admin</button>
      </div>
      <form class="px-7 py-5 flex flex-col gap-5" @submit.prevent="handleLogin">
        <template v-if="loginTab === 'captain'">
          <InputGroup label="Captain Name" :model-value="captainName" placeholder="e.g. Puppey" @update:model-value="captainName = $event" />
          <InputGroup label="Password" :model-value="captainPassword" placeholder="••••••••" type="password" @update:model-value="captainPassword = $event" />
        </template>
        <template v-else>
          <InputGroup label="Admin Password" :model-value="adminPassword" placeholder="••••••••" type="password" @update:model-value="adminPassword = $event" />
        </template>
        <p v-if="loginError" class="text-sm text-red-500">{{ loginError }}</p>
      </form>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" @click="handleLogin">
          <Lock class="w-4 h-4" />
          {{ loginTab === 'captain' ? 'Login as Captain' : 'Login as Admin' }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showLoginModal = false">
          Cancel
        </button>
      </div>
    </ModalOverlay>
  </div>
</template>
