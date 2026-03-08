<script setup lang="ts">
import { Settings, DollarSign, Users, UserPlus, RotateCcw, Play, Pencil, ArrowDown, Wifi, ArrowLeft, Plus, Trash2, Search } from 'lucide-vue-next'
import { ref, computed, onMounted, reactive } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import InputGroup from '@/components/common/InputGroup.vue'
import CaptainAvatar from '@/components/common/CaptainAvatar.vue'
import RichTextEditor from '@/components/common/RichTextEditor.vue'

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

const compName = ref('')
const compDescription = ref('')
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
  compStartsAt.value = comp.starts_at ? new Date(comp.starts_at).toISOString().slice(0, 16) : ''
  compRegStart.value = comp.registration_start ? new Date(comp.registration_start).toISOString().slice(0, 16) : ''
  compRegEnd.value = comp.registration_end ? new Date(comp.registration_end).toISOString().slice(0, 16) : ''
  Object.assign(localSettings, comp.settings)
  // Load all users for promote
  allUsers.value = await api.getUsers()
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
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[1200px] mx-auto w-full">
    <div class="flex items-center gap-3">
      <button class="btn-ghost p-2" @click="router.push('/admin/competitions')">
        <ArrowLeft class="w-4 h-4" />
      </button>
      <div>
        <h1 class="text-2xl font-semibold text-foreground">Competition Setup</h1>
        <p class="text-sm text-muted-foreground mt-1">{{ compName || 'Loading...' }}</p>
      </div>
    </div>

    <!-- Competition Info -->
    <div class="card">
      <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Settings class="w-5 h-5 text-foreground" />
        <span class="text-sm font-semibold text-foreground">Competition Info</span>
      </div>
      <div class="p-4 flex flex-col gap-4">
        <InputGroup label="Name" :model-value="compName" placeholder="Competition name" @update:model-value="compName = $event" />
        <div class="flex flex-col gap-1.5">
          <label class="label-text">Description</label>
          <RichTextEditor v-model="compDescription" />
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div class="flex flex-col gap-1.5">
            <label class="label-text">Registration Start</label>
            <input type="datetime-local" class="input-field" :value="compRegStart" @input="compRegStart = ($event.target as HTMLInputElement).value" />
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="label-text">Registration End</label>
            <input type="datetime-local" class="input-field" :value="compRegEnd" @input="compRegEnd = ($event.target as HTMLInputElement).value" />
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="label-text">Draft Start Date</label>
            <input type="datetime-local" class="input-field" :value="compStartsAt" @input="compStartsAt = ($event.target as HTMLInputElement).value" />
          </div>
        </div>
      </div>
    </div>

    <!-- Settings -->
    <div class="flex flex-col md:flex-row gap-4 md:gap-6">
      <div class="card flex-1">
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Settings class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">General Settings</span>
        </div>
        <div class="p-4 flex flex-col gap-4">
          <InputGroup label="Players per Team" :model-value="String(localSettings.playersPerTeam)" placeholder="5" @update:model-value="localSettings.playersPerTeam = Number($event)" :hint="`1 captain + ${localSettings.playersPerTeam} drafted = ${localSettings.playersPerTeam + 1} total per team`" />
          <InputGroup label="Bid Timer (seconds)" :model-value="String(localSettings.bidTimer)" placeholder="30" @update:model-value="localSettings.bidTimer = Number($event)" />
          <div class="flex flex-col gap-1.5">
            <label class="label-text">Nomination Order</label>
            <select class="input-field" :value="localSettings.nominationOrder" @change="localSettings.nominationOrder = ($event.target as HTMLSelectElement).value">
              <option value="normal">Normal (Round Robin)</option>
              <option value="lowest_avg">Lowest Average MMR First</option>
              <option value="fewest_then_lowest">Fewest Players, then Lowest Avg MMR</option>
            </select>
          </div>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" class="w-4 h-4 accent-primary" v-model="localSettings.requireAllOnline" />
            <span class="text-sm text-foreground">Require all captains online to nominate</span>
          </label>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" class="w-4 h-4 accent-primary" v-model="localSettings.allowSteamRegistration" />
            <span class="text-sm text-foreground">Allow players to self-register</span>
          </label>
        </div>
      </div>

      <div class="card flex-1">
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
          <DollarSign class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">Budget Settings</span>
        </div>
        <div class="p-4 flex flex-col gap-4">
          <InputGroup label="Starting Budget (Gold)" :model-value="String(localSettings.startingBudget)" placeholder="1000" @update:model-value="localSettings.startingBudget = Number($event)" />
          <InputGroup label="Minimum Starting Bid" :model-value="String(localSettings.minimumBid)" placeholder="10" @update:model-value="localSettings.minimumBid = Number($event)" />
          <InputGroup label="Bid Increment" :model-value="String(localSettings.bidIncrement)" placeholder="5" @update:model-value="localSettings.bidIncrement = Number($event)" />
          <InputGroup label="Max Bid (0 = no limit)" :model-value="String(localSettings.maxBid)" placeholder="0" @update:model-value="localSettings.maxBid = Number($event)" />
        </div>
      </div>
    </div>

    <!-- Save -->
    <div class="flex justify-end">
      <button class="btn-outline text-sm" :disabled="saving" @click="saveAll">
        {{ saving ? 'Saving...' : 'Save Settings' }}
      </button>
    </div>

    <!-- Captains -->
    <div class="card">
      <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 px-4 py-3 border-b border-border">
        <div class="flex items-center gap-2 flex-wrap">
          <Users class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">Captains &amp; Teams ({{ store.captains.value.length }})</span>
          <span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium bg-color-success text-color-success-foreground">
            <Wifi class="w-3 h-3" />
            {{ onlineCount }} online
          </span>
          <span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium" :class="allCaptainsReady ? 'bg-color-success text-color-success-foreground' : 'bg-accent text-muted-foreground'">
            {{ readyCount }}/{{ store.captains.value.length }} ready
          </span>
        </div>
        <button class="btn-primary text-sm" @click="showPromote = true" :disabled="promotablePlayers.length === 0">
          <UserPlus class="w-4 h-4" />
          Promote to Captain
        </button>
      </div>

      <div v-if="store.captains.value.length === 0" class="px-4 py-8 text-center text-sm text-muted-foreground">
        No captains yet. Promote a participant or any registered user.
      </div>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border bg-accent/50">
              <th class="text-left px-4 py-3 font-medium text-muted-foreground w-[40px]">#</th>
              <th class="text-left px-4 py-3 font-medium text-muted-foreground">CAPTAIN</th>
              <th class="text-left px-4 py-3 font-medium text-muted-foreground">TEAM NAME</th>
              <th class="text-left px-4 py-3 font-medium text-muted-foreground w-[120px]">BUDGET</th>
              <th class="text-left px-4 py-3 font-medium text-muted-foreground w-[100px]">STATUS</th>
              <th class="text-left px-4 py-3 font-medium text-muted-foreground w-[100px]">ACTIONS</th>
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
                <span v-if="isCaptainReady(captain.id)" class="badge-ready">Ready</span>
                <span v-else-if="isCaptainOnline(captain.id)" class="badge-waiting">Waiting</span>
                <span v-else class="badge-waiting">Offline</span>
              </td>
              <td class="px-4 py-3">
                <div class="flex items-center gap-1">
                  <button class="btn-ghost p-2" title="Edit Captain" @click="openEditCaptain(captain)">
                    <Pencil class="w-4 h-4" />
                  </button>
                  <button class="btn-ghost p-2 text-destructive" title="Demote to Player" @click="handleDemote(captain.id)">
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
          <span class="text-sm font-semibold text-foreground">Participants ({{ store.players.value.filter(p => !p.is_captain).length }})</span>
        </div>
        <button class="btn-primary text-sm" @click="showAddParticipant = true">
          <Plus class="w-4 h-4" />
          Add Participant
        </button>
      </div>

      <div v-if="store.players.value.filter(p => !p.is_captain).length === 0" class="px-4 py-8 text-center text-sm text-muted-foreground">
        No participants yet. Add users or let them self-register.
      </div>
      <div v-else class="overflow-x-auto max-h-[400px] overflow-y-auto">
        <table class="w-full text-sm">
          <thead class="sticky top-0 bg-card">
            <tr class="border-b border-border bg-accent/50">
              <th class="text-left px-4 py-2.5 font-medium text-muted-foreground w-[40px]">#</th>
              <th class="text-left px-4 py-2.5 font-medium text-muted-foreground">PLAYER</th>
              <th class="text-left px-4 py-2.5 font-medium text-muted-foreground">ROLES</th>
              <th class="text-left px-4 py-2.5 font-medium text-muted-foreground w-[80px]">MMR</th>
              <th class="text-left px-4 py-2.5 font-medium text-muted-foreground w-[100px]">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(player, i) in store.players.value.filter(p => !p.is_captain)" :key="player.id" class="border-b border-border hover:bg-accent/30 transition-colors">
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
                  <button class="btn-ghost p-1.5" title="Promote to Captain" @click="promptPromoteParticipant(player)">
                    <UserPlus class="w-3.5 h-3.5" />
                  </button>
                  <button class="btn-ghost p-1.5 text-destructive" title="Remove" @click="removeParticipant(player.id)">
                    <Trash2 class="w-3.5 h-3.5" />
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Action Bar -->
    <div class="flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-3">
      <p v-if="!allCaptainsReady && store.captains.value.length > 0" class="text-sm text-muted-foreground mr-2">
        Waiting for all captains to ready up ({{ readyCount }}/{{ store.captains.value.length }})...
      </p>
      <button class="btn-outline" @click="showResetConfirm = true">
        <RotateCcw class="w-4 h-4" />
        Reset
      </button>
      <button v-if="store.auction.status === 'idle'" class="btn-primary" :disabled="!allCaptainsReady" @click="startDraft">
        <Play class="w-4 h-4" />
        Start Draft
      </button>
    </div>

    <!-- Promote Modal -->
    <ModalOverlay :show="showPromote" @close="showPromote = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">Promote Player to Captain</h2>
        <p class="text-sm text-muted-foreground mt-1">Select a registered player to promote as a captain.</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-5">
        <div class="flex flex-col gap-1.5">
          <label class="label-text">Select Player</label>
          <select class="input-field" :value="promotePlayerId || ''" @change="promotePlayerId = Number(($event.target as HTMLSelectElement).value) || null">
            <option value="">Choose a player...</option>
            <option v-for="p in promotablePlayers" :key="p.id" :value="p.id">{{ p.name }} ({{ p.mmr }} MMR)</option>
          </select>
        </div>
        <InputGroup label="Team Name" :model-value="promoteTeam" placeholder="e.g. Team Secret" @update:model-value="promoteTeam = $event" />
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" :disabled="!promotePlayerId || !promoteTeam" @click="handlePromote">
          <UserPlus class="w-4 h-4" />
          Promote to Captain
        </button>
        <button class="btn-secondary w-full justify-center" @click="showPromote = false">Cancel</button>
      </div>
    </ModalOverlay>

    <!-- Reset Confirmation -->
    <ModalOverlay :show="showResetConfirm" @close="showResetConfirm = false">
      <div class="px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">Reset Draft</h2>
        <p class="text-sm text-muted-foreground mt-2">This will reset all captain budgets, drafted players, bid history, and auction state for this competition.</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-destructive w-full justify-center" @click="store.resetDraft(); showResetConfirm = false">
          <RotateCcw class="w-4 h-4" />
          Yes, Reset Everything
        </button>
        <button class="btn-secondary w-full justify-center" @click="showResetConfirm = false">Cancel</button>
      </div>
    </ModalOverlay>

    <!-- Add Participant Modal -->
    <ModalOverlay :show="showAddParticipant" @close="showAddParticipant = false; participantSearchQuery = ''">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">Add Participant</h2>
        <p class="text-sm text-muted-foreground mt-1">Select registered users to add as participants in this competition.</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-4">
        <div class="relative">
          <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input v-model="participantSearchQuery" type="text" placeholder="Search users..." class="input-field pl-9 w-full" />
        </div>
        <div class="max-h-[300px] overflow-y-auto border border-border rounded-lg divide-y divide-border">
          <div v-if="addableUsers.length === 0" class="px-4 py-6 text-center text-sm text-muted-foreground">
            {{ participantSearchQuery ? 'No matching users found.' : 'All users are already participants or captains.' }}
          </div>
          <div v-for="user in addableUsers" :key="user.id" class="flex items-center justify-between px-4 py-2.5 hover:bg-accent/30 transition-colors">
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
              Add
            </button>
          </div>
        </div>
      </div>
      <div class="px-7 py-4 border-t border-border">
        <button class="btn-secondary w-full justify-center" @click="showAddParticipant = false; participantSearchQuery = ''">Close</button>
      </div>
    </ModalOverlay>

    <!-- Edit Captain Modal -->
    <ModalOverlay :show="showEditCaptain" @close="showEditCaptain = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">Edit Captain</h2>
      </div>
      <div class="px-7 py-5 flex flex-col gap-5">
        <InputGroup label="Team Name" :model-value="editCaptain.team" placeholder="e.g. Team Secret" @update:model-value="editCaptain.team = $event" />
        <InputGroup label="Budget (Gold)" :model-value="String(editCaptain.budget)" placeholder="1000" @update:model-value="editCaptain.budget = Number($event)" />
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" @click="saveCaptain">
          <Pencil class="w-4 h-4" />
          Save Changes
        </button>
        <button class="btn-secondary w-full justify-center" @click="showEditCaptain = false">Cancel</button>
      </div>
    </ModalOverlay>
  </div>
</template>
