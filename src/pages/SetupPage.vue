<script setup lang="ts">
import { Settings, DollarSign, Users, UserPlus, RotateCcw, Play, Trash2, Wifi, Pencil, ArrowDown } from 'lucide-vue-next'
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useDraftStore } from '@/composables/useDraftStore'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import InputGroup from '@/components/common/InputGroup.vue'
import CaptainAvatar from '@/components/common/CaptainAvatar.vue'

const store = useDraftStore()
const router = useRouter()
const showPromote = ref(false)
const showEditCaptain = ref(false)
const showResetConfirm = ref(false)
const saving = ref(false)

const promotePlayerId = ref<number | null>(null)
const promoteTeam = ref('')
const editCaptain = ref({ id: 0, team: '', budget: 1000 })

// Players eligible for promotion (Steam-registered, not already captains)
const promotablePlayers = computed(() =>
  store.players.value.filter(p => p.steam_id && !p.is_captain)
)

async function handlePromote() {
  if (!promotePlayerId.value || !promoteTeam.value) return
  await store.promoteToCaptain(promotePlayerId.value, promoteTeam.value)
  promotePlayerId.value = null
  promoteTeam.value = ''
  showPromote.value = false
}

async function saveSettings() {
  saving.value = true
  await store.saveSettings()
  saving.value = false
}

function startDraft() {
  store.startDraft()
  router.push('/auction')
}

function openEditCaptain(captain: any) {
  editCaptain.value = { id: captain.id, team: captain.team, budget: captain.budget }
  showEditCaptain.value = true
}

async function saveCaptain() {
  await store.updateCaptain(editCaptain.value.id, {
    team: editCaptain.value.team,
    budget: editCaptain.value.budget,
  })
  showEditCaptain.value = false
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
  store.captains.value.length > 0 && (!store.settings.requireAllOnline || store.captains.value.every(c => store.readyCaptainIds.value.includes(c.id)))
)

