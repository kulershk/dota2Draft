<script setup lang="ts">
import { Swords, Settings, Plus, RotateCcw, Trash2, ChevronRight, Pencil } from 'lucide-vue-next'
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import BracketView from '@/components/tournament/BracketView.vue'
import DoubleEliminationView from '@/components/tournament/DoubleEliminationView.vue'
import GroupStageView from '@/components/tournament/GroupStageView.vue'
import MatchScoreModal from '@/components/tournament/MatchScoreModal.vue'

const { t } = useI18n()
const api = useApi()
const store = useDraftStore()

const loading = ref(true)
const showAddStage = ref(false)
const showReset = ref(false)
const showEditStage = ref(false)
const editingMatch = ref<any>(null)
const activeStageId = ref<number | null>(null)

// Edit stage form
const editStageName = ref('')
const editStageStatus = ref('')
const editStageId = ref<number | null>(null)

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

onMounted(async () => {
  await store.fetchTournament()
  loading.value = false
  if (stages.value.length > 0) {
    activeStageId.value = stages.value[0].id
  }
  initSeeds()
})

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
  const c = store.captains.value.find(c => c.id === id)
  return c ? c.team : '?'
}

function moveSeed(idx: number, dir: -1 | 1) {
  const newIdx = idx + dir
  if (newIdx < 0 || newIdx >= seeds.value.length) return
  const tmp = seeds.value[idx]
  seeds.value[idx] = seeds.value[newIdx]
  seeds.value[newIdx] = tmp
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
      data.seeds = seeds.value.filter(id => selectedTeams.value.has(id))
    } else {
      data.groups = groups.value
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

async function deleteStage(stageId: number) {
  const compId = store.currentCompetitionId.value
  if (!compId) return
  await api.deleteTournamentStage(compId, stageId)
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

function openEditStage(stage: any) {
  editStageId.value = stage.id
  editStageName.value = stage.name
  editStageStatus.value = stage.status
  showEditStage.value = true
}

async function saveEditStage() {
  const compId = store.currentCompetitionId.value
  if (!compId || !editStageId.value) return
  try {
    await api.updateTournamentStage(compId, editStageId.value, {
      name: editStageName.value,
      status: editStageStatus.value,
    })
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
          <button class="btn-ghost text-xs" @click="openEditStage(activeStage)">
            <Pencil class="w-3 h-3" />
            {{ t('editStage') }}
          </button>
          <button class="btn-ghost text-xs text-destructive" @click="deleteStage(activeStage.id)">
            <Trash2 class="w-3 h-3" />
            {{ t('deleteStage') }}
          </button>
        </div>

        <!-- Bracket view (single elimination) -->
        <BracketView
          v-if="activeStage.format === 'single_elimination'"
          :matches="stageMatches"
          :tournament-state="activeStage"
          :is-admin="isCompAdmin"
          @edit-match="editingMatch = $event"
        />

        <!-- Double elimination view -->
        <DoubleEliminationView
          v-else-if="activeStage.format === 'double_elimination'"
          :matches="stageMatches"
          :tournament-state="activeStage"
          :is-admin="isCompAdmin"
          @edit-match="editingMatch = $event"
        />

        <!-- Group stage view -->
        <GroupStageView
          v-else-if="activeStage.format === 'group_stage'"
          :matches="stageMatches"
          :tournament-state="activeStage"
          :captains="store.captains.value"
          :is-admin="isCompAdmin"
          @edit-match="editingMatch = $event"
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
          <!-- Team selection -->
          <label class="label-text mb-2 block">{{ t('selectTeams') }}</label>
          <div class="flex flex-wrap gap-1.5 mb-4">
            <button
              v-for="cap in store.captains.value" :key="cap.id"
              class="px-2.5 py-1 rounded-full text-xs font-medium transition-colors"
              :class="selectedTeams.has(cap.id)
                ? 'bg-primary text-primary-foreground'
                : 'bg-accent text-foreground hover:bg-accent/80'"
              @click="toggleTeamSelected(cap.id)"
            >{{ cap.team }}</button>
          </div>

          <!-- Seeding order (only selected teams) -->
          <label class="label-text mb-2 block">{{ t('seeding') }}</label>
          <div class="flex flex-col gap-1 max-h-60 overflow-y-auto">
            <div v-for="(id, idx) in seeds.filter(s => selectedTeams.has(s))" :key="id"
              class="flex items-center gap-2 px-3 py-2 rounded-md bg-accent/50"
            >
              <span class="text-xs text-muted-foreground w-6">{{ idx + 1 }}.</span>
              <span class="text-sm font-medium text-foreground flex-1">{{ getCaptainName(id) }}</span>
              <button class="btn-ghost p-1 text-xs" :disabled="idx === 0" @click="moveSeed(idx, -1)">&uarr;</button>
              <button class="btn-ghost p-1 text-xs" :disabled="idx === seeds.length - 1" @click="moveSeed(idx, 1)">&darr;</button>
            </div>
          </div>
        </div>

        <!-- Group Stage: Group assignment -->
        <div v-if="format === 'group_stage'">
          <div class="flex items-center justify-between mb-2">
            <label class="label-text">{{ t('assignTeams') }}</label>
            <button class="btn-ghost text-xs" @click="addGroup">+ {{ t('addGroup') }}</button>
          </div>
          <div class="flex flex-col gap-4 max-h-60 overflow-y-auto">
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
    <ModalOverlay :show="showEditStage" @close="showEditStage = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('editStage') }}</h2>
      </div>
      <div class="px-7 py-5 flex flex-col gap-5">
        <div class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('stageName') }}</label>
          <input v-model="editStageName" class="input-field" :placeholder="t('stageNamePlaceholder')" />
        </div>
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
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" @click="saveEditStage">
          <Pencil class="w-4 h-4" />
          {{ t('saveChanges') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showEditStage = false">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>

    <!-- Match Score Modal -->
    <MatchScoreModal
      v-if="editingMatch"
      :match="editingMatch"
      @close="editingMatch = null"
      @save="saveMatchScore(editingMatch.id, $event)"
    />
  </div>
</template>
