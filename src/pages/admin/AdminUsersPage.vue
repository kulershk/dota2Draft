<script setup lang="ts">
import { Users, Search, Shield, ShieldOff, ExternalLink, Ban, CheckCircle, LogIn, UserPlus } from 'lucide-vue-next'
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import ModalOverlay from '@/components/common/ModalOverlay.vue'

const { t } = useI18n()
const api = useApi()
const store = useDraftStore()

interface PermGroupRef {
  id: number
  name: string
}

interface User {
  id: number
  name: string
  steam_id: string | null
  avatar_url: string | null
  roles: string[]
  mmr: number
  info: string
  is_admin: boolean
  is_banned: boolean
  created_at: string
  permission_groups: PermGroupRef[]
}

const users = ref<User[]>([])
const searchQuery = ref('')
const loading = ref(false)
const usersPage = ref(1)
const USERS_PAGE_SIZE = 20

async function fetchUsers() {
  loading.value = true
  try {
    users.value = await api.getUsers()
  } finally {
    loading.value = false
  }
}
fetchUsers()

const filteredUsers = computed(() => {
  let list = [...users.value]
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter(u => u.name.toLowerCase().includes(q) || u.steam_id?.includes(q))
  }
  return list
})

const paginatedUsers = computed(() => filteredUsers.value.slice(0, usersPage.value * USERS_PAGE_SIZE))
const hasMoreUsers = computed(() => paginatedUsers.value.length < filteredUsers.value.length)

watch(searchQuery, () => { usersPage.value = 1 })

const adminConfirmUser = ref<User | null>(null)
const banConfirmUser = ref<User | null>(null)

function promptToggleAdmin(user: User) {
  adminConfirmUser.value = user
}

async function confirmToggleAdmin() {
  if (!adminConfirmUser.value) return
  await api.updatePlayer(adminConfirmUser.value.id, { is_admin: !adminConfirmUser.value.is_admin })
  adminConfirmUser.value = null
  await fetchUsers()
}

function promptToggleBan(user: User) {
  banConfirmUser.value = user
}

async function confirmToggleBan() {
  if (!banConfirmUser.value) return
  await api.updatePlayer(banConfirmUser.value.id, { is_banned: !banConfirmUser.value.is_banned })
  banConfirmUser.value = null
  await fetchUsers()
}

async function impersonateUser(user: User) {
  const { token } = await api.impersonateUser(user.id)
  await store.loginWithAuthToken(token)
  window.location.href = '/'
}

const generateCount = ref(5)
const generating = ref(false)

