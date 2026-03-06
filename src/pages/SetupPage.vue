<script setup lang="ts">
import { Settings, DollarSign, Users, UserPlus, RotateCcw, Play, Trash2, Wifi, Pencil, Link } from 'lucide-vue-next'
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useDraftStore } from '@/composables/useDraftStore'
import { useApi } from '@/composables/useApi'
import ModalOverlay from '@/components/ModalOverlay.vue'
import InputGroup from '@/components/InputGroup.vue'

const store = useDraftStore()
const api = useApi()
const router = useRouter()
const copiedId = ref<number | null>(null)
const showAddCaptain = ref(false)
const showEditCaptain = ref(false)
const showResetConfirm = ref(false)
const saving = ref(false)

const newCaptain = ref({ name: '', team: '', budget: 1000, password: '' })
const editCaptain = ref({ id: 0, name: '', team: '', budget: 1000, password: '' })

async function addCaptain() {
  if (!newCaptain.value.name || !newCaptain.value.team) return
  await store.addCaptain(newCaptain.value)
  newCaptain.value = { name: '', team: '', budget: 1000, password: '' }
  showAddCaptain.value = false
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
  editCaptain.value = { id: captain.id, name: captain.name, team: captain.team, budget: captain.budget, password: '' }
  showEditCaptain.value = true
}

async function saveCaptain() {
  const data: Record<string, any> = {
    name: editCaptain.value.name,
    team: editCaptain.value.team,
    budget: editCaptain.value.budget,
  }
  if (editCaptain.value.password) data.password = editCaptain.value.password
  await store.updateCaptain(editCaptain.value.id, data)
  showEditCaptain.value = false
}

async function copyLoginLink(captainId: number) {
  const { token } = await api.getCaptainLoginToken(captainId)
  const url = `${window.location.origin}/auction?token=${token}`
  await navigator.clipboard.writeText(url)
  copiedId.value = captainId
  setTimeout(() => { copiedId.value = null }, 2000)
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
  store.captains.value.length > 0 && store.captains.value.every(c => store.readyCaptainIds.value.includes(c.id))
)

const readyCount = computed(() => store.readyCaptainIds.value.length)
</script>

<template>
  <div class="p-8 px-10 flex flex-col gap-6">
    <div>
      <h1 class="text-2xl font-semibold text-foreground">Draft Setup</h1>
      <p class="text-sm text-muted-foreground mt-1">Configure your Dota 2 Salary Cap Auction Draft</p>
    </div>

    <!-- Settings -->
    <div class="flex gap-6">
      <div class="card flex-1">
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Settings class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">General Settings</span>
        </div>
        <div class="p-4 flex flex-col gap-4">
          <InputGroup label="Number of Teams" :model-value="String(store.settings.numberOfTeams)" placeholder="8" @update:model-value="store.settings.numberOfTeams = Number($event)" />
          <InputGroup label="Players per Team" :model-value="String(store.settings.playersPerTeam)" placeholder="5" @update:model-value="store.settings.playersPerTeam = Number($event)" />
<InputGroup label="Bid Timer (seconds)" :model-value="String(store.settings.bidTimer)" placeholder="30" @update:model-value="store.settings.bidTimer = Number($event)" />
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
      <div class="flex items-center justify-between px-4 py-3 border-b border-border">
        <div class="flex items-center gap-2">
          <Users class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">Captains &amp; Teams ({{ store.captains.value.length }})</span>
          <span class="inline-flex items-center gap-1.5 ml-2 rounded-full px-2.5 py-0.5 text-xs font-medium bg-color-success text-color-success-foreground">
            <Wifi class="w-3 h-3" />
            {{ onlineCount }} online
          </span>
          <span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium" :class="allCaptainsReady ? 'bg-color-success text-color-success-foreground' : 'bg-accent text-muted-foreground'">
            {{ readyCount }}/{{ store.captains.value.length }} ready
          </span>
        </div>
        <button class="btn-primary text-sm" @click="showAddCaptain = true">
          <UserPlus class="w-4 h-4" />
          Add Captain
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
                  <div class="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-xs font-semibold text-secondary-foreground">
                    {{ captain.name.charAt(0) }}
                  </div>
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
                  <span v-if="isCaptainOnline(captain.id)" class="w-2 h-2 rounded-full bg-green-500" title="Online"></span>
                </div>
              </td>
              <td class="px-4 py-3">
                <div class="flex items-center gap-1">
                  <button class="btn-ghost p-2" :title="copiedId === captain.id ? 'Copied!' : 'Copy Login Link'" @click="copyLoginLink(captain.id)">
                    <Link class="w-4 h-4" :class="copiedId === captain.id ? 'text-green-500' : ''" />
                  </button>
                  <button class="btn-ghost p-2" title="Edit Captain" @click="openEditCaptain(captain)">
                    <Pencil class="w-4 h-4" />
                  </button>
                  <button class="btn-ghost p-2 text-destructive" title="Delete Captain" @click="store.deleteCaptain(captain.id)">
                    <Trash2 class="w-4 h-4" />
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Action Bar -->
    <div class="flex items-center justify-end gap-3">
      <p v-if="!allCaptainsReady" class="text-sm text-muted-foreground mr-2">Waiting for all captains to ready up ({{ readyCount }}/{{ store.captains.value.length }})...</p>
      <button class="btn-outline" @click="showResetConfirm = true">
        <RotateCcw class="w-4 h-4" />
        Reset
      </button>
      <button class="btn-primary" :disabled="!allCaptainsReady" @click="startDraft">
        <Play class="w-4 h-4" />
        Start Draft
      </button>
    </div>

    <!-- Add Captain Modal -->
    <ModalOverlay :show="showAddCaptain" @close="showAddCaptain = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">Add New Captain</h2>
        <p class="text-sm text-muted-foreground mt-1">Set up a captain with their team name, budget and login credentials.</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-5">
        <InputGroup label="Captain Name" :model-value="newCaptain.name" placeholder="e.g. Puppey" @update:model-value="newCaptain.name = $event" />
        <InputGroup label="Team Name" :model-value="newCaptain.team" placeholder="e.g. Team Secret" @update:model-value="newCaptain.team = $event" />
        <InputGroup label="Custom Budget (Gold)" :model-value="String(newCaptain.budget)" placeholder="1000" @update:model-value="newCaptain.budget = Number($event)" />
        <InputGroup label="Login Password" :model-value="newCaptain.password" placeholder="••••••••" type="password" @update:model-value="newCaptain.password = $event" />
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" @click="addCaptain">
          <UserPlus class="w-4 h-4" />
          Add Captain
        </button>
        <button class="btn-secondary w-full justify-center" @click="showAddCaptain = false">
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
        <p class="text-sm text-muted-foreground mt-1">Update captain details. Leave password blank to keep current.</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-5">
        <InputGroup label="Captain Name" :model-value="editCaptain.name" placeholder="e.g. Puppey" @update:model-value="editCaptain.name = $event" />
        <InputGroup label="Team Name" :model-value="editCaptain.team" placeholder="e.g. Team Secret" @update:model-value="editCaptain.team = $event" />
        <InputGroup label="Budget (Gold)" :model-value="String(editCaptain.budget)" placeholder="1000" @update:model-value="editCaptain.budget = Number($event)" />
        <InputGroup label="New Password (optional)" :model-value="editCaptain.password" placeholder="Leave blank to keep current" type="password" @update:model-value="editCaptain.password = $event" />
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
