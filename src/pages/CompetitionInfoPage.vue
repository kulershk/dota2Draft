<script setup lang="ts">
import { Calendar, Users, User, Gavel, Trophy, Clock, Settings, DollarSign, Upload, X, Tv } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useDraftStore } from '@/composables/useDraftStore'
import { useApi } from '@/composables/useApi'
import ImageCropper from '@/components/common/ImageCropper.vue'

const { t } = useI18n()
const route = useRoute()
const store = useDraftStore()
const api = useApi()
const uploading = ref(false)

const compId = computed(() => Number(route.params.compId))
const comp = computed(() => store.currentCompetition.value)

const compStatusLabels = computed<Record<string, string>>(() => ({
  draft: t('statusSetup'),
  registration: t('statusRegistrationOpen'),
  active: t('statusInProgress'),
  finished: t('statusFinished'),
}))

const compStatusClasses: Record<string, string> = {
  draft: 'bg-accent text-muted-foreground',
  registration: 'bg-primary/10 text-primary',
  active: 'bg-color-success text-color-success-foreground',
  finished: 'bg-yellow-500/20 text-yellow-600 dark:text-yellow-400',
}

function getCompStatus(c: any) {
  const auc = c?.auction_state?.status || 'idle'
  if (['nominating', 'bidding', 'paused'].includes(auc)) return 'active'
  return c?.status || 'draft'
}

const displayStatus = computed(() => getCompStatus(comp.value))
const auctionStatus = computed(() => compStatusLabels.value[displayStatus.value] || t('statusSetup'))
const auctionStatusClass = computed(() => compStatusClasses[displayStatus.value] || compStatusClasses.draft)

const registrationStatus = computed(() => {
  if (!comp.value) return { label: '—', open: false }
  const now = new Date()
  if (comp.value.registration_start && new Date(comp.value.registration_start) > now) {
    return { label: t('registrationNotYetOpen'), open: false }
  }
  if (comp.value.registration_end && new Date(comp.value.registration_end) < now) {
    return { label: t('registrationClosed'), open: false }
  }
  if (comp.value.registration_start || comp.value.registration_end) {
    return { label: t('registrationOpen'), open: true }
  }
  return { label: t('registrationOpen'), open: true }
})

const participantCount = computed(() => store.players.value.length)
const captainCount = computed(() => store.captains.value.length)

