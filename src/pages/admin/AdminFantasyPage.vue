<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Star, Trash2, Search, ChevronDown, ChevronUp, Users } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import ModalOverlay from '@/components/common/ModalOverlay.vue'

const { t } = useI18n()
const api = useApi()
const store = useDraftStore()

const ROLES = ['carry', 'mid', 'offlane', 'pos4', 'pos5'] as const

// State
const competitions = ref<any[]>([])
const selectedCompId = ref<number | null>(null)
const loading = ref(false)
const stages = ref<any[]>([])
const picks = ref<Record<number, Record<number, Record<string, number>>>>({}) // userId -> stageId -> role -> pickPlayerId
const users = ref<any[]>([])
const compPlayers = ref<any[]>([])
const captains = ref<any[]>([])
const expandedUserId = ref<number | null>(null)

// Pick modal
const showPickModal = ref(false)
const pickUserId = ref<number | null>(null)
const pickStageId = ref<number | null>(null)
const pickRole = ref('')
const pickSearch = ref('')

// Search/filter for users
const userSearch = ref('')

// Add user search
const addUserSearch = ref('')
const showAddUser = ref(false)

const addableUsers = computed(() => {
  const existingIds = new Set(users.value.map((u: any) => u.id))
  const q = addUserSearch.value.toLowerCase()
  return compPlayers.value
    .filter((cp: any) => !existingIds.has(cp.player_id))
    .filter((cp: any) => !q || (cp.name || '').toLowerCase().includes(q))
    .slice(0, 20) // limit results
})

function addUser(playerId: number) {
  const cp = compPlayers.value.find((p: any) => p.player_id === playerId)
  if (!cp) return
  // Add to users list locally
  users.value.push({ id: cp.player_id, name: cp.name, avatar_url: cp.avatar_url })
  addUserSearch.value = ''
  showAddUser.value = false
  // Auto-expand the new user
  expandedUserId.value = cp.player_id
}

onMounted(async () => {
  try {
    competitions.value = await api.getCompetitions()
  } catch {}
})

const filteredComps = computed(() => {
  return competitions.value.filter((c: any) => {
    // Admin must have permission
    return store.hasPerm('manage_competitions') ||
      (store.hasPerm('manage_own_competitions') && c.created_by === store.currentUser.value?.id)
  })
})

watch(selectedCompId, async (compId) => {
  if (!compId) {
    stages.value = []
    picks.value = {}
    users.value = []
    compPlayers.value = []
    captains.value = []
    return
  }
  await loadData()
})

async function loadData() {
  const compId = selectedCompId.value
  if (!compId) return
  loading.value = true
  try {
    const data = await api.getAdminFantasyPicks(compId)
    stages.value = data.stages || []
    picks.value = data.picks || {}
    users.value = data.users || []
    compPlayers.value = data.compPlayers || []
    captains.value = data.captains || []
  } catch {
    stages.value = []
    picks.value = {}
    users.value = []
  } finally {
    loading.value = false
  }
}

// Admin sees all stages regardless of status
const allStages = computed(() => stages.value)

const sortedUsers = computed(() => {
  // Users with picks first, then alphabetical
  return [...users.value].sort((a: any, b: any) => {
    const aPicks = userPickCount(a.id)
    const bPicks = userPickCount(b.id)
    if (aPicks > 0 && bPicks === 0) return -1
    if (aPicks === 0 && bPicks > 0) return 1
    return (a.name || '').localeCompare(b.name || '')
  })
})

const filteredUsers = computed(() => {
  const q = userSearch.value.toLowerCase()
  if (!q) return sortedUsers.value
  return sortedUsers.value.filter((u: any) => (u.name || '').toLowerCase().includes(q))
})

function getUserPicks(userId: number, stageId: number): Record<string, number> {
  return picks.value[userId]?.[stageId] || {}
}

function getPickPlayerName(playerId: number): string {
  const p = compPlayers.value.find((cp: any) => cp.player_id === playerId)
  return p?.name || `Player #${playerId}`
}

function getPickPlayerTeam(playerId: number): string {
  const cp = compPlayers.value.find((p: any) => p.player_id === playerId)
  if (!cp) {
    // Check if player is a captain
    const cap = captains.value.find((c: any) => c.player_id === playerId)
    return cap?.team || ''
  }
  const cap = captains.value.find((c: any) => c.id === cp.drafted_by)
  if (cap) return cap.team
  // Player might be a captain themselves
  const selfCap = captains.value.find((c: any) => c.player_id === playerId)
  return selfCap?.team || ''
}

