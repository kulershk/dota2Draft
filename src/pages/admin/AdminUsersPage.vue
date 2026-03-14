<script setup lang="ts">
import { Users, Search, ExternalLink, Ban, CheckCircle, LogIn, UserPlus, Pencil, ArrowUp, ArrowDown, Upload, RefreshCw } from 'lucide-vue-next'
import RoleBadge from '@/components/common/RoleBadge.vue'
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import ModalOverlay from '@/components/common/ModalOverlay.vue'

const { t } = useI18n()
const api = useApi()
const store = useDraftStore()
const isDev = import.meta.env.DEV

interface PermGroupRef {
  id: number
  name: string
}

interface PermGroup {
  id: number
  name: string
  permissions: string[]
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
  last_online: string | null
  permission_groups: PermGroupRef[]
}

const users = ref<User[]>([])
const searchQuery = ref('')
const loading = ref(false)
const usersPage = ref(1)
const USERS_PAGE_SIZE = 20

// Permission groups for edit modal
const allGroups = ref<PermGroup[]>([])
const editUser = ref<User | null>(null)
const editUserGroupIds = ref<number[]>([])
const editUserMmr = ref(0)
const editUserRoles = ref<string[]>([])
const savingUser = ref(false)
const ALL_ROLES = ['Carry', 'Mid', 'Offlane', 'Pos4', 'Pos5']

async function fetchUsers() {
  loading.value = true
  try {
    const [usrs, grps] = await Promise.all([
      api.getUsers(),
      api.getPermissionGroups(),
    ])
    users.value = usrs
    allGroups.value = grps
  } finally {
    loading.value = false
  }
}
fetchUsers()
fetchSyncStatus()

async function openEditUser(user: User) {
  editUser.value = user
  editUserMmr.value = user.mmr
  editUserRoles.value = [...(user.roles || [])]
  const groups = await api.getPlayerGroups(user.id)
  editUserGroupIds.value = groups.map((g: PermGroup) => g.id)
}

function toggleRole(role: string) {
  const idx = editUserRoles.value.indexOf(role)
  if (idx >= 0) editUserRoles.value.splice(idx, 1)
  else editUserRoles.value.push(role)
}

function toggleGroupForUser(groupId: number) {
  const idx = editUserGroupIds.value.indexOf(groupId)
  if (idx >= 0) editUserGroupIds.value.splice(idx, 1)
  else editUserGroupIds.value.push(groupId)
}

function addGroup(groupId: number) {
  if (groupId && !editUserGroupIds.value.includes(groupId)) {
    editUserGroupIds.value.push(groupId)
  }
}

const availableGroups = computed(() =>
  allGroups.value.filter(g => !editUserGroupIds.value.includes(g.id))
)

async function saveEditUser() {
  if (!editUser.value) return
  savingUser.value = true
  try {
    await Promise.all([
      api.setPlayerGroups(editUser.value.id, editUserGroupIds.value),
      api.updatePlayer(editUser.value.id, { mmr: editUserMmr.value, roles: editUserRoles.value }),
    ])
    editUser.value = null
    await fetchUsers()
  } finally {
    savingUser.value = false
  }
}

type SortKey = 'id' | 'name' | 'last_online' | 'status' | 'joined'
const sortKey = ref<SortKey>('id')
const sortDir = ref<'asc' | 'desc'>('asc')

function toggleSort(key: SortKey) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    sortDir.value = (key === 'last_online' || key === 'joined') ? 'desc' : 'asc'
  }
  usersPage.value = 1
}

function getUserStatusWeight(u: User): number {
  if (u.is_banned) return 0
  if (u.is_admin) return 3
  if (u.permission_groups.length > 0) return 2
  return 1
}

