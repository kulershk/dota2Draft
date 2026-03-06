<script setup lang="ts">
import { Gamepad2, Settings, Users, Gavel, Trophy, Lock, LogOut } from 'lucide-vue-next'
import { useRoute, useRouter } from 'vue-router'
import { onMounted, ref, computed } from 'vue'
import { useDraftStore } from '@/composables/useDraftStore'
import ModalOverlay from '@/components/ModalOverlay.vue'
import InputGroup from '@/components/InputGroup.vue'

const route = useRoute()
const router = useRouter()
const store = useDraftStore()

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
  ...(store.isAdmin.value ? [{ label: 'Draft Setup', icon: Settings, path: '/' }] : []),
  { label: 'Player Pool', icon: Users, path: '/players' },
  { label: 'Live Auction', icon: Gavel, path: '/auction' },
  { label: 'Results', icon: Trophy, path: '/results' },
])

const isLoggedIn = computed(() => store.isAdmin.value || !!store.currentCaptain.value)

const userRoleLabel = computed(() => {
  if (store.isAdmin.value) return 'Admin'
  if (store.currentCaptain.value) return 'Captain'
  return 'Viewer'
})

const userNameLabel = computed(() => {
  if (store.isAdmin.value) return 'Lobby Host'
  if (store.currentCaptain.value) return store.currentCaptain.value.name
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
      router.push('/')
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
  if (route.path === '/') {
    router.push('/players')
  }
}
</script>

<template>
  <div class="flex h-screen bg-background">
    <!-- Sidebar -->
    <aside class="w-[260px] flex-shrink-0 flex flex-col bg-sidebar border-r border-sidebar-border">
      <!-- Logo -->
      <div class="flex items-center gap-3 px-5 py-5">
        <div class="w-9 h-9 rounded bg-primary flex items-center justify-center">
          <Gamepad2 class="w-5 h-5 text-primary-foreground" />
        </div>
        <span class="text-base font-semibold text-foreground">DOTA2 DRAFT</span>
      </div>

      <!-- Nav Section -->
      <div class="px-3 mt-2">
        <p class="px-3 mb-2 text-[11px] font-semibold tracking-[2px] text-muted-foreground uppercase">
          Draft Menu
        </p>
        <nav class="flex flex-col gap-1">
          <router-link
            v-for="item in navItems"
            :key="item.path"
            :to="item.path"
            class="flex items-center gap-3 px-3 py-2 rounded text-sm transition-colors"
            :class="route.path === item.path
              ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
              : 'text-sidebar-foreground hover:bg-accent'"
          >
            <component :is="item.icon" class="w-[18px] h-[18px]" />
            {{ item.label }}
          </router-link>
        </nav>
      </div>

      <!-- Spacer -->
      <div class="flex-1" />

      <!-- User section -->
      <div class="flex items-center justify-between px-5 py-4 border-t border-sidebar-border">
        <div>
          <p class="text-xs text-muted-foreground">{{ userRoleLabel }}</p>
          <p class="text-sm font-medium text-foreground">{{ userNameLabel }}</p>
        </div>
        <button v-if="!isLoggedIn" class="p-1 rounded hover:bg-accent" title="Login" @click="openLoginModal">
          <Lock class="w-4 h-4 text-muted-foreground" />
        </button>
        <button v-else class="p-1 rounded hover:bg-accent" title="Logout" @click="handleLogout">
          <LogOut class="w-4 h-4 text-muted-foreground" />
        </button>
      </div>
    </aside>

    <!-- Main Content -->
    <main class="flex-1 overflow-y-auto">
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
