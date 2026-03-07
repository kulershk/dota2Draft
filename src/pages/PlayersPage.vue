<script setup lang="ts">
import { Users, UserPlus, Search, Pencil, Trash2, Upload, LogIn } from 'lucide-vue-next'
import { ref, computed, nextTick, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDraftStore } from '@/composables/useDraftStore'
import { useApi } from '@/composables/useApi'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import InputGroup from '@/components/common/InputGroup.vue'
import RoleBadge from '@/components/common/RoleBadge.vue'
import MmrDisplay from '@/components/common/MmrDisplay.vue'
import { sortedRoles } from '@/utils/roles'

const store = useDraftStore()
const api = useApi()
const route = useRoute()
const router = useRouter()
const showAddPlayer = ref(false)
const showEditPlayer = ref(false)
const showImportPlayers = ref(false)
const searchQuery = ref('')
const showRegister = ref(false)
const importText = ref('')
const importError = ref('')
const importing = ref(false)

// Steam registration state
const steamToken = ref('')
const steamProfile = ref<{ steamId: string; name: string; avatarUrl: string } | null>(null)
const registerRoles = ref<string[]>([])
const registerMmr = ref('')
const registerInfo = ref('')
const registerError = ref('')
const registering = ref(false)

function toggleRegisterRole(role: string) {
  const idx = registerRoles.value.indexOf(role)
  if (idx >= 0) registerRoles.value.splice(idx, 1)
  else registerRoles.value.push(role)
}

function startSteamLogin() {
  window.location.href = '/api/auth/steam'
}

async function submitRegistration() {
  if (!steamToken.value || !steamProfile.value) return
  registering.value = true
  registerError.value = ''
  try {
    await api.registerPlayer({
      token: steamToken.value,
      roles: [...new Set(registerRoles.value.map(r => roleMap[r] || r))],
      mmr: Number(registerMmr.value) || 0,
      info: registerInfo.value,
    })
    showRegister.value = false
    steamToken.value = ''
    steamProfile.value = null
    registerRoles.value = []
    registerMmr.value = ''
    registerInfo.value = ''
  } catch (e: any) {
    registerError.value = e.message || 'Registration failed'
  } finally {
    registering.value = false
  }
}

// Handle Steam callback redirect
onMounted(async () => {
  const token = route.query.steamToken as string
  const steamError = route.query.steam_error as string

  if (steamError) {
    const errorMessages: Record<string, string> = {
      already_registered: 'This Steam account is already registered.',
      validation_failed: 'Steam authentication failed. Please try again.',
      invalid_id: 'Could not verify Steam identity.',
      server_error: 'Server error during authentication.',
    }
    registerError.value = errorMessages[steamError] || 'Steam login failed.'
    showRegister.value = true
    router.replace({ path: '/players' })
    return
  }

  if (token) {
    try {
      const profile = await api.getSteamProfile(token)
      steamToken.value = token
      steamProfile.value = profile
      showRegister.value = true
    } catch {
      registerError.value = 'Registration session expired. Please try again.'
      showRegister.value = true
    }
    router.replace({ path: '/players' })
  }
})

const newPlayer = ref({ name: '', roles: [] as string[], mmr: '', info: '' })
const editPlayer = ref({ id: 0, name: '', roles: [] as string[], mmr: '', info: '' })

const allRoles = ['Carry (Pos 1)', 'Mid (Pos 2)', 'Offlane (Pos 3)', 'Soft Support (Pos 4)', 'Hard Support (Pos 5)']
const roleMap: Record<string, string> = {
  'Carry (Pos 1)': 'Carry',
  'Mid (Pos 2)': 'Mid',
  'Offlane (Pos 3)': 'Offlane',
  'Soft Support (Pos 4)': 'Pos4',
  'Hard Support (Pos 5)': 'Pos5',
}

const reverseRoleMap: Record<string, string[]> = {
  Carry: ['Carry (Pos 1)'],
  Mid: ['Mid (Pos 2)'],
  Offlane: ['Offlane (Pos 3)'],
  Pos4: ['Soft Support (Pos 4)'],
  Pos5: ['Hard Support (Pos 5)'],
}

function toggleRole(role: string) {
  const idx = newPlayer.value.roles.indexOf(role)
  if (idx >= 0) newPlayer.value.roles.splice(idx, 1)
  else newPlayer.value.roles.push(role)
}

