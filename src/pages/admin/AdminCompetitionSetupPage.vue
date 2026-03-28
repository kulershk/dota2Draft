<script setup lang="ts">
import { Settings, DollarSign, Users, UserPlus, RotateCcw, Play, Pencil, ArrowDown, Wifi, ArrowLeft, Plus, Trash2, Search, Tv, Upload, Swords, ChevronDown, ChevronRight, X } from 'lucide-vue-next'
import { ref, computed, onMounted, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import InputGroup from '@/components/common/InputGroup.vue'
import CaptainAvatar from '@/components/common/CaptainAvatar.vue'
import RichTextEditor from '@/components/common/RichTextEditor.vue'
import DatePicker from '@/components/common/DatePicker.vue'
import { getDefaultFantasyScoring } from '@/utils/fantasyDefaults'
import { toLocalDatetime, localDatetimeToISO } from '@/utils/format'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const api = useApi()
const store = useDraftStore()

const compId = computed(() => Number(route.params.compId))

const activeTab = ref('settings')
const showPromote = ref(false)
const showEditCaptain = ref(false)
const showResetConfirm = ref(false)
const showAddParticipant = ref(false)
const saving = ref(false)
const loaded = ref(false)
const participantSearchQuery = ref('')
const participantTableSearch = ref('')
const participantTablePage = ref(1)
const addParticipantPage = ref(1)
const promoteSearchQuery = ref('')
const PAGE_SIZE = 20


const compName = ref('')
const compDescription = ref('')
const compRulesTitle = ref('')
const compRulesContent = ref('')
const compType = ref('')
const compStatus = ref('draft')
const compIsPublic = ref(false)
const compStartsAt = ref('')
const compRegStart = ref('')
const compRegEnd = ref('')

const localSettings = reactive({
  playersPerTeam: 5,
  bidTimer: 30,
  startingBudget: 1000,
  minimumBid: 10,
  bidIncrement: 5,
  maxBid: 0,
  nominationOrder: 'normal',
  requireAllOnline: true,
  allowSteamRegistration: true,
  biddingType: 'default',
  blindTopBidders: 3,
  blindBidTimer: 30,
  autoFinish: true,
  fantasyEnabled: false,
  fantasyEnforceRoles: false,
  fantasyScoring: getDefaultFantasyScoring(),
  fantasyRepeatPenalty: 0.15,
  lobbyGameMode: 2,
  lobbyServerRegion: 3,
  lobbyAutoAssignTeams: true,
  lobbyLeagueId: 0,
  lobbyDotaTvDelay: 1,
  lobbyCheats: false,
  lobbyAllowSpectating: true,
  lobbyPauseSetting: 0,
  lobbySelectionPriority: 0,
  lobbyCmPick: 0,
  lobbyPenaltyRadiant: 0,
  lobbyPenaltyDire: 0,
  lobbySeriesType: 0,
})

const showFantasyScoring = ref(false)
const fantasyRoles = ['carry', 'mid', 'offlane', 'pos4', 'pos5'] as const
const fantasyStats = [
  'kill', 'death', 'assist', 'lastHit', 'deny', 'gpm', 'xpm',
  'heroDamage', 'towerDamage', 'heroHealing',
  'obsPlaced', 'senPlaced', 'obsKilled', 'senKilled',
  'campsStacked', 'stuns', 'teamfight', 'towerKill', 'roshanKill',
  'firstBlood', 'runePickup', 'tripleKill', 'ultraKill', 'rampage', 'courierKill',
] as const

function resetFantasyDefaults() {
  localSettings.fantasyScoring = getDefaultFantasyScoring()
}

// Steam import for participants
const showImportParticipants = ref(false)
const importInput = ref('')
const importing = ref(false)
const importStep = ref<'input' | 'processing' | 'done'>('input')
const importTotal = ref(0)
const importResults = ref<{ steamId: string; name: string; avatarUrl: string; status: string; id: number }[]>([])
const importError = ref('')

async function importSteamParticipants() {
  if (!importInput.value.trim()) return
  importing.value = true
  importStep.value = 'processing'
  importResults.value = []
  importError.value = ''

  try {
    const { steamIds } = await api.parseSteamIds(importInput.value)
    importTotal.value = steamIds.length

    for (const steamId of steamIds) {
      try {
        const result = await api.importSteamParticipant(compId.value, steamId)
        importResults.value.push(result)
      } catch (e: any) {
        importResults.value.push({ steamId, name: '', avatarUrl: '', status: 'error', id: 0 })
      }
    }

    importStep.value = 'done'
    await store.fetchCompData()
  } catch (e: any) {
    importError.value = e.message
    importStep.value = 'input'
  } finally {
    importing.value = false
  }
}

function closeImportParticipants() {
  showImportParticipants.value = false
  importInput.value = ''
  importResults.value = []
  importStep.value = 'input'
  importTotal.value = 0
  importError.value = ''
}

const promotePlayerId = ref<number | null>(null)
const promoteTeam = ref('')
const editCaptain = ref({ id: 0, team: '', budget: 1000 })

// All users (for promote dropdown)
const allUsers = ref<any[]>([])

onMounted(async () => {
  await store.joinCompetition(compId.value)
  await store.fetchCompData()
  // Load competition info
  const comp = await api.getCompetition(compId.value)
  compName.value = comp.name
  compDescription.value = comp.description || ''
  compRulesTitle.value = comp.rules_title || ''
  compRulesContent.value = comp.rules_content || ''
  compType.value = comp.competition_type || ''
  compStatus.value = comp.status || 'draft'
  compIsPublic.value = !!comp.is_public
  compStartsAt.value = comp.starts_at ? toLocalDatetime(comp.starts_at) : ''
  compRegStart.value = comp.registration_start ? toLocalDatetime(comp.registration_start) : ''
  compRegEnd.value = comp.registration_end ? toLocalDatetime(comp.registration_end) : ''
  Object.assign(localSettings, comp.settings)
  loaded.value = true
  // Load all users for promote
  allUsers.value = await api.getUsers()
  // Load streams
  await fetchStreams()
})

// Players eligible for promotion (Steam-registered, not already captains in this competition)
const promotablePlayers = computed(() => {
  const captainPlayerIds = store.captains.value.map(c => c.player_id).filter(Boolean)
  return allUsers.value.filter(u => u.steam_id && !captainPlayerIds.includes(u.id))
})

// Users that can be added as participants (not already in pool, not captains, not banned)
const addableUsers = computed(() => {
  const poolPlayerIds = store.players.value.map(p => p.id || 0)
  const captainPlayerIds = store.captains.value.map(c => c.player_id).filter(Boolean)
  let list = allUsers.value.filter(u => u.steam_id && !u.is_banned && !poolPlayerIds.includes(u.id) && !captainPlayerIds.includes(u.id))
  if (participantSearchQuery.value) {
    const q = participantSearchQuery.value.toLowerCase()
    list = list.filter(u => u.name.toLowerCase().includes(q))
  }
  return list
})

const paginatedAddableUsers = computed(() => addableUsers.value.slice(0, addParticipantPage.value * PAGE_SIZE))
const hasMoreAddable = computed(() => paginatedAddableUsers.value.length < addableUsers.value.length)

// Participants table with search + pagination
const participants = computed(() => store.players.value.filter(p => !p.is_captain))
const filteredParticipants = computed(() => {
  if (!participantTableSearch.value) return participants.value
  const q = participantTableSearch.value.toLowerCase()
  return participants.value.filter(p => p.name.toLowerCase().includes(q))
})
const paginatedParticipants = computed(() => filteredParticipants.value.slice(0, participantTablePage.value * PAGE_SIZE))
const hasMoreParticipants = computed(() => paginatedParticipants.value.length < filteredParticipants.value.length)

// Promotable players with search
const filteredPromotable = computed(() => {
  if (!promoteSearchQuery.value) return promotablePlayers.value
  const q = promoteSearchQuery.value.toLowerCase()
  return promotablePlayers.value.filter(u => u.name.toLowerCase().includes(q))
})

watch(participantSearchQuery, () => { addParticipantPage.value = 1 })
watch(participantTableSearch, () => { participantTablePage.value = 1 })

async function addParticipant(userId: number) {
  await api.addUserToCompPool(compId.value, userId)
  await store.fetchCompData()
}

async function removeParticipant(playerId: number) {
  await api.deleteCompPlayer(compId.value, playerId)
  await store.fetchCompData()
}

function promptPromoteParticipant(player: any) {
  promotePlayerId.value = player.id
  promoteTeam.value = `Team ${player.name}`
  showPromote.value = true
}

async function handlePromote() {
  if (!promotePlayerId.value || !promoteTeam.value) return
  await api.promoteToCaptain(compId.value, { playerId: promotePlayerId.value, team: promoteTeam.value })
  promotePlayerId.value = null
  promoteTeam.value = ''
  showPromote.value = false
  await store.fetchCompData()
}

async function saveAll() {
  saving.value = true
  try {
    await api.updateCompetition(compId.value, {
      name: compName.value,
      description: compDescription.value,
      rules_title: compRulesTitle.value,
      rules_content: compRulesContent.value,
      competition_type: compType.value,
      status: compStatus.value,
      is_public: compIsPublic.value,
      starts_at: compStartsAt.value ? localDatetimeToISO(compStartsAt.value) : null,
      registration_start: compRegStart.value ? localDatetimeToISO(compRegStart.value) : null,
      registration_end: compRegEnd.value ? localDatetimeToISO(compRegEnd.value) : null,
      settings: { ...localSettings },
    })
    // Sync store
    Object.assign(store.settings, localSettings)
  } finally {
    saving.value = false
  }
}

function startDraft() {
  store.startDraft()
  router.push(`/c/${compId.value}/auction`)
}

function openEditCaptain(captain: any) {
  editCaptain.value = { id: captain.id, team: captain.team, budget: captain.budget }
  showEditCaptain.value = true
}

async function saveCaptain() {
  await api.updateCaptain(compId.value, editCaptain.value.id, {
    team: editCaptain.value.team,
    budget: editCaptain.value.budget,
  })
  showEditCaptain.value = false
  await store.fetchCompData()
}

async function handleDemote(captainId: number) {
  await api.demoteCaptain(compId.value, captainId)
  await store.fetchCompData()
}

function formatGold(amount: number) {
  return amount.toLocaleString() + 'g'
}

// Team member management
const expandedCaptain = ref<number | null>(null)
const showAssignModal = ref(false)
const assignCaptainId = ref<number | null>(null)
const assignSearch = ref('')

function toggleExpand(captainId: number) {
  expandedCaptain.value = expandedCaptain.value === captainId ? null : captainId
}

function getTeamMembers(captainId: number) {
  return store.players.value.filter((p: any) => p.drafted && p.drafted_by === captainId)
}

function openAssignModal(captainId: number) {
  assignCaptainId.value = captainId
  assignSearch.value = ''
  showAssignModal.value = true
}

const assignablePlayers = computed(() => {
  const players = store.players.value.filter((p: any) => !p.drafted && p.in_pool && !p.is_captain)
  if (!assignSearch.value) return players
  const q = assignSearch.value.toLowerCase()
  return players.filter((p: any) => (p.name || '').toLowerCase().includes(q))
})

async function assignPlayer(playerId: number) {
  if (!assignCaptainId.value) return
  await api.assignPlayer(compId.value, playerId, assignCaptainId.value)
  showAssignModal.value = false
}

async function unassignPlayer(playerId: number) {
  await api.unassignPlayer(compId.value, playerId)
}

const onlineCount = computed(() => store.onlineCaptainIds.value.length)
function isCaptainOnline(captainId: number) {
  return store.onlineCaptainIds.value.includes(captainId)
}
function isCaptainReady(captainId: number) {
  return store.readyCaptainIds.value.includes(captainId)
}

const allCaptainsReady = computed(() =>
  store.captains.value.length > 0 && (!localSettings.requireAllOnline || store.captains.value.every(c => store.readyCaptainIds.value.includes(c.id)))
)
const readyCount = computed(() => store.readyCaptainIds.value.length)

// Streams
const streams = ref<any[]>([])
const showAddStream = ref(false)
const newStreamUsername = ref('')
const newStreamTitle = ref('')
const editingStream = ref<any>(null)

async function fetchStreams() {
  if (!compId.value) return
  streams.value = await api.getCompStreams(compId.value)
}

async function addStream() {
  if (!newStreamUsername.value.trim()) return
  await api.addCompStream(compId.value, { twitch_username: newStreamUsername.value.trim(), title: newStreamTitle.value.trim() })
  newStreamUsername.value = ''
  newStreamTitle.value = ''
  showAddStream.value = false
  await fetchStreams()
}

async function saveStream() {
  if (!editingStream.value) return
  await api.updateCompStream(compId.value, editingStream.value.id, { twitch_username: editingStream.value.twitch_username, title: editingStream.value.title })
  editingStream.value = null
  await fetchStreams()
}

async function deleteStream(id: number) {
  await api.deleteCompStream(compId.value, id)
  await fetchStreams()
}
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[1200px] w-full">
    <div class="flex items-center gap-3">
      <button class="btn-ghost p-2" @click="router.push('/admin/competitions')">
        <ArrowLeft class="w-4 h-4" />
      </button>
      <div>
        <h1 class="text-2xl font-semibold text-foreground">{{ t('competitionSetup') }}</h1>
        <p class="text-sm text-muted-foreground mt-1">{{ compName || t('loading') }}</p>
      </div>
    </div>

    <div v-if="!loaded" class="flex items-center justify-center py-16">
      <div class="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full"></div>
    </div>
    <template v-else>
    <!-- Tabs -->
    <div class="flex gap-1 border-b border-border overflow-x-auto">
      <button v-for="tab in ['settings', 'rules', 'lobby', 'fantasy', 'captains', 'other']" :key="tab"
        class="px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px"
        :class="activeTab === tab ? 'text-primary border-primary' : 'text-muted-foreground border-transparent hover:text-foreground hover:border-border'"
        @click="activeTab = tab"
      >
        {{ t('tab_' + tab) }}
      </button>
    </div>

    <!-- Tab: Settings -->
    <template v-if="activeTab === 'settings'">

    <!-- Competition Info -->
    <div class="card">
      <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Settings class="w-5 h-5 text-foreground" />
        <span class="text-sm font-semibold text-foreground">{{ t('competitionInfo') }}</span>
      </div>
      <div class="p-4 flex flex-col gap-4">
        <InputGroup :label="t('name')" :model-value="compName" placeholder="Competition name" @update:model-value="compName = $event" />
        <div class="flex flex-col gap-1.5">
          <label class="label-text">Competition Type</label>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="ct in ['', 'LAN', 'ONLINE', 'TEAMBUILDING', 'KRAKEN']"
              :key="ct"
              class="px-3 py-1.5 rounded-md text-xs font-semibold transition-colors"
              :class="compType === ct
                ? 'bg-primary text-primary-foreground'
                : 'bg-accent text-muted-foreground hover:text-foreground'"
              @click="compType = ct"
            >{{ ct || 'None' }}</button>
          </div>
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('statusCol') }}</label>
          <select class="input-field" v-model="compStatus">
            <option value="draft">{{ t('statusSetup') }}</option>
            <option value="registration">{{ t('statusRegistrationOpen') }}</option>
            <option value="registration_closed">{{ t('statusRegistrationClosed') }}</option>
            <option value="active">{{ t('statusInProgress') }}</option>
            <option value="finished">{{ t('statusFinished') }}</option>
          </select>
        </div>
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" class="w-4 h-4 accent-primary" v-model="compIsPublic" />
          <span class="text-sm text-foreground">{{ t('publicCompetition') }}</span>
          <span class="text-xs text-muted-foreground">{{ t('publicCompetitionHint') }}</span>
        </label>
        <div class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('description') }}</label>
          <RichTextEditor v-model="compDescription" />
        </div>
        <DatePicker
          mode="range"
          show-time
          :start-label="t('registrationStart')"
          :end-label="t('registrationEnd')"
          :model-start="compRegStart"
          :model-end="compRegEnd"
          @update:model-start="compRegStart = $event"
          @update:model-end="compRegEnd = $event"
        />
        <DatePicker
          mode="single"
          show-time
          :label="t('draftStartDate')"
          :model-value="compStartsAt"
          @update:model-value="compStartsAt = $event"
        />
      </div>
    </div>

    <!-- Settings -->
    <div class="flex flex-col md:flex-row gap-4 md:gap-6">
      <div class="card flex-1">
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Settings class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">{{ t('generalSettings') }}</span>
        </div>
        <div class="p-4 flex flex-col gap-4">
          <InputGroup :label="t('playersPerTeam')" :model-value="String(localSettings.playersPerTeam)" placeholder="5" @update:model-value="localSettings.playersPerTeam = Number($event)" :hint="t('captainPlusDrafted', { n: localSettings.playersPerTeam })" />
          <InputGroup :label="t('bidTimerSeconds')" :model-value="String(localSettings.bidTimer)" placeholder="30" @update:model-value="localSettings.bidTimer = Number($event)" />
          <div class="flex flex-col gap-1.5">
            <label class="label-text">{{ t('biddingType') }}</label>
            <select class="input-field" :value="localSettings.biddingType" @change="localSettings.biddingType = ($event.target as HTMLSelectElement).value">
              <option value="default">{{ t('biddingTypeDefault') }}</option>
              <option value="blind">{{ t('biddingTypeBlind') }}</option>
            </select>
            <p class="text-xs text-muted-foreground">{{ localSettings.biddingType === 'blind' ? t('biddingTypeBlindHint') : t('biddingTypeDefaultHint') }}</p>
          </div>
          <InputGroup v-if="localSettings.biddingType === 'blind'" :label="t('blindBidTimerSeconds')" :model-value="String(localSettings.blindBidTimer)" placeholder="30" @update:model-value="localSettings.blindBidTimer = Number($event)" :hint="t('blindBidTimerHint')" />
          <InputGroup v-if="localSettings.biddingType === 'blind'" :label="t('blindTopBidders')" :model-value="String(localSettings.blindTopBidders)" placeholder="3" @update:model-value="localSettings.blindTopBidders = Number($event)" :hint="t('blindTopBiddersHint')" />
          <div class="flex flex-col gap-1.5">
            <label class="label-text">{{ t('nominationOrder') }}</label>
            <select class="input-field" :value="localSettings.nominationOrder" @change="localSettings.nominationOrder = ($event.target as HTMLSelectElement).value">
              <option value="normal">{{ t('normalRoundRobin') }}</option>
              <option value="lowest_avg">{{ t('lowestAvgFirst') }}</option>
              <option value="fewest_then_lowest">{{ t('fewestThenLowest') }}</option>
            </select>
          </div>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" class="w-4 h-4 accent-primary" v-model="localSettings.requireAllOnline" />
            <span class="text-sm text-foreground">{{ t('requireOnlineNominate') }}</span>
          </label>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" class="w-4 h-4 accent-primary" v-model="localSettings.allowSteamRegistration" />
            <span class="text-sm text-foreground">{{ t('allowSelfRegister') }}</span>
          </label>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" class="w-4 h-4 accent-primary" v-model="localSettings.autoFinish" />
            <span class="text-sm text-foreground">{{ t('autoFinishDraft') }}</span>
            <span class="text-xs text-muted-foreground">{{ t('autoFinishHint') }}</span>
          </label>
        </div>
      </div>

      <div class="card flex-1">
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
          <DollarSign class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">{{ t('budgetSettings') }}</span>
        </div>
        <div class="p-4 flex flex-col gap-4">
          <InputGroup :label="t('startingBudgetGold')" :model-value="String(localSettings.startingBudget)" placeholder="1000" @update:model-value="localSettings.startingBudget = Number($event)" />
          <InputGroup :label="t('minimumStartingBid')" :model-value="String(localSettings.minimumBid)" placeholder="10" @update:model-value="localSettings.minimumBid = Number($event)" />
          <InputGroup :label="t('bidIncrementLabel')" :model-value="String(localSettings.bidIncrement)" placeholder="5" @update:model-value="localSettings.bidIncrement = Number($event)" />
          <InputGroup :label="t('maxBidNoLimit')" :model-value="String(localSettings.maxBid)" placeholder="0" @update:model-value="localSettings.maxBid = Number($event)" />
        </div>
      </div>
    </div>

    <!-- Save -->
    <div class="flex justify-end">
      <button class="btn-outline text-sm" :disabled="saving" @click="saveAll">
        {{ saving ? t('saving') : t('saveSettings') }}
      </button>
    </div>

    </template>

    <!-- Tab: Rules -->
    <template v-if="activeTab === 'rules'">
    <div class="card">
      <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Info class="w-5 h-5 text-foreground" />
        <span class="text-sm font-semibold text-foreground">Competition Rules</span>
      </div>
      <div class="p-4 flex flex-col gap-4">
        <div class="flex flex-col gap-1.5">
          <label class="label-text">Rules Title</label>
          <input type="text" v-model="compRulesTitle" class="input-field" placeholder="e.g. Competition Rules" />
          <p class="text-[11px] text-muted-foreground">Displayed as the section heading on the competition info page.</p>
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="label-text">Rules Content</label>
          <RichTextEditor v-model="compRulesContent" />
          <p class="text-[11px] text-muted-foreground">Use the rich text editor to format rules with headings, lists, bold text, etc.</p>
        </div>
      </div>
    </div>
    <div class="flex justify-end">
      <button class="btn-outline text-sm" :disabled="saving" @click="saveAll">
        {{ saving ? t('saving') : t('saveSettings') }}
      </button>
    </div>
    </template>

    <!-- Tab: Lobby -->
    <template v-if="activeTab === 'lobby'">

    <!-- Lobby Settings -->
    <div class="card">
      <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Swords class="w-5 h-5 text-foreground" />
        <span class="text-sm font-semibold text-foreground">{{ t('lobbySettings') }}</span>
      </div>
      <div class="p-4 flex flex-col gap-4">
        <div class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('lobbyGameMode') }}</label>
          <select class="input-field" :value="localSettings.lobbyGameMode" @change="localSettings.lobbyGameMode = Number(($event.target as HTMLSelectElement).value)">
            <option :value="1">{{ t('gameModeAP') }}</option>
            <option :value="2">{{ t('gameModeCM') }}</option>
            <option :value="3">{{ t('gameModeRD') }}</option>
            <option :value="4">{{ t('gameModeSD') }}</option>
            <option :value="5">{{ t('gameModeAR') }}</option>
            <option :value="8">{{ t('gameModeReverseCM') }}</option>
            <option :value="11">{{ t('gameModeMO') }}</option>
            <option :value="12">{{ t('gameModeLP') }}</option>
            <option :value="16">{{ t('gameModeCD') }}</option>
            <option :value="18">{{ t('gameModeABD') }}</option>
            <option :value="20">{{ t('gameModeARDM') }}</option>
            <option :value="21">{{ t('gameMode1v1') }}</option>
            <option :value="22">{{ t('gameModeAD') }}</option>
            <option :value="23">{{ t('gameModeTurbo') }}</option>
          </select>
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('lobbyServerRegion') }}</label>
          <select class="input-field" :value="localSettings.lobbyServerRegion" @change="localSettings.lobbyServerRegion = Number(($event.target as HTMLSelectElement).value)">
            <option :value="3">{{ t('regionEUWest') }}</option>
            <option :value="8">{{ t('regionEUEast') }}</option>
            <option :value="1">{{ t('regionUSEast') }}</option>
            <option :value="0">{{ t('regionUSWest') }}</option>
            <option :value="5">{{ t('regionSEAsia') }}</option>
            <option :value="7">{{ t('regionAustralia') }}</option>
            <option :value="9">{{ t('regionSAmerica') }}</option>
            <option :value="10">{{ t('regionRussia') }}</option>
          </select>
        </div>
        <InputGroup :label="t('lobbyLeagueId')" :model-value="String(localSettings.lobbyLeagueId)" placeholder="0" @update:model-value="localSettings.lobbyLeagueId = Number($event)" :hint="t('lobbyLeagueIdHint')" />
        <div class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('lobbyDotaTvDelay') }}</label>
          <select class="input-field" :value="localSettings.lobbyDotaTvDelay" @change="localSettings.lobbyDotaTvDelay = Number(($event.target as HTMLSelectElement).value)">
            <option :value="0">{{ t('dotaTvNone') }}</option>
            <option :value="1">{{ t('dotaTv10min') }}</option>
            <option :value="2">{{ t('dotaTv5min') }}</option>
            <option :value="3">{{ t('dotaTv2min') }}</option>
          </select>
        </div>
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" class="w-4 h-4 accent-primary" v-model="localSettings.lobbyAutoAssignTeams" />
          <span class="text-sm text-foreground">{{ t('lobbyAutoAssignTeams') }}</span>
        </label>
        <p class="text-xs text-muted-foreground">{{ t('lobbyAutoAssignTeamsHint') }}</p>
        <div class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('lobbySelectionPriority') }}</label>
          <select class="input-field" :value="localSettings.lobbySelectionPriority" @change="localSettings.lobbySelectionPriority = Number(($event.target as HTMLSelectElement).value)">
            <option :value="0">{{ t('selectionPriorityManual') }}</option>
            <option :value="1">{{ t('selectionPriorityAutomatic') }}</option>
          </select>
          <p class="text-xs text-muted-foreground">{{ t('lobbySelectionPriorityHint') }}</p>
        </div>
        <div v-if="localSettings.lobbySelectionPriority === 0" class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('lobbyCmPick') }}</label>
          <select class="input-field" :value="localSettings.lobbyCmPick" @change="localSettings.lobbyCmPick = Number(($event.target as HTMLSelectElement).value)">
            <option :value="0">{{ t('cmPickRandom') }}</option>
            <option :value="1">{{ t('cmPickRadiant') }}</option>
            <option :value="2">{{ t('cmPickDire') }}</option>
          </select>
        </div>
        <div class="flex flex-col md:flex-row gap-4">
          <InputGroup class="flex-1" :label="t('lobbyPenaltyRadiant')" :model-value="String(localSettings.lobbyPenaltyRadiant)" placeholder="0" @update:model-value="localSettings.lobbyPenaltyRadiant = Number($event)" />
          <InputGroup class="flex-1" :label="t('lobbyPenaltyDire')" :model-value="String(localSettings.lobbyPenaltyDire)" placeholder="0" @update:model-value="localSettings.lobbyPenaltyDire = Number($event)" />
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('lobbyPauseSetting') }}</label>
          <select class="input-field" :value="localSettings.lobbyPauseSetting" @change="localSettings.lobbyPauseSetting = Number(($event.target as HTMLSelectElement).value)">
            <option :value="0">{{ t('pauseUnlimited') }}</option>
            <option :value="1">{{ t('pauseLimited') }}</option>
            <option :value="2">{{ t('pauseDisabled') }}</option>
          </select>
        </div>
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" class="w-4 h-4 accent-primary" v-model="localSettings.lobbyAllowSpectating" />
          <span class="text-sm text-foreground">{{ t('lobbyAllowSpectating') }}</span>
        </label>
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" class="w-4 h-4 accent-primary" v-model="localSettings.lobbyCheats" />
          <span class="text-sm text-foreground">{{ t('lobbyCheats') }}</span>
        </label>
        <div class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('lobbySeriesType') }}</label>
          <select class="input-field" :value="localSettings.lobbySeriesType" @change="localSettings.lobbySeriesType = Number(($event.target as HTMLSelectElement).value)">
            <option :value="0">{{ t('seriesNone') }}</option>
            <option :value="1">{{ t('seriesBo2') }}</option>
            <option :value="2">{{ t('seriesBo3') }}</option>
            <option :value="3">{{ t('seriesBo5') }}</option>
          </select>
        </div>
      </div>
    </div>

    <!-- Save -->
    <div class="flex justify-end">
      <button class="btn-outline text-sm" :disabled="saving" @click="saveAll">
        {{ saving ? t('saving') : t('saveSettings') }}
      </button>
    </div>

    </template>

    <!-- Tab: Fantasy -->
    <template v-if="activeTab === 'fantasy'">

    <!-- Fantasy Scoring -->
    <div class="card">
      <div class="flex items-center justify-between px-4 py-3 border-b border-border">
        <div class="flex items-center gap-2">
          <Swords class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">{{ t('fantasyScoring') }}</span>
        </div>
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" class="w-4 h-4 accent-primary" v-model="localSettings.fantasyEnabled" />
          <span class="text-sm text-foreground">{{ t('enabled') }}</span>
        </label>
      </div>
      <div v-if="localSettings.fantasyEnabled" class="p-4 flex flex-col gap-4">
        <div class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('repeatPenalty') }}</label>
          <div class="flex items-center gap-3">
            <input
              type="number"
              step="0.01"
              min="0"
              max="1"
              class="input-field w-24"
              :value="localSettings.fantasyRepeatPenalty"
              @input="localSettings.fantasyRepeatPenalty = Number(($event.target as HTMLInputElement).value)"
            />
            <span class="text-xs text-muted-foreground flex-1">{{ t('repeatPenaltyHint', { pct: Math.round((localSettings.fantasyRepeatPenalty || 0) * 100) }) }}</span>
          </div>
        </div>
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" class="w-4 h-4 accent-primary" v-model="localSettings.fantasyEnforceRoles" />
          <span class="text-sm text-foreground">{{ t('fantasyEnforceRoles') }}</span>
        </label>
        <span class="text-xs text-muted-foreground -mt-2">{{ t('fantasyEnforceRolesHint') }}</span>
        <div class="flex items-center justify-between">
          <button class="text-xs text-primary hover:underline" @click="showFantasyScoring = !showFantasyScoring">
            {{ showFantasyScoring ? t('hideMultipliers') : t('showMultipliers') }}
          </button>
          <button v-if="showFantasyScoring" class="text-xs text-muted-foreground hover:text-foreground" @click="resetFantasyDefaults">
            {{ t('resetDefaults') }}
          </button>
        </div>

        <div v-if="showFantasyScoring" class="overflow-x-auto">
          <table class="w-full text-xs border-collapse">
            <thead>
              <tr class="border-b border-border">
                <th class="text-left py-2 px-2 text-muted-foreground font-medium sticky left-0 bg-background">{{ t('stat') }}</th>
                <th v-for="role in fantasyRoles" :key="role" class="text-center py-2 px-2 text-muted-foreground font-medium min-w-[70px]">
                  {{ t('fantasyRole_' + role) }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="stat in fantasyStats" :key="stat" class="border-b border-border/30 hover:bg-accent/20">
                <td class="py-1.5 px-2 text-foreground font-medium sticky left-0 bg-background">{{ t('fantasyStat_' + stat) }}</td>
                <td v-for="role in fantasyRoles" :key="role" class="text-center px-1">
                  <input
                    type="number"
                    step="any"
                    class="w-16 px-1.5 py-1 text-center text-xs rounded border border-border bg-background text-foreground focus:border-primary focus:outline-none"
                    :value="localSettings.fantasyScoring[role]?.[stat]"
                    @input="localSettings.fantasyScoring[role][stat] = Number(($event.target as HTMLInputElement).value)"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Save -->
    <div class="flex justify-end">
      <button class="btn-outline text-sm" :disabled="saving" @click="saveAll">
        {{ saving ? t('saving') : t('saveSettings') }}
      </button>
    </div>

    </template>

    <!-- Tab: Captains & Participants -->
    <!-- Tab: Other -->
    <template v-if="activeTab === 'other'">

    <!-- Official Streams -->
    <div class="card">
      <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 px-4 py-3 border-b border-border">
        <div class="flex items-center gap-2">
          <Tv class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">{{ t('officialStreams') }} ({{ streams.length }})</span>
        </div>
        <button class="btn-primary text-sm" @click="showAddStream = true">
          <Plus class="w-4 h-4" />
          {{ t('addStream') }}
        </button>
      </div>
      <div v-if="streams.length === 0" class="px-4 py-8 text-center text-sm text-muted-foreground">
        {{ t('noStreamsYet') }}
      </div>
      <div v-else class="divide-y divide-border">
        <div v-for="stream in streams" :key="stream.id" class="flex items-center justify-between px-4 py-3">
          <template v-if="editingStream && editingStream.id === stream.id">
            <div class="flex items-center gap-2 flex-1 mr-3">
              <input v-model="editingStream.twitch_username" type="text" :placeholder="t('twitchUsername')" class="input-field w-40" />
              <input v-model="editingStream.title" type="text" :placeholder="t('streamTitlePlaceholder')" class="input-field flex-1" />
            </div>
            <div class="flex items-center gap-1">
              <button class="btn-primary text-xs py-1 px-2.5" @click="saveStream">{{ t('save') }}</button>
              <button class="btn-ghost text-xs py-1 px-2.5" @click="editingStream = null">{{ t('cancel') }}</button>
            </div>
          </template>
          <template v-else>
            <div class="flex items-center gap-3">
              <img v-if="stream.profile_image_url" :src="stream.profile_image_url" class="w-8 h-8 rounded-full" />
              <div v-else class="w-8 h-8 rounded-full bg-[#9146FF]/10 flex items-center justify-center">
                <Tv class="w-4 h-4 text-[#9146FF]" />
              </div>
              <div>
                <p class="text-sm font-medium text-foreground">{{ stream.title || stream.twitch_username }}</p>
                <p class="text-xs text-muted-foreground">twitch.tv/{{ stream.twitch_username }}</p>
              </div>
            </div>
            <div class="flex items-center gap-1">
              <button class="btn-ghost p-2" :title="t('edit')" @click="editingStream = { ...stream }">
                <Pencil class="w-4 h-4" />
              </button>
              <button class="btn-ghost p-2 text-destructive" :title="t('delete')" @click="deleteStream(stream.id)">
                <Trash2 class="w-4 h-4" />
              </button>
            </div>
          </template>
        </div>
      </div>
    </div>

    </template>

    <!-- Tab: Captains & Participants -->
    <template v-if="activeTab === 'captains'">

    <!-- Captains -->
    <div class="card">
      <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 px-4 py-3 border-b border-border">
        <div class="flex items-center gap-2 flex-wrap">
          <Users class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">{{ t('captainsAndTeams') }} ({{ store.captains.value.length }})</span>
          <span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium bg-color-success text-color-success-foreground">
            <Wifi class="w-3 h-3" />
            {{ onlineCount }} {{ t('online') }}
          </span>
          <span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium" :class="allCaptainsReady ? 'bg-color-success text-color-success-foreground' : 'bg-accent text-muted-foreground'">
            {{ readyCount }}/{{ store.captains.value.length }} {{ t('ready').toLowerCase() }}
          </span>
        </div>
        <button class="btn-primary text-sm" @click="showPromote = true" :disabled="promotablePlayers.length === 0">
          <UserPlus class="w-4 h-4" />
          {{ t('promoteToCaptain') }}
        </button>
      </div>

      <div v-if="store.captains.value.length === 0" class="px-4 py-8 text-center text-sm text-muted-foreground">
        {{ t('noCaptainsYet') }}
      </div>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border bg-accent/50">
              <th class="text-left px-4 py-3 font-medium text-muted-foreground w-[40px]">#</th>
              <th class="text-left px-4 py-3 font-medium text-muted-foreground">{{ t('captainCol') }}</th>
              <th class="text-left px-4 py-3 font-medium text-muted-foreground">{{ t('teamName') }}</th>
              <th class="text-left px-4 py-3 font-medium text-muted-foreground w-[120px]">{{ t('budgetCol') }}</th>
              <th class="text-left px-4 py-3 font-medium text-muted-foreground w-[100px]">{{ t('statusCol') }}</th>
              <th class="text-left px-4 py-3 font-medium text-muted-foreground w-[100px]">{{ t('actionsCol') }}</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="(captain, i) in store.captains.value" :key="captain.id">
            <tr class="border-b border-border hover:bg-accent/30 transition-colors cursor-pointer" @click="toggleExpand(captain.id)">
              <td class="px-4 py-3 text-muted-foreground">
                <div class="flex items-center gap-1">
                  <component :is="expandedCaptain === captain.id ? ChevronDown : ChevronRight" class="w-3.5 h-3.5 text-muted-foreground" />
                  {{ String(i + 1).padStart(2, '0') }}
                </div>
              </td>
              <td class="px-4 py-3">
                <div class="flex items-center gap-2.5">
                  <img v-if="captain.avatar_url" :src="captain.avatar_url" class="w-8 h-8 rounded-full" />
                  <CaptainAvatar v-else :name="captain.name" :online="isCaptainOnline(captain.id)" />
                  <div class="flex flex-col">
                    <span class="font-medium text-foreground">{{ captain.name }}</span>
                    <span class="text-[10px] text-muted-foreground">{{ getTeamMembers(captain.id).length }} {{ t('members') }}</span>
                  </div>
                </div>
              </td>
              <td class="px-4 py-3 text-foreground">{{ captain.team }}</td>
              <td class="px-4 py-3 font-mono text-foreground">{{ formatGold(captain.budget) }}</td>
              <td class="px-4 py-3">
                <span v-if="isCaptainReady(captain.id)" class="badge-ready">{{ t('ready') }}</span>
                <span v-else-if="isCaptainOnline(captain.id)" class="badge-waiting">{{ t('waiting') }}</span>
                <span v-else class="badge-waiting">{{ t('offline') }}</span>
              </td>
              <td class="px-4 py-3" @click.stop>
                <div class="flex items-center gap-1">
                  <button class="btn-ghost p-2" :title="t('editCaptain')" @click="openEditCaptain(captain)">
                    <Pencil class="w-4 h-4" />
                  </button>
                  <button class="btn-ghost p-2 text-destructive" :title="t('demoteToPlayer')" @click="handleDemote(captain.id)">
                    <ArrowDown class="w-4 h-4" />
                  </button>
                </div>
              </td>
            </tr>
            <!-- Expanded team members -->
            <tr v-if="expandedCaptain === captain.id">
              <td colspan="6" class="px-4 py-3 bg-accent/20">
                <div class="flex flex-col gap-2">
                  <div class="flex items-center justify-between">
                    <span class="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{{ t('teamMembers') }}</span>
                    <button class="btn-outline text-xs px-2 py-1" @click="openAssignModal(captain.id)">
                      <Plus class="w-3 h-3" />
                      {{ t('addPlayer') }}
                    </button>
                  </div>
                  <div v-if="getTeamMembers(captain.id).length === 0" class="text-xs text-muted-foreground py-2">
                    {{ t('noTeamMembers') }}
                  </div>
                  <div v-for="member in getTeamMembers(captain.id)" :key="member.id" class="flex items-center justify-between py-1.5 px-2 rounded hover:bg-accent/30">
                    <div class="flex items-center gap-2">
                      <img v-if="member.avatar_url" :src="member.avatar_url" class="w-6 h-6 rounded-full" />
                      <div v-else class="w-6 h-6 rounded-full bg-surface flex items-center justify-center text-[10px] font-semibold text-muted-foreground">{{ member.name.charAt(0) }}</div>
                      <span class="text-sm text-foreground">{{ member.name }}</span>
                      <span v-if="member.playing_role" class="text-[9px] font-bold text-primary bg-primary/10 px-1 rounded">P{{ member.playing_role }}</span>
                      <span class="text-xs text-muted-foreground font-mono">{{ member.mmr }}</span>
                    </div>
                    <button class="btn-ghost p-1 text-destructive" :title="t('removeFromTeam')" @click="unassignPlayer(member.id)">
                      <X class="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </td>
            </tr>
            </template>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Participants -->
    <div class="card">
      <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 px-4 py-3 border-b border-border">
        <div class="flex items-center gap-2">
          <Users class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">{{ t('participants') }} ({{ participants.length }})</span>
        </div>
        <div class="flex items-center gap-2">
          <div class="relative">
            <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input v-model="participantTableSearch" type="text" :placeholder="t('search')" class="input-field pl-9 w-44" />
          </div>
          <button class="btn-outline text-sm" @click="showImportParticipants = true">
            <Upload class="w-4 h-4" />
            {{ t('importParticipants') }}
          </button>
          <button class="btn-primary text-sm" @click="showAddParticipant = true">
            <Plus class="w-4 h-4" />
            {{ t('addParticipant') }}
          </button>
        </div>
      </div>

      <div v-if="participants.length === 0" class="px-4 py-8 text-center text-sm text-muted-foreground">
        {{ t('noParticipantsYet') }}
      </div>
      <div v-else class="overflow-x-auto max-h-[400px] overflow-y-auto">
        <table class="w-full text-sm">
          <thead class="sticky top-0 bg-card">
            <tr class="border-b border-border bg-accent/50">
              <th class="text-left px-4 py-2.5 font-medium text-muted-foreground w-[40px]">#</th>
              <th class="text-left px-4 py-2.5 font-medium text-muted-foreground">{{ t('playerCol') }}</th>
              <th class="text-left px-4 py-2.5 font-medium text-muted-foreground">{{ t('rolesCol') }}</th>
              <th class="text-left px-4 py-2.5 font-medium text-muted-foreground w-[80px]">{{ t('mmrCol') }}</th>
              <th class="text-left px-4 py-2.5 font-medium text-muted-foreground w-[120px]">{{ t('joined') }}</th>
              <th class="text-left px-4 py-2.5 font-medium text-muted-foreground w-[100px]">{{ t('actionsCol') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(player, i) in paginatedParticipants" :key="player.id" class="border-b border-border hover:bg-accent/30 transition-colors">
              <td class="px-4 py-2.5 text-muted-foreground text-xs">{{ String(i + 1).padStart(2, '0') }}</td>
              <td class="px-4 py-2.5">
                <div class="flex items-center gap-2">
                  <img v-if="player.avatar_url" :src="player.avatar_url" class="w-6 h-6 rounded-full" />
                  <div v-else class="w-6 h-6 rounded-full bg-secondary flex items-center justify-center text-[10px] font-semibold text-secondary-foreground">
                    {{ player.name.charAt(0) }}
                  </div>
                  <span class="text-sm font-medium text-foreground">{{ player.name }}</span>
                </div>
              </td>
              <td class="px-4 py-2.5 text-xs text-muted-foreground">{{ (player.roles || []).join(', ') || '—' }}</td>
              <td class="px-4 py-2.5 text-xs text-muted-foreground">{{ player.mmr || 0 }}</td>
              <td class="px-4 py-2.5 text-xs text-muted-foreground">{{ player.joined_at ? new Date(player.joined_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—' }}</td>
              <td class="px-4 py-2.5">
                <div class="flex items-center gap-1">
                  <button class="btn-ghost p-1.5" :title="t('promoteToCaptain')" @click="promptPromoteParticipant(player)">
                    <UserPlus class="w-3.5 h-3.5" />
                  </button>
                  <button class="btn-ghost p-1.5 text-destructive" :title="t('delete')" @click="removeParticipant(player.id)">
                    <Trash2 class="w-3.5 h-3.5" />
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="hasMoreParticipants" class="px-4 py-3 border-t border-border text-center">
        <button class="btn-ghost text-sm text-primary" @click="participantTablePage++">
          {{ t('showMore', { remaining: filteredParticipants.length - paginatedParticipants.length }) }}
        </button>
      </div>
    </div>

    <!-- Action Bar -->
    <div class="flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-3">
      <p v-if="!allCaptainsReady && store.captains.value.length > 0" class="text-sm text-muted-foreground mr-2">
        {{ t('waitingReady', { ready: readyCount, total: store.captains.value.length }) }}
      </p>
      <button class="btn-outline" @click="showResetConfirm = true">
        <RotateCcw class="w-4 h-4" />
        {{ t('reset') }}
      </button>
      <button v-if="store.auction.status === 'idle'" class="btn-primary" :disabled="!allCaptainsReady" @click="startDraft">
        <Play class="w-4 h-4" />
        {{ t('startDraft') }}
      </button>
    </div>

    </template>

    <!-- Promote Modal -->
    <ModalOverlay :show="showPromote" @close="showPromote = false; promoteSearchQuery = ''">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('promoteModal.title') }}</h2>
        <p class="text-sm text-muted-foreground mt-1">{{ t('promoteModal.subtitle') }}</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-5">
        <div class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('promoteModal.selectPlayer') }}</label>
          <div class="relative">
            <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input v-model="promoteSearchQuery" type="text" :placeholder="t('search')" class="input-field pl-9 w-full" />
          </div>
          <div class="max-h-[200px] overflow-y-auto border border-border rounded-lg divide-y divide-border">
            <button
              v-for="p in filteredPromotable.slice(0, 20)" :key="p.id"
              class="flex items-center gap-2.5 w-full px-3 py-2 text-left hover:bg-accent/30 transition-colors"
              :class="promotePlayerId === p.id ? 'bg-primary/10' : ''"
              @click="promotePlayerId = p.id; if (!promoteTeam || promoteTeam.startsWith('Team ')) promoteTeam = `Team ${p.name}`"
            >
              <img v-if="p.avatar_url" :src="p.avatar_url" class="w-6 h-6 rounded-full" />
              <div v-else class="w-6 h-6 rounded-full bg-secondary flex items-center justify-center text-[10px] font-semibold text-secondary-foreground">
                {{ p.name.charAt(0) }}
              </div>
              <span class="text-sm font-medium text-foreground">{{ p.name }}</span>
              <span class="text-xs text-muted-foreground ml-auto">{{ p.mmr }} MMR</span>
            </button>
            <div v-if="filteredPromotable.length === 0" class="px-3 py-4 text-center text-sm text-muted-foreground">
              {{ t('noUsersFound') }}
            </div>
          </div>
        </div>
        <InputGroup :label="t('promoteModal.teamName')" :model-value="promoteTeam" :placeholder="t('promoteModal.teamPlaceholder')" @update:model-value="promoteTeam = $event" />
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" :disabled="!promotePlayerId || !promoteTeam" @click="handlePromote">
          <UserPlus class="w-4 h-4" />
          {{ t('promoteToCaptain') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showPromote = false; promoteSearchQuery = ''">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>

    <!-- Reset Confirmation -->
    <ModalOverlay :show="showResetConfirm" @close="showResetConfirm = false">
      <div class="px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('resetModal.title') }}</h2>
        <p class="text-sm text-muted-foreground mt-2">{{ t('resetModal.message') }}</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-destructive w-full justify-center" @click="store.resetDraft(); showResetConfirm = false">
          <RotateCcw class="w-4 h-4" />
          {{ t('resetModal.confirm') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showResetConfirm = false">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>

    <!-- Add Participant Modal -->
    <ModalOverlay :show="showAddParticipant" @close="showAddParticipant = false; participantSearchQuery = ''">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('addParticipantModal.title') }}</h2>
        <p class="text-sm text-muted-foreground mt-1">{{ t('addParticipantModal.subtitle') }}</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-4">
        <div class="relative">
          <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input v-model="participantSearchQuery" type="text" :placeholder="t('addParticipantModal.searchPlaceholder')" class="input-field pl-9 w-full" />
        </div>
        <div class="max-h-[300px] overflow-y-auto border border-border rounded-lg divide-y divide-border">
          <div v-if="addableUsers.length === 0" class="px-4 py-6 text-center text-sm text-muted-foreground">
            {{ participantSearchQuery ? t('addParticipantModal.noMatching') : t('addParticipantModal.allAdded') }}
          </div>
          <div v-for="user in paginatedAddableUsers" :key="user.id" class="flex items-center justify-between px-4 py-2.5 hover:bg-accent/30 transition-colors">
            <div class="flex items-center gap-2.5">
              <img v-if="user.avatar_url" :src="user.avatar_url" class="w-7 h-7 rounded-full" />
              <div v-else class="w-7 h-7 rounded-full bg-secondary flex items-center justify-center text-[10px] font-semibold text-secondary-foreground">
                {{ user.name.charAt(0) }}
              </div>
              <div>
                <span class="text-sm font-medium text-foreground">{{ user.name }}</span>
                <span v-if="user.mmr" class="text-xs text-muted-foreground ml-2">{{ user.mmr }} MMR</span>
              </div>
            </div>
            <button class="btn-primary text-xs py-1 px-2.5" @click="addParticipant(user.id)">
              <Plus class="w-3 h-3" />
              {{ t('add') }}
            </button>
          </div>
        </div>
        <div v-if="hasMoreAddable" class="py-2 text-center">
          <button class="btn-ghost text-sm text-primary" @click="addParticipantPage++">
            {{ t('showMore', { remaining: addableUsers.length - paginatedAddableUsers.length }) }}
          </button>
        </div>
      </div>
      <div class="px-7 py-4 border-t border-border">
        <button class="btn-secondary w-full justify-center" @click="showAddParticipant = false; participantSearchQuery = ''">{{ t('close') }}</button>
      </div>
    </ModalOverlay>

    <!-- Add Stream Modal -->
    <ModalOverlay :show="showAddStream" @close="showAddStream = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('addStream') }}</h2>
      </div>
      <div class="px-7 py-5 flex flex-col gap-5">
        <InputGroup :label="t('twitchUsername')" :model-value="newStreamUsername" placeholder="username" @update:model-value="newStreamUsername = $event" />
        <InputGroup :label="t('streamTitle')" :model-value="newStreamTitle" :placeholder="t('streamTitlePlaceholder')" @update:model-value="newStreamTitle = $event" />
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" :disabled="!newStreamUsername.trim()" @click="addStream">
          <Plus class="w-4 h-4" />
          {{ t('addStream') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showAddStream = false">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>

    <!-- Edit Captain Modal -->
    <ModalOverlay :show="showEditCaptain" @close="showEditCaptain = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('editCaptainModal.title') }}</h2>
      </div>
      <div class="px-7 py-5 flex flex-col gap-5">
        <InputGroup :label="t('editCaptainModal.teamName')" :model-value="editCaptain.team" placeholder="e.g. Team Secret" @update:model-value="editCaptain.team = $event" />
        <InputGroup :label="t('editCaptainModal.budgetGold')" :model-value="String(editCaptain.budget)" placeholder="1000" @update:model-value="editCaptain.budget = Number($event)" />
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" @click="saveCaptain">
          <Pencil class="w-4 h-4" />
          {{ t('editCaptainModal.save') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showEditCaptain = false">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>

    <!-- Import Participants Modal -->
    <ModalOverlay :show="showImportParticipants" @close="closeImportParticipants">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('importParticipants') }}</h2>
        <p class="text-sm text-muted-foreground mt-1">{{ t('importParticipantsHint') }}</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-4">
        <!-- Input step -->
        <template v-if="importStep === 'input'">
          <textarea
            v-model="importInput"
            class="input-field w-full h-40 font-mono text-xs resize-y"
            :placeholder="t('importSteamPlaceholder')"
          ></textarea>
          <p v-if="importError" class="text-sm text-destructive">{{ importError }}</p>
        </template>

        <!-- Processing / Done step -->
        <template v-if="importStep === 'processing' || importStep === 'done'">
          <div class="flex items-center gap-3">
            <div class="flex-1 h-2 rounded-full bg-accent overflow-hidden">
              <div class="h-full bg-primary rounded-full transition-all duration-300" :style="{ width: `${importTotal > 0 ? (importResults.length / importTotal) * 100 : 0}%` }"></div>
            </div>
            <span class="text-sm font-mono text-muted-foreground flex-shrink-0">{{ importResults.length }}/{{ importTotal }}</span>
          </div>

          <div class="border border-border rounded-lg divide-y divide-border max-h-[300px] overflow-y-auto">
            <div v-for="(r, i) in importResults" :key="i" class="flex items-center justify-between px-3 py-2.5">
              <div class="flex items-center gap-2.5 min-w-0">
                <img v-if="r.avatarUrl" :src="r.avatarUrl" class="w-7 h-7 rounded-full flex-shrink-0" />
                <div v-else class="w-7 h-7 rounded-full bg-secondary flex items-center justify-center text-[10px] font-semibold text-secondary-foreground flex-shrink-0">
                  {{ r.name ? r.name.charAt(0) : '?' }}
                </div>
                <div class="min-w-0">
                  <span class="text-sm font-medium text-foreground truncate block">{{ r.name || r.steamId }}</span>
                  <span class="text-[10px] text-muted-foreground font-mono">{{ r.steamId }}</span>
                </div>
              </div>
              <span class="text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ml-2" :class="{
                'bg-color-success/15 text-color-success': r.status === 'added',
                'bg-accent text-muted-foreground': r.status === 'already_in_pool' || r.status === 'captain',
                'bg-red-500/15 text-red-500': r.status === 'error',
              }">
                {{ r.status === 'added' ? t('importParticipantAdded') : r.status === 'already_in_pool' ? t('alreadyExists') : r.status === 'captain' ? t('captainCol') : t('failed') }}
              </span>
            </div>
            <div v-if="importStep === 'processing'" v-for="i in Math.max(0, importTotal - importResults.length)" :key="'pending-' + i" class="flex items-center gap-2.5 px-3 py-2.5">
              <div class="w-7 h-7 rounded-full bg-accent animate-pulse flex-shrink-0"></div>
              <div class="h-4 w-32 bg-accent animate-pulse rounded"></div>
            </div>
          </div>

          <div v-if="importStep === 'done'" class="text-sm text-muted-foreground text-center">
            {{ t('importParticipantsSummary', {
              added: importResults.filter(r => r.status === 'added').length,
              existing: importResults.filter(r => r.status === 'already_in_pool' || r.status === 'captain').length,
              failed: importResults.filter(r => r.status === 'error').length,
            }) }}
          </div>
        </template>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button v-if="importStep === 'input'" class="btn-primary w-full justify-center" :disabled="!importInput.trim()" @click="importSteamParticipants">
          <Upload class="w-4 h-4" />
          {{ t('importParticipants') }}
        </button>
        <button class="btn-secondary w-full justify-center" :disabled="importStep === 'processing'" @click="closeImportParticipants">{{ t('close') }}</button>
      </div>
    </ModalOverlay>

    <!-- Assign Player to Team Modal -->
    <ModalOverlay :show="showAssignModal" @close="showAssignModal = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('addPlayer') }}</h2>
        <p class="text-sm text-muted-foreground mt-1">{{ t('addPlayerToTeamHint') }}</p>
      </div>
      <div class="px-7 py-4">
        <input class="input-field w-full mb-3" v-model="assignSearch" :placeholder="t('search')" />
        <div class="flex flex-col gap-0.5 max-h-[400px] overflow-y-auto">
          <div v-if="assignablePlayers.length === 0" class="text-sm text-muted-foreground py-4 text-center">
            {{ t('noPlayersFound') }}
          </div>
          <button
            v-for="player in assignablePlayers.slice(0, 50)"
            :key="player.id"
            class="flex items-center gap-3 px-3 py-2 rounded hover:bg-accent/30 text-left transition-colors"
            @click="assignPlayer(player.id)"
          >
            <img v-if="player.avatar_url" :src="player.avatar_url" class="w-7 h-7 rounded-full" />
            <div v-else class="w-7 h-7 rounded-full bg-surface flex items-center justify-center text-xs font-semibold text-muted-foreground">{{ player.name.charAt(0) }}</div>
            <div class="flex flex-col flex-1 min-w-0">
              <span class="text-sm font-medium text-foreground truncate">{{ player.name }}</span>
              <span class="text-[10px] text-muted-foreground">MMR {{ player.mmr }}</span>
            </div>
            <span v-if="player.playing_role" class="text-[9px] font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded">P{{ player.playing_role }}</span>
          </button>
        </div>
      </div>
      <div class="px-7 py-5 border-t border-border">
        <button class="btn-secondary w-full justify-center" @click="showAssignModal = false">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>
    </template>
  </div>
</template>
