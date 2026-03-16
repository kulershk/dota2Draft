<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Star, Plus, Pencil, Trash2, Trophy, Lock, Play, Square } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import ModalOverlay from '@/components/common/ModalOverlay.vue'

const { t } = useI18n()
const api = useApi()
const store = useDraftStore()

const loading = ref(true)
const activeTab = ref<'picks' | 'leaderboard' | 'rules'>('picks')
const leaderboard = ref<{ stages: any[]; users: any[] }>({ stages: [], users: [] })
const loadingLeaderboard = ref(false)

// Admin stage modal
const showStageModal = ref(false)
const editingStageId = ref<number | null>(null)
const stageName = ref('')
const stageMatchIds = ref<number[]>([])
const stageStatus = ref('pending')
const showDeleteConfirm = ref(false)
const deleteStageId = ref<number | null>(null)

// Pick modal
const showPickModal = ref(false)
const pickStageId = ref<number | null>(null)
const pickRole = ref('')
const pickSearch = ref('')

const compId = store.currentCompetitionId
const stages = computed(() => store.fantasyData.value?.stages || [])
const myPicks = computed(() => store.fantasyData.value?.myPicks || {})
const isAdmin = computed(() =>
  store.hasPerm('manage_competitions') ||
  (store.hasPerm('manage_own_competitions') && store.currentCompetition.value?.created_by === store.currentUser.value?.id)
)
const isLoggedIn = computed(() => !!store.currentUser.value)

// All tournament matches that have at least one game with a dotabuff_id
const allMatches = computed(() => {
  const matches = store.tournamentData.value?.matches || []
  return matches.filter((m: any) => m.games?.some((g: any) => g.dotabuff_id))
})

// Matches already assigned to fantasy stages (excluding current editing stage)
const assignedMatchIds = computed(() => {
  const ids = new Set<number>()
  for (const stage of stages.value) {
    if (stage.id === editingStageId.value) continue
    for (const mid of (stage.match_ids || [])) {
      ids.add(mid)
    }
  }
  return ids
})

// Competition players for picking
const compPlayers = computed(() => {
  const players = (store.players.value || []) as any[]
  return players.filter(p => p.drafted === 1 || p.drafted === true)
})

// Current stage picks as object
function getStagePicks(stageId: number): Record<string, number> {
  return myPicks.value[stageId] || {}
}

// Get player info by id
function getPlayerInfo(playerId: number): any {
  const all = (store.players.value || []) as any[]
  return all.find(p => p.player_id === playerId || p.id === playerId)
}

async function loadAll() {
  loading.value = true
  await store.fetchFantasy()
  await store.fetchTournament()
  await fetchLeaderboard()
  loading.value = false
}

onMounted(() => {
  if (compId.value) loadAll()
})

watch(compId, (newId) => {
  if (newId) loadAll()
})

watch(activeTab, (tab) => {
  if (tab === 'leaderboard') fetchLeaderboard()
})

async function fetchLeaderboard() {
  const cId = compId.value
  if (!cId) return
  loadingLeaderboard.value = true
  try {
    leaderboard.value = await api.getFantasyLeaderboard(cId)
  } catch {
    leaderboard.value = { stages: [], users: [] }
  } finally {
    loadingLeaderboard.value = false
  }
}

// Admin: open stage create/edit modal
function openCreateStage() {
  editingStageId.value = null
  stageName.value = ''
  stageMatchIds.value = []
  stageStatus.value = 'pending'
  showStageModal.value = true
}

function openEditStage(stage: any) {
  editingStageId.value = stage.id
  stageName.value = stage.name
  stageMatchIds.value = [...(stage.match_ids || [])]
  stageStatus.value = stage.status
  showStageModal.value = true
}

async function saveStage() {
  const cId = compId.value
  if (!cId) return
  if (editingStageId.value) {
    await api.updateFantasyStage(cId, editingStageId.value, {
      name: stageName.value,
      status: stageStatus.value,
      matchIds: stageMatchIds.value,
    })
  } else {
    await api.createFantasyStage(cId, {
      name: stageName.value,
      matchIds: stageMatchIds.value,
    })
  }
  showStageModal.value = false
  await store.fetchFantasy()
}

