<script setup lang="ts">
import { Users, UserPlus, Search, Pencil, Trash2, LogIn, Shield, RefreshCw } from 'lucide-vue-next'
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDraftStore } from '@/composables/useDraftStore'
import { useApi } from '@/composables/useApi'
import { getServerNow } from '@/composables/useSocket'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import InputGroup from '@/components/common/InputGroup.vue'
import RoleBadge from '@/components/common/RoleBadge.vue'
import MmrDisplay from '@/components/common/MmrDisplay.vue'
import { sortedRoles } from '@/utils/roles'
import { fmtDateTime } from '@/utils/format'
import UserName from '@/components/common/UserName.vue'

const { t } = useI18n()
const store = useDraftStore()
const api = useApi()
const showEditPlayer = ref(false)
const syncingRoles = ref(false)

async function syncRoles() {
  const compId = store.currentCompetitionId.value
  if (!compId) return
  syncingRoles.value = true
  try {
    await api.syncPlayerRoles(compId)
  } catch (e: any) {
    console.error('Sync roles error:', e.message)
  } finally {
    syncingRoles.value = false
  }
}
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
  const now = new Date(getServerNow())
  if (comp.registration_start && new Date(comp.registration_start) > now) return false
  if (comp.registration_end && new Date(comp.registration_end) < now) return false
  return true
})

