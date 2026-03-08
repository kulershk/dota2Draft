<script setup lang="ts">
import { Users, UserPlus, Search, Pencil, Trash2, ExternalLink, LogIn } from 'lucide-vue-next'
import { ref, computed } from 'vue'
import { useDraftStore } from '@/composables/useDraftStore'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import InputGroup from '@/components/common/InputGroup.vue'
import RoleBadge from '@/components/common/RoleBadge.vue'
import MmrDisplay from '@/components/common/MmrDisplay.vue'
import { sortedRoles } from '@/utils/roles'

const store = useDraftStore()
const showEditPlayer = ref(false)
const showRegister = ref(false)
const searchQuery = ref('')

// Registration state
const registerRoles = ref<string[]>([])
const registerMmr = ref('')
const registerInfo = ref('')
const registerError = ref('')
const registering = ref(false)

function loginWithSteam() {
  window.location.href = '/api/auth/steam'
}

function toggleRegisterRole(role: string) {
  const idx = registerRoles.value.indexOf(role)
  if (idx >= 0) registerRoles.value.splice(idx, 1)
  else registerRoles.value.push(role)
}

function openRegister() {
  // Prefill from competition-specific data if available, else global user data
  const cu = store.compUser.value
  const user = store.currentUser.value
  const roles = cu?.roles?.length ? cu.roles : (user?.roles || [])
  const mmr = cu?.mmr || user?.mmr || 0
  const info = cu?.info || user?.info || ''
  registerRoles.value = roles.map((r: string) => {
    for (const [display, short] of Object.entries(roleMap)) {
      if (short === r) return display
    }
    return r
  })
  registerMmr.value = mmr ? String(mmr) : ''
  registerInfo.value = info
  registerError.value = ''
  showRegister.value = true
}

async function submitRegistration() {
  registering.value = true
  registerError.value = ''
  try {
    await store.registerForPool({
      roles: [...new Set(registerRoles.value.map(r => roleMap[r] || r))],
      mmr: Number(registerMmr.value) || 0,
      info: registerInfo.value,
    })
    showRegister.value = false
  } catch (e: any) {
    registerError.value = e.message || 'Registration failed'
  } finally {
    registering.value = false
  }
}

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
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[1440px] mx-auto w-full">
    <div>
      <h1 class="text-2xl font-semibold text-foreground">Participants</h1>
      <p class="text-sm text-muted-foreground mt-1">Dota 2 players available for auction bidding</p>
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
          <button v-if="store.currentUser.value && !store.compUser.value?.in_pool && !store.compUser.value?.captain" class="btn-primary text-sm flex-shrink-0" @click="openRegister">
            <UserPlus class="w-4 h-4" />
            <span class="hidden sm:inline">Join as Participant</span>
          </button>
          <button v-else-if="!store.currentUser.value && store.settings.allowSteamRegistration" class="btn-primary text-sm flex-shrink-0" @click="loginWithSteam">
            <LogIn class="w-4 h-4" />
            <span class="hidden sm:inline">Login to Join</span>
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
                  <div class="flex flex-col">
                    <span class="font-medium text-foreground">{{ player.name }}</span>
                    <div v-if="player.steam_id" class="flex items-center gap-2 mt-0.5">
                      <a :href="`https://steamcommunity.com/profiles/${player.steam_id}`" target="_blank" rel="noopener" class="text-[10px] text-muted-foreground hover:text-primary transition-colors flex items-center gap-0.5">
                        Steam <ExternalLink class="w-2.5 h-2.5" />
                      </a>
                      <a :href="`https://www.dotabuff.com/players/${BigInt(player.steam_id) - BigInt('76561197960265728')}`" target="_blank" rel="noopener" class="text-[10px] text-muted-foreground hover:text-primary transition-colors flex items-center gap-0.5">
                        Dotabuff <ExternalLink class="w-2.5 h-2.5" />
                      </a>
                    </div>
                  </div>
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

    <!-- Join as Participant Modal -->
    <ModalOverlay :show="showRegister" @close="showRegister = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">Join as Participant</h2>
        <p class="text-sm text-muted-foreground mt-1">Fill in your Dota 2 details to join as a participant.</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-5">
        <p v-if="registerError" class="text-sm text-red-500 bg-red-500/10 rounded px-3 py-2">{{ registerError }}</p>

        <div v-if="store.currentUser.value" class="flex items-center gap-4 p-4 rounded-lg bg-accent/50 border border-border">
          <img v-if="store.currentUser.value.avatar_url" :src="store.currentUser.value.avatar_url" class="w-14 h-14 rounded-full" />
          <div v-else class="w-14 h-14 rounded-full bg-secondary flex items-center justify-center text-lg font-bold text-secondary-foreground">
            {{ store.currentUser.value.name.charAt(0) }}
          </div>
          <div>
            <p class="font-semibold text-foreground text-lg">{{ store.currentUser.value.name }}</p>
            <p class="text-xs text-muted-foreground">Steam ID: {{ store.currentUser.value.steam_id }}</p>
          </div>
        </div>

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
        <div class="flex flex-col gap-1.5">
          <label class="label-text">About You</label>
          <textarea :value="registerInfo" maxlength="200" placeholder="Brief description, achievements, playstyle notes..." rows="3" class="textarea-field" @input="registerInfo = ($event.target as HTMLTextAreaElement).value" />
          <p class="text-xs text-muted-foreground text-right">{{ registerInfo.length }}/200</p>
        </div>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" :disabled="registering" @click="submitRegistration">
          <UserPlus class="w-4 h-4" />
          {{ registering ? 'Joining...' : 'Join as Participant' }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showRegister = false">
          Cancel
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
        <div class="flex flex-col gap-1.5">
          <label class="label-text">Player Info</label>
          <textarea :value="editPlayer.info" maxlength="200" placeholder="Brief description, achievements, playstyle notes..." rows="3" class="textarea-field" @input="editPlayer.info = ($event.target as HTMLTextAreaElement).value" />
        </div>
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
