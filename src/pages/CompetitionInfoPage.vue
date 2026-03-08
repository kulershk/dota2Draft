<script setup lang="ts">
import { Calendar, Users, User, Gavel, Trophy, Clock, Settings, DollarSign, Upload, X } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import { useDraftStore } from '@/composables/useDraftStore'
import { useApi } from '@/composables/useApi'

const store = useDraftStore()
const api = useApi()
const uploading = ref(false)

const comp = computed(() => store.currentCompetition.value)

const auctionStatus = computed(() => {
  const s = comp.value?.auction_state?.status || 'idle'
  if (s === 'finished') return 'Completed'
  if (['nominating', 'bidding', 'paused'].includes(s)) return 'In Progress'
  return 'Not Started'
})

const auctionStatusClass = computed(() => {
  const s = comp.value?.auction_state?.status || 'idle'
  if (s === 'finished') return 'bg-yellow-500/20 text-yellow-600 dark:text-yellow-400'
  if (['nominating', 'bidding', 'paused'].includes(s)) return 'bg-color-success text-color-success-foreground'
  return 'bg-accent text-muted-foreground'
})

const registrationStatus = computed(() => {
  if (!comp.value) return { label: '—', open: false }
  const now = new Date()
  if (comp.value.registration_start && new Date(comp.value.registration_start) > now) {
    return { label: 'Not Yet Open', open: false }
  }
  if (comp.value.registration_end && new Date(comp.value.registration_end) < now) {
    return { label: 'Closed', open: false }
  }
  if (comp.value.registration_start || comp.value.registration_end) {
    return { label: 'Open', open: true }
  }
  return { label: 'Open', open: true }
})

const participantCount = computed(() => store.players.value.filter(p => !p.is_captain).length)
const captainCount = computed(() => store.captains.value.length)

function formatDate(dateStr: string | null) {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const myCaptain = computed(() => {
  if (!store.currentUser.value) return null
  return store.captains.value.find(c => c.player_id === store.currentUser.value!.id) || null
})

function canEditBanner(captain: any) {
  if (!store.currentUser.value) return false
  return captain.player_id === store.currentUser.value.id || store.isAdmin.value
}

async function uploadBanner(captain: any, event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || !store.currentCompetitionId.value) return
  uploading.value = true
  try {
    await api.uploadCaptainBanner(store.currentCompetitionId.value, captain.id, file)
    await store.fetchCaptains()
  } finally {
    uploading.value = false
    input.value = ''
  }
}

