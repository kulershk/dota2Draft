<script setup lang="ts">
import { ShieldCheck, Plus, Trash2, Save, Users, ChevronDown, ChevronUp } from 'lucide-vue-next'
import { ref, reactive, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'
import ModalOverlay from '@/components/common/ModalOverlay.vue'

const { t } = useI18n()
const api = useApi()

interface PermGroup {
  id: number
  name: string
  permissions: string[]
}

interface User {
  id: number
  name: string
  avatar_url: string | null
  is_admin: boolean
}

const allPermissions = ref<string[]>([])
const groups = ref<PermGroup[]>([])
const users = ref<User[]>([])
const loading = ref(true)

// Create group modal
const showCreate = ref(false)
const newGroupName = ref('')
const newGroupPerms = ref<string[]>([])

// Edit group
const expandedGroup = ref<number | null>(null)
const editPerms = reactive<Record<number, string[]>>({})
const editNames = reactive<Record<number, string>>({})
const savingGroup = ref<number | null>(null)

// Assign users modal
const assignGroup = ref<PermGroup | null>(null)
const userGroups = reactive<Record<number, number[]>>({})
const loadingUserGroups = ref(false)

const permLabels: Record<string, string> = {
  manage_competitions: 'Manage All Competitions',
  manage_own_competitions: 'Manage Own Competitions',
  manage_users: 'Manage Users',
  manage_news: 'Manage News',
  manage_site_settings: 'Manage Site Settings',
  manage_captains: 'Manage Captains',
  manage_players: 'Manage Players',
  manage_auction: 'Manage Auction',
  manage_permissions: 'Manage Permissions',
}

onMounted(async () => {
  try {
    const [perms, grps, usrs] = await Promise.all([
      api.getAllPermissions(),
      api.getPermissionGroups(),
      api.getUsers(),
    ])
    allPermissions.value = perms
    groups.value = grps
    users.value = usrs
  } finally {
    loading.value = false
  }
})

function toggleExpand(id: number) {
  if (expandedGroup.value === id) {
    expandedGroup.value = null
  } else {
    expandedGroup.value = id
    const g = groups.value.find(g => g.id === id)
    if (g) {
      editPerms[id] = [...g.permissions]
      editNames[id] = g.name
    }
  }
}

function togglePerm(list: string[], perm: string) {
  const idx = list.indexOf(perm)
  if (idx >= 0) list.splice(idx, 1)
  else list.push(perm)
}

async function createGroup() {
  if (!newGroupName.value.trim()) return
  const g = await api.createPermissionGroup({ name: newGroupName.value.trim(), permissions: newGroupPerms.value })
  groups.value.push(g)
  newGroupName.value = ''
  newGroupPerms.value = []
  showCreate.value = false
}

async function saveGroup(id: number) {
  savingGroup.value = id
  try {
    const updated = await api.updatePermissionGroup(id, {
      name: editNames[id],
      permissions: editPerms[id],
    })
    const idx = groups.value.findIndex(g => g.id === id)
    if (idx >= 0) groups.value[idx] = updated
  } finally {
    savingGroup.value = null
  }
}

async function deleteGroup(id: number) {
  await api.deletePermissionGroup(id)
  groups.value = groups.value.filter(g => g.id !== id)
  if (expandedGroup.value === id) expandedGroup.value = null
}

async function openAssign(group: PermGroup) {
  assignGroup.value = group
  loadingUserGroups.value = true
  try {
    for (const u of users.value) {
      if (!userGroups[u.id]) {
        const uGroups = await api.getPlayerGroups(u.id)
        userGroups[u.id] = uGroups.map((g: PermGroup) => g.id)
      }
    }
  } finally {
    loadingUserGroups.value = false
  }
}

function isUserInGroup(userId: number, groupId: number) {
  return userGroups[userId]?.includes(groupId) ?? false
}

async function toggleUserGroup(userId: number, groupId: number) {
  const current = userGroups[userId] || []
  let updated: number[]
  if (current.includes(groupId)) {
    updated = current.filter(id => id !== groupId)
  } else {
    updated = [...current, groupId]
  }
  await api.setPlayerGroups(userId, updated)
  userGroups[userId] = updated
}
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[1000px]">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-xl font-semibold text-foreground">{{ t('permissionGroups') }}</h1>
        <p class="text-sm text-muted-foreground mt-1">{{ t('permissionGroupsDesc') }}</p>
      </div>
      <button class="btn-primary" @click="showCreate = true">
        <Plus class="w-4 h-4" />
        {{ t('newGroup') }}
      </button>
    </div>

    <div v-if="loading" class="text-sm text-muted-foreground py-8 text-center">{{ t('loading') }}</div>

    <div v-else-if="groups.length === 0" class="card px-6 py-10 text-center text-sm text-muted-foreground">
      {{ t('noGroupsYet') }}
    </div>

    <div v-else class="flex flex-col gap-3">
      <div v-for="group in groups" :key="group.id" class="card">
        <!-- Group header -->
        <div class="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-accent/30 transition-colors" @click="toggleExpand(group.id)">
          <div class="flex items-center gap-2.5">
            <ShieldCheck class="w-4 h-4 text-primary" />
            <span class="text-sm font-semibold text-foreground">{{ group.name }}</span>
            <span class="text-xs text-muted-foreground">({{ group.permissions.length }} {{ t('permissionsCount') }})</span>
          </div>
          <div class="flex items-center gap-2">
            <button class="btn-ghost p-1.5" :title="t('assignUsers')" @click.stop="openAssign(group)">
              <Users class="w-4 h-4" />
            </button>
            <button class="btn-ghost p-1.5 text-destructive" :title="t('delete')" @click.stop="deleteGroup(group.id)">
              <Trash2 class="w-3.5 h-3.5" />
            </button>
            <ChevronUp v-if="expandedGroup === group.id" class="w-4 h-4 text-muted-foreground" />
            <ChevronDown v-else class="w-4 h-4 text-muted-foreground" />
          </div>
        </div>

        <!-- Expanded: edit permissions -->
        <div v-if="expandedGroup === group.id" class="px-4 py-4 border-t border-border">
          <div class="mb-3">
            <label class="block text-xs font-medium text-muted-foreground mb-1">{{ t('groupName') }}</label>
            <input type="text" v-model="editNames[group.id]" class="input-field w-full max-w-[300px]" />
          </div>
          <label class="block text-xs font-medium text-muted-foreground mb-2">{{ t('permissionsLabel') }}</label>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label
              v-for="perm in allPermissions"
              :key="perm"
              class="flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors cursor-pointer"
              :class="editPerms[group.id]?.includes(perm)
                ? 'bg-primary/10 border-primary/30 text-foreground'
                : 'border-border text-muted-foreground hover:border-foreground/20'"
            >
              <input
                type="checkbox"
                :checked="editPerms[group.id]?.includes(perm)"
                class="rounded border-border"
                @change="togglePerm(editPerms[group.id], perm)"
              />
              <span class="text-xs font-medium">{{ permLabels[perm] || perm }}</span>
            </label>
          </div>
          <div class="mt-4">
            <button class="btn-primary text-xs" :disabled="savingGroup === group.id" @click="saveGroup(group.id)">
              <Save class="w-3.5 h-3.5" />
              {{ savingGroup === group.id ? t('saving') : t('saveChanges') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Create Group Modal -->
    <ModalOverlay :show="showCreate" @close="showCreate = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('newGroup') }}</h2>
        <p class="text-sm text-muted-foreground mt-1">{{ t('newGroupDesc') }}</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-4">
        <div>
          <label class="block text-xs font-medium text-muted-foreground mb-1">{{ t('groupName') }}</label>
          <input type="text" v-model="newGroupName" class="input-field w-full" :placeholder="t('groupNamePlaceholder')" />
        </div>
        <div>
          <label class="block text-xs font-medium text-muted-foreground mb-2">{{ t('permissionsLabel') }}</label>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label
              v-for="perm in allPermissions"
              :key="perm"
              class="flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors cursor-pointer"
              :class="newGroupPerms.includes(perm)
                ? 'bg-primary/10 border-primary/30 text-foreground'
                : 'border-border text-muted-foreground hover:border-foreground/20'"
            >
              <input
                type="checkbox"
                :checked="newGroupPerms.includes(perm)"
                class="rounded border-border"
                @change="togglePerm(newGroupPerms, perm)"
              />
              <span class="text-xs font-medium">{{ permLabels[perm] || perm }}</span>
            </label>
          </div>
        </div>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" :disabled="!newGroupName.trim()" @click="createGroup">
          <Plus class="w-4 h-4" />
          {{ t('createGroup') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showCreate = false">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>

    <!-- Assign Users Modal -->
    <ModalOverlay :show="!!assignGroup" @close="assignGroup = null">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('assignUsers') }}: {{ assignGroup?.name }}</h2>
        <p class="text-sm text-muted-foreground mt-1">{{ t('assignUsersDesc') }}</p>
      </div>
      <div class="px-7 py-4 max-h-[400px] overflow-y-auto">
        <div v-if="loadingUserGroups" class="text-sm text-muted-foreground py-4 text-center">{{ t('loading') }}</div>
        <div v-else class="flex flex-col divide-y divide-border">
          <label
            v-for="user in users"
            :key="user.id"
            class="flex items-center gap-3 py-2.5 cursor-pointer hover:bg-accent/30 px-2 rounded transition-colors"
          >
            <input
              type="checkbox"
              :checked="isUserInGroup(user.id, assignGroup!.id)"
              class="rounded border-border"
              @change="toggleUserGroup(user.id, assignGroup!.id)"
            />
            <img v-if="user.avatar_url" :src="user.avatar_url" class="w-7 h-7 rounded-full" />
            <div v-else class="w-7 h-7 rounded-full bg-secondary flex items-center justify-center text-[10px] font-semibold text-secondary-foreground">
              {{ user.name.charAt(0) }}
            </div>
            <span class="text-sm text-foreground">{{ user.name }}</span>
            <span v-if="user.is_admin" class="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 font-medium">{{ t('admin') }}</span>
          </label>
        </div>
      </div>
      <div class="px-7 py-4 border-t border-border">
        <button class="btn-secondary w-full justify-center" @click="assignGroup = null">{{ t('close') }}</button>
      </div>
    </ModalOverlay>
  </div>
</template>