const registrationStatus = computed(() => {
  const comp = store.currentCompetition.value
  if (!comp) return ''
  const now = new Date(getServerNow())
  if (comp.registration_start && new Date(comp.registration_start) > now) {
    return t('registrationOpensAt', { date: fmtDateTime(new Date(comp.registration_start)) })
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

const editPlayer = ref({ id: 0, name: '', roles: [] as string[], mmr: '', info: '', playing_role: null as number | null })

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
    playing_role: player.playing_role ?? null,
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
    playing_role: editPlayer.value.playing_role,
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
    <div class="flex gap-2 md:gap-4 overflow-x-auto">
      <div class="flex-1 min-w-[60px] stat-card cursor-pointer transition-colors" :class="!activeRoleFilter ? 'shadow-[inset_0_0_0_2px_rgb(var(--primary))]' : 'hover:brightness-110'" @click="activeRoleFilter = null">
        <span class="stat-card-label">{{ t('total') }}</span>
        <span class="stat-card-value">{{ store.players.value.length }}</span>
      </div>
      <div v-for="role in ['Carry', 'Mid', 'Offlane', 'Pos4', 'Pos5']" :key="role"
        class="flex-1 min-w-[60px] stat-card cursor-pointer transition-colors"
        :class="activeRoleFilter === role ? 'shadow-[inset_0_0_0_2px_rgb(var(--primary))]' : 'hover:brightness-110'"
        @click="toggleRoleFilter(role)">
        <span class="stat-card-label">{{ t(role.toLowerCase()) }}</span>
        <span class="stat-card-value">{{ store.roleCounts.value[role as keyof typeof store.roleCounts.value] }}</span>
      </div>
    </div>

    <!-- Players Table -->
    <div>
      <!-- Table toolbar -->
      <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-4">
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
          <button v-if="store.isAdmin.value" class="btn-secondary text-sm flex-shrink-0" :disabled="syncingRoles" @click="syncRoles">
            <RefreshCw class="w-4 h-4" :class="{ 'animate-spin': syncingRoles }" />
            <span class="hidden sm:inline">{{ t('syncRoles') }}</span>
          </button>
        </div>
      </div>

      <!-- Table header -->
      <div class="hidden md:flex items-center rounded-t-md bg-surface px-4 py-3">
        <span class="w-10 text-[11px] font-semibold font-mono uppercase tracking-wider text-text-tertiary">#</span>
        <span class="flex-1 text-[11px] font-semibold font-mono uppercase tracking-wider text-text-tertiary">{{ t('playerName') }}</span>
        <span class="w-[120px] text-[11px] font-semibold font-mono uppercase tracking-wider text-text-tertiary">{{ t('role') }}</span>
        <span class="w-20 text-[11px] font-semibold font-mono uppercase tracking-wider text-text-tertiary text-right">{{ t('mmr') }}</span>
        <span class="w-32 text-[11px] font-semibold font-mono uppercase tracking-wider text-text-tertiary text-right">{{ t('info') }}</span>
        <span v-if="store.isAdmin.value" class="w-20 text-[11px] font-semibold font-mono uppercase tracking-wider text-text-tertiary text-right">{{ t('actions') }}</span>
      </div>

      <!-- Desktop table rows -->
      <div v-for="(player, i) in paginatedPlayers" :key="player.id"
        class="hidden md:flex items-center px-4 py-3 border-b border-border hover:bg-surface/50 transition-colors">
        <!-- Rank -->
        <span class="w-10 text-sm font-mono text-text-tertiary">{{ String(i + 1).padStart(2, '0') }}</span>
        <!-- Player name -->
        <div class="w-[180px] flex items-center gap-1.5 min-w-0 shrink-0">
          <UserName :id="player.id" :name="player.name" :avatar-url="player.avatar_url" />
          <Shield v-if="player.is_captain" class="w-3.5 h-3.5 text-amber-500 flex-shrink-0" :title="t('captainCol')" />
        </div>
        <!-- Roles -->
        <div class="w-[120px] flex flex-wrap gap-1 items-center shrink-0">
          <RoleBadge v-for="role in sortedRoles(player.roles)" :key="role" :role="role" />
          <span v-if="player.playing_role" class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-primary/15 text-primary border border-primary/25" :title="t('playingRole')">
            P{{ player.playing_role }}
          </span>
        </div>
        <!-- MMR -->
        <div class="w-16 text-right shrink-0">
          <MmrDisplay :mmr="player.mmr" size="md" />
        </div>
        <!-- Info -->
        <span class="flex-1 text-sm text-muted-foreground truncate ml-3 min-w-0" :title="player.info">{{ player.info }}</span>
        <!-- Actions -->
        <div v-if="store.isAdmin.value" class="w-20 flex items-center justify-end gap-2">
          <button class="text-text-tertiary hover:text-foreground transition-colors" @click="openEditPlayer(player)"><Pencil class="w-4 h-4" /></button>
          <button class="text-text-tertiary hover:text-destructive transition-colors" @click="store.deletePlayer(player.id)"><Trash2 class="w-4 h-4" /></button>
        </div>
      </div>

      <!-- Mobile card rows -->
      <div v-for="(player, i) in paginatedPlayers" :key="'m-' + player.id"
        class="flex md:hidden items-start gap-3 px-3 py-3 border-b border-border">
        <span class="text-xs font-mono text-text-tertiary mt-1 w-6 shrink-0">{{ i + 1 }}</span>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-1.5 min-w-0">
              <UserName :id="player.id" :name="player.name" :avatar-url="player.avatar_url" />
              <Shield v-if="player.is_captain" class="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
            </div>
            <MmrDisplay :mmr="player.mmr" size="sm" />
          </div>
          <div class="flex flex-wrap gap-1 mt-1">
            <RoleBadge v-for="role in sortedRoles(player.roles)" :key="role" :role="role" />
            <span v-if="player.playing_role" class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-primary/15 text-primary border border-primary/25">
              P{{ player.playing_role }}
            </span>
          </div>
          <div v-if="player.info" class="text-[11px] text-muted-foreground mt-1 truncate">{{ player.info }}</div>
          <div v-if="store.isAdmin.value" class="flex gap-3 mt-1.5">
            <button class="text-text-tertiary hover:text-foreground transition-colors" @click="openEditPlayer(player)"><Pencil class="w-3.5 h-3.5" /></button>
            <button class="text-text-tertiary hover:text-destructive transition-colors" @click="store.deletePlayer(player.id)"><Trash2 class="w-3.5 h-3.5" /></button>
          </div>
        </div>
      </div>

      <!-- Show more -->
      <div v-if="hasMorePlayers" class="flex justify-center py-4">
        <button class="text-sm font-medium text-primary hover:text-primary/80 transition-colors" @click="playersPage++">
          {{ t('showMore', { remaining: filteredPlayers.length - paginatedPlayers.length }) }}
        </button>
      </div>
      <div v-else-if="filteredPlayers.length > PLAYERS_PAGE_SIZE" class="flex justify-center py-3">
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
          <label class="label-text">{{ t('playingRole') }}</label>
          <select class="input-field" :value="editPlayer.playing_role ?? ''" @change="editPlayer.playing_role = ($event.target as HTMLSelectElement).value ? Number(($event.target as HTMLSelectElement).value) : null">
            <option value="">{{ t('playingRoleNone') }}</option>
            <option :value="1">Pos 1 — Carry</option>
            <option :value="2">Pos 2 — Mid</option>
            <option :value="3">Pos 3 — Offlane</option>
            <option :value="4">Pos 4 — Soft Support</option>
            <option :value="5">Pos 5 — Hard Support</option>
          </select>
        </div>
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