async function generateTestUsers() {
  generating.value = true
  try {
    await api.generateTestUsers(generateCount.value)
    await fetchUsers()
  } catch (e: any) {
    alert(e.message)
  } finally {
    generating.value = false
  }
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[1200px] mx-auto w-full">
    <div>
      <h1 class="text-2xl font-semibold text-foreground">{{ t('steamUsers') }}</h1>
      <p class="text-sm text-muted-foreground mt-1">{{ t('steamUsersSubtitle') }}</p>
    </div>

    <div class="flex gap-4">
      <div class="card p-4">
        <p class="text-xs font-semibold tracking-wider text-muted-foreground uppercase">{{ t('totalAccounts') }}</p>
        <p class="text-3xl font-bold text-foreground mt-1">{{ users.length }}</p>
      </div>
      <div class="card p-4">
        <p class="text-xs font-semibold tracking-wider text-muted-foreground uppercase">{{ t('banned') }}</p>
        <p class="text-3xl font-bold text-destructive mt-1">{{ users.filter(u => u.is_banned).length }}</p>
      </div>
      <div class="card p-4 flex items-center gap-3 ml-auto">
        <p class="text-xs font-semibold tracking-wider text-muted-foreground uppercase whitespace-nowrap">{{ t('generateTestUsers') }}</p>
        <input v-model.number="generateCount" type="number" min="1" max="50" class="input-field !h-9 !w-20 text-center" />
        <button class="btn-primary text-sm whitespace-nowrap" :disabled="generating" @click="generateTestUsers">
          <UserPlus class="w-4 h-4" />
          {{ generating ? t('generating') : t('generate') }}
        </button>
      </div>
    </div>

    <div class="card">
      <div class="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
        <div class="flex items-center gap-2">
          <Users class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">{{ t('users', { count: filteredUsers.length }) }}</span>
        </div>
        <div class="relative">
          <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input v-model="searchQuery" type="text" :placeholder="t('search')" class="input-field pl-9 w-56" />
        </div>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border bg-accent/50">
              <th class="text-left px-4 py-3 font-medium text-muted-foreground w-[40px]">#</th>
              <th class="text-left px-4 py-3 font-medium text-muted-foreground">{{ t('user') }}</th>
              <th class="text-left px-4 py-3 font-medium text-muted-foreground">{{ t('status') }}</th>
              <th class="text-left px-4 py-3 font-medium text-muted-foreground w-[100px]">{{ t('joined') }}</th>
              <th class="text-left px-4 py-3 font-medium text-muted-foreground w-[120px]">{{ t('actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(user, i) in paginatedUsers" :key="user.id" class="border-b border-border hover:bg-accent/30 transition-colors" :class="user.is_banned ? 'opacity-60' : ''">
              <td class="px-4 py-3 text-muted-foreground">{{ String(i + 1).padStart(2, '0') }}</td>
              <td class="px-4 py-3">
                <div class="flex items-center gap-2.5">
                  <img v-if="user.avatar_url" :src="user.avatar_url" class="w-8 h-8 rounded-full object-cover" />
                  <div v-else class="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-xs font-semibold text-secondary-foreground">
                    {{ user.name.charAt(0) }}
                  </div>
                  <div class="flex flex-col">
                    <span class="font-medium text-foreground">{{ user.name }}</span>
                    <div v-if="user.steam_id" class="flex items-center gap-2 mt-0.5">
                      <a :href="`https://steamcommunity.com/profiles/${user.steam_id}`" target="_blank" rel="noopener" class="text-[10px] text-muted-foreground hover:text-primary transition-colors flex items-center gap-0.5">
                        Steam <ExternalLink class="w-2.5 h-2.5" />
                      </a>
                    </div>
                  </div>
                </div>
              </td>
              <td class="px-4 py-3">
                <div class="flex flex-wrap gap-1">
                  <span v-if="user.is_banned" class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-red-500/15 text-red-600 dark:text-red-400 w-fit">{{ t('banned') }}</span>
                  <span v-if="user.is_admin" class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400 w-fit">{{ t('rootAdmin') }}</span>
                  <span v-if="!user.is_admin && !user.is_banned && user.permission_groups.length === 0" class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-accent text-muted-foreground w-fit">{{ t('user') }}</span>
                  <span
                    v-for="pg in user.permission_groups"
                    :key="pg.id"
                    class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-primary/15 text-primary w-fit"
                  >{{ pg.name }}</span>
                </div>
              </td>
              <td class="px-4 py-3 text-muted-foreground text-xs">{{ formatDate(user.created_at) }}</td>
              <td class="px-4 py-3">
                <div class="flex items-center gap-1">
                  <button v-if="!user.is_admin" class="btn-ghost p-2" :title="t('makeAdmin')" @click="promptToggleAdmin(user)">
                    <Shield class="w-4 h-4" />
                  </button>
                  <button v-else class="btn-ghost p-2 text-amber-500" :title="t('removeAdmin')" @click="promptToggleAdmin(user)">
                    <ShieldOff class="w-4 h-4" />
                  </button>
                  <button v-if="!user.is_banned" class="btn-ghost p-2" :title="t('banUser')" @click="promptToggleBan(user)">
                    <Ban class="w-4 h-4" />
                  </button>
                  <button v-else class="btn-ghost p-2 text-red-500" :title="t('unbanUser')" @click="promptToggleBan(user)">
                    <CheckCircle class="w-4 h-4" />
                  </button>
                  <button class="btn-ghost p-2" :title="t('loginAs')" @click="impersonateUser(user)">
                    <LogIn class="w-4 h-4" />
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="filteredUsers.length === 0" class="px-4 py-12 text-center text-sm text-muted-foreground">
        {{ loading ? t('loading') : t('noUsersFound') }}
      </div>
      <div v-else-if="hasMoreUsers" class="px-4 py-3 border-t border-border text-center">
        <button class="btn-ghost text-sm text-primary" @click="usersPage++">
          {{ t('showMore', { remaining: filteredUsers.length - paginatedUsers.length }) }}
        </button>
      </div>
      <div v-else-if="filteredUsers.length > USERS_PAGE_SIZE" class="px-4 py-2 border-t border-border text-center">
        <span class="text-xs text-muted-foreground">{{ t('showingAll', { count: filteredUsers.length }) }}</span>
      </div>
    </div>

    <!-- Admin Confirmation Modal -->
    <ModalOverlay :show="!!adminConfirmUser" @close="adminConfirmUser = null">
      <div class="px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">
          {{ adminConfirmUser?.is_admin ? t('adminConfirmModal.removeTitle') : t('adminConfirmModal.makeTitle') }}
        </h2>
        <p class="text-sm text-muted-foreground mt-2">
          {{ t('adminConfirmModal.confirmQuestion') }}
          <span class="font-semibold text-foreground">{{ adminConfirmUser?.is_admin ? t('adminConfirmModal.removeDesc') : t('adminConfirmModal.makeDesc') }}</span>
          <span class="font-semibold text-foreground">{{ adminConfirmUser?.name }}</span>?
        </p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" @click="confirmToggleAdmin">
          <Shield class="w-4 h-4" />
          {{ adminConfirmUser?.is_admin ? t('removeAdmin') : t('makeAdmin') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="adminConfirmUser = null">
          {{ t('cancel') }}
        </button>
      </div>
    </ModalOverlay>

    <!-- Ban Confirmation Modal -->
    <ModalOverlay :show="!!banConfirmUser" @close="banConfirmUser = null">
      <div class="px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">
          {{ banConfirmUser?.is_banned ? t('banConfirmModal.unbanTitle') : t('banConfirmModal.banTitle') }}
        </h2>
        <p class="text-sm text-muted-foreground mt-2">
          <template v-if="banConfirmUser?.is_banned">
            {{ t('banConfirmModal.unbanDesc', { name: banConfirmUser?.name }) }}
          </template>
          <template v-else>
            {{ t('banConfirmModal.banDesc', { name: banConfirmUser?.name }) }}
          </template>
        </p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button :class="banConfirmUser?.is_banned ? 'btn-primary' : 'btn-destructive'" class="w-full justify-center" @click="confirmToggleBan">
          <Ban v-if="!banConfirmUser?.is_banned" class="w-4 h-4" />
          <CheckCircle v-else class="w-4 h-4" />
          {{ banConfirmUser?.is_banned ? t('unbanUser') : t('banUser') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="banConfirmUser = null">
          {{ t('cancel') }}
        </button>
      </div>
    </ModalOverlay>
  </div>
</template>