async function removeBanner(captain: any) {
  if (!store.currentCompetitionId.value) return
  await api.deleteCaptainBanner(store.currentCompetitionId.value, captain.id)
  await store.fetchCaptains()
}
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-5 md:gap-6 max-w-[1200px] mx-auto w-full">
    <div v-if="!comp" class="text-center py-12 text-muted-foreground">Loading...</div>

    <template v-else>
      <!-- Header -->
      <div>
        <div class="flex items-center gap-3 flex-wrap">
          <h1 class="text-2xl md:text-3xl font-bold text-foreground">{{ comp.name }}</h1>
          <span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium" :class="auctionStatusClass">
            {{ auctionStatus }}
          </span>
          <span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium"
            :class="registrationStatus.open ? 'bg-color-success text-color-success-foreground' : 'bg-accent text-muted-foreground'">
            Registration {{ registrationStatus.label }}
          </span>
        </div>
        <div v-if="comp.created_by_name" class="flex items-center gap-1.5 mt-2 text-sm text-muted-foreground">
          <img v-if="comp.created_by_avatar" :src="comp.created_by_avatar" class="w-5 h-5 rounded-full" />
          <User v-else class="w-4 h-4" />
          <span>Created by <span class="font-medium text-foreground">{{ comp.created_by_name }}</span></span>
          <span class="mx-1">&middot;</span>
          <span>{{ formatDate(comp.created_at) }}</span>
        </div>
      </div>

      <!-- Description -->
      <div v-if="comp.description" class="card">
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
          <span class="text-sm font-semibold text-foreground">About</span>
        </div>
        <div class="p-4 md:p-6 prose prose-sm dark:prose-invert max-w-none text-foreground/80" v-html="comp.description"></div>
      </div>

      <!-- Stats -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
        <div class="card p-4">
          <div class="flex items-center gap-2 text-muted-foreground mb-1">
            <Users class="w-4 h-4" />
            <p class="text-xs font-semibold tracking-wider uppercase">Participants</p>
          </div>
          <p class="text-2xl font-bold text-foreground">{{ participantCount }}</p>
        </div>
        <div class="card p-4">
          <div class="flex items-center gap-2 text-muted-foreground mb-1">
            <Trophy class="w-4 h-4" />
            <p class="text-xs font-semibold tracking-wider uppercase">Captains</p>
          </div>
          <p class="text-2xl font-bold text-foreground">{{ captainCount }}</p>
        </div>
        <div class="card p-4">
          <div class="flex items-center gap-2 text-muted-foreground mb-1">
            <DollarSign class="w-4 h-4" />
            <p class="text-xs font-semibold tracking-wider uppercase">Budget</p>
          </div>
          <p class="text-2xl font-bold text-foreground">{{ store.settings.startingBudget.toLocaleString() }}g</p>
        </div>
        <div class="card p-4">
          <div class="flex items-center gap-2 text-muted-foreground mb-1">
            <Settings class="w-4 h-4" />
            <p class="text-xs font-semibold tracking-wider uppercase">Per Team</p>
          </div>
          <p class="text-2xl font-bold text-foreground">{{ store.settings.playersPerTeam + 1 }}</p>
          <p class="text-xs text-muted-foreground">1 captain + {{ store.settings.playersPerTeam }} drafted</p>
        </div>
      </div>

      <!-- Dates -->
      <div class="card">
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Calendar class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">Schedule</span>
        </div>
        <div class="p-4 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <p class="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Registration Opens</p>
            <p class="text-sm text-foreground mt-1">{{ formatDate(comp.registration_start) }}</p>
          </div>
          <div>
            <p class="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Registration Closes</p>
            <p class="text-sm text-foreground mt-1">{{ formatDate(comp.registration_end) }}</p>
          </div>
          <div>
            <p class="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Draft Starts</p>
            <p class="text-sm text-foreground mt-1">{{ formatDate(comp.starts_at) }}</p>
          </div>
        </div>
      </div>

      <!-- Draft Settings -->
      <div class="card">
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Gavel class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">Draft Settings</span>
        </div>
        <div class="p-4 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3">
          <div>
            <p class="text-xs text-muted-foreground">Bid Timer</p>
            <p class="text-sm font-medium text-foreground">{{ store.settings.bidTimer }}s</p>
          </div>
          <div>
            <p class="text-xs text-muted-foreground">Minimum Bid</p>
            <p class="text-sm font-medium text-foreground">{{ store.settings.minimumBid }}g</p>
          </div>
          <div>
            <p class="text-xs text-muted-foreground">Bid Increment</p>
            <p class="text-sm font-medium text-foreground">{{ store.settings.bidIncrement }}g</p>
          </div>
          <div>
            <p class="text-xs text-muted-foreground">Max Bid</p>
            <p class="text-sm font-medium text-foreground">{{ store.settings.maxBid ? store.settings.maxBid + 'g' : 'No limit' }}</p>
          </div>
          <div>
            <p class="text-xs text-muted-foreground">Nomination Order</p>
            <p class="text-sm font-medium text-foreground">{{ store.settings.nominationOrder === 'normal' ? 'Round Robin' : store.settings.nominationOrder === 'lowest_avg' ? 'Lowest Avg MMR' : 'Fewest Players First' }}</p>
          </div>
          <div>
            <p class="text-xs text-muted-foreground">Require All Online</p>
            <p class="text-sm font-medium text-foreground">{{ store.settings.requireAllOnline ? 'Yes' : 'No' }}</p>
          </div>
          <div>
            <p class="text-xs text-muted-foreground">Self Registration</p>
            <p class="text-sm font-medium text-foreground">{{ store.settings.allowSteamRegistration ? 'Allowed' : 'Disabled' }}</p>
          </div>
        </div>
      </div>

      <!-- Captains Preview -->
      <div v-if="store.captains.value.length > 0" class="card">
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Trophy class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">Captains ({{ captainCount }})</span>
        </div>
        <div class="p-4 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
          <div v-for="captain in store.captains.value" :key="captain.id" class="rounded-lg bg-accent/30 border border-border overflow-hidden">
            <!-- Banner -->
            <div class="relative">
              <img v-if="captain.banner_url" :src="captain.banner_url" class="w-full h-24 object-cover" />
              <div v-else class="w-full h-24 bg-gradient-to-br from-primary/10 to-primary/5"></div>
              <!-- Upload/remove controls for captain owner or admin -->
              <div v-if="canEditBanner(captain)" class="absolute top-1.5 right-1.5 flex gap-1">
                <label class="p-1 rounded bg-background/80 backdrop-blur-sm cursor-pointer hover:bg-background transition-colors" title="Upload banner">
                  <Upload class="w-3.5 h-3.5 text-foreground" />
                  <input type="file" accept="image/*" class="hidden" @change="uploadBanner(captain, $event)" :disabled="uploading" />
                </label>
                <button v-if="captain.banner_url" class="p-1 rounded bg-background/80 backdrop-blur-sm hover:bg-background transition-colors" title="Remove banner" @click="removeBanner(captain)">
                  <X class="w-3.5 h-3.5 text-destructive" />
                </button>
              </div>
            </div>
            <!-- Captain info -->
            <div class="flex items-center gap-3 p-3">
              <img v-if="captain.avatar_url" :src="captain.avatar_url" class="w-9 h-9 rounded-full" />
              <div v-else class="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">
                {{ captain.name.charAt(0) }}
              </div>
              <div class="min-w-0">
                <p class="text-sm font-semibold text-foreground truncate">{{ captain.team }}</p>
                <p class="text-xs text-muted-foreground truncate">{{ captain.name }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