function toggleEditRole(role: string) {
  const idx = editPlayer.value.roles.indexOf(role)
  if (idx >= 0) editPlayer.value.roles.splice(idx, 1)
  else editPlayer.value.roles.push(role)
}

function openEditPlayer(player: any) {
  const displayRoles: string[] = []
  for (const r of player.roles) {
    if (reverseRoleMap[r]) displayRoles.push(reverseRoleMap[r][0])
  }
  editPlayer.value = {
    id: player.id,
    name: player.name,
    roles: displayRoles,
    mmr: String(player.mmr),
    info: player.info || '',
  }
  showEditPlayer.value = true
}

async function savePlayer() {
  if (!editPlayer.value.name) return
  await store.updatePlayer(editPlayer.value.id, {
    name: editPlayer.value.name,
    roles: [...new Set(editPlayer.value.roles.map(r => roleMap[r] || r))],
    mmr: Number(editPlayer.value.mmr) || 0,
    info: editPlayer.value.info,
  })
  showEditPlayer.value = false
}

async function addPlayer() {
  if (!newPlayer.value.name) return
  await store.addPlayer({
    name: newPlayer.value.name,
    roles: [...new Set(newPlayer.value.roles.map(r => roleMap[r] || r))],
    mmr: Number(newPlayer.value.mmr) || 0,
    info: newPlayer.value.info,
  })
  newPlayer.value = { name: '', roles: [], mmr: '', info: '' }
  showAddPlayer.value = false
}

const filteredPlayers = computed(() => {
  let list = [...store.players.value].sort((a, b) => b.mmr - a.mmr)
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter(p =>
      p.name.toLowerCase().includes(q) || p.roles.some(r => r.toLowerCase().includes(q))
    )
  }
  return list
})

const roleColumns = ['Carry', 'Mid', 'Offlane', 'Pos4', 'Pos5']

function parseImportText(text: string) {
  const lines = text.trim().split('\n').filter(l => l.trim())
  const players: { name: string; roles: string[]; mmr: number }[] = []
  for (const line of lines) {
    const cols = line.split('\t')
    const name = cols[0].trim()
    if (!name) continue
    const mmr = Number(cols[1]?.trim()) || 0
    const roles: string[] = []
    for (let i = 0; i < roleColumns.length; i++) {
      const val = cols[i + 2]?.trim().toLowerCase()
      if (val === 'v' || val === 'x' || val === '✓' || val === 'yes' || val === '1') {
        roles.push(roleColumns[i])
      }
    }
    players.push({ name, roles: [...new Set(roles)], mmr })
  }
  return players
}

const importPreview = computed(() => parseImportText(importText.value))

function onTabInImport(e: KeyboardEvent) {
  const ta = e.target as HTMLTextAreaElement
  const start = ta.selectionStart
  const end = ta.selectionEnd
  importText.value = ta.value.substring(0, start) + '\t' + ta.value.substring(end)
  nextTick(() => {
    ta.selectionStart = ta.selectionEnd = start + 1
  })
}

async function handleImport() {
  const players = importPreview.value
  if (players.length === 0) {
    importError.value = 'No valid players found. Check format: Name[tab]MMR[tab]v/empty for each role.'
    return
  }
  importing.value = true
  importError.value = ''
  try {
    for (const p of players) {
      await store.addPlayer({ name: p.name, roles: p.roles, mmr: p.mmr })
    }
    importText.value = ''
    showImportPlayers.value = false
  } catch (e: any) {
    importError.value = e.message || 'Import failed'
  } finally {
    importing.value = false
  }
}