const filteredUsers = computed(() => {
  let list = [...users.value]
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter(u => u.name.toLowerCase().includes(q) || u.steam_id?.includes(q))
  }
  const dir = sortDir.value === 'asc' ? 1 : -1
  list.sort((a, b) => {
    switch (sortKey.value) {
      case 'id':
        return (a.id - b.id) * dir
      case 'name':
        return a.name.localeCompare(b.name) * dir
      case 'last_online': {
        const aTime = a.last_online ? new Date(a.last_online).getTime() : 0
        const bTime = b.last_online ? new Date(b.last_online).getTime() : 0
        return (aTime - bTime) * dir
      }
      case 'status':
        return (getUserStatusWeight(a) - getUserStatusWeight(b)) * dir
      case 'joined':
        return (new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) * dir
      default:
        return 0
    }
  })
  return list
})

const paginatedUsers = computed(() => filteredUsers.value.slice(0, usersPage.value * USERS_PAGE_SIZE))
const hasMoreUsers = computed(() => paginatedUsers.value.length < filteredUsers.value.length)

watch(searchQuery, () => { usersPage.value = 1 })

const banConfirmUser = ref<User | null>(null)

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

// Steam import
const showImportModal = ref(false)
const importInput = ref('')
const importing = ref(false)
const importStep = ref<'input' | 'processing' | 'done'>('input')
const importTotal = ref(0)
const importResults = ref<{ steamId: string; name: string; avatarUrl: string; status: string; id: number }[]>([])
const importError = ref('')

async function importSteamUsers() {
  if (!importInput.value.trim()) return
  importing.value = true
  importStep.value = 'processing'
  importResults.value = []
  importError.value = ''

  try {
    // Step 1: Parse and resolve all Steam IDs
    const { steamIds } = await api.parseSteamIds(importInput.value)
    importTotal.value = steamIds.length

    // Step 2: Import one by one
    for (const steamId of steamIds) {
      try {
        const result = await api.importSteamUser(steamId)
        importResults.value.push(result)
      } catch (e: any) {
        importResults.value.push({ steamId, name: '', avatarUrl: '', status: 'error', id: 0 })
      }
    }

    importStep.value = 'done'
    await fetchUsers()
  } catch (e: any) {
    importError.value = e.message
    importStep.value = 'input'
  } finally {
    importing.value = false
  }
}

function closeImportModal() {
  showImportModal.value = false
  importInput.value = ''
  importResults.value = []
  importStep.value = 'input'
  importTotal.value = 0
  importError.value = ''
}

// Steam sync
const syncing = ref(false)
const lastSynced = ref<string | null>(null)
const syncedUsers = ref(0)
const totalSteamUsers = ref(0)

async function fetchSyncStatus() {
  try {
    const data = await api.getSteamSyncStatus()
    lastSynced.value = data.lastSynced
    syncedUsers.value = data.syncedUsers
    totalSteamUsers.value = data.totalSteamUsers
  } catch {}
}

async function syncAllProfiles() {
  syncing.value = true
  try {
    await api.syncSteamAll()
    await Promise.all([fetchUsers(), fetchSyncStatus()])
  } catch (e: any) {
    alert(e.message)
  } finally {
    syncing.value = false
  }
}

