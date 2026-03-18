<script setup lang="ts">
import { Swords, Settings, Plus, RotateCcw, Trash2, ChevronRight, Pencil, EyeOff } from 'lucide-vue-next'
import { ref, computed, watch } from 'vue'
import { usePersistedRef } from '@/composables/usePersistedRef'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import BracketView from '@/components/tournament/BracketView.vue'
import DoubleEliminationView from '@/components/tournament/DoubleEliminationView.vue'
import GroupStageView from '@/components/tournament/GroupStageView.vue'
import MatchScoreModal from '@/components/tournament/MatchScoreModal.vue'
import MatchDetailsModal from '@/components/tournament/MatchDetailsModal.vue'

const { t } = useI18n()
const route = useRoute()
const api = useApi()
const store = useDraftStore()

const loading = ref(true)
const showAddStage = ref(false)
const showReset = ref(false)
const showEditStage = ref(false)
const showDeleteStage = ref(false)
const deleteStageId = ref<number | null>(null)
const editingMatch = ref<any>(null)
const viewingMatch = ref<any>(null)
const activeStageId = ref<number | null>(null)
const showHidden = usePersistedRef('showHiddenMatches', true)

// Edit stage form
const editStageName = ref('')
const editStageStatus = ref('')
const editStageId = ref<number | null>(null)
const editStageFormat = ref('')
const editStageBestOf = ref(3)
const editSeeds = ref<number[]>([])
const editSelectedTeams = ref<Set<number>>(new Set())
const editGroups = ref<{ name: string; teamIds: number[] }[]>([])
const editHasMatches = ref(false)

// Add-stage form state
const stageName = ref('')
const format = ref<'single_elimination' | 'double_elimination' | 'group_stage'>('single_elimination')
const bestOf = ref(3)
const seeds = ref<number[]>([])
const selectedTeams = ref<Set<number>>(new Set())
const groups = ref<{ name: string; teamIds: number[] }[]>([
  { name: 'Group A', teamIds: [] },
  { name: 'Group B', teamIds: [] },
])

const tournamentState = computed(() => store.tournamentData.value.tournament_state || {})
const allMatches = computed(() => store.tournamentData.value.matches || [])
const stages = computed(() => tournamentState.value.stages || [])
const hasStages = computed(() => stages.value.length > 0)

const activeStage = computed(() => {
  if (!hasStages.value) return null
  return stages.value.find((s: any) => s.id === activeStageId.value) || stages.value[0]
})

const stageMatches = computed(() => {
  if (!activeStage.value) return []
  return allMatches.value.filter((m: any) => m.stage === activeStage.value.id)
})

const isCompAdmin = computed(() =>
  store.hasPerm('manage_competitions') ||
  (store.hasPerm('manage_own_competitions') && store.currentCompetition.value?.created_by === store.currentUser.value?.id)
)

watch(() => store.currentCompetitionId.value, async (id) => {
  if (!id) return
  loading.value = true
  await store.fetchTournament()
  loading.value = false
  if (stages.value.length > 0) {
    activeStageId.value = stages.value[0].id
  }
  initSeeds()

  // Auto-open match modal from ?match=ID query param
  const matchId = Number(route.query.match)
  if (matchId) {
    const match = allMatches.value.find((m: any) => m.id === matchId)
    if (match) {
      // Switch to the stage containing this match
      if (match.stage && stages.value.find((s: any) => s.id === match.stage)) {
        activeStageId.value = match.stage
      }
      if (isCompAdmin.value) {
        editingMatch.value = match
      } else {
        viewingMatch.value = match
      }
    }
  }
}, { immediate: true })

watch(() => store.captains.value, () => initSeeds())
watch(stages, (s) => {
  if (s.length > 0 && !activeStageId.value) {
    activeStageId.value = s[0].id
  }
})

function initSeeds() {
  if (store.captains.value.length > 0 && seeds.value.length === 0) {
    seeds.value = store.captains.value.map(c => c.id)
    selectedTeams.value = new Set(seeds.value)
  }
}

function toggleTeamSelected(id: number) {
  const s = new Set(selectedTeams.value)
  if (s.has(id)) {
    s.delete(id)
    seeds.value = seeds.value.filter(sid => sid !== id)
  } else {
    s.add(id)
    seeds.value.push(id)
  }
  selectedTeams.value = s
}

function getCaptainName(id: number) {
  if (id === 0) return t('tbd')
  const c = store.captains.value.find(c => c.id === id)
  return c ? c.team : '?'
}

function addTbd() {
  seeds.value.push(0)
}