</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[1440px] mx-auto w-full">
    <div>
      <h1 class="text-2xl font-semibold text-foreground">Player Pool</h1>
      <p class="text-sm text-muted-foreground mt-1">Manage the pool of Dota 2 players available for auction bidding</p>
    </div>

    <!-- Stats Row -->
    <div class="grid grid-cols-3 md:grid-cols-6 gap-3 md:gap-4">
      <div class="card p-3 md:p-4">
        <p class="text-[10px] md:text-xs font-semibold tracking-wider text-muted-foreground uppercase">Total</p>
        <p class="text-xl md:text-3xl font-bold text-foreground mt-1">{{ store.players.value.length }}</p>
      </div>
      <div class="card p-3 md:p-4">
        <p class="text-[10px] md:text-xs font-semibold tracking-wider text-muted-foreground uppercase">Carry</p>
        <p class="text-xl md:text-3xl font-bold text-foreground mt-1">{{ store.roleCounts.value.Carry }}</p>
      </div>
      <div class="card p-3 md:p-4">
        <p class="text-[10px] md:text-xs font-semibold tracking-wider text-muted-foreground uppercase">Mid</p>
        <p class="text-xl md:text-3xl font-bold text-foreground mt-1">{{ store.roleCounts.value.Mid }}</p>
      </div>
      <div class="card p-3 md:p-4">
        <p class="text-[10px] md:text-xs font-semibold tracking-wider text-muted-foreground uppercase">Offlane</p>
        <p class="text-xl md:text-3xl font-bold text-foreground mt-1">{{ store.roleCounts.value.Offlane }}</p>
      </div>
      <div class="card p-3 md:p-4">
        <p class="text-[10px] md:text-xs font-semibold tracking-wider text-muted-foreground uppercase">Pos 4</p>
        <p class="text-xl md:text-3xl font-bold text-foreground mt-1">{{ store.roleCounts.value.Pos4 }}</p>
      </div>
      <div class="card p-3 md:p-4">
        <p class="text-[10px] md:text-xs font-semibold tracking-wider text-muted-foreground uppercase">Pos 5</p>
        <p class="text-xl md:text-3xl font-bold text-foreground mt-1">{{ store.roleCounts.value.Pos5 }}</p>
      </div>
    </div>

    <!-- Players Table -->
    <div class="card">
      <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 px-4 py-3 border-b border-border">
        <div class="flex items-center gap-2">
          <Users class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">Players ({{ store.players.value.length }})</span>
        </div>
        <div class="flex items-center gap-2 sm:gap-3 w-full sm:w-auto">
          <div class="relative flex-1 sm:flex-initial">
            <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input v-model="searchQuery" type="text" placeholder="Search..." class="input-field pl-9 w-full sm:w-56" />
          </div>
          <template v-if="store.isAdmin.value">
            <button class="btn-outline text-sm flex-shrink-0" @click="showImportPlayers = true">
              <Upload class="w-4 h-4" />
              <span class="hidden sm:inline">Import</span>
            </button>
            <button class="btn-primary text-sm flex-shrink-0" @click="showAddPlayer = true">
              <UserPlus class="w-4 h-4" />
              <span class="hidden sm:inline">Add Player</span>
            </button>
          </template>
          <button v-if="!store.isAdmin.value && store.settings.allowSteamRegistration" class="btn-primary text-sm flex-shrink-0" @click="startSteamLogin">
            <LogIn class="w-4 h-4" />
            <span class="hidden sm:inline">Register via Steam</span>
          </button>
        </div>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border bg-accent/50">
              <th class="text-left px-4 py-3 font-medium text-muted-foreground w-[40px]">#</th>
              <th class="text-left px-4 py-3 font-medium text-muted-foreground">PLAYER NAME</th>
              <th class="text-left px-4 py-3 font-medium text-muted-foreground">ROLE</th>
              <th class="text-left px-4 py-3 font-medium text-muted-foreground w-[100px]">MMR</th>
              <th class="text-left px-4 py-3 font-medium text-muted-foreground">INFO</th>
              <th v-if="store.isAdmin.value" class="text-left px-4 py-3 font-medium text-muted-foreground w-[100px]">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(player, i) in filteredPlayers" :key="player.id" class="border-b border-border hover:bg-accent/30 transition-colors">
              <td class="px-4 py-3 text-muted-foreground">{{ String(i + 1).padStart(2, '0') }}</td>
              <td class="px-4 py-3">
                <div class="flex items-center gap-2.5">
                  <img v-if="player.avatar_url" :src="player.avatar_url" class="w-8 h-8 rounded-full object-cover" />
                  <div v-else class="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-xs font-semibold text-secondary-foreground">
                    {{ player.name.charAt(0) }}
                  </div>
                  <span class="font-medium text-foreground">{{ player.name }}</span>
                </div>
              </td>
              <td class="px-4 py-3">
                <div class="flex gap-1">
                  <RoleBadge v-for="role in sortedRoles(player.roles)" :key="role" :role="role" />
                </div>
              </td>
              <td class="px-4 py-3">
                <MmrDisplay :mmr="player.mmr" size="md" />
              </td>
              <td class="px-4 py-3 text-muted-foreground text-xs">{{ player.info }}</td>
              <td v-if="store.isAdmin.value" class="px-4 py-3">
                <div class="flex items-center gap-1">
                  <button class="btn-ghost p-2" @click="openEditPlayer(player)"><Pencil class="w-4 h-4" /></button>
                  <button class="btn-ghost p-2 text-destructive" @click="store.deletePlayer(player.id)"><Trash2 class="w-4 h-4" /></button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Add Player Modal -->
    <ModalOverlay :show="showAddPlayer" @close="showAddPlayer = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">Add New Player</h2>
        <p class="text-sm text-muted-foreground mt-1">Add a Dota 2 player to the auction pool with their details.</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-5">
        <InputGroup label="Player Name" :model-value="newPlayer.name" placeholder="e.g. Miracle-" @update:model-value="newPlayer.name = $event" />
        <div class="flex flex-col gap-2">
          <label class="label-text">Roles (select all that apply)</label>
          <div class="flex flex-wrap gap-x-5 gap-y-2">
            <label v-for="role in allRoles" :key="role" class="flex items-center gap-2 text-sm text-foreground cursor-pointer">
              <input type="checkbox" :checked="newPlayer.roles.includes(role)" class="w-4 h-4 rounded border-input text-primary focus:ring-primary" @change="toggleRole(role)" />
              {{ role }}
            </label>
          </div>
        </div>
        <InputGroup label="MMR" :model-value="newPlayer.mmr" placeholder="e.g. 11000" @update:model-value="newPlayer.mmr = $event" />
        <TextareaGroup label="Player Info" :model-value="newPlayer.info" placeholder="Brief description, achievements, playstyle notes..." :rows="3" @update:model-value="newPlayer.info = $event" />
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" @click="addPlayer">
          <UserPlus class="w-4 h-4" />
          Add Player
        </button>
        <button class="btn-secondary w-full justify-center" @click="showAddPlayer = false">
          Cancel
        </button>
      </div>
    </ModalOverlay>

    <!-- Import Players Modal -->
    <ModalOverlay :show="showImportPlayers" @close="showImportPlayers = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">Import Players</h2>
        <p class="text-sm text-muted-foreground mt-1">Paste tab-separated player data. Format: Name, MMR, then v for each role (Carry, Mid, Offlane, Pos4, Pos5).</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-4">
        <div class="flex flex-col gap-1.5">
          <label class="label-text">Paste player data</label>
          <textarea
            :value="importText"
            placeholder="Ri4man&#9;14000&#9;v&#9;v&#9;v&#9;v&#9;v&#10;majkk&#9;10500&#9;&#9;v"
            :rows="8"
            class="textarea-field"
            @input="importText = ($event.target as HTMLTextAreaElement).value"
            @keydown.tab.prevent="onTabInImport"
          />
        </div>
        <p v-if="importError" class="text-sm text-red-500">{{ importError }}</p>

        <!-- Preview -->
        <div v-if="importPreview.length > 0">
          <p class="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Preview ({{ importPreview.length }} players)</p>
          <div class="max-h-[200px] overflow-y-auto border border-border rounded">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border bg-accent/50">
                  <th class="text-left px-3 py-2 font-medium text-muted-foreground text-xs">NAME</th>
                  <th class="text-left px-3 py-2 font-medium text-muted-foreground text-xs">MMR</th>
                  <th class="text-left px-3 py-2 font-medium text-muted-foreground text-xs">ROLES</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(p, i) in importPreview" :key="i" class="border-b border-border">
                  <td class="px-3 py-1.5 text-foreground">{{ p.name }}</td>
                  <td class="px-3 py-1.5 font-mono text-foreground">{{ p.mmr.toLocaleString() }}</td>
                  <td class="px-3 py-1.5">
                    <div class="flex flex-wrap gap-1">
                      <RoleBadge v-for="role in sortedRoles(p.roles)" :key="role" :role="role" size="xs" />
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" :disabled="importPreview.length === 0 || importing" @click="handleImport">
          <Upload class="w-4 h-4" />
          {{ importing ? 'Importing...' : `Import ${importPreview.length} Players` }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showImportPlayers = false">
          Cancel
        </button>
      </div>
    </ModalOverlay>

    <!-- Steam Register Modal -->
    <ModalOverlay :show="showRegister" @close="showRegister = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">Complete Registration</h2>
        <p class="text-sm text-muted-foreground mt-1">Fill in your Dota 2 details to finish signing up.</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-5">
        <p v-if="registerError" class="text-sm text-red-500 bg-red-500/10 rounded px-3 py-2">{{ registerError }}</p>

        <!-- Steam profile info (read-only, from Steam) -->
        <template v-if="steamProfile">
          <div class="flex items-center gap-4 p-4 rounded-lg bg-accent/50 border border-border">
            <img v-if="steamProfile.avatarUrl" :src="steamProfile.avatarUrl" class="w-14 h-14 rounded-full" />
            <div v-else class="w-14 h-14 rounded-full bg-secondary flex items-center justify-center text-lg font-bold text-secondary-foreground">
              {{ steamProfile.name.charAt(0) }}
            </div>
            <div>
              <p class="font-semibold text-foreground text-lg">{{ steamProfile.name }}</p>
              <p class="text-xs text-muted-foreground">Steam ID: {{ steamProfile.steamId }}</p>
            </div>
          </div>
        </template>

        <!-- If no steam profile yet (error state), show login button -->
        <template v-if="!steamProfile">
          <button class="btn-primary w-full justify-center py-3" @click="startSteamLogin">
            <LogIn class="w-5 h-5" />
            Sign in with Steam
          </button>
        </template>

        <template v-if="steamProfile">
          <div class="flex flex-col gap-2">
            <label class="label-text">Roles (select all that apply)</label>
            <div class="flex flex-wrap gap-x-5 gap-y-2">
              <label v-for="role in allRoles" :key="role" class="flex items-center gap-2 text-sm text-foreground cursor-pointer">
                <input type="checkbox" :checked="registerRoles.includes(role)" class="w-4 h-4 rounded border-input text-primary focus:ring-primary" @change="toggleRegisterRole(role)" />
                {{ role }}
              </label>
            </div>
          </div>
          <InputGroup label="MMR" :model-value="registerMmr" placeholder="e.g. 11000" @update:model-value="registerMmr = $event" />
          <TextareaGroup label="About You" :model-value="registerInfo" placeholder="Brief description, achievements, playstyle notes..." :rows="3" @update:model-value="registerInfo = $event" />
        </template>
      </div>
      <div v-if="steamProfile" class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" :disabled="registering" @click="submitRegistration">
          <UserPlus class="w-4 h-4" />
          {{ registering ? 'Registering...' : 'Complete Registration' }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showRegister = false">
          Cancel
        </button>
      </div>
      <div v-else class="px-7 py-5 border-t border-border">
        <button class="btn-secondary w-full justify-center" @click="showRegister = false">
          Close
        </button>
      </div>
    </ModalOverlay>

    <!-- Edit Player Modal -->
    <ModalOverlay :show="showEditPlayer" @close="showEditPlayer = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">Edit Player</h2>
        <p class="text-sm text-muted-foreground mt-1">Update this player's details.</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-5">
        <InputGroup label="Player Name" :model-value="editPlayer.name" placeholder="e.g. Miracle-" @update:model-value="editPlayer.name = $event" />
        <div class="flex flex-col gap-2">
          <label class="label-text">Roles (select all that apply)</label>
          <div class="flex flex-wrap gap-x-5 gap-y-2">
            <label v-for="role in allRoles" :key="role" class="flex items-center gap-2 text-sm text-foreground cursor-pointer">
              <input type="checkbox" :checked="editPlayer.roles.includes(role)" class="w-4 h-4 rounded border-input text-primary focus:ring-primary" @change="toggleEditRole(role)" />
              {{ role }}
            </label>
          </div>
        </div>
        <InputGroup label="MMR" :model-value="editPlayer.mmr" placeholder="e.g. 11000" @update:model-value="editPlayer.mmr = $event" />
        <TextareaGroup label="Player Info" :model-value="editPlayer.info" placeholder="Brief description, achievements, playstyle notes..." :rows="3" @update:model-value="editPlayer.info = $event" />
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" @click="savePlayer">
          <Pencil class="w-4 h-4" />
          Save Changes
        </button>
        <button class="btn-secondary w-full justify-center" @click="showEditPlayer = false">
          Cancel
        </button>
      </div>
    </ModalOverlay>
  </div>
</template>
