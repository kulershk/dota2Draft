<script setup lang="ts">
import { Settings, DollarSign, Users, UserPlus, RotateCcw, Play, Pencil, ArrowDown, Wifi, ArrowLeft, Plus, Trash2, Search, Tv } from 'lucide-vue-next'
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

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const api = useApi()
const store = useDraftStore()

const compId = computed(() => Number(route.params.compId))

const showPromote = ref(false)
const showEditCaptain = ref(false)
const showResetConfirm = ref(false)
const showAddParticipant = ref(false)
const saving = ref(false)
const participantSearchQuery = ref('')
const participantTableSearch = ref('')
const participantTablePage = ref(1)
const addParticipantPage = ref(1)
const promoteSearchQuery = ref('')
const PAGE_SIZE = 20

const compName = ref('')
const compDescription = ref('')
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
})

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
  compStatus.value = comp.status || 'draft'
  compIsPublic.value = !!comp.is_public
  compStartsAt.value = comp.starts_at ? new Date(comp.starts_at).toISOString().slice(0, 16) : ''
  compRegStart.value = comp.registration_start ? new Date(comp.registration_start).toISOString().slice(0, 16) : ''
  compRegEnd.value = comp.registration_end ? new Date(comp.registration_end).toISOString().slice(0, 16) : ''
  Object.assign(localSettings, comp.settings)
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
  promoteTeam.value = ''
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
      status: compStatus.value,
      is_public: compIsPublic.value,
      starts_at: compStartsAt.value || null,
      registration_start: compRegStart.value || null,
      registration_end: compRegEnd.value || null,
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
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[1200px] mx-auto w-full">
    <div class="flex items-center gap-3">
      <button class="btn-ghost p-2" @click="router.push('/admin/competitions')">
        <ArrowLeft class="w-4 h-4" />
      </button>
      <div>
        <h1 class="text-2xl font-semibold text-foreground">{{ t('competitionSetup') }}</h1>
        <p class="text-sm text-muted-foreground mt-1">{{ compName || t('loading') }}</p>
      </div>
    </div>

    <!-- Competition Info -->
    <div class="card">
      <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Settings class="w-5 h-5 text-foreground" />
        <span class="text-sm font-semibold text-foreground">{{ t('competitionInfo') }}</span>
      </div>
      <div class="p-4 flex flex-col gap-4">
        <InputGroup :label="t('name')" :model-value="compName" placeholder="Competition name" @update:model-value="compName = $event" />
        <div class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('statusCol') }}</label>
          <select class="input-field" v-model="compStatus">
            <option value="draft">{{ t('statusSetup') }}</option>
            <option value="registration">{{ t('statusRegistrationOpen') }}</option>
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
            <tr v-for="(captain, i) in store.captains.value" :key="captain.id" class="border-b border-border hover:bg-accent/30 transition-colors">
              <td class="px-4 py-3 text-muted-foreground">{{ String(i + 1).padStart(2, '0') }}</td>
              <td class="px-4 py-3">
                <div class="flex items-center gap-2.5">
                  <img v-if="captain.avatar_url" :src="captain.avatar_url" class="w-8 h-8 rounded-full" />
                  <CaptainAvatar v-else :name="captain.name" :online="isCaptainOnline(captain.id)" />
                  <span class="font-medium text-foreground">{{ captain.name }}</span>
                </div>
              </td>
              <td class="px-4 py-3 text-foreground">{{ captain.team }}</td>
              <td class="px-4 py-3 font-mono text-foreground">{{ formatGold(captain.budget) }}</td>
              <td class="px-4 py-3">
                <span v-if="isCaptainReady(captain.id)" class="badge-ready">{{ t('ready') }}</span>
                <span v-else-if="isCaptainOnline(captain.id)" class="badge-waiting">{{ t('waiting') }}</span>
                <span v-else class="badge-waiting">{{ t('offline') }}</span>
              </td>
              <td class="px-4 py-3">
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
              @click="promotePlayerId = p.id"
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
  </div>
</template>
