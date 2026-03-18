<script setup lang="ts">
import { Users, UserPlus, Search, Pencil, Trash2, ExternalLink, LogIn, Shield } from 'lucide-vue-next'
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDraftStore } from '@/composables/useDraftStore'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import InputGroup from '@/components/common/InputGroup.vue'
import RoleBadge from '@/components/common/RoleBadge.vue'
import MmrDisplay from '@/components/common/MmrDisplay.vue'
import { sortedRoles } from '@/utils/roles'

const { t } = useI18n()
const store = useDraftStore()
const showEditPlayer = ref(false)
const showRegister = ref(false)
const searchQuery = ref('')
const activeRoleFilter = ref<string | null>(null)

function toggleRoleFilter(role: string) {
  activeRoleFilter.value = activeRoleFilter.value === role ? null : role
  playersPage.value = 1
}

// Registration state
const registerRoles = ref<string[]>([])
const registerMmr = ref('')
const registerInfo = ref('')
const registerError = ref('')
const registering = ref(false)

function loginWithSteam() {
  window.location.href = '/api/auth/steam'
}

const registrationOpen = computed(() => {
  const comp = store.currentCompetition.value
  if (!comp) return false
  const now = new Date()
  if (comp.registration_start && new Date(comp.registration_start) > now) return false
  if (comp.registration_end && new Date(comp.registration_end) < now) return false
  return true
})

const registrationStatus = computed(() => {
  const comp = store.currentCompetition.value
  if (!comp) return ''
  const now = new Date()
  if (comp.registration_start && new Date(comp.registration_start) > now) {
    return t('registrationOpensAt', { date: new Date(comp.registration_start).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })
  }
  if (comp.registration_end && new Date(comp.registration_end) < now) {
    return t('registrationClosedLabel')
  }
  return ''
})

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

const playersPage = ref(1)
const PLAYERS_PAGE_SIZE = 20

const filteredPlayers = computed(() => {
  let list = [...store.players.value].sort((a, b) => b.mmr - a.mmr)
  if (activeRoleFilter.value) {
    list = list.filter(p => p.roles.includes(activeRoleFilter.value!))
  }
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter(p =>
      p.name.toLowerCase().includes(q) || p.roles.some(r => r.toLowerCase().includes(q))
    )
  }
  return list
})

const paginatedPlayers = computed(() => filteredPlayers.value.slice(0, playersPage.value * PLAYERS_PAGE_SIZE))
const hasMorePlayers = computed(() => paginatedPlayers.value.length < filteredPlayers.value.length)