async function syncSingleUser(userId: number) {
  try {
    const result = await api.syncSteamUser(userId)
    if (result.status === 'synced') {
      const user = users.value.find(u => u.id === userId)
      if (user) {
        user.name = result.name
        user.avatar_url = result.avatar_url
      }
    }
  } catch {}
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatRelativeTime(dateStr: string | null) {
  if (!dateStr) return t('never')
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMs = now - then
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHr = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHr / 24)

  if (diffMin < 1) return t('justNow')
  if (diffMin < 60) return t('minutesAgo', { n: diffMin })
  if (diffHr < 24) return t('hoursAgo', { n: diffHr })
  if (diffDay < 30) return t('daysAgo', { n: diffDay })
  return formatDate(dateStr)
}
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[1200px] mx-auto w-full">
    <div>
      <h1 class="text-2xl font-semibold text-foreground">{{ t('steamUsers') }}</h1>
      <p class="text-sm text-muted-foreground mt-1">{{ t('steamUsersSubtitle') }}</p>
    </div>

    <div class="flex flex-wrap gap-4">
      <div class="card p-4">
        <p class="text-xs font-semibold tracking-wider text-muted-foreground uppercase">{{ t('totalAccounts') }}</p>
        <p class="text-3xl font-bold text-foreground mt-1">{{ users.length }}</p>
      </div>
      <div class="card p-4">
        <p class="text-xs font-semibold tracking-wider text-muted-foreground uppercase">{{ t('banned') }}</p>
        <p class="text-3xl font-bold text-destructive mt-1">{{ users.filter(u => u.is_banned).length }}</p>
      </div>
      <div class="card p-4 flex items-center gap-4 ml-auto">
        <div class="flex flex-col">
          <p class="text-xs font-semibold tracking-wider text-muted-foreground uppercase">{{ t('steamSync') }}</p>
          <p class="text-xs text-muted-foreground mt-0.5">
            <template v-if="lastSynced">{{ t('lastSynced') }}: {{ formatRelativeTime(lastSynced) }}</template>
            <template v-else>{{ t('neverSynced') }}</template>
          </p>
        </div>
        <button class="btn-outline text-sm whitespace-nowrap" :disabled="syncing" @click="syncAllProfiles">
          <RefreshCw class="w-4 h-4" :class="syncing ? 'animate-spin' : ''" />
          {{ syncing ? t('syncing') : t('syncAll') }}
        </button>
      </div>
      <div class="card p-4 flex items-center gap-3">
        <button class="btn-primary text-sm whitespace-nowrap" @click="showImportModal = true">
          <Upload class="w-4 h-4" />
          {{ t('importSteamUsers') }}
        </button>
      </div>
      <div v-if="isDev" class="card p-4 flex items-center gap-3">
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
              <th class="text-left px-4 py-3 font-medium text-muted-foreground w-[40px] cursor-pointer select-none hover:text-foreground transition-colors" @click="toggleSort('id')">
                <span class="flex items-center gap-1">
                  #
                  <ArrowUp v-if="sortKey === 'id' && sortDir === 'asc'" class="w-3 h-3" />
                  <ArrowDown v-else-if="sortKey === 'id' && sortDir === 'desc'" class="w-3 h-3" />
                </span>
              </th>
              <th class="text-left px-4 py-3 font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground transition-colors" @click="toggleSort('name')">
                <span class="flex items-center gap-1">
                  {{ t('user') }}
                  <ArrowUp v-if="sortKey === 'name' && sortDir === 'asc'" class="w-3 h-3" />
                  <ArrowDown v-else-if="sortKey === 'name' && sortDir === 'desc'" class="w-3 h-3" />
                </span>
              </th>
              <th class="text-left px-4 py-3 font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground transition-colors" @click="toggleSort('status')">
                <span class="flex items-center gap-1">
                  {{ t('status') }}
                  <ArrowUp v-if="sortKey === 'status' && sortDir === 'asc'" class="w-3 h-3" />
                  <ArrowDown v-else-if="sortKey === 'status' && sortDir === 'desc'" class="w-3 h-3" />
                </span>
              </th>
              <th class="text-left px-4 py-3 font-medium text-muted-foreground w-[100px] cursor-pointer select-none hover:text-foreground transition-colors" @click="toggleSort('last_online')">
                <span class="flex items-center gap-1">
                  {{ t('lastOnline') }}
                  <ArrowUp v-if="sortKey === 'last_online' && sortDir === 'asc'" class="w-3 h-3" />
                  <ArrowDown v-else-if="sortKey === 'last_online' && sortDir === 'desc'" class="w-3 h-3" />
                </span>
              </th>
              <th class="text-left px-4 py-3 font-medium text-muted-foreground w-[100px] cursor-pointer select-none hover:text-foreground transition-colors" @click="toggleSort('joined')">
                <span class="flex items-center gap-1">
                  {{ t('joined') }}
                  <ArrowUp v-if="sortKey === 'joined' && sortDir === 'asc'" class="w-3 h-3" />
                  <ArrowDown v-else-if="sortKey === 'joined' && sortDir === 'desc'" class="w-3 h-3" />
                </span>
              </th>
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
              <td class="px-4 py-3 text-muted-foreground text-xs">{{ formatRelativeTime(user.last_online) }}</td>
              <td class="px-4 py-3 text-muted-foreground text-xs">{{ formatDate(user.created_at) }}</td>
              <td class="px-4 py-3">
                <div class="flex items-center gap-1">
                  <button class="btn-ghost p-2" :title="t('edit')" @click="openEditUser(user)">
                    <Pencil class="w-4 h-4" />
                  </button>
                  <button v-if="user.steam_id" class="btn-ghost p-2" :title="t('syncProfile')" @click="syncSingleUser(user.id)">
                    <RefreshCw class="w-4 h-4" />
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

    <!-- Import Steam Users Modal -->
    <ModalOverlay :show="showImportModal" @close="closeImportModal">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('importSteamUsers') }}</h2>
        <p class="text-sm text-muted-foreground mt-1">{{ t('importSteamUsersHint') }}</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-4">
        <!-- Input step -->
        <template v-if="importStep === 'input'">
          <textarea
            v-model="importInput"
            class="input-field w-full h-40 font-mono text-xs resize-y"
            :placeholder="t('importSteamPlaceholder')"
          ></textarea>
          <p v-if="importError" class="text-sm text-destructive">{{ importError }}</p>
        </template>

        <!-- Processing / Done step -->
        <template v-if="importStep === 'processing' || importStep === 'done'">
          <!-- Progress bar -->
          <div class="flex items-center gap-3">
            <div class="flex-1 h-2 rounded-full bg-accent overflow-hidden">
              <div class="h-full bg-primary rounded-full transition-all duration-300" :style="{ width: `${importTotal > 0 ? (importResults.length / importTotal) * 100 : 0}%` }"></div>
            </div>
            <span class="text-sm font-mono text-muted-foreground flex-shrink-0">{{ importResults.length }}/{{ importTotal }}</span>
          </div>

          <!-- Results list -->
          <div class="border border-border rounded-lg divide-y divide-border max-h-[300px] overflow-y-auto">
            <div v-for="(r, i) in importResults" :key="i" class="flex items-center justify-between px-3 py-2.5">
              <div class="flex items-center gap-2.5 min-w-0">
                <img v-if="r.avatarUrl" :src="r.avatarUrl" class="w-7 h-7 rounded-full flex-shrink-0" />
                <div v-else class="w-7 h-7 rounded-full bg-secondary flex items-center justify-center text-[10px] font-semibold text-secondary-foreground flex-shrink-0">
                  {{ r.name ? r.name.charAt(0) : '?' }}
                </div>
                <div class="min-w-0">
                  <span class="text-sm font-medium text-foreground truncate block">{{ r.name || r.steamId }}</span>
                  <span class="text-[10px] text-muted-foreground font-mono">{{ r.steamId }}</span>
                </div>
              </div>
              <span class="text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ml-2" :class="{
                'bg-color-success/15 text-color-success': r.status === 'created',
                'bg-accent text-muted-foreground': r.status === 'exists',
                'bg-red-500/15 text-red-500': r.status === 'error',
              }">
                {{ r.status === 'created' ? t('imported') : r.status === 'error' ? t('failed') : t('alreadyExists') }}
              </span>
            </div>
            <!-- Pending placeholders -->
            <div v-if="importStep === 'processing'" v-for="i in Math.max(0, importTotal - importResults.length)" :key="'pending-' + i" class="flex items-center gap-2.5 px-3 py-2.5">
              <div class="w-7 h-7 rounded-full bg-accent animate-pulse flex-shrink-0"></div>
              <div class="h-4 w-32 bg-accent animate-pulse rounded"></div>
            </div>
          </div>

          <!-- Summary when done -->
          <div v-if="importStep === 'done'" class="text-sm text-muted-foreground text-center">
            {{ t('importSummary', {
              created: importResults.filter(r => r.status === 'created').length,
              existing: importResults.filter(r => r.status === 'exists').length,
              failed: importResults.filter(r => r.status === 'error').length,
            }) }}
          </div>
        </template>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button v-if="importStep === 'input'" class="btn-primary w-full justify-center" :disabled="!importInput.trim()" @click="importSteamUsers">
          <Upload class="w-4 h-4" />
          {{ t('importUsers') }}
        </button>
        <button class="btn-secondary w-full justify-center" :disabled="importStep === 'processing'" @click="closeImportModal">{{ t('close') }}</button>
      </div>
    </ModalOverlay>

    <!-- Edit User Modal -->
    <ModalOverlay :show="!!editUser" @close="editUser = null">
      <div class="border-b border-border px-7 py-6">
        <div class="flex items-center gap-3">
          <img v-if="editUser?.avatar_url" :src="editUser.avatar_url" class="w-10 h-10 rounded-full object-cover" />
          <div v-else class="w-10 h-10 rounded-full bg-secondary flex items-center justify-center text-sm font-semibold text-secondary-foreground">
            {{ editUser?.name.charAt(0) }}
          </div>
          <div>
            <h2 class="text-xl font-semibold text-foreground">{{ editUser?.name }}</h2>
            <p class="text-xs text-muted-foreground">{{ t('editUserProfile') }}</p>
          </div>
        </div>
      </div>
      <div class="px-7 py-5 max-h-[450px] overflow-y-auto flex flex-col gap-5">
        <!-- MMR -->
        <div class="flex flex-col gap-1.5">
          <label class="block text-xs font-medium text-muted-foreground">{{ t('mmrCol') }}</label>
          <input type="number" class="input-field w-full" v-model.number="editUserMmr" placeholder="0" />
        </div>

        <!-- Roles -->
        <div class="flex flex-col gap-1.5">
          <label class="block text-xs font-medium text-muted-foreground">{{ t('rolesCol') }}</label>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="role in ALL_ROLES"
              :key="role"
              class="px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors"
              :class="editUserRoles.includes(role)
                ? 'bg-primary/10 border-primary/30 text-foreground'
                : 'border-border text-muted-foreground hover:border-foreground/20'"
              @click="toggleRole(role)"
            >
              <RoleBadge :role="role" size="sm" />
            </button>
          </div>
        </div>

        <!-- Permission Groups -->
        <div class="flex flex-col gap-1.5">
          <label class="block text-xs font-medium text-muted-foreground">{{ t('permissionGroups') }}</label>
          <!-- Assigned groups as tags -->
          <div v-if="editUserGroupIds.length > 0" class="flex flex-wrap gap-1.5 mb-1">
            <span
              v-for="gid in editUserGroupIds"
              :key="gid"
              class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-primary/15 text-primary"
            >
              {{ allGroups.find(g => g.id === gid)?.name }}
              <button class="hover:text-destructive transition-colors ml-0.5" @click="toggleGroupForUser(gid)">
                <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </span>
          </div>
          <!-- Dropdown to add -->
          <select
            v-if="availableGroups.length > 0"
            class="input-field w-full"
            @change="addGroup(Number(($event.target as HTMLSelectElement).value)); ($event.target as HTMLSelectElement).value = ''"
          >
            <option value="" disabled selected>{{ t('addPermissionGroup') }}</option>
            <option v-for="g in availableGroups" :key="g.id" :value="g.id">{{ g.name }}</option>
          </select>
          <p v-else-if="allGroups.length === 0" class="text-sm text-muted-foreground">{{ t('noGroupsYet') }}</p>
        </div>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" :disabled="savingUser" @click="saveEditUser">
          {{ savingUser ? t('saving') : t('saveChanges') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="editUser = null">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>
  </div>
</template>