function userPickCount(userId: number): number {
  const userPicks = picks.value[userId]
  if (!userPicks) return 0
  let count = 0
  for (const stageId of Object.keys(userPicks)) {
    count += Object.keys(userPicks[Number(stageId)]).length
  }
  return count
}

// Team-grouped players for pick modal
const teamGroupedPlayers = computed(() => {
  const groups: { captain: any; players: any[] }[] = []
  for (const cap of captains.value) {
    const teamPlayers: any[] = []
    // Captain themselves
    if (cap.player_id) {
      const p = compPlayers.value.find((cp: any) => cp.player_id === cap.player_id)
      if (p) teamPlayers.push({ ...p, _isCaptain: true })
    }
    // Drafted players
    for (const cp of compPlayers.value) {
      if (cp.drafted_by === cap.id && cp.player_id !== cap.player_id) {
        teamPlayers.push(cp)
      }
    }
    if (teamPlayers.length > 0) {
      groups.push({ captain: cap, players: teamPlayers })
    }
  }
  return groups
})

const filteredTeamGroups = computed(() => {
  const q = pickSearch.value.toLowerCase()
  const result: { captain: any; players: any[] }[] = []
  for (const group of teamGroupedPlayers.value) {
    const filtered = group.players.filter((p: any) => {
      return (p.name || '').toLowerCase().includes(q)
    })
    if (filtered.length > 0) {
      result.push({ captain: group.captain, players: filtered })
    }
  }
  return result
})

// Players already picked by this user in other roles for this stage
const pickedPlayerIds = computed(() => {
  if (!pickUserId.value || !pickStageId.value) return new Set<number>()
  const stagePicks = getUserPicks(pickUserId.value, pickStageId.value)
  const ids = new Set<number>()
  for (const [role, pid] of Object.entries(stagePicks)) {
    if (role !== pickRole.value) ids.add(pid as number)
  }
  return ids
})

function openPick(userId: number, stageId: number, role: string) {
  pickUserId.value = userId
  pickStageId.value = stageId
  pickRole.value = role
  pickSearch.value = ''
  showPickModal.value = true
}

async function selectPlayer(playerId: number) {
  const compId = selectedCompId.value
  if (!compId || !pickUserId.value || !pickStageId.value) return

  // Optimistic update
  if (!picks.value[pickUserId.value]) picks.value[pickUserId.value] = {}
  if (!picks.value[pickUserId.value][pickStageId.value]) picks.value[pickUserId.value][pickStageId.value] = {}
  picks.value[pickUserId.value][pickStageId.value][pickRole.value] = playerId
  showPickModal.value = false

  try {
    await api.adminSetFantasyPick(compId, pickUserId.value, pickStageId.value, pickRole.value, playerId)
  } catch (e: any) {
    console.error('Failed to set pick:', e.message)
    await loadData()
  }
}

async function clearPick(userId: number, stageId: number, role: string) {
  const compId = selectedCompId.value
  if (!compId) return

  // Optimistic update
  if (picks.value[userId]?.[stageId]) {
    delete picks.value[userId][stageId][role]
  }

  try {
    await api.adminClearFantasyPick(compId, userId, stageId, role)
  } catch (e: any) {
    console.error('Failed to clear pick:', e.message)
    await loadData()
  }
}