const readyCount = computed(() => store.readyCaptainIds.value.length)
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[1200px] mx-auto w-full">
    <div>
      <h1 class="text-2xl font-semibold text-foreground">Draft Setup</h1>
      <p class="text-sm text-muted-foreground mt-1">Configure your Dota 2 Salary Cap Auction Draft</p>
    </div>

    <!-- Settings -->
    <div class="flex flex-col md:flex-row gap-4 md:gap-6">
      <div class="card flex-1">
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Settings class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">General Settings</span>
        </div>
        <div class="p-4 flex flex-col gap-4">
          <InputGroup label="Players per Team" :model-value="String(store.settings.playersPerTeam)" placeholder="5" @update:model-value="store.settings.playersPerTeam = Number($event)" :hint="`1 captain + ${store.settings.playersPerTeam} drafted = ${store.settings.playersPerTeam + 1} total per team`" />
          <InputGroup label="Bid Timer (seconds)" :model-value="String(store.settings.bidTimer)" placeholder="30" @update:model-value="store.settings.bidTimer = Number($event)" />
          <div class="flex flex-col gap-1.5">
            <label class="label-text">Nomination Order</label>
            <select class="input-field" :value="store.settings.nominationOrder" @change="store.settings.nominationOrder = ($event.target as HTMLSelectElement).value">
              <option value="normal">Normal (Round Robin)</option>
              <option value="lowest_avg">Lowest Average MMR First</option>
              <option value="fewest_then_lowest">Fewest Players, then Lowest Avg MMR</option>
            </select>
          </div>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" class="w-4 h-4 accent-primary" :checked="store.settings.requireAllOnline" @change="store.settings.requireAllOnline = ($event.target as HTMLInputElement).checked; saveSettings()" />
            <span class="text-sm text-foreground">Require all captains online to nominate</span>
          </label>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" class="w-4 h-4 accent-primary" :checked="store.settings.allowSteamRegistration" @change="store.settings.allowSteamRegistration = ($event.target as HTMLInputElement).checked; saveSettings()" />
            <span class="text-sm text-foreground">Allow players to register via Steam login</span>
          </label>
        </div>
      </div>

      <div class="card flex-1">
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
          <DollarSign class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">Budget Settings</span>
        </div>
        <div class="p-4 flex flex-col gap-4">
          <InputGroup label="Starting Budget (Gold)" :model-value="String(store.settings.startingBudget)" placeholder="1000" @update:model-value="store.settings.startingBudget = Number($event)" />
          <InputGroup label="Minimum Starting Bid" :model-value="String(store.settings.minimumBid)" placeholder="10" @update:model-value="store.settings.minimumBid = Number($event)" />
          <InputGroup label="Bid Increment" :model-value="String(store.settings.bidIncrement)" placeholder="5" @update:model-value="store.settings.bidIncrement = Number($event)" />
          <InputGroup label="Max Bid (0 = no limit)" :model-value="String(store.settings.maxBid)" placeholder="0" @update:model-value="store.settings.maxBid = Number($event)" />
        </div>
      </div>
    </div>

    <!-- Save Settings Button -->
    <div class="flex justify-end">
      <button class="btn-outline text-sm" :disabled="saving" @click="saveSettings">
        {{ saving ? 'Saving...' : 'Save Settings' }}
      </button>
    </div>

    <!-- Captains & Teams -->
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

      <div class="overflow-x-auto">
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
            <tr
              v-for="(captain, i) in store.captains.value"
              :key="captain.id"
              class="border-b border-border hover:bg-accent/30 transition-colors"
            >
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
                <div class="flex items-center gap-2">
                  <span v-if="isCaptainReady(captain.id)" class="badge-ready">Ready</span>
                  <span v-else-if="isCaptainOnline(captain.id)" class="badge-waiting">Waiting</span>
                  <span v-else class="badge-waiting">Offline</span>
                </div>
              </td>
              <td class="px-4 py-3">
                <div class="flex items-center gap-1">
                  <button class="btn-ghost p-2" title="Edit Captain" @click="openEditCaptain(captain)">
                    <Pencil class="w-4 h-4" />
                  </button>
                  <button class="btn-ghost p-2 text-destructive" title="Demote to Player" @click="store.demoteCaptain(captain.id)">
                    <ArrowDown class="w-4 h-4" />
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
      <p v-if="!allCaptainsReady" class="text-sm text-muted-foreground mr-2">Waiting for all captains to ready up ({{ readyCount }}/{{ store.captains.value.length }})...</p>
      <button class="btn-outline" @click="showResetConfirm = true">
        <RotateCcw class="w-4 h-4" />
        Reset
      </button>
      <button v-if="store.auction.status === 'idle'" class="btn-primary" :disabled="!allCaptainsReady" @click="startDraft">
        <Play class="w-4 h-4" />
        Start Draft
      </button>
    </div>

    <!-- Promote Player Modal -->
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
        <button class="btn-secondary w-full justify-center" @click="showPromote = false">
          Cancel
        </button>
      </div>
    </ModalOverlay>

    <!-- Reset Confirmation Modal -->
    <ModalOverlay :show="showResetConfirm" @close="showResetConfirm = false">
      <div class="px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">Reset Draft</h2>
        <p class="text-sm text-muted-foreground mt-2">This will reset <span class="font-semibold text-foreground">everything</span>: all captain budgets, drafted players, bid history, and auction state. This action cannot be undone.</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-destructive w-full justify-center" @click="store.resetDraft(); showResetConfirm = false">
          <RotateCcw class="w-4 h-4" />
          Yes, Reset Everything
        </button>
        <button class="btn-secondary w-full justify-center" @click="showResetConfirm = false">
          Cancel
        </button>
      </div>
    </ModalOverlay>

    <!-- Edit Captain Modal -->
    <ModalOverlay :show="showEditCaptain" @close="showEditCaptain = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">Edit Captain</h2>
        <p class="text-sm text-muted-foreground mt-1">Update captain's team name and budget.</p>
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
        <button class="btn-secondary w-full justify-center" @click="showEditCaptain = false">
          Cancel
        </button>
      </div>
    </ModalOverlay>
  </div>
</template>
