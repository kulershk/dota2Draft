<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Star, Plus, Pencil, Trash2, Trophy, Lock, Play, Square, ChevronDown, ChevronUp } from 'lucide-vue-next'
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
const expandedUserId = ref<number | null>(null)

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
const myRepeats = computed(() => store.fantasyData.value?.myRepeats || {})
const repeatPenalty = computed(() => store.fantasyData.value?.repeatPenalty ?? 0)
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

// All pickable players (drafted + captains) grouped by team
const teamGroupedPlayers = computed(() => {
  const players = (store.players.value || []) as any[]
  const captains = (store.captains.value || []) as any[]
  const groups: { captain: any; players: any[] }[] = []

  for (const cap of captains) {
    const teamPlayers: any[] = []
    // Add captain themselves if they have a player_id
    if (cap.player_id) {
      const capPlayer = players.find(p => p.id === cap.player_id)
      if (capPlayer) {
        teamPlayers.push({ ...capPlayer, _isCaptain: true })
      }
    }
    // Add drafted players for this captain
    for (const p of players) {
      if (p.drafted_by === cap.id && p.id !== cap.player_id) {
        teamPlayers.push(p)
      }
    }
    if (teamPlayers.length > 0) {
      groups.push({ captain: cap, players: teamPlayers })
    }
  }
  return groups
})

// Current stage picks as object
function getStagePicks(stageId: number): Record<string, number> {
  return myPicks.value[stageId] || {}
}

function isRepeatPick(stageId: number, playerId: number): boolean {
  const repeats = myRepeats.value[stageId]
  if (!repeats) return false
  return repeats.includes(playerId)
}

// Get player info by id (checks players and captains)
function getPlayerInfo(playerId: number): any {
  const all = (store.players.value || []) as any[]
  const found = all.find(p => p.player_id === playerId || p.id === playerId)
  if (found) return found
  // Check captains
  const cap = (store.captains.value || []).find((c: any) => c.player_id === playerId)
  if (cap) return { id: cap.player_id, name: cap.name, avatar_url: cap.avatar_url }
  return null
}