function removeTbdAt(filteredIdx: number) {
  const filtered = seeds.value.filter(s => s === 0 || selectedTeams.value.has(s))
  const targetId = filtered[filteredIdx]
  if (targetId !== 0) return
  // Find the nth TBD (0) in seeds that corresponds to this filtered index
  let count = 0
  for (let i = 0; i < seeds.value.length; i++) {
    if (seeds.value[i] === 0 || selectedTeams.value.has(seeds.value[i])) {
      if (count === filteredIdx) { seeds.value.splice(i, 1); return }
      count++
    }
  }
}

function addEditTbd() {
  editSeeds.value.push(0)
}

function removeEditTbdAt(filteredIdx: number) {
  const filtered = editSeeds.value.filter(s => s === 0 || editSelectedTeams.value.has(s))
  const targetId = filtered[filteredIdx]
  if (targetId !== 0) return
  let count = 0
  for (let i = 0; i < editSeeds.value.length; i++) {
    if (editSeeds.value[i] === 0 || editSelectedTeams.value.has(editSeeds.value[i])) {
      if (count === filteredIdx) { editSeeds.value.splice(i, 1); return }
      count++
    }
  }
}

function moveSeed(idx: number, dir: -1 | 1) {
  const newIdx = idx + dir
  if (newIdx < 0 || newIdx >= seeds.value.length) return
  const tmp = seeds.value[idx]
  seeds.value[idx] = seeds.value[newIdx]
  seeds.value[newIdx] = tmp
}

function addGroupTbd(groupIdx: number) {
  groups.value[groupIdx].teamIds.push(0)
}

function removeGroupTbd(groupIdx: number, nthTbd: number) {
  const teamIds = groups.value[groupIdx].teamIds
  let count = 0
  for (let i = 0; i < teamIds.length; i++) {
    if (teamIds[i] === 0) {
      if (count === nthTbd) { teamIds.splice(i, 1); return }
      count++
    }
  }
}

function addEditGroupTbd(groupIdx: number) {
  editGroups.value[groupIdx].teamIds.push(0)
}

function removeEditGroupTbd(groupIdx: number, nthTbd: number) {
  const teamIds = editGroups.value[groupIdx].teamIds
  let count = 0
  for (let i = 0; i < teamIds.length; i++) {
    if (teamIds[i] === 0) {
      if (count === nthTbd) { teamIds.splice(i, 1); return }
      count++
    }
  }
}

function addGroup() {
  const letter = String.fromCharCode(65 + groups.value.length)
  groups.value.push({ name: `Group ${letter}`, teamIds: [] })
}

function removeGroup(idx: number) {
  groups.value.splice(idx, 1)
}

function toggleTeamInGroup(groupIdx: number, captainId: number) {
  const g = groups.value[groupIdx]
  const i = g.teamIds.indexOf(captainId)
  if (i >= 0) {
    g.teamIds.splice(i, 1)
  } else {
    groups.value.forEach(gr => {
      const j = gr.teamIds.indexOf(captainId)
      if (j >= 0) gr.teamIds.splice(j, 1)
    })
    g.teamIds.push(captainId)
  }
}

function isTeamInAnyGroup(captainId: number) {
  return groups.value.some(g => g.teamIds.includes(captainId))
}

function openAddStage() {
  stageName.value = ''
  format.value = 'single_elimination'
  bestOf.value = 3
  seeds.value = store.captains.value.map(c => c.id)
  selectedTeams.value = new Set(seeds.value)
  groups.value = [
    { name: 'Group A', teamIds: [] },
    { name: 'Group B', teamIds: [] },
  ]
  showAddStage.value = true
}

async function addStage() {
  const compId = store.currentCompetitionId.value
  if (!compId) return
  try {
    const defaultName = format.value === 'group_stage' ? t('groupStage')
      : format.value === 'double_elimination' ? t('doubleElimination')
      : t('singleElimination')
    const data: any = {
      name: stageName.value || defaultName,
      format: format.value,
      bestOf: bestOf.value,
    }
    if (format.value === 'single_elimination' || format.value === 'double_elimination') {
      const filteredSeeds = seeds.value.filter(id => id === 0 || selectedTeams.value.has(id))
      if (filteredSeeds.length > 0) data.seeds = filteredSeeds.map(id => id === 0 ? null : id)
    } else {
      data.groups = groups.value.map(g => ({
        ...g,
        teamIds: g.teamIds.map(id => id === 0 ? null : id),
      }))
    }
    await api.addTournamentStage(compId, data)
    showAddStage.value = false
    await store.fetchTournament()
    // Switch to the new stage
    const newStages = store.tournamentData.value.tournament_state?.stages || []
    if (newStages.length > 0) {
      activeStageId.value = newStages[newStages.length - 1].id
    }
  } catch (e: any) {
    alert(e.message)
  }
}