function getUserName(user: any): string {
  return user?.name || 'Unknown'
}
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[1200px] w-full">
    <!-- Header -->
    <div>
      <h1 class="text-2xl font-semibold text-foreground">{{ t('adminFantasy') }}</h1>
      <p class="text-sm text-muted-foreground mt-1">{{ t('adminFantasyDesc') }}</p>
    </div>

    <!-- Competition selector -->
    <div class="card px-5 py-4 flex flex-col gap-3">
      <label class="text-sm font-medium text-muted-foreground">{{ t('selectCompetition') }}</label>
      <select
        v-model="selectedCompId"
        class="bg-accent border border-border rounded-lg px-3 py-2 text-sm text-foreground w-full max-w-md"
      >
        <option :value="null">— {{ t('selectCompetition') }} —</option>
        <option v-for="comp in filteredComps" :key="comp.id" :value="comp.id">
          {{ comp.name }}
        </option>
      </select>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="text-center text-muted-foreground py-12">{{ t('loading') }}</div>

    <!-- No competition selected -->
    <div v-else-if="!selectedCompId" class="card px-6 py-12 text-center">
      <Star class="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
      <p class="text-muted-foreground">{{ t('adminFantasySelectComp') }}</p>
    </div>

    <!-- No stages -->
    <div v-else-if="stages.length === 0" class="card px-6 py-12 text-center">
      <Star class="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
      <p class="text-muted-foreground">{{ t('adminFantasyNoStages') }}</p>
    </div>

    <!-- User picks management -->
    <template v-else>
      <!-- Stage summary -->
      <div class="card px-5 py-3">
        <div class="text-sm text-muted-foreground">
          {{ stages.length }} {{ stages.length === 1 ? 'stage' : 'stages' }},
          {{ users.length }} {{ users.length === 1 ? 'participant' : 'participants' }}
        </div>
      </div>

      <!-- User search + add user -->
      <div class="flex items-center gap-3">
        <div class="relative flex-1">
          <Search class="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            v-model="userSearch"
            type="text"
            :placeholder="t('adminFantasySearchUsers')"
            class="w-full pl-9 pr-4 py-2.5 bg-accent border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground"
          />
        </div>
        <div class="relative">
          <button
            class="px-4 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors flex items-center gap-1.5 whitespace-nowrap"
            @click="showAddUser = !showAddUser; addUserSearch = ''"
          >
            <Users class="w-4 h-4" />
            {{ t('adminFantasyAddUser') }}
          </button>
          <!-- Add user dropdown -->
          <div v-if="showAddUser" class="absolute right-0 top-full mt-1 w-72 bg-card border border-border rounded-lg shadow-lg z-20 overflow-hidden">
            <div class="p-2">
              <input
                v-model="addUserSearch"
                type="text"
                :placeholder="t('searchPlayers')"
                class="w-full px-3 py-2 bg-accent border border-border rounded-md text-sm text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <div class="max-h-[250px] overflow-y-auto">
              <button
                v-for="cp in addableUsers"
                :key="cp.player_id"
                class="flex items-center gap-2.5 w-full px-3 py-2 hover:bg-accent transition-colors text-sm text-left"
                @click="addUser(cp.player_id)"
              >
                <div class="w-6 h-6 rounded-full bg-accent overflow-hidden shrink-0">
                  <img v-if="cp.avatar_url" :src="cp.avatar_url" class="w-full h-full object-cover" />
                </div>
                <span class="text-foreground truncate">{{ cp.name }}</span>
              </button>
              <div v-if="addableUsers.length === 0" class="px-3 py-3 text-xs text-muted-foreground text-center">
                {{ t('noResultsFound') }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Users list -->
      <div class="flex flex-col gap-3">
        <div v-for="user in filteredUsers" :key="user.id" class="card overflow-hidden">
          <!-- User header -->
          <button
            class="flex items-center gap-3 w-full px-5 py-3.5 hover:bg-accent/30 transition-colors"
            @click="expandedUserId = expandedUserId === user.id ? null : user.id"
          >
            <div class="w-8 h-8 rounded-full bg-accent overflow-hidden shrink-0">
              <img v-if="user.avatar_url" :src="user.avatar_url" class="w-full h-full object-cover" />
            </div>
            <span class="text-sm font-semibold text-foreground">{{ getUserName(user) }}</span>
            <span class="text-xs text-muted-foreground ml-1">{{ userPickCount(user.id) }} picks</span>
            <component :is="expandedUserId === user.id ? ChevronUp : ChevronDown" class="w-4 h-4 text-muted-foreground ml-auto" />
          </button>

          <!-- User picks per stage -->
          <div v-if="expandedUserId === user.id" class="border-t border-border/50">
            <div v-for="stage in allStages" :key="stage.id" class="border-b border-border/30 last:border-0">
              <div class="px-5 py-2.5 bg-accent/20">
                <div class="flex items-center gap-2">
                  <span class="text-xs font-semibold text-foreground">{{ stage.name }}</span>
                  <span class="text-[10px] px-1.5 py-0.5 rounded font-medium"
                    :class="{
                      'bg-amber-500/15 text-amber-500': stage.status === 'pending',
                      'bg-green-500/15 text-green-500': stage.status === 'active',
                      'bg-muted-foreground/15 text-muted-foreground': stage.status === 'completed',
                    }">
                    {{ stage.status }}
                  </span>
                </div>
              </div>
              <div class="px-5 py-3 grid grid-cols-5 gap-3">
                <div v-for="role in ROLES" :key="role" class="flex flex-col gap-1">
                  <span class="text-[10px] font-semibold text-muted-foreground uppercase">{{ t(`fantasyRole_${role}`) }}</span>
                  <div v-if="getUserPicks(user.id, stage.id)[role]" class="flex items-center gap-1.5">
                    <button
                      class="flex-1 flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-accent/60 hover:bg-accent transition-colors min-w-0"
                      @click="openPick(user.id, stage.id, role)"
                    >
                      <div class="flex flex-col min-w-0">
                        <span class="text-xs font-medium text-foreground truncate">{{ getPickPlayerName(getUserPicks(user.id, stage.id)[role]) }}</span>
                        <span class="text-[10px] text-muted-foreground truncate">{{ getPickPlayerTeam(getUserPicks(user.id, stage.id)[role]) }}</span>
                      </div>
                    </button>
                    <button
                      class="p-1 rounded text-red-500/60 hover:text-red-500 hover:bg-red-500/10 transition-colors shrink-0"
                      @click="clearPick(user.id, stage.id, role)"
                    >
                      <Trash2 class="w-3 h-3" />
                    </button>
                  </div>
                  <button
                    v-else
                    class="px-2 py-2 rounded-md border border-dashed border-border hover:border-primary hover:bg-accent/30 transition-colors text-xs text-muted-foreground hover:text-foreground"
                    @click="openPick(user.id, stage.id, role)"
                  >
                    + {{ t('pick') }}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-if="filteredUsers.length === 0" class="text-center text-muted-foreground text-sm py-8">
          {{ userSearch ? t('noResultsFound') : t('adminFantasyNoParticipants') }}
        </div>
      </div>
    </template>

    <!-- Pick modal -->
    <ModalOverlay :show="showPickModal" @close="showPickModal = false">
      <div class="px-5 pt-4 pb-2 flex flex-col gap-3">
        <div class="flex items-center gap-2">
          <Star class="w-4 h-4 text-primary" />
          <span class="text-base font-semibold text-foreground">{{ t('adminFantasyPickPlayer') }}</span>
        </div>
        <div class="text-xs text-muted-foreground">
          {{ t(`fantasyRole_${pickRole}`) }}
          <span v-if="pickUserId" class="text-foreground font-medium">— {{ getUserName(users.find(u => u.id === pickUserId)) }}</span>
        </div>
        <div class="relative">
          <Search class="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            v-model="pickSearch"
            type="text"
            :placeholder="t('searchPlayers')"
            class="w-full pl-9 pr-4 py-2 bg-accent border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground"
          />
        </div>
      </div>
      <div class="px-5 pb-5 max-h-[400px] overflow-y-auto flex flex-col gap-3">
        <div v-for="group in filteredTeamGroups" :key="group.captain.id">
          <div class="flex items-center gap-2 py-1.5 px-1 sticky top-0 bg-card z-10">
            <div class="w-5 h-5 rounded bg-accent overflow-hidden shrink-0">
              <img v-if="group.captain.banner_url || group.captain.avatar_url" :src="group.captain.banner_url || group.captain.avatar_url" class="w-full h-full object-cover" />
            </div>
            <span class="text-xs font-semibold text-muted-foreground">{{ group.captain.team || group.captain.name }}</span>
          </div>
          <div class="flex flex-col">
            <button
              v-for="p in group.players"
              :key="p.player_id"
              class="flex items-center gap-2.5 px-3 py-2 rounded-md transition-colors text-sm"
              :class="pickedPlayerIds.has(p.player_id) ? 'opacity-30 cursor-not-allowed' : 'hover:bg-accent cursor-pointer'"
              :disabled="pickedPlayerIds.has(p.player_id)"
              @click="!pickedPlayerIds.has(p.player_id) && selectPlayer(p.player_id)"
            >
              <div class="w-6 h-6 rounded-full bg-accent overflow-hidden shrink-0">
                <img v-if="p.avatar_url" :src="p.avatar_url" class="w-full h-full object-cover" />
              </div>
              <span class="text-foreground truncate">{{ p.name }}</span>
              <span v-if="p._isCaptain" class="text-[10px] font-medium text-primary bg-primary/10 px-1.5 py-0.5 rounded">C</span>
              <span v-if="p.playing_role" class="text-[10px] text-muted-foreground ml-auto">pos {{ p.playing_role }}</span>
            </button>
          </div>
        </div>
        <div v-if="filteredTeamGroups.length === 0" class="text-center text-muted-foreground text-sm py-4">
          {{ t('noResultsFound') }}
        </div>
      </div>
    </ModalOverlay>
  </div>
</template>