function formatDate(dateStr: string | null) {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// Streams
const streams = ref<any[]>([])

watch(compId, async (id) => {
  if (!id) return
  try {
    streams.value = await api.getCompStreamsLive(id)
  } catch { }
}, { immediate: true })

const myCaptain = computed(() => {
  if (!store.currentUser.value) return null
  return store.captains.value.find(c => c.player_id === store.currentUser.value!.id) || null
})

function canEditBanner(captain: any) {
  if (!store.currentUser.value) return false
  return captain.player_id === store.currentUser.value.id || store.isAdmin.value
}

const showCropper = ref(false)
const cropFile = ref<File | null>(null)
const cropCaptainId = ref<number>(0)

function openCropper(captain: any, event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  cropFile.value = file
  cropCaptainId.value = captain.id
  showCropper.value = true
  input.value = ''
}

async function handleCrop(blob: Blob) {
  if (!store.currentCompetitionId.value) return
  uploading.value = true
  showCropper.value = false
  try {
    const file = new File([blob], 'logo.png', { type: 'image/png' })
    await api.uploadCaptainBanner(store.currentCompetitionId.value, cropCaptainId.value, file)
    await store.fetchCaptains()
  } finally {
    uploading.value = false
    cropFile.value = null
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
    <div v-if="!comp" class="text-center py-12 text-muted-foreground">{{ t('loading') }}</div>

    <template v-else>
      <!-- Header -->
      <div>
        <div class="flex items-center gap-3 flex-wrap">
          <h1 class="text-2xl md:text-3xl font-bold text-foreground">{{ comp.name }}</h1>
          <span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium" :class="auctionStatusClass">
            {{ auctionStatus }}
          </span>
          <span v-if="displayStatus !== 'registration'" class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium"
            :class="registrationStatus.open ? 'bg-color-success text-color-success-foreground' : 'bg-accent text-muted-foreground'">
            {{ t('registrationLabel') }} {{ registrationStatus.label }}
          </span>
        </div>
        <div v-if="comp.created_by_name" class="flex items-center gap-1.5 mt-2 text-sm text-muted-foreground">
          <img v-if="comp.created_by_avatar" :src="comp.created_by_avatar" class="w-5 h-5 rounded-full" />
          <User v-else class="w-4 h-4" />
          <span>{{ t('createdBy') }} <span class="font-medium text-foreground">{{ comp.created_by_name }}</span></span>
          <span class="mx-1">&middot;</span>
          <span>{{ formatDate(comp.created_at) }}</span>
        </div>
      </div>

      <!-- Description -->
      <div v-if="comp.description" class="card">
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
          <span class="text-sm font-semibold text-foreground">{{ t('about') }}</span>
        </div>
        <div class="p-4 md:p-6 prose prose-sm dark:prose-invert max-w-none text-foreground/80" v-html="comp.description"></div>
      </div>

      <!-- Official Streams -->
      <div v-if="streams.length > 0" class="card">
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Tv class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">{{ t('officialStreams') }}</span>
        </div>
        <div class="p-4 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
          <a v-for="stream in streams" :key="stream.id"
            :href="'https://twitch.tv/' + stream.twitch_username" target="_blank" rel="noopener"
            class="rounded-lg border border-border overflow-hidden hover:border-primary/40 transition-colors group">
            <!-- Thumbnail preview (live) -->
            <div v-if="stream.is_live && stream.stream?.thumbnail_url" class="relative">
              <img :src="stream.stream.thumbnail_url" class="w-full aspect-video object-cover" />
              <span class="absolute top-2 left-2 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold bg-red-600 text-white">
                {{ t('live') }}
              </span>
              <span v-if="stream.viewer_count != null" class="absolute bottom-2 left-2 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-black/70 text-white">
                {{ stream.viewer_count.toLocaleString() }} viewers
              </span>
            </div>
            <!-- Offline placeholder -->
            <div v-else class="w-full aspect-video bg-accent/50 flex items-center justify-center">
              <Tv class="w-8 h-8 text-muted-foreground/40" />
            </div>
            <!-- Stream info -->
            <div class="flex items-center gap-2.5 p-3">
              <div class="relative shrink-0">
                <img v-if="stream.profile_image_url" :src="stream.profile_image_url" class="w-9 h-9 rounded-full" />
                <div v-else class="w-9 h-9 rounded-full bg-[#9146FF]/10 flex items-center justify-center">
                  <Tv class="w-4 h-4 text-[#9146FF]" />
                </div>
                <span v-if="stream.is_live" class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-red-500 border-2 border-card"></span>
              </div>
              <div class="min-w-0">
                <p class="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">
                  {{ stream.is_live && stream.stream?.title ? stream.stream.title : (stream.title || stream.twitch_username) }}
                </p>
                <p class="text-xs text-muted-foreground truncate">{{ stream.twitch_username }}</p>
              </div>
            </div>
          </a>
        </div>
      </div>

      <!-- Stats -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
        <div class="card p-4">
          <div class="flex items-center gap-2 text-muted-foreground mb-1">
            <Users class="w-4 h-4" />
            <p class="text-xs font-semibold tracking-wider uppercase">{{ t('participants') }}</p>
          </div>
          <p class="text-2xl font-bold text-foreground">{{ participantCount }}</p>
        </div>
        <div class="card p-4">
          <div class="flex items-center gap-2 text-muted-foreground mb-1">
            <Trophy class="w-4 h-4" />
            <p class="text-xs font-semibold tracking-wider uppercase">{{ t('captains') }}</p>
          </div>
          <p class="text-2xl font-bold text-foreground">{{ captainCount }}</p>
        </div>
        <div class="card p-4">
          <div class="flex items-center gap-2 text-muted-foreground mb-1">
            <DollarSign class="w-4 h-4" />
            <p class="text-xs font-semibold tracking-wider uppercase">{{ t('budget') }}</p>
          </div>
          <p class="text-2xl font-bold text-foreground">{{ store.settings.startingBudget.toLocaleString() }}g</p>
        </div>
        <div class="card p-4">
          <div class="flex items-center gap-2 text-muted-foreground mb-1">
            <Settings class="w-4 h-4" />
            <p class="text-xs font-semibold tracking-wider uppercase">{{ t('perTeam') }}</p>
          </div>
          <p class="text-2xl font-bold text-foreground">{{ store.settings.playersPerTeam + 1 }}</p>
          <p class="text-xs text-muted-foreground">{{ t('captainPlusDrafted', { n: store.settings.playersPerTeam }) }}</p>
        </div>
      </div>

      <!-- Dates -->
      <div class="card">
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Calendar class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">{{ t('schedule') }}</span>
        </div>
        <div class="p-4 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <p class="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{{ t('registrationOpens') }}</p>
            <p class="text-sm text-foreground mt-1">{{ formatDate(comp.registration_start) }}</p>
          </div>
          <div>
            <p class="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{{ t('registrationCloses') }}</p>
            <p class="text-sm text-foreground mt-1">{{ formatDate(comp.registration_end) }}</p>
          </div>
          <div>
            <p class="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{{ t('draftStarts') }}</p>
            <p class="text-sm text-foreground mt-1">{{ formatDate(comp.starts_at) }}</p>
          </div>
        </div>
      </div>

      <!-- Draft Settings -->
      <div class="card">
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Gavel class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">{{ t('draftSettings') }}</span>
        </div>
        <div class="p-4 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3">
          <div>
            <p class="text-xs text-muted-foreground">{{ t('bidTimer') }}</p>
            <p class="text-sm font-medium text-foreground">{{ store.settings.bidTimer }}s</p>
          </div>
          <div>
            <p class="text-xs text-muted-foreground">{{ t('minimumBid') }}</p>
            <p class="text-sm font-medium text-foreground">{{ store.settings.minimumBid }}g</p>
          </div>
          <div>
            <p class="text-xs text-muted-foreground">{{ t('bidIncrement') }}</p>
            <p class="text-sm font-medium text-foreground">{{ store.settings.bidIncrement }}g</p>
          </div>
          <div>
            <p class="text-xs text-muted-foreground">{{ t('maxBid') }}</p>
            <p class="text-sm font-medium text-foreground">{{ store.settings.maxBid ? store.settings.maxBid + 'g' : t('noLimit') }}</p>
          </div>
          <div>
            <p class="text-xs text-muted-foreground">{{ t('nominationOrder') }}</p>
            <p class="text-sm font-medium text-foreground">{{ store.settings.nominationOrder === 'normal' ? t('roundRobin') : store.settings.nominationOrder === 'lowest_avg' ? t('lowestAvgMmr') : t('fewestPlayersFirst') }}</p>
          </div>
          <div>
            <p class="text-xs text-muted-foreground">{{ t('requireAllOnline') }}</p>
            <p class="text-sm font-medium text-foreground">{{ store.settings.requireAllOnline ? t('yes') : t('no') }}</p>
          </div>
          <div>
            <p class="text-xs text-muted-foreground">{{ t('selfRegistration') }}</p>
            <p class="text-sm font-medium text-foreground">{{ store.settings.allowSteamRegistration ? t('allowed') : t('disabled') }}</p>
          </div>
        </div>
      </div>

      <!-- Captains Preview -->
      <div v-if="store.captains.value.length > 0" class="card">
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Trophy class="w-5 h-5 text-foreground" />
          <span class="text-sm font-semibold text-foreground">{{ t('captains') }} ({{ captainCount }})</span>
        </div>
        <div class="p-4 grid grid-cols-2 md:grid-cols-4 gap-3">
          <div v-for="captain in store.captains.value" :key="captain.id" class="rounded-lg bg-accent/30 border border-border overflow-hidden flex">
            <!-- Logo / Banner (left side, 1:1) -->
            <div class="relative shrink-0 w-24 aspect-square">
              <img v-if="captain.banner_url" :src="captain.banner_url" class="w-full h-full object-cover" />
              <div v-else class="w-full h-full bg-gradient-to-br from-primary/10 to-primary/5 flex items-center justify-center">
                <Trophy class="w-6 h-6 text-primary/30" />
              </div>
              <!-- Upload/remove controls -->
              <div v-if="canEditBanner(captain)" class="absolute top-1 right-1 flex flex-col gap-0.5">
                <label class="p-0.5 rounded bg-background/80 backdrop-blur-sm cursor-pointer hover:bg-background transition-colors" :title="t('uploadBanner')">
                  <Upload class="w-3 h-3 text-foreground" />
                  <input type="file" accept="image/*" class="hidden" @change="openCropper(captain, $event)" :disabled="uploading" />
                </label>
                <button v-if="captain.banner_url" class="p-0.5 rounded bg-background/80 backdrop-blur-sm hover:bg-background transition-colors" :title="t('removeBanner')" @click="removeBanner(captain)">
                  <X class="w-3 h-3 text-destructive" />
                </button>
              </div>
            </div>
            <!-- Team name + Captain info (right side) -->
            <div class="flex flex-col justify-center gap-1.5 p-3 min-w-0">
              <p class="text-sm font-semibold text-foreground truncate">{{ captain.team }}</p>
              <div class="flex items-center gap-2">
                <img v-if="captain.avatar_url" :src="captain.avatar_url" class="w-6 h-6 rounded-full shrink-0" />
                <div v-else class="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-bold text-primary shrink-0">
                  {{ captain.name.charAt(0) }}
                </div>
                <p class="text-xs text-muted-foreground truncate">{{ captain.name }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <ImageCropper
      :show="showCropper"
      :image-file="cropFile"
      :aspect-ratio="1"
      :output-size="256"
      @crop="handleCrop"
      @close="showCropper = false; cropFile = null"
    />
  </div>
</template>