function confirmDeleteStage(stageId: number) {
  deleteStageId.value = stageId
  showDeleteStage.value = true
}

async function deleteStage() {
  const compId = store.currentCompetitionId.value
  const stageId = deleteStageId.value
  if (!compId || !stageId) return
  await api.deleteTournamentStage(compId, stageId)
  showDeleteStage.value = false
  deleteStageId.value = null
  await store.fetchTournament()
  if (activeStageId.value === stageId) {
    activeStageId.value = stages.value.length > 0 ? stages.value[0].id : null
  }
}

async function resetTournament() {
  const compId = store.currentCompetitionId.value
  if (!compId) return
  await api.resetTournament(compId)
  showReset.value = false
  activeStageId.value = null
  await store.fetchTournament()
}

async function saveMatchScore(matchId: number, data: any) {
  const compId = store.currentCompetitionId.value
  if (!compId) return
  await api.updateMatchScore(compId, matchId, data)
  editingMatch.value = null
  await store.fetchTournament()
}

function toggleEditTeamSelected(id: number) {
  const s = new Set(editSelectedTeams.value)
  if (s.has(id)) {
    s.delete(id)
    editSeeds.value = editSeeds.value.filter(sid => sid !== id)
  } else {
    s.add(id)
    editSeeds.value.push(id)
  }
  editSelectedTeams.value = s
}

function moveEditSeed(idx: number, dir: -1 | 1) {
  const newIdx = idx + dir
  if (newIdx < 0 || newIdx >= editSeeds.value.length) return
  const tmp = editSeeds.value[idx]
  editSeeds.value[idx] = editSeeds.value[newIdx]
  editSeeds.value[newIdx] = tmp
}

function addEditGroup() {
  const letter = String.fromCharCode(65 + editGroups.value.length)
  editGroups.value.push({ name: `Group ${letter}`, teamIds: [] })
}

function removeEditGroup(idx: number) {
  editGroups.value.splice(idx, 1)
}

function toggleEditTeamInGroup(groupIdx: number, captainId: number) {
  const g = editGroups.value[groupIdx]
  const i = g.teamIds.indexOf(captainId)
  if (i >= 0) {
    g.teamIds.splice(i, 1)
  } else {
    editGroups.value.forEach(gr => {
      const j = gr.teamIds.indexOf(captainId)
      if (j >= 0) gr.teamIds.splice(j, 1)
    })
    g.teamIds.push(captainId)
  }
}

function isEditTeamInAnyGroup(captainId: number) {
  return editGroups.value.some(g => g.teamIds.includes(captainId))
}

function openEditStage(stage: any) {
  editStageId.value = stage.id
  editStageName.value = stage.name
  editStageStatus.value = stage.status
  editStageFormat.value = stage.format
  editStageBestOf.value = stage.bestOf || 3
  editHasMatches.value = stageMatches.value.length > 0

  // Initialize team selection from existing stage data
  if (stage.format === 'group_stage') {
    editGroups.value = (stage.groups || []).map((g: any) => ({ name: g.name, teamIds: (g.teamIds || []).map((id: any) => id == null ? 0 : id) }))
    if (editGroups.value.length === 0) {
      editGroups.value = [{ name: 'Group A', teamIds: [] }, { name: 'Group B', teamIds: [] }]
    }
  } else {
    // For elimination: try to reconstruct seeds from existing matches or use all captains
    const matchTeams = new Set<number>()
    for (const m of stageMatches.value) {
      if (m.team1_captain_id) matchTeams.add(m.team1_captain_id)
      if (m.team2_captain_id) matchTeams.add(m.team2_captain_id)
    }
    if (matchTeams.size > 0) {
      editSeeds.value = [...matchTeams]
      editSelectedTeams.value = new Set(matchTeams)
    } else {
      editSeeds.value = store.captains.value.map(c => c.id)
      editSelectedTeams.value = new Set(editSeeds.value)
    }
  }

  showEditStage.value = true
}

const showRegenerateConfirm = ref(false)

async function saveEditStage() {
  const compId = store.currentCompetitionId.value
  if (!compId || !editStageId.value) return
  try {
    const data: any = {
      name: editStageName.value,
      status: editStageStatus.value,
      bestOf: editStageBestOf.value,
    }

    await api.updateTournamentStage(compId, editStageId.value, data)
    showEditStage.value = false
    await store.fetchTournament()
  } catch (e: any) {
    alert(e.message)
  }
}