async function confirmDeleteStage() {
  const cId = compId.value
  if (!cId || !deleteStageId.value) return
  await api.deleteFantasyStage(cId, deleteStageId.value)
  showDeleteConfirm.value = false
  deleteStageId.value = null
  await store.fetchFantasy()
}

async function setStageStatus(stageId: number, status: string) {
  const cId = compId.value
  if (!cId) return
  await api.updateFantasyStage(cId, stageId, { status })
  await store.fetchFantasy()
}

function toggleMatchId(matchId: number) {
  const idx = stageMatchIds.value.indexOf(matchId)
  if (idx >= 0) stageMatchIds.value.splice(idx, 1)
  else stageMatchIds.value.push(matchId)
}

// User picks
function openPick(stageId: number, role: string) {
  pickStageId.value = stageId
  pickRole.value = role
  pickSearch.value = ''
  showPickModal.value = true
}

const filteredPickPlayers = computed(() => {
  const q = pickSearch.value.toLowerCase()
  return compPlayers.value.filter((p: any) => {
    const name = (p.name || '').toLowerCase()
    return name.includes(q)
  })
})

// Players already picked in other slots for this stage
const pickedPlayerIds = computed(() => {
  if (!pickStageId.value) return new Set<number>()
  const picks = getStagePicks(pickStageId.value)
  const ids = new Set<number>()
  for (const [role, pid] of Object.entries(picks)) {
    if (role !== pickRole.value) ids.add(pid as number)
  }
  return ids
})

async function selectPlayer(playerId: number) {
  const cId = compId.value
  if (!cId || !pickStageId.value) return

  const currentPicks = { ...getStagePicks(pickStageId.value) }
  currentPicks[pickRole.value] = playerId

  // Only save if all 5 roles are filled, otherwise update local state
  const roles = ['carry', 'mid', 'offlane', 'pos4', 'pos5']
  const allFilled = roles.every(r => currentPicks[r])

  // Update local state immediately
  if (!store.fantasyData.value.myPicks[pickStageId.value]) {
    store.fantasyData.value.myPicks[pickStageId.value] = {}
  }
  store.fantasyData.value.myPicks[pickStageId.value][pickRole.value] = playerId
  showPickModal.value = false

  if (allFilled) {
    await api.saveFantasyPicks(cId, pickStageId.value, currentPicks)
  }
}

function getMyStagePoints(stageId: number) {
  const userId = store.currentUser.value?.id
  if (!userId) return null
  const user = leaderboard.value.users.find((u: any) => u.playerId === userId)
  return user?.stages?.[stageId] || null
}

function getMyRolePoints(stageId: number, role: string): number | null {
  const data = getMyStagePoints(stageId)
  if (!data?.picks?.[role]) return null
  return data.picks[role].points
}

function getMyStageTotal(stageId: number): number | null {
  const data = getMyStagePoints(stageId)
  if (!data) return null
  return data.total
}

const expandedStageTop = ref<number | null>(null)
const topPicksData = ref<Record<number, Record<string, any[]>>>({})
const loadingTopPicks = ref<Record<number, boolean>>({})

async function toggleTopPicks(stageId: number) {
  if (expandedStageTop.value === stageId) {
    expandedStageTop.value = null
    return
  }
  expandedStageTop.value = stageId
  if (!topPicksData.value[stageId]) {
    const cId = compId.value
    if (!cId) return
    loadingTopPicks.value[stageId] = true
    try {
      topPicksData.value[stageId] = await api.getFantasyTopPicks(cId, stageId)
    } catch {
      topPicksData.value[stageId] = {}
    } finally {
      loadingTopPicks.value[stageId] = false
    }
  }
}

const roles = ['carry', 'mid', 'offlane', 'pos4', 'pos5'] as const

const fantasyStats = [
  'kill', 'death', 'assist', 'lastHit', 'deny', 'gpm', 'xpm',
  'heroDamage', 'towerDamage', 'heroHealing',
  'obsPlaced', 'senPlaced', 'obsKilled', 'senKilled',
  'campsStacked', 'stuns', 'teamfight', 'towerKill', 'roshanKill',
  'firstBlood', 'runePickup', 'tripleKill', 'ultraKill', 'rampage', 'courierKill',
] as const