async function loadAll() {
  loading.value = true
  await store.fetchFantasy()
  await store.fetchTournament()
  await fetchLeaderboard()
  // Auto-expand active/pending stages
  for (const stage of stages.value) {
    if (stage.status === 'active' || stage.status === 'pending') {
      expandedStages.value.add(stage.id)
    }
  }
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
  stageStatus.value = 'upcoming'
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

const filteredTeamGroups = computed(() => {
  const q = pickSearch.value.toLowerCase()
  const result: { captain: any; players: any[] }[] = []
  for (const group of teamGroupedPlayers.value) {
    const filtered = group.players.filter((p: any) => {
      const name = (p.name || '').toLowerCase()
      return name.includes(q)
    })
    if (filtered.length > 0) {
      result.push({ captain: group.captain, players: filtered })
    }
  }
  return result
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

  // Update local state immediately
  if (!store.fantasyData.value.myPicks[pickStageId.value]) {
    store.fantasyData.value.myPicks[pickStageId.value] = {}
  }
  store.fantasyData.value.myPicks[pickStageId.value][pickRole.value] = playerId
  showPickModal.value = false

  // Save to server immediately (partial picks are OK)
  try {
    await api.saveFantasyPick(cId, pickStageId.value, pickRole.value, playerId)
  } catch (e: any) {
    console.error('Failed to save pick:', e.message)
  }
}

async function clearPick(stageId: number, role: string) {
  const cId = compId.value
  if (!cId) return
  // Update local state
  if (store.fantasyData.value.myPicks[stageId]) {
    delete store.fantasyData.value.myPicks[stageId][role]
  }
  try {
    await api.clearFantasyPick(cId, stageId, role)
  } catch (e: any) {
    console.error('Failed to clear pick:', e.message)
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

const expandedStages = ref<Set<number>>(new Set())

function toggleStageExpand(stageId: number) {
  if (expandedStages.value.has(stageId)) {
    expandedStages.value.delete(stageId)
  } else {
    expandedStages.value.add(stageId)
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
  <div class="p-4 md:p-8 flex flex-col gap-0 max-w-[1200px] mx-auto w-full">
    <!-- Header -->
    <div class="flex items-center justify-between py-6">
      <div class="flex items-center gap-3">
        <Star class="w-6 h-6 text-primary" />
        <h1 class="text-2xl md:text-[28px] font-bold text-foreground tracking-tight">{{ t('fantasy') }}</h1>
      </div>
      <div class="flex items-center gap-3">
        <button
          v-for="tab in (['picks', 'leaderboard', 'rules'] as const)" :key="tab"
          class="px-4 py-2.5 text-sm font-medium rounded-md transition-colors"
          :class="activeTab === tab
            ? 'bg-primary text-primary-foreground font-semibold'
            : 'text-muted-foreground border border-border hover:text-foreground hover:border-muted-foreground'"
          @click="activeTab = tab"
        >
          {{ tab === 'picks' ? t('myPicks') : tab === 'leaderboard' ? t('leaderboard') : t('fantasyRules') }}
        </button>
        <button v-if="isAdmin && activeTab === 'picks'" class="btn-primary text-sm" @click="openCreateStage">
          <Plus class="w-4 h-4" />
          {{ t('createFantasyStage') }}
        </button>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="text-center text-muted-foreground py-12">{{ t('loading') }}...</div>

    <!-- Picks Tab -->
    <template v-else-if="activeTab === 'picks'">
      <div v-if="stages.length === 0" class="text-center text-muted-foreground py-12">
        {{ t('noFantasyStages') }}
      </div>

      <template v-for="stage in stages" :key="stage.id">
        <!-- Stage section -->
        <div class="border-t border-border">
          <!-- Stage header (always visible) -->
          <div class="flex items-center justify-between py-5 cursor-pointer" @click="toggleStageExpand(stage.id)">
            <div class="flex items-center gap-3">
              <h3 class="text-xl font-bold text-foreground">{{ stage.name }}</h3>
              <span class="inline-flex items-center rounded px-2.5 py-0.5 text-[10px] font-bold font-mono"
                :class="stage.status === 'active' ? 'bg-color-success/20 text-color-success'
                  : stage.status === 'completed' ? 'bg-color-warning/20 text-color-warning'
                  : stage.status === 'pending' ? 'bg-primary/20 text-primary'
                  : 'bg-accent text-muted-foreground'">
                {{ stage.status === 'completed' ? 'COMPLETED' : stage.status === 'active' ? 'LIVE' : stage.status === 'pending' ? 'OPEN' : 'UPCOMING' }}
              </span>
              <span class="text-sm text-text-tertiary">{{ stage.participant_count || 0 }} {{ t('participants') }}</span>
            </div>
            <div class="flex items-center gap-4">
              <!-- Mini stats when collapsed -->
              <template v-if="!expandedStages.has(stage.id) && stage.status !== 'pending' && stage.status !== 'upcoming'">
                <span v-if="getMyStageTotal(stage.id) != null" class="text-sm font-semibold font-mono text-primary">
                  {{ (getMyStageTotal(stage.id) ?? 0).toFixed(1) }} pts
                </span>
              </template>
              <!-- Admin controls -->
              <div v-if="isAdmin" class="flex items-center gap-2" @click.stop>
                <button
                  v-if="stage.status === 'upcoming'"
                  class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary/20 text-primary hover:bg-primary/30 transition-colors"
                  @click="setStageStatus(stage.id, 'pending')"
                >
                  {{ t('openStage') }}
                </button>
                <button
                  v-else-if="stage.status === 'pending'"
                  class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-color-warning/20 text-color-warning hover:bg-color-warning/30 transition-colors"
                  @click="setStageStatus(stage.id, 'active')"
                >
                  <Play class="w-3.5 h-3.5" />
                  {{ t('matchLive') }}
                </button>
                <button
                  v-else-if="stage.status === 'active'"
                  class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-color-success/20 text-color-success hover:bg-color-success/30 transition-colors"
                  @click="setStageStatus(stage.id, 'completed')"
                >
                  <Square class="w-3.5 h-3.5" />
                  {{ t('closeStage') }}
                </button>
                <button
                  v-else-if="stage.status === 'completed'"
                  class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-accent text-muted-foreground hover:bg-accent/80 transition-colors"
                  @click="setStageStatus(stage.id, 'upcoming')"
                >
                  {{ t('reopenStage') }}
                </button>
                <button class="text-text-tertiary hover:text-foreground transition-colors" @click="openEditStage(stage)">
                  <Pencil class="w-4 h-4" />
                </button>
                <button class="text-text-tertiary hover:text-destructive transition-colors" @click="deleteStageId = stage.id; showDeleteConfirm = true">
                  <Trash2 class="w-4 h-4" />
                </button>
              </div>
              <!-- Collapse link -->
              <button v-if="!expandedStages.has(stage.id)" class="text-sm font-medium text-primary" @click.stop="toggleStageExpand(stage.id)">
                {{ t('viewAll') || 'View My Picks' }}
              </button>
              <component :is="expandedStages.has(stage.id) ? ChevronUp : ChevronDown" class="w-5 h-5 text-text-tertiary" />
            </div>
          </div>

          <!-- Expanded content -->
          <div v-if="expandedStages.has(stage.id)" class="pb-6 flex flex-col gap-4">
            <!-- Upcoming — no picks yet -->
            <div v-if="stage.status === 'upcoming'" class="text-sm text-text-tertiary text-center py-6">
              {{ t('fantasyUpcoming') || 'Picks will be available once this stage is opened.' }}
            </div>
            <!-- Picks row — card style -->
            <div v-else-if="!isLoggedIn" class="text-sm text-muted-foreground text-center py-4">
              {{ t('loginToPickFantasy') }}
            </div>
            <div v-else class="flex gap-3">
              <!-- Role pick cards -->
              <div v-for="role in roles" :key="role"
                class="flex-1 flex flex-col items-center gap-2 rounded-lg bg-card p-3">
                <span class="text-[10px] font-semibold font-mono uppercase tracking-wider text-text-tertiary">{{ t('fantasyRole_' + role) }}</span>

                <template v-if="getStagePicks(stage.id)[role]">
                  <div class="w-12 h-12 rounded-full bg-surface overflow-hidden">
                    <img
                      v-if="getPlayerInfo(getStagePicks(stage.id)[role])?.avatar_url"
                      :src="getPlayerInfo(getStagePicks(stage.id)[role])?.avatar_url || ''"
                      class="w-full h-full object-cover"
                    />
                  </div>
                  <span class="text-xs font-medium text-foreground text-center truncate w-full">
                    {{ getPlayerInfo(getStagePicks(stage.id)[role])?.name || '?' }}
                  </span>
                  <span
                    v-if="repeatPenalty > 0 && isRepeatPick(stage.id, getStagePicks(stage.id)[role])"
                    class="text-[9px] font-bold text-amber-500 px-1.5 py-0.5 rounded bg-amber-500/10"
                    :title="t('repeatPenaltyLabel', { pct: Math.round(repeatPenalty * 100) })"
                  >-{{ Math.round(repeatPenalty * 100) }}%</span>
                  <span
                    v-if="stage.status !== 'pending' && getMyRolePoints(stage.id, role) != null"
                    class="text-[11px] font-semibold font-mono"
                    :class="(getMyRolePoints(stage.id, role) ?? 0) >= 0 ? 'text-primary' : 'text-red-500'"
                  >{{ (getMyRolePoints(stage.id, role) ?? 0).toFixed(1) }} {{ t('pts') }}</span>
                  <span v-else-if="stage.status === 'pending'" class="text-[11px] font-semibold font-mono text-muted-foreground">—</span>
                  <div v-if="stage.status === 'pending'" class="flex gap-2">
                    <button class="text-[10px] text-primary hover:underline" @click="openPick(stage.id, role)">{{ t('changePick') }}</button>
                    <button class="text-[10px] text-destructive hover:underline" @click="clearPick(stage.id, role)">{{ t('clear') }}</button>
                  </div>
                  <Lock v-else class="w-3 h-3 text-text-tertiary" />
                </template>

                <template v-else-if="stage.status === 'pending'">
                  <button
                    class="w-12 h-12 rounded-full border-2 border-dashed border-border hover:border-primary flex items-center justify-center transition-colors"
                    @click="openPick(stage.id, role)"
                  >
                    <Plus class="w-4 h-4 text-text-tertiary" />
                  </button>
                  <span class="text-[10px] text-text-muted">{{ t('pickPlayer') }}</span>
                </template>
                <template v-else>
                  <div class="w-12 h-12 rounded-full bg-surface" />
                  <span class="text-xs text-text-tertiary">—</span>
                </template>
              </div>

              <!-- Total card -->
              <div class="flex-1 flex flex-col items-center justify-center gap-2 rounded-lg bg-primary/10 border border-primary/25 p-3">
                <span class="text-[10px] font-semibold font-mono uppercase tracking-wider text-text-tertiary">TOTAL</span>
                <span v-if="stage.status !== 'pending' && getMyStageTotal(stage.id) != null"
                  class="text-[22px] font-bold font-mono text-primary">
                  {{ (getMyStageTotal(stage.id) ?? 0).toFixed(1) }} pts
                </span>
                <span v-else class="text-[22px] font-bold font-mono text-text-tertiary">—</span>
              </div>
            </div>

            <!-- Top Picks table -->
            <div v-if="stage.status !== 'pending' && stage.status !== 'upcoming'" class="flex flex-col gap-2">
              <button
                class="text-xs font-medium text-primary hover:underline self-start"
                @click="toggleTopPicks(stage.id)"
              >{{ expandedStageTop === stage.id ? t('hideTopPicks') : t('showTopPicks') }}</button>

              <div v-if="expandedStageTop === stage.id">
                <div v-if="loadingTopPicks[stage.id]" class="text-xs text-muted-foreground text-center py-4">{{ t('loading') }}...</div>
                <div v-else class="rounded-md border border-border overflow-hidden">
                  <!-- Table header -->
                  <div class="flex items-center bg-surface px-3 py-2">
                    <span class="flex-1 text-[10px] font-semibold font-mono uppercase tracking-wider text-text-tertiary">PICK TOP</span>
                    <span class="w-20 text-[10px] font-semibold font-mono uppercase tracking-wider text-text-tertiary text-center">PTS LIVE</span>
                    <span class="w-20 text-[10px] font-semibold font-mono uppercase tracking-wider text-text-tertiary text-center">BANS</span>
                    <span class="w-20 text-[10px] font-semibold font-mono uppercase tracking-wider text-text-tertiary text-right">PICKS</span>
                  </div>
                  <!-- Rows per role -->
                  <template v-for="role in roles" :key="role">
                    <div
                      v-for="(player, idx) in (topPicksData[stage.id]?.[role] || []).slice(0, 3)"
                      :key="`${role}-${idx}`"
                      class="flex items-center px-3 py-2 border-t border-border"
                    >
                      <div class="flex-1 flex items-center gap-2 min-w-0">
                        <div class="w-6 h-6 rounded-full bg-card overflow-hidden shrink-0">
                          <img v-if="player.avatar" :src="player.avatar" class="w-full h-full object-cover" />
                        </div>
                        <span class="text-xs text-foreground truncate">{{ player.name }}</span>
                      </div>
                      <span class="w-20 text-xs font-semibold font-mono text-center" :class="player.points >= 0 ? 'text-primary' : 'text-destructive'">
                        {{ player.points.toFixed(1) }}
                      </span>
                      <div class="w-20 flex justify-center">
                        <span v-if="player.bans" class="map-loss text-[9px]">{{ player.bans }}</span>
                        <span v-else class="text-xs text-text-tertiary">—</span>
                      </div>
                      <span class="w-20 text-xs font-mono text-foreground text-right">{{ player.picks || 0 }}</span>
                    </div>
                  </template>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>
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
            <template v-for="(user, idx) in leaderboard.users" :key="user.playerId">
              <tr
                class="border-b border-border/30 hover:bg-accent/20 cursor-pointer"
                @click="expandedUserId = expandedUserId === user.playerId ? null : user.playerId"
              >
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
                <td v-for="stage in leaderboard.stages" :key="stage.id" class="text-center py-3 px-4 text-foreground">
                  {{ user.stages[stage.id]?.total?.toFixed(1) || '-' }}
                </td>
                <td class="text-center py-3 px-4 font-bold text-primary">{{ user.total.toFixed(1) }}</td>
              </tr>
              <!-- Expanded picks -->
              <tr v-if="expandedUserId === user.playerId">
                <td :colspan="3 + leaderboard.stages.length" class="p-0">
                  <div class="bg-accent/20 px-4 py-3">
                    <table class="w-full text-xs">
                      <thead>
                        <tr class="border-b border-border/30">
                          <th class="text-left py-1.5 px-2 text-muted-foreground font-medium">{{ t('fantasyPickRole') }}</th>
                          <th v-for="stage in leaderboard.stages" :key="stage.id" class="text-center py-1.5 px-2 text-muted-foreground font-medium" colspan="1">
                            {{ stage.name }}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="role in roles" :key="role" class="border-b border-border/20">
                          <td class="py-1.5 px-2 font-medium text-foreground">{{ t('fantasyRole_' + role) }}</td>
                          <td v-for="stage in leaderboard.stages" :key="stage.id" class="text-center py-1.5 px-2">
                            <div v-if="user.stages[stage.id]?.picks?.[role]" class="flex items-center justify-center gap-1.5">
                              <img
                                v-if="user.stages[stage.id].picks[role].avatar"
                                :src="user.stages[stage.id].picks[role].avatar"
                                class="w-5 h-5 rounded-full"
                              />
                              <span class="text-foreground truncate max-w-[80px]">{{ user.stages[stage.id].picks[role].name }}</span>
                              <span v-if="user.stages[stage.id].picks[role].repeated" class="text-[8px] font-bold text-amber-500">-{{ Math.round(repeatPenalty * 100) }}%</span>
                              <span class="font-bold ml-1" :class="user.stages[stage.id].picks[role].points >= 0 ? 'text-primary' : 'text-red-500'">
                                {{ user.stages[stage.id].picks[role].points.toFixed(1) }}
                              </span>
                            </div>
                            <span v-else class="text-muted-foreground">-</span>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </td>
              </tr>
            </template>
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
          <p v-if="repeatPenalty > 0" class="text-amber-500 font-medium">{{ t('fantasyRule6', { pct: Math.round(repeatPenalty * 100) }) }}</p>
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
            <option value="upcoming">{{ t('fantasyUpcomingLabel') || 'Upcoming' }}</option>
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
        <div class="flex flex-col gap-0.5 max-h-[400px] overflow-y-auto">
          <template v-for="(group, gIdx) in filteredTeamGroups" :key="group.captain.id">
            <!-- Team divider -->
            <div v-if="gIdx > 0" class="border-t border-border my-1"></div>
            <!-- Team header -->
            <div class="flex items-center gap-2 px-3 py-1.5">
              <img v-if="group.captain.banner_url || group.captain.avatar_url" :src="group.captain.banner_url || group.captain.avatar_url" class="w-4 h-4 object-cover" :class="group.captain.banner_url ? 'rounded' : 'rounded-full'" />
              <span class="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">{{ group.captain.team }}</span>
            </div>
            <!-- Team players -->
            <template v-for="(player, pIdx) in group.players" :key="player.id">
              <div v-if="pIdx > 0" class="border-t border-border/30 mx-3"></div>
              <button
                class="flex items-center gap-3 px-3 py-2 rounded hover:bg-accent/30 text-left transition-colors"
                :class="{ 'opacity-40 cursor-not-allowed': pickedPlayerIds.has(player.id) }"
                :disabled="pickedPlayerIds.has(player.id)"
                @click="selectPlayer(player.id)"
              >
                <img v-if="player.avatar_url" :src="player.avatar_url" class="w-7 h-7 rounded-full" />
                <div class="flex flex-col flex-1 min-w-0">
                  <div class="flex items-center gap-1.5">
                    <span class="text-sm font-medium text-foreground truncate">{{ player.name }}</span>
                    <span v-if="player._isCaptain" class="text-[9px] font-bold text-primary px-1 py-0.5 rounded bg-primary/10">C</span>
                  </div>
                  <span class="text-[10px] text-muted-foreground">MMR: {{ player.mmr || '?' }}</span>
                </div>
              </button>
            </template>
          </template>
          <div v-if="filteredTeamGroups.length === 0" class="text-xs text-muted-foreground text-center py-4">
            {{ t('noPlayersFound') }}
          </div>
        </div>
      </div>
    </ModalOverlay>
  </div>
</template>