watch(searchQuery, () => { playersPage.value = 1 })
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[1200px] mx-auto w-full">
    <div>
      <h1 class="text-2xl font-semibold text-foreground">{{ t('participantsTitle') }}</h1>
      <p class="text-sm text-muted-foreground mt-1">{{ t('participantsSubtitle') }}</p>
    </div>

    <!-- Stats Row -->
    <div class="grid grid-cols-3 md:grid-cols-6 gap-3 md:gap-4">
      <div class="card p-3 md:p-4 cursor-pointer transition-colors" :class="!activeRoleFilter ? 'ring-2 ring-primary' : 'hover:bg-accent/50'" @click="activeRoleFilter = null">
        <p class="text-[10px] md:text-xs font-semibold tracking-wider text-muted-foreground uppercase">{{ t('total') }}</p>
        <p class="text-xl md:text-3xl font-bold text-foreground mt-1">{{ store.players.value.length }}</p>
      </div>
      <div v-for="role in ['Carry', 'Mid', 'Offlane', 'Pos4', 'Pos5']" :key="role" class="card p-3 md:p-4 cursor-pointer transition-colors" :class="activeRoleFilter === role ? 'ring-2 ring-primary' : 'hover:bg-accent/50'" @click="toggleRoleFilter(role)">
        <p class="text-[10px] md:text-xs font-semibold tracking-wider text-muted-foreground uppercase">{{ t(role.toLowerCase()) }}</p>
        <p class="text-xl md:text-3xl font-bold text-foreground mt-1">{{ store.roleCounts.value[role as keyof typeof store.roleCounts.value] }}</p>
      </div>
    </div>

    <!-- Players Table -->
    <div class="card">
      <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 px-4 py-3 border-b border-border">
        <div class="flex items-center gap-2">
          <Users class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">{{ t('players') }} ({{ store.players.value.length }})</span>
        </div>
        <div class="flex items-center gap-2 sm:gap-3 w-full sm:w-auto">
          <div class="relative flex-1 sm:flex-initial">
            <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input v-model="searchQuery" type="text" :placeholder="t('search')" class="input-field pl-9 w-full sm:w-56" />
          </div>
          <template v-if="store.currentUser.value && !store.compUser.value?.in_pool && !store.compUser.value?.captain">
            <button v-if="registrationOpen || store.isAdmin.value" class="btn-primary text-sm flex-shrink-0" @click="openRegister">
              <UserPlus class="w-4 h-4" />
              <span class="hidden sm:inline">{{ t('joinAsParticipant') }}</span>
            </button>
            <span v-else-if="registrationStatus" class="text-xs text-muted-foreground italic flex-shrink-0">{{ registrationStatus }}</span>
          </template>
          <template v-else-if="!store.currentUser.value && store.settings.allowSteamRegistration">
            <button v-if="registrationOpen" class="btn-primary text-sm flex-shrink-0" @click="loginWithSteam">
              <LogIn class="w-4 h-4" />
              <span class="hidden sm:inline">{{ t('loginToJoin') }}</span>
            </button>
            <span v-else-if="registrationStatus" class="text-xs text-muted-foreground italic flex-shrink-0">{{ registrationStatus }}</span>
          </template>
        </div>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border bg-accent/50">
              <th class="text-left px-4 py-3 font-medium text-muted-foreground w-[40px]">#</th>
              <th class="text-left px-4 py-3 font-medium text-muted-foreground">{{ t('playerName') }}</th>
              <th class="text-left px-4 py-3 font-medium text-muted-foreground">{{ t('role') }}</th>
              <th class="text-left px-4 py-3 font-medium text-muted-foreground w-[100px]">{{ t('mmr') }}</th>
              <th class="text-left px-4 py-3 font-medium text-muted-foreground">{{ t('info') }}</th>
              <th v-if="store.isAdmin.value" class="text-left px-4 py-3 font-medium text-muted-foreground w-[100px]">{{ t('actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(player, i) in paginatedPlayers" :key="player.id" class="border-b border-border hover:bg-accent/30 transition-colors">
              <td class="px-4 py-3 text-muted-foreground">{{ String(i + 1).padStart(2, '0') }}</td>
              <td class="px-4 py-3">
                <div class="flex items-center gap-2.5">
                  <img v-if="player.avatar_url" :src="player.avatar_url" class="w-8 h-8 rounded-full object-cover" />
                  <div v-else class="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-xs font-semibold text-secondary-foreground">
                    {{ player.name.charAt(0) }}
                  </div>
                  <div class="flex flex-col">
                    <router-link :to="{ name: 'player-profile', params: { id: player.id } }" class="font-medium text-foreground hover:text-primary transition-colors flex items-center gap-1.5">
                      <Shield v-if="player.is_captain" class="w-3.5 h-3.5 text-amber-500 flex-shrink-0" :title="t('captainCol')" />
                      {{ player.name }}
                    </router-link>
                    <div v-if="player.steam_id" class="flex items-center gap-2 mt-0.5">
                      <a :href="`https://steamcommunity.com/profiles/${player.steam_id}`" target="_blank" rel="noopener" class="text-[10px] text-muted-foreground hover:text-primary transition-colors flex items-center gap-0.5">
                        Steam <ExternalLink class="w-2.5 h-2.5" />
                      </a>
                      <a v-if="player.steam_id && /^\d{10,}$/.test(player.steam_id)" :href="`https://www.dotabuff.com/players/${BigInt(player.steam_id) - BigInt('76561197960265728')}`" target="_blank" rel="noopener" class="text-[10px] text-muted-foreground hover:text-primary transition-colors flex items-center gap-0.5">
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
      <div v-if="hasMorePlayers" class="px-4 py-3 border-t border-border text-center">
        <button class="btn-ghost text-sm text-primary" @click="playersPage++">
          {{ t('showMore', { remaining: filteredPlayers.length - paginatedPlayers.length }) }}
        </button>
      </div>
      <div v-else-if="filteredPlayers.length > PLAYERS_PAGE_SIZE" class="px-4 py-2 border-t border-border text-center">
        <span class="text-xs text-muted-foreground">{{ t('showingAll', { count: filteredPlayers.length }) }}</span>
      </div>
    </div>

    <!-- Join as Participant Modal -->
    <ModalOverlay :show="showRegister" @close="showRegister = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('joinModal.title') }}</h2>
        <p class="text-sm text-muted-foreground mt-1">{{ t('joinModal.subtitle') }}</p>
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

        <div class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('joinModal.roles') }}</label>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="role in allRoles"
              :key="role"
              class="px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors"
              :class="registerRoles.includes(role)
                ? 'bg-primary/10 border-primary/30 text-foreground'
                : 'border-border text-muted-foreground hover:border-foreground/20'"
              @click="toggleRegisterRole(role)"
            >
              <RoleBadge :role="roleMap[role] || role" size="sm" />
            </button>
          </div>
        </div>
        <InputGroup label="MMR" :model-value="registerMmr" placeholder="e.g. 11000" @update:model-value="registerMmr = $event" />
        <div class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('joinModal.aboutYou') }}</label>
          <textarea :value="registerInfo" maxlength="200" :placeholder="t('joinModal.aboutPlaceholder')" rows="3" class="textarea-field" @input="registerInfo = ($event.target as HTMLTextAreaElement).value" />
          <p class="text-xs text-muted-foreground text-right">{{ registerInfo.length }}/200</p>
        </div>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" :disabled="registering" @click="submitRegistration">
          <UserPlus class="w-4 h-4" />
          {{ registering ? t('joinModal.joining') : t('joinAsParticipant') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showRegister = false">
          {{ t('cancel') }}
        </button>
      </div>
    </ModalOverlay>

    <!-- Edit Player Modal -->
    <ModalOverlay :show="showEditPlayer" @close="showEditPlayer = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('editPlayerModal.title') }}</h2>
        <p class="text-sm text-muted-foreground mt-1">{{ t('editPlayerModal.subtitle') }}</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-5">
        <InputGroup label="Player Name" :model-value="editPlayer.name" placeholder="e.g. Miracle-" @update:model-value="editPlayer.name = $event" />
        <div class="flex flex-col gap-1.5">
          <label class="label-text">Roles (select all that apply)</label>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="role in allRoles"
              :key="role"
              class="px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors"
              :class="editPlayer.roles.includes(role)
                ? 'bg-primary/10 border-primary/30 text-foreground'
                : 'border-border text-muted-foreground hover:border-foreground/20'"
              @click="toggleEditRole(role)"
            >
              <RoleBadge :role="roleMap[role] || role" size="sm" />
            </button>
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
          {{ t('editPlayerModal.saveChanges') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showEditPlayer = false">
          {{ t('cancel') }}
        </button>
      </div>
    </ModalOverlay>
  </div>
</template>