function matchLabel(match: any) {
  const t1 = match.team1_name || 'TBD'
  const t2 = match.team2_name || 'TBD'
  if (match.score1 != null && match.score2 != null) {
    return `${t1} ${match.score1}-${match.score2} ${t2}`
  }
  return `${t1} vs ${t2}`
}
</script>

<template>
  <div class="p-4 md:p-8 flex flex-col gap-4 md:gap-6 max-w-[1440px] mx-auto w-full">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-3">
        <Star class="w-6 h-6 text-primary" />
        <h1 class="text-2xl font-bold text-foreground">{{ t('fantasy') }}</h1>
      </div>
      <div class="flex items-center gap-2">
        <button
          v-for="tab in (['picks', 'leaderboard', 'rules'] as const)" :key="tab"
          class="px-4 py-2 text-sm font-medium rounded-lg transition-colors"
          :class="activeTab === tab ? 'bg-primary text-primary-foreground' : 'bg-accent text-foreground hover:bg-accent/80'"
          @click="activeTab = tab"
        >
          {{ tab === 'picks' ? t('myPicks') : tab === 'leaderboard' ? t('leaderboard') : t('fantasyRules') }}
        </button>
      </div>
    </div>

    <!-- Admin: Create stage -->
    <div v-if="isAdmin && activeTab === 'picks'" class="flex justify-end">
      <button class="btn-primary text-sm" @click="openCreateStage">
        <Plus class="w-4 h-4" />
        {{ t('createFantasyStage') }}
      </button>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="text-center text-muted-foreground py-12">{{ t('loading') }}...</div>

    <!-- Picks Tab -->
    <template v-else-if="activeTab === 'picks'">
      <div v-if="stages.length === 0" class="text-center text-muted-foreground py-12">
        {{ t('noFantasyStages') }}
      </div>

      <div v-for="stage in stages" :key="stage.id" class="card">
        <div class="flex items-center justify-between px-5 py-4 border-b border-border">
          <div class="flex items-center gap-3">
            <h3 class="text-lg font-semibold text-foreground">{{ stage.name }}</h3>
            <span class="text-xs font-semibold uppercase px-2 py-0.5 rounded-full"
              :class="stage.status === 'completed' ? 'bg-green-500/10 text-green-500'
                : stage.status === 'active' ? 'bg-amber-500/10 text-amber-500'
                : 'bg-accent text-muted-foreground'">
              {{ stage.status === 'completed' ? t('matchCompleted') : stage.status === 'active' ? t('matchLive') : t('matchPending') }}
            </span>
            <span class="text-xs text-muted-foreground">{{ stage.participant_count || 0 }} {{ t('participants') }}</span>
          </div>
          <div v-if="isAdmin" class="flex items-center gap-2">
            <button
              v-if="stage.status === 'pending'"
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 transition-colors"
              @click="setStageStatus(stage.id, 'active')"
            >
              <Play class="w-3.5 h-3.5" />
              {{ t('openStage') }}
            </button>
            <button
              v-else-if="stage.status === 'active'"
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-green-500/10 text-green-600 hover:bg-green-500/20 transition-colors"
              @click="setStageStatus(stage.id, 'completed')"
            >
              <Square class="w-3.5 h-3.5" />
              {{ t('closeStage') }}
            </button>
            <button
              v-else
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-accent text-muted-foreground hover:bg-accent/80 transition-colors"
              @click="setStageStatus(stage.id, 'pending')"
            >
              {{ t('reopenStage') }}
            </button>
            <button class="p-1.5 rounded hover:bg-accent" @click="openEditStage(stage)">
              <Pencil class="w-4 h-4 text-muted-foreground" />
            </button>
            <button class="p-1.5 rounded hover:bg-accent" @click="deleteStageId = stage.id; showDeleteConfirm = true">
              <Trash2 class="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
        </div>

        <!-- Picks grid -->
        <div class="p-5">
          <div v-if="!isLoggedIn" class="text-sm text-muted-foreground text-center py-4">
            {{ t('loginToPickFantasy') }}
          </div>
          <div v-else class="grid grid-cols-5 gap-3">
            <div v-for="role in roles" :key="role" class="flex flex-col items-center gap-2">
              <span class="text-xs font-semibold text-muted-foreground uppercase">{{ t('fantasyRole_' + role) }}</span>
              <div v-if="getStagePicks(stage.id)[role]" class="flex flex-col items-center gap-1">
                <img
                  v-if="getPlayerInfo(getStagePicks(stage.id)[role])?.avatar_url"
                  :src="getPlayerInfo(getStagePicks(stage.id)[role])?.avatar_url || ''"
                  class="w-10 h-10 rounded-full"
                />
                <span class="text-xs text-foreground font-medium text-center truncate max-w-[100px]">
                  {{ getPlayerInfo(getStagePicks(stage.id)[role])?.name || '?' }}
                </span>
                <span
                  v-if="stage.status !== 'pending' && getMyRolePoints(stage.id, role) != null"
                  class="text-xs font-bold"
                  :class="(getMyRolePoints(stage.id, role) ?? 0) >= 0 ? 'text-primary' : 'text-red-500'"
                >{{ (getMyRolePoints(stage.id, role) ?? 0).toFixed(1) }} {{ t('pts') }}</span>
                <button
                  v-if="stage.status === 'pending'"
                  class="text-[10px] text-primary hover:underline"
                  @click="openPick(stage.id, role)"
                >{{ t('changePick') }}</button>
                <Lock v-else class="w-3 h-3 text-muted-foreground" />
              </div>
              <button
                v-else-if="stage.status === 'pending'"
                class="w-full py-3 rounded-lg border-2 border-dashed border-border hover:border-primary text-xs text-muted-foreground hover:text-primary transition-colors"
                @click="openPick(stage.id, role)"
              >
                {{ t('pickPlayer') }}
              </button>
              <div v-else class="text-xs text-muted-foreground py-3">-</div>
            </div>
          </div>
          <!-- Stage total -->
          <div v-if="stage.status !== 'pending' && getMyStageTotal(stage.id) != null" class="mt-4 pt-3 border-t border-border flex items-center justify-between">
            <span class="text-sm font-medium text-muted-foreground">{{ t('fantasyTotal') }}</span>
            <span class="text-lg font-bold text-primary">{{ (getMyStageTotal(stage.id) ?? 0).toFixed(1) }} {{ t('pts') }}</span>
          </div>

          <!-- Top Picks toggle -->
          <div v-if="stage.status !== 'pending'" class="mt-3 pt-3 border-t border-border">
            <button
              class="text-xs font-medium text-primary hover:underline"
              @click="toggleTopPicks(stage.id)"
            >{{ expandedStageTop === stage.id ? t('hideTopPicks') : t('showTopPicks') }}</button>

            <div v-if="expandedStageTop === stage.id" class="mt-4">
              <div v-if="loadingTopPicks[stage.id]" class="text-xs text-muted-foreground text-center py-4">{{ t('loading') }}...</div>
              <div v-else class="grid grid-cols-1 sm:grid-cols-5 gap-4">
                <div v-for="role in roles" :key="role" class="flex flex-col gap-2">
                  <span class="text-xs font-semibold text-muted-foreground uppercase text-center">{{ t('fantasyRole_' + role) }}</span>
                  <div
                    v-for="(player, idx) in (topPicksData[stage.id]?.[role] || []).slice(0, 5)"
                    :key="idx"
                    class="flex items-center gap-2 px-2 py-1.5 rounded-lg"
                    :class="idx === 0 ? 'bg-primary/10' : 'bg-accent/30'"
                  >
                    <span class="text-[10px] font-bold text-muted-foreground w-4">{{ idx + 1 }}</span>
                    <img v-if="player.avatar" :src="player.avatar" class="w-6 h-6 rounded-full" />
                    <div class="flex-1 min-w-0">
                      <div class="text-xs font-medium text-foreground truncate">{{ player.name }}</div>
                    </div>
                    <span class="text-xs font-bold" :class="player.points >= 0 ? 'text-primary' : 'text-red-500'">
                      {{ player.points.toFixed(1) }}
                    </span>
                  </div>
                  <div v-if="!(topPicksData[stage.id]?.[role] || []).length" class="text-[10px] text-muted-foreground text-center py-2">
                    -
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- Leaderboard Tab -->
    <template v-else-if="activeTab === 'leaderboard'">
      <div v-if="loadingLeaderboard" class="text-center text-muted-foreground py-12">{{ t('loading') }}...</div>
      <div v-else-if="leaderboard.users.length === 0" class="text-center text-muted-foreground py-12">
        {{ t('noFantasyResults') }}
      </div>
      <div v-else class="card overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border">
              <th class="text-left py-3 px-4 text-muted-foreground font-medium">#</th>
              <th class="text-left py-3 px-4 text-muted-foreground font-medium">{{ t('playerCol') }}</th>
              <th v-for="stage in leaderboard.stages" :key="stage.id" class="text-center py-3 px-4 text-muted-foreground font-medium">
                {{ stage.name }}
              </th>
              <th class="text-center py-3 px-4 text-muted-foreground font-bold">{{ t('fantasyTotal') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(user, idx) in leaderboard.users" :key="user.playerId" class="border-b border-border/30 hover:bg-accent/20">
              <td class="py-3 px-4 font-medium text-muted-foreground">
                <Trophy v-if="idx === 0" class="w-4 h-4 text-yellow-500 inline" />
                <span v-else>{{ idx + 1 }}</span>
              </td>
              <td class="py-3 px-4">
                <div class="flex items-center gap-2">
                  <img v-if="user.avatar" :src="user.avatar" class="w-6 h-6 rounded-full" />
                  <span class="font-medium text-foreground">{{ user.name }}</span>
                </div>
              </td>
              <td v-for="stage in leaderboard.stages" :key="stage.id" class="text-center py-3 px-4">
                {{ user.stages[stage.id]?.total?.toFixed(1) || '-' }}
              </td>
              <td class="text-center py-3 px-4 font-bold text-primary">{{ user.total.toFixed(1) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- Rules Tab -->
    <template v-else-if="activeTab === 'rules'">
      <div class="card">
        <div class="px-5 py-4 border-b border-border">
          <h3 class="text-lg font-semibold text-foreground">{{ t('fantasyRulesTitle') }}</h3>
          <p class="text-sm text-muted-foreground mt-1">{{ t('fantasyRulesDesc') }}</p>
        </div>
        <div class="p-5">
          <div class="overflow-x-auto">
            <table class="w-full text-xs border-collapse">
              <thead>
                <tr class="border-b border-border">
                  <th class="text-left py-2.5 px-3 text-muted-foreground font-semibold sticky left-0 bg-background">{{ t('stat') }}</th>
                  <th v-for="role in roles" :key="role" class="text-center py-2.5 px-3 text-muted-foreground font-semibold min-w-[80px]">
                    {{ t('fantasyRole_' + role) }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="stat in fantasyStats" :key="stat" class="border-b border-border/30 hover:bg-accent/20">
                  <td class="py-2 px-3 text-foreground font-medium sticky left-0 bg-background">{{ t('fantasyStat_' + stat) }}</td>
                  <td v-for="role in roles" :key="role" class="text-center py-2 px-3"
                    :class="(store.settings.fantasyScoring?.[role]?.[stat] ?? 0) > 0 ? 'text-green-500'
                      : (store.settings.fantasyScoring?.[role]?.[stat] ?? 0) < 0 ? 'text-red-500'
                      : 'text-muted-foreground'"
                  >
                    <span class="font-mono font-medium">
                      {{ (store.settings.fantasyScoring?.[role]?.[stat] ?? 0) > 0 ? '+' : '' }}{{ store.settings.fantasyScoring?.[role]?.[stat] ?? 0 }}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- How it works -->
      <div class="card">
        <div class="px-5 py-4 border-b border-border">
          <h3 class="text-lg font-semibold text-foreground">{{ t('howFantasyWorks') }}</h3>
        </div>
        <div class="p-5 flex flex-col gap-3 text-sm text-muted-foreground">
          <p>{{ t('fantasyRule1') }}</p>
          <p>{{ t('fantasyRule2') }}</p>
          <p>{{ t('fantasyRule3') }}</p>
          <p>{{ t('fantasyRule4') }}</p>
          <p>{{ t('fantasyRule5') }}</p>
        </div>
      </div>
    </template>

    <!-- Stage Create/Edit Modal -->
    <ModalOverlay :show="showStageModal" @close="showStageModal = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">
          {{ editingStageId ? t('editFantasyStage') : t('createFantasyStage') }}
        </h2>
      </div>
      <div class="px-7 py-5 flex flex-col gap-4 max-h-[60vh] overflow-y-auto">
        <div class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('fantasyStageName') }}</label>
          <input class="input-field" v-model="stageName" :placeholder="t('fantasyStageName')" />
        </div>

        <div v-if="editingStageId" class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('statusCol') }}</label>
          <select class="input-field" v-model="stageStatus">
            <option value="pending">{{ t('matchPending') }}</option>
            <option value="active">{{ t('matchLive') }}</option>
            <option value="completed">{{ t('matchCompleted') }}</option>
          </select>
        </div>

        <div class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('selectMatches') }}</label>
          <div class="flex flex-col gap-1 max-h-[300px] overflow-y-auto">
            <label
              v-for="match in allMatches" :key="match.id"
              class="flex items-center gap-2 px-3 py-2 rounded hover:bg-accent/30 cursor-pointer"
              :class="{ 'opacity-40 cursor-not-allowed': assignedMatchIds.has(match.id) }"
            >
              <input
                type="checkbox"
                class="w-4 h-4 accent-primary"
                :checked="stageMatchIds.includes(match.id)"
                :disabled="assignedMatchIds.has(match.id)"
                @change="toggleMatchId(match.id)"
              />
              <span class="text-sm text-foreground">{{ matchLabel(match) }}</span>
              <span v-if="match.status" class="text-[10px] uppercase ml-auto"
                :class="match.status === 'completed' ? 'text-green-500' : match.status === 'live' ? 'text-amber-500' : 'text-muted-foreground'">
                {{ match.status }}
              </span>
            </label>
            <div v-if="allMatches.length === 0" class="text-xs text-muted-foreground text-center py-4">
              {{ t('noMatchesAvailable') }}
            </div>
          </div>
        </div>
      </div>
      <div class="px-7 py-4 border-t border-border flex gap-3">
        <button class="btn-primary flex-1" :disabled="!stageName" @click="saveStage">
          {{ editingStageId ? t('updateScore') : t('create') }}
        </button>
        <button class="btn-secondary flex-1" @click="showStageModal = false">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>

    <!-- Delete Confirm Modal -->
    <ModalOverlay :show="showDeleteConfirm" @close="showDeleteConfirm = false">
      <div class="px-7 py-6">
        <h2 class="text-lg font-semibold text-foreground mb-2">{{ t('deleteFantasyStage') }}</h2>
        <p class="text-sm text-muted-foreground">{{ t('deleteFantasyStageConfirm') }}</p>
      </div>
      <div class="px-7 py-4 border-t border-border flex gap-3">
        <button class="btn-primary flex-1 !bg-red-600 hover:!bg-red-700" @click="confirmDeleteStage">{{ t('delete') }}</button>
        <button class="btn-secondary flex-1" @click="showDeleteConfirm = false">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>

    <!-- Pick Player Modal -->
    <ModalOverlay :show="showPickModal" @close="showPickModal = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">
          {{ t('pickPlayer') }} — {{ t('fantasyRole_' + pickRole) }}
        </h2>
      </div>
      <div class="px-7 py-4">
        <input class="input-field w-full mb-3" v-model="pickSearch" :placeholder="t('search')" />
        <div class="flex flex-col gap-1 max-h-[400px] overflow-y-auto">
          <button
            v-for="player in filteredPickPlayers" :key="player.id"
            class="flex items-center gap-3 px-3 py-2 rounded hover:bg-accent/30 text-left transition-colors"
            :class="{ 'opacity-40 cursor-not-allowed': pickedPlayerIds.has(player.id) }"
            :disabled="pickedPlayerIds.has(player.id)"
            @click="selectPlayer(player.id)"
          >
            <img v-if="player.avatar_url" :src="player.avatar_url" class="w-8 h-8 rounded-full" />
            <div class="flex flex-col">
              <span class="text-sm font-medium text-foreground">{{ player.name }}</span>
              <span class="text-[10px] text-muted-foreground">MMR: {{ player.mmr || '?' }}</span>
            </div>
          </button>
          <div v-if="filteredPickPlayers.length === 0" class="text-xs text-muted-foreground text-center py-4">
            {{ t('noPlayersFound') }}
          </div>
        </div>
      </div>
    </ModalOverlay>
  </div>
</template>