function requestRegenerate() {
  showRegenerateConfirm.value = true
}

async function confirmRegenerate() {
  const compId = store.currentCompetitionId.value
  if (!compId || !editStageId.value) return
  try {
    const data: any = {
      name: editStageName.value,
      status: editStageStatus.value,
      bestOf: editStageBestOf.value,
      regenerate: true,
    }

    if (editStageFormat.value === 'group_stage') {
      data.groups = editGroups.value.map(g => ({
        ...g,
        teamIds: g.teamIds.map(id => id === 0 ? null : id),
      }))
    } else {
      const filteredSeeds = editSeeds.value.filter(id => id === 0 || editSelectedTeams.value.has(id))
      if (filteredSeeds.length > 0) data.seeds = filteredSeeds.map(id => id === 0 ? null : id)
    }

    await api.updateTournamentStage(compId, editStageId.value, data)
    showRegenerateConfirm.value = false
    showEditStage.value = false
    await store.fetchTournament()
  } catch (e: any) {
    alert(e.message)
  }
}

function stageStatusClass(stage: any) {
  if (stage.status === 'completed') return 'text-green-600 dark:text-green-400'
  if (stage.status === 'active') return 'text-primary'
  return 'text-muted-foreground'
}
</script>

<template>
  <div class="p-4 md:p-8 flex flex-col gap-4 md:gap-6 max-w-[1440px] mx-auto w-full">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-semibold text-foreground flex items-center gap-2">
          <Swords class="w-6 h-6" />
          {{ t('tournament') }}
        </h1>
      </div>
      <div v-if="isCompAdmin" class="flex items-center gap-2">
        <button class="btn-primary text-sm" @click="openAddStage">
          <Plus class="w-4 h-4" />
          {{ t('addStage') }}
        </button>
        <button v-if="hasStages" class="btn-ghost text-sm text-destructive" @click="showReset = true">
          <RotateCcw class="w-4 h-4" />
          {{ t('resetTournament') }}
        </button>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="text-center text-muted-foreground py-12">{{ t('loading') }}</div>

    <!-- No stages yet -->
    <div v-else-if="!hasStages" class="card px-6 py-12 text-center">
      <Swords class="w-12 h-12 text-muted-foreground/40 mx-auto mb-3" />
      <p class="text-muted-foreground">{{ t('noTournamentYet') }}</p>
      <button v-if="isCompAdmin" class="btn-primary text-sm mt-4 mx-auto" @click="openAddStage">
        <Plus class="w-4 h-4" />
        {{ t('addStage') }}
      </button>
    </div>

    <!-- Multi-stage view -->
    <template v-else>
      <!-- Stage tabs -->
      <div class="flex items-center gap-1 border-b border-border pb-0">
        <button
          v-for="stage in stages"
          :key="stage.id"
          class="relative px-4 py-2.5 text-sm font-medium transition-colors rounded-t-md"
          :class="activeStageId === stage.id
            ? 'text-foreground bg-card border border-border border-b-card -mb-[1px]'
            : 'text-muted-foreground hover:text-foreground'"
          @click="activeStageId = stage.id"
        >
          <div class="flex items-center gap-2">
            <span class="w-1.5 h-1.5 rounded-full"
              :class="stage.status === 'completed' ? 'bg-green-500' : stage.status === 'active' ? 'bg-primary' : 'bg-muted-foreground/40'"
            ></span>
            {{ stage.name }}
            <span class="text-[10px] uppercase" :class="stageStatusClass(stage)">
              {{ stage.status === 'completed' ? t('matchCompleted') : stage.status === 'active' ? t('matchLive') : t('matchPending') }}
            </span>
          </div>
        </button>
      </div>

      <!-- Active stage content -->
      <div v-if="activeStage">
        <!-- Admin: edit/delete this stage -->
        <div v-if="isCompAdmin" class="flex justify-end gap-2 mb-2">
          <button class="btn-ghost text-xs" :class="showHidden ? '' : 'text-primary'" @click="showHidden = !showHidden">
            <EyeOff class="w-3 h-3" />
            {{ showHidden ? t('previewAsPlayer') : t('showHiddenMatches') }}
          </button>
          <button class="btn-ghost text-xs" @click="openEditStage(activeStage)">
            <Pencil class="w-3 h-3" />
            {{ t('editStage') }}
          </button>
          <button class="btn-ghost text-xs text-destructive" @click="confirmDeleteStage(activeStage.id)">
            <Trash2 class="w-3 h-3" />
            {{ t('deleteStage') }}
          </button>
        </div>

        <!-- Pending stage with no groups defined -->
        <div v-if="activeStage.format === 'group_stage' && (!activeStage.groups || activeStage.groups.length === 0)" class="card px-6 py-12 text-center">
          <Swords class="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
          <p class="text-muted-foreground text-sm">{{ t('teamsNotAssigned') }}</p>
          <p class="text-muted-foreground/60 text-xs mt-1">{{ t('teamsNotAssignedHint') }}</p>
          <button v-if="isCompAdmin" class="btn-primary text-sm mt-4 mx-auto" @click="openEditStage(activeStage)">
            <Pencil class="w-4 h-4" />
            {{ t('assignTeamsAction') }}
          </button>
        </div>

        <!-- Bracket view (single elimination) -->
        <BracketView
          v-else-if="activeStage.format === 'single_elimination'"
          :matches="stageMatches"
          :tournament-state="activeStage"
          :is-admin="isCompAdmin && showHidden"
          @edit-match="isCompAdmin ? (editingMatch = $event) : (viewingMatch = $event)"
        />

        <!-- Double elimination view -->
        <DoubleEliminationView
          v-else-if="activeStage.format === 'double_elimination'"
          :matches="stageMatches"
          :tournament-state="activeStage"
          :is-admin="isCompAdmin && showHidden"
          @edit-match="isCompAdmin ? (editingMatch = $event) : (viewingMatch = $event)"
        />

        <!-- Group stage view -->
        <GroupStageView
          v-else-if="activeStage.format === 'group_stage'"
          :matches="stageMatches"
          :tournament-state="activeStage"
          :captains="store.captains.value"
          :is-admin="isCompAdmin && showHidden"
          @edit-match="isCompAdmin ? (editingMatch = $event) : (viewingMatch = $event)"
        />
      </div>
    </template>

    <!-- Add Stage Modal -->
    <ModalOverlay :show="showAddStage" wide @close="showAddStage = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('addStage') }}</h2>
        <p class="text-sm text-muted-foreground mt-1">{{ t('addStageDesc') }}</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-5">
        <!-- Stage name -->
        <div class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('stageName') }}</label>
          <input v-model="stageName" class="input-field" :placeholder="t('stageNamePlaceholder')" />
        </div>

        <!-- Format selection -->
        <div>
          <label class="label-text mb-2 block">{{ t('selectFormat') }}</label>
          <div class="grid grid-cols-3 gap-3">
            <button
              class="card p-4 text-left transition-colors cursor-pointer"
              :class="format === 'single_elimination' ? 'ring-2 ring-primary bg-primary/5' : 'hover:bg-accent/50'"
              @click="format = 'single_elimination'"
            >
              <div class="text-sm font-semibold text-foreground">{{ t('singleElimination') }}</div>
              <div class="text-xs text-muted-foreground mt-1">{{ t('singleEliminationDesc') }}</div>
            </button>
            <button
              class="card p-4 text-left transition-colors cursor-pointer"
              :class="format === 'double_elimination' ? 'ring-2 ring-primary bg-primary/5' : 'hover:bg-accent/50'"
              @click="format = 'double_elimination'"
            >
              <div class="text-sm font-semibold text-foreground">{{ t('doubleElimination') }}</div>
              <div class="text-xs text-muted-foreground mt-1">{{ t('doubleEliminationDesc') }}</div>
            </button>
            <button
              class="card p-4 text-left transition-colors cursor-pointer"
              :class="format === 'group_stage' ? 'ring-2 ring-primary bg-primary/5' : 'hover:bg-accent/50'"
              @click="format = 'group_stage'"
            >
              <div class="text-sm font-semibold text-foreground">{{ t('groupStage') }}</div>
              <div class="text-xs text-muted-foreground mt-1">{{ t('groupStageDesc') }}</div>
            </button>
          </div>
        </div>

        <!-- Best of -->
        <div>
          <label class="label-text mb-1 block">{{ t('bestOf') }}</label>
          <div class="flex gap-2">
            <button v-for="n in [1, 2, 3, 5]" :key="n"
              class="px-4 py-2 rounded-md text-sm font-medium transition-colors"
              :class="bestOf === n ? 'bg-primary text-primary-foreground' : 'bg-accent text-foreground hover:bg-accent/80'"
              @click="bestOf = n"
            >BO{{ n }}</button>
          </div>
        </div>

        <!-- Elimination: Team Selection + Seeding -->
        <div v-if="format === 'single_elimination' || format === 'double_elimination'">
          <label class="label-text mb-2 block">{{ t('selectTeams') }}</label>
          <div v-if="store.captains.value.length === 0" class="text-sm text-muted-foreground bg-accent/50 rounded-md px-3 py-2 mb-2">
            {{ t('noTeamsAvailable') }}
          </div>
          <template v-else>
            <div class="flex flex-wrap gap-1.5 mb-4">
              <button
                v-for="cap in store.captains.value" :key="cap.id"
                class="px-2.5 py-1 rounded-full text-xs font-medium transition-colors"
                :class="selectedTeams.has(cap.id)
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-accent text-foreground hover:bg-accent/80'"
                @click="toggleTeamSelected(cap.id)"
              >{{ cap.team }}</button>
              <button
                class="px-2.5 py-1 rounded-full text-xs font-medium transition-colors bg-accent/60 text-muted-foreground hover:bg-accent border border-dashed border-border"
                @click="addTbd"
              >+ {{ t('tbd') }}</button>
            </div>

            <!-- Seeding order (selected teams + TBD) -->
            <label v-if="seeds.filter(s => s === 0 || selectedTeams.has(s)).length > 0" class="label-text mb-2 block">{{ t('seeding') }}</label>
            <div class="flex flex-col gap-1 max-h-60 overflow-y-auto">
              <div v-for="(id, idx) in seeds.filter(s => s === 0 || selectedTeams.has(s))" :key="`${id}-${idx}`"
                class="flex items-center gap-2 px-3 py-2 rounded-md bg-accent/50"
              >
                <span class="text-xs text-muted-foreground w-6">{{ idx + 1 }}.</span>
                <span class="text-sm font-medium flex-1" :class="id === 0 ? 'text-muted-foreground italic' : 'text-foreground'">{{ getCaptainName(id) }}</span>
                <button v-if="id === 0" class="btn-ghost p-1 text-xs text-destructive" @click="removeTbdAt(idx)">&times;</button>
                <button class="btn-ghost p-1 text-xs" :disabled="idx === 0" @click="moveSeed(idx, -1)">&uarr;</button>
                <button class="btn-ghost p-1 text-xs" :disabled="idx === seeds.filter(s => s === 0 || selectedTeams.has(s)).length - 1" @click="moveSeed(idx, 1)">&darr;</button>
              </div>
            </div>
          </template>
        </div>

        <!-- Group Stage: Group assignment -->
        <div v-if="format === 'group_stage'">
          <div class="flex items-center justify-between mb-2">
            <label class="label-text">{{ t('assignTeams') }}</label>
            <button class="btn-ghost text-xs" @click="addGroup">+ {{ t('addGroup') }}</button>
          </div>
          <div class="flex flex-col gap-4">
            <div v-for="(group, gi) in groups" :key="gi" class="card p-3">
              <div class="flex items-center justify-between mb-2">
                <input v-model="group.name" class="input-field !h-8 !text-sm w-40" />
                <button v-if="groups.length > 1" class="btn-ghost text-xs text-destructive" @click="removeGroup(gi)">{{ t('removeGroup') }}</button>
              </div>
              <div class="flex flex-wrap gap-1.5">
                <button
                  v-for="cap in store.captains.value" :key="cap.id"
                  class="px-2.5 py-1 rounded-full text-xs font-medium transition-colors"
                  :class="group.teamIds.includes(cap.id)
                    ? 'bg-primary text-primary-foreground'
                    : isTeamInAnyGroup(cap.id) && !group.teamIds.includes(cap.id)
                      ? 'bg-accent/30 text-muted-foreground/50 cursor-not-allowed'
                      : 'bg-accent text-foreground hover:bg-accent/80'"
                  :disabled="isTeamInAnyGroup(cap.id) && !group.teamIds.includes(cap.id)"
                  @click="toggleTeamInGroup(gi, cap.id)"
                >{{ cap.team }}</button>
                <span
                  v-for="(id, ti) in group.teamIds.filter(t => t === 0)" :key="`tbd-${ti}`"
                  class="px-2.5 py-1 rounded-full text-xs font-medium bg-accent/60 text-muted-foreground italic inline-flex items-center gap-1"
                >
                  {{ t('tbd') }}
                  <button class="text-destructive hover:text-destructive/80" @click="removeGroupTbd(gi, ti)">&times;</button>
                </span>
                <button
                  class="px-2.5 py-1 rounded-full text-xs font-medium transition-colors bg-accent/60 text-muted-foreground hover:bg-accent border border-dashed border-border"
                  @click="addGroupTbd(gi)"
                >+ {{ t('tbd') }}</button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" @click="addStage">
          <Plus class="w-4 h-4" />
          {{ t('addStage') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showAddStage = false">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>

    <!-- Delete Stage Confirmation -->
    <ModalOverlay :show="showDeleteStage" @close="showDeleteStage = false">
      <div class="px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('deleteStage') }}</h2>
        <p class="text-sm text-muted-foreground mt-2">{{ t('deleteStageDesc') }}</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-destructive w-full justify-center" @click="deleteStage">
          <Trash2 class="w-4 h-4" />
          {{ t('deleteStage') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showDeleteStage = false">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>

    <!-- Reset Confirmation -->
    <ModalOverlay :show="showReset" @close="showReset = false">
      <div class="px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('resetTournament') }}</h2>
        <p class="text-sm text-muted-foreground mt-2">{{ t('resetTournamentDesc') }}</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-destructive w-full justify-center" @click="resetTournament">
          <Trash2 class="w-4 h-4" />
          {{ t('resetTournamentConfirm') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showReset = false">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>

    <!-- Edit Stage Modal -->
    <ModalOverlay :show="showEditStage" wide @close="showEditStage = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('editStage') }}</h2>
      </div>
      <div class="px-7 py-5 flex flex-col gap-5">
        <div class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('stageName') }}</label>
          <input v-model="editStageName" class="input-field" :placeholder="t('stageNamePlaceholder')" />
        </div>

        <!-- Best of -->
        <div>
          <label class="label-text mb-1 block">{{ t('bestOf') }}</label>
          <div class="flex gap-2">
            <button v-for="n in [1, 2, 3, 5]" :key="n"
              class="px-4 py-2 rounded-md text-sm font-medium transition-colors"
              :class="editStageBestOf === n ? 'bg-primary text-primary-foreground' : 'bg-accent text-foreground hover:bg-accent/80'"
              @click="editStageBestOf = n"
            >BO{{ n }}</button>
          </div>
        </div>

        <!-- Status -->
        <div>
          <label class="label-text mb-2 block">{{ t('status') }}</label>
          <div class="flex gap-2">
            <button v-for="s in ['pending', 'active', 'completed']" :key="s"
              class="px-4 py-2 rounded-md text-sm font-medium transition-colors"
              :class="editStageStatus === s
                ? s === 'completed' ? 'bg-green-600 text-white' : s === 'active' ? 'bg-primary text-primary-foreground' : 'bg-accent text-foreground ring-2 ring-border'
                : 'bg-accent text-foreground hover:bg-accent/80'"
              @click="editStageStatus = s"
            >
              {{ s === 'completed' ? t('matchCompleted') : s === 'active' ? t('matchLive') : t('matchPending') }}
            </button>
          </div>
        </div>

        <!-- Elimination: Team Selection + Seeding -->
        <div v-if="editStageFormat === 'single_elimination' || editStageFormat === 'double_elimination'">
          <label class="label-text mb-2 block">{{ t('selectTeams') }}</label>
          <div v-if="editHasMatches" class="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 rounded-md px-3 py-2 mb-2">
            {{ t('reassignTeamsWarning') }}
          </div>
          <div v-if="store.captains.value.length === 0" class="text-sm text-muted-foreground bg-accent/50 rounded-md px-3 py-2">
            {{ t('noTeamsAvailable') }}
          </div>
          <template v-else>
            <div class="flex flex-wrap gap-1.5 mb-4">
              <button
                v-for="cap in store.captains.value" :key="cap.id"
                class="px-2.5 py-1 rounded-full text-xs font-medium transition-colors"
                :class="editSelectedTeams.has(cap.id)
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-accent text-foreground hover:bg-accent/80'"
                @click="toggleEditTeamSelected(cap.id)"
              >{{ cap.team }}</button>
              <button
                class="px-2.5 py-1 rounded-full text-xs font-medium transition-colors bg-accent/60 text-muted-foreground hover:bg-accent border border-dashed border-border"
                @click="addEditTbd"
              >+ {{ t('tbd') }}</button>
            </div>

            <label v-if="editSeeds.filter(s => s === 0 || editSelectedTeams.has(s)).length > 0" class="label-text mb-2 block">{{ t('seeding') }}</label>
            <div class="flex flex-col gap-1 max-h-60 overflow-y-auto">
              <div v-for="(id, idx) in editSeeds.filter(s => s === 0 || editSelectedTeams.has(s))" :key="`${id}-${idx}`"
                class="flex items-center gap-2 px-3 py-2 rounded-md bg-accent/50"
              >
                <span class="text-xs text-muted-foreground w-6">{{ idx + 1 }}.</span>
                <span class="text-sm font-medium flex-1" :class="id === 0 ? 'text-muted-foreground italic' : 'text-foreground'">{{ getCaptainName(id) }}</span>
                <button v-if="id === 0" class="btn-ghost p-1 text-xs text-destructive" @click="removeEditTbdAt(idx)">&times;</button>
                <button class="btn-ghost p-1 text-xs" :disabled="idx === 0" @click="moveEditSeed(idx, -1)">&uarr;</button>
                <button class="btn-ghost p-1 text-xs" :disabled="idx === editSeeds.filter(s => s === 0 || editSelectedTeams.has(s)).length - 1" @click="moveEditSeed(idx, 1)">&darr;</button>
              </div>
            </div>
          </template>
        </div>

        <!-- Group Stage: Group assignment -->
        <div v-if="editStageFormat === 'group_stage'">
          <div class="flex items-center justify-between mb-2">
            <label class="label-text">{{ t('assignTeams') }}</label>
            <button class="btn-ghost text-xs" @click="addEditGroup">+ {{ t('addGroup') }}</button>
          </div>
          <div v-if="editHasMatches" class="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 rounded-md px-3 py-2 mb-2">
            {{ t('reassignTeamsWarning') }}
          </div>
          <div class="flex flex-col gap-4">
            <div v-for="(group, gi) in editGroups" :key="gi" class="card p-3">
              <div class="flex items-center justify-between mb-2">
                <input v-model="group.name" class="input-field !h-8 !text-sm w-40" />
                <button v-if="editGroups.length > 1" class="btn-ghost text-xs text-destructive" @click="removeEditGroup(gi)">{{ t('removeGroup') }}</button>
              </div>
              <div class="flex flex-wrap gap-1.5">
                <button
                  v-for="cap in store.captains.value" :key="cap.id"
                  class="px-2.5 py-1 rounded-full text-xs font-medium transition-colors"
                  :class="group.teamIds.includes(cap.id)
                    ? 'bg-primary text-primary-foreground'
                    : isEditTeamInAnyGroup(cap.id) && !group.teamIds.includes(cap.id)
                      ? 'bg-accent/30 text-muted-foreground/50 cursor-not-allowed'
                      : 'bg-accent text-foreground hover:bg-accent/80'"
                  :disabled="isEditTeamInAnyGroup(cap.id) && !group.teamIds.includes(cap.id)"
                  @click="toggleEditTeamInGroup(gi, cap.id)"
                >{{ cap.team }}</button>
                <span
                  v-for="(id, ti) in group.teamIds.filter(t => t === 0)" :key="`tbd-${ti}`"
                  class="px-2.5 py-1 rounded-full text-xs font-medium bg-accent/60 text-muted-foreground italic inline-flex items-center gap-1"
                >
                  {{ t('tbd') }}
                  <button class="text-destructive hover:text-destructive/80" @click="removeEditGroupTbd(gi, ti)">&times;</button>
                </span>
                <button
                  class="px-2.5 py-1 rounded-full text-xs font-medium transition-colors bg-accent/60 text-muted-foreground hover:bg-accent border border-dashed border-border"
                  @click="addEditGroupTbd(gi)"
                >+ {{ t('tbd') }}</button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" @click="saveEditStage">
          <Pencil class="w-4 h-4" />
          {{ t('saveChanges') }}
        </button>
        <button class="btn-ghost w-full justify-center text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30" @click="requestRegenerate">
          <RotateCcw class="w-4 h-4" />
          {{ t('regenerateBracket') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showEditStage = false">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>

    <!-- Regenerate Confirmation -->
    <ModalOverlay :show="showRegenerateConfirm" @close="showRegenerateConfirm = false">
      <div class="px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('regenerateBracket') }}</h2>
        <p class="text-sm text-muted-foreground mt-2">{{ t('regenerateBracketDesc') }}</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-destructive w-full justify-center" @click="confirmRegenerate">
          <RotateCcw class="w-4 h-4" />
          {{ t('regenerateBracketConfirm') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showRegenerateConfirm = false">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>

    <!-- Match Score Modal (admin) -->
    <MatchScoreModal
      v-if="editingMatch"
      :match="editingMatch"
      @close="editingMatch = null"
      @save="saveMatchScore(editingMatch.id, $event)"
    />

    <!-- Match Details Modal (everyone) -->
    <MatchDetailsModal
      v-if="viewingMatch"
      :match="viewingMatch"
      @close="viewingMatch = null"
    />
  </div>
</template>
