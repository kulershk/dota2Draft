<script setup lang="ts">
import { Calendar, Users, User, UserPlus, LogIn, Gavel, Trophy, Clock, Settings, DollarSign, Upload, X, Tv, Swords, Info, ChevronRight, Play } from 'lucide-vue-next'
import { getRank } from '@/utils/ranks'
import { formatMatchDate as formatMatchDateUtil, fmtDateTime } from '@/utils/format'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useDraftStore } from '@/composables/useDraftStore'
import { useApi } from '@/composables/useApi'
import { getServerNow } from '@/composables/useSocket'
import ImageCropper from '@/components/common/ImageCropper.vue'
import ModalOverlay from '@/components/common/ModalOverlay.vue'

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
  registration_closed: t('statusRegistrationClosed'),
  active: t('statusInProgress'),
  finished: t('statusFinished'),
}))

function getCompStatus(c: any) {
  const auc = c?.auction_state?.status || 'idle'
  if (['nominating', 'bidding', 'paused'].includes(auc)) return 'active'
  return c?.status || 'draft'
}

const displayStatus = computed(() => getCompStatus(comp.value))
const statusLabel = computed(() => compStatusLabels.value[displayStatus.value] || t('statusSetup'))

const registrationStatus = computed(() => {
  if (!comp.value) return { label: '—', open: false }
  const now = new Date(getServerNow())
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

const canJoinAsParticipant = computed(() => {
  if (!store.currentUser.value) return false
  if (store.compUser.value?.in_pool || store.compUser.value?.captain) return false
  if (!store.settings.allowSteamRegistration && !store.isAdmin.value) return false
  return registrationStatus.value.open || store.isAdmin.value
})

const showSteamLogin = computed(() => {
  return !store.currentUser.value && store.settings.allowSteamRegistration && registrationStatus.value.open
})

const participantCount = computed(() => store.players.value.length)
const captainCount = computed(() => store.captains.value.length)
const avgMmr = computed(() => {
  const players = store.players.value.filter(p => p.mmr > 0)
  if (!players.length) return 0
  return Math.round(players.reduce((s, p) => s + p.mmr, 0) / players.length)
})
const avgRank = computed(() => getRank(avgMmr.value))

function formatDate(dateStr: string | null) {
  if (!dateStr) return '—'
  return fmtDateTime(new Date(dateStr))
}

// Streams
const streams = ref<any[]>([])

watch(compId, async (id) => {
  if (!id) return
  try {
    streams.value = await api.getCompStreamsLive(id)
  } catch { }
  try {
    await store.fetchTournament()
  } catch { }
}, { immediate: true })

// Upcoming matches (scheduled, not completed)
const upcomingMatches = computed(() => {
  const tournament = store.tournamentData.value
  if (!tournament?.matches) return []
  return tournament.matches
    .filter((m: any) => m.scheduled_at && m.status !== 'completed' && !m.hidden)
    .sort((a: any, b: any) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime())
    .slice(0, 5)
})

function formatMatchDate(dateStr: string) {
  return formatMatchDateUtil(dateStr, t)
}

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

const showRemoveBanner = ref(false)
const removeBannerCaptainId = ref<number>(0)

function confirmRemoveBanner(captain: any) {
  removeBannerCaptainId.value = captain.id
  showRemoveBanner.value = true
}

async function removeBanner() {
  if (!store.currentCompetitionId.value) return
  await api.deleteCaptainBanner(store.currentCompetitionId.value, removeBannerCaptainId.value)
  await store.fetchCaptains()
  showRemoveBanner.value = false
}
</script>

<template>
  <div v-if="!comp" class="text-center py-12 text-muted-foreground">{{ t('loading') }}</div>

  <template v-else>
    <!-- Hero Header -->
    <div class="bg-gradient-to-b from-muted to-background">
      <div class="max-w-[1200px] mx-auto w-full px-6 md:px-12 pt-8 md:pt-10 pb-6 md:pb-8 flex flex-col gap-6">
        <!-- Title row -->
        <div class="flex items-center gap-4 flex-wrap">
          <h1 class="text-2xl md:text-[32px] font-bold text-foreground tracking-tight">{{ comp.name }}</h1>
          <span class="inline-flex items-center gap-1.5 rounded px-3 py-1 text-xs font-semibold"
            :class="displayStatus === 'active' ? 'bg-color-success/20 text-color-success' :
                     displayStatus === 'finished' ? 'bg-color-success/20 text-color-success' :
                     displayStatus === 'registration' ? 'bg-primary/20 text-primary' :
                     displayStatus === 'registration_closed' ? 'bg-amber-500/20 text-amber-600 dark:text-amber-400' :
                     'bg-accent text-muted-foreground'">
            <span class="w-2 h-2 rounded-full"
              :class="displayStatus === 'active' ? 'bg-color-success' :
                       displayStatus === 'finished' ? 'bg-color-success' :
                       displayStatus === 'registration' ? 'bg-primary' :
                       displayStatus === 'registration_closed' ? 'bg-amber-500' :
                       'bg-muted-foreground'" />
            {{ statusLabel }}
          </span>
          <span v-if="registrationStatus.open" class="inline-flex items-center rounded px-3 py-1 text-xs font-medium bg-color-success/20 text-color-success">
            {{ registrationStatus.label }}
          </span>
        </div>
        <!-- Stats row -->
        <div class="flex items-center">
          <div class="flex-1 flex flex-col items-center gap-1 py-4">
            <span class="text-2xl md:text-[28px] font-bold font-mono text-foreground">{{ participantCount }}</span>
            <span class="text-[11px] font-semibold font-mono uppercase tracking-[2px] text-text-tertiary">{{ t('participants') }}</span>
          </div>
          <div class="w-px h-12 bg-border" />
          <div class="flex-1 flex flex-col items-center gap-1 py-4">
            <span class="text-2xl md:text-[28px] font-bold font-mono text-foreground">{{ captainCount }}</span>
            <span class="text-[11px] font-semibold font-mono uppercase tracking-[2px] text-text-tertiary">{{ t('captains') }}</span>
          </div>
          <div class="w-px h-12 bg-border" />
          <div class="flex-1 flex flex-col items-center gap-1 py-4">
            <template v-if="comp.competition_type">
              <span class="text-2xl">{{ comp.competition_type === 'LAN' ? '🖥️' : comp.competition_type === 'ONLINE' ? '🌐' : comp.competition_type === 'TEAMBUILDING' ? '🤝' : comp.competition_type === 'KRAKEN' ? '🐙' : '' }}</span>
              <span class="text-[11px] font-semibold font-mono uppercase tracking-[2px] text-text-tertiary">{{ comp.competition_type }}</span>
            </template>
            <template v-else>
              <span class="relative w-10 h-10" :title="avgRank.label">
                <img :src="avgRank.icon" class="w-10 h-10" :alt="avgRank.label" />
                <img v-if="avgRank.star" :src="avgRank.star" class="absolute inset-0 w-10 h-10" />
              </span>
              <span class="text-[11px] font-semibold font-mono uppercase tracking-[2px] text-text-tertiary">AVG RANK</span>
            </template>
          </div>
          <div class="w-px h-12 bg-border" />
          <div class="flex-1 flex flex-col items-center gap-1 py-4">
            <span class="text-2xl md:text-[28px] font-bold font-mono text-primary">{{ avgMmr.toLocaleString() }}</span>
            <span class="text-[11px] font-semibold font-mono uppercase tracking-[2px] text-text-tertiary">AVG MMR</span>
          </div>
        </div>

      </div>
    </div>
    <div class="h-px bg-border" />

    <!-- Main Content — two column layout -->
    <div class="max-w-[1200px] mx-auto w-full px-6 md:px-12 py-8 flex flex-col lg:flex-row gap-8">

      <!-- Join CTA (mobile) -->
      <router-link v-if="canJoinAsParticipant" :to="`/c/${compId}/players`"
        class="flex lg:hidden items-center justify-center gap-2.5 w-full py-3.5 rounded-lg bg-primary text-primary-foreground font-semibold text-base hover:bg-primary/90 transition-colors">
        <UserPlus class="w-5 h-5" />
        {{ t('joinAsParticipant') }}
      </router-link>
      <a v-else-if="showSteamLogin" href="/api/auth/steam"
        class="flex lg:hidden items-center justify-center gap-2.5 w-full py-3.5 rounded-lg bg-primary text-primary-foreground font-semibold text-base hover:bg-primary/90 transition-colors">
        <LogIn class="w-5 h-5" />
        {{ t('loginToJoin') }}
      </a>

      <!-- Left Column -->
      <div class="flex-1 flex flex-col gap-8 min-w-0">

        <!-- Upcoming Matches -->
        <div v-if="upcomingMatches.length > 0" class="rounded-lg bg-card p-6 flex flex-col gap-4">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <Swords class="w-[18px] h-[18px] text-primary" />
              <span class="text-lg font-semibold text-foreground">{{ t('upcomingMatches') }}</span>
            </div>
            <router-link :to="`/c/${compId}/tournament`" class="text-sm font-medium text-primary hover:text-primary/80 transition-colors">
              {{ t('viewAll') || 'View All' }} →
            </router-link>
          </div>

          <!-- Table header -->
          <div class="flex items-center gap-3 rounded bg-surface px-3 py-2">
            <span class="w-10 text-[11px] font-semibold font-mono uppercase tracking-wider text-text-tertiary">BO</span>
            <span class="flex-1 text-[11px] font-semibold font-mono uppercase tracking-wider text-text-tertiary">{{ t('teams') || 'TEAMS' }}</span>
            <span class="w-28 text-[11px] font-semibold font-mono uppercase tracking-wider text-text-tertiary text-right">{{ t('schedule') || 'TIME' }}</span>
            <span class="w-6"></span>
          </div>

          <!-- Match rows -->
          <router-link
            v-for="match in upcomingMatches"
            :key="match.id"
            :to="`/c/${compId}/match/${match.id}`"
            class="flex items-center gap-3 px-3 py-2.5 border-b border-surface last:border-0 hover:bg-surface/50 transition-colors"
          >
            <!-- BO -->
            <span class="w-10 text-sm font-mono text-foreground">{{ match.best_of || 1 }}</span>
            <!-- Teams -->
            <div class="flex-1 flex items-center gap-2 min-w-0">
              <div class="w-6 h-6 rounded bg-surface overflow-hidden shrink-0">
                <img v-if="match.team1_banner || match.team1_avatar" :src="match.team1_banner || match.team1_avatar" class="w-full h-full object-cover" />
              </div>
              <span class="text-sm font-medium text-foreground truncate">{{ match.team1_name || t('tbd') }}</span>
              <span class="text-xs text-text-tertiary">vs</span>
              <div class="w-6 h-6 rounded bg-surface overflow-hidden shrink-0">
                <img v-if="match.team2_banner || match.team2_avatar" :src="match.team2_banner || match.team2_avatar" class="w-full h-full object-cover" />
              </div>
              <span class="text-sm font-medium text-foreground truncate">{{ match.team2_name || t('tbd') }}</span>
            </div>
            <!-- Time -->
            <span class="w-28 text-xs font-medium text-primary text-right">{{ formatMatchDate(match.scheduled_at) }}</span>
            <!-- Arrow -->
            <ChevronRight class="w-4 h-4 text-text-tertiary shrink-0" />
          </router-link>
        </div>

        <!-- About -->
        <div v-if="comp.description" class="rounded-lg bg-card p-6 flex flex-col gap-5">
          <div class="flex items-center gap-2">
            <Info class="w-[18px] h-[18px] text-primary" />
            <span class="text-lg font-semibold text-foreground">{{ t('about') }}</span>
          </div>
          <div class="flex flex-col gap-5">
            <div>
              <p class="text-[11px] font-semibold font-mono uppercase tracking-[2px] text-text-tertiary mb-1.5">{{ t('about').toUpperCase() }}</p>
              <div class="prose prose-sm dark:prose-invert max-w-none text-muted-foreground leading-relaxed" v-safe-html="comp.description"></div>
            </div>
          </div>
        </div>

      </div>

      <!-- Right Column (sidebar) -->
      <div class="w-full lg:w-[380px] flex flex-col gap-6 shrink-0">

        <!-- Join CTA (desktop) -->
        <router-link v-if="canJoinAsParticipant" :to="`/c/${compId}/players`"
          class="hidden lg:flex items-center justify-center gap-2.5 w-full py-3.5 rounded-lg bg-primary text-primary-foreground font-semibold text-base hover:bg-primary/90 transition-colors">
          <UserPlus class="w-5 h-5" />
          {{ t('joinAsParticipant') }}
        </router-link>
        <a v-else-if="showSteamLogin" href="/api/auth/steam"
          class="hidden lg:flex items-center justify-center gap-2.5 w-full py-3.5 rounded-lg bg-primary text-primary-foreground font-semibold text-base hover:bg-primary/90 transition-colors">
          <LogIn class="w-5 h-5" />
          {{ t('loginToJoin') }}
        </a>

        <!-- Official Streams -->
        <div class="rounded-lg bg-card p-5 flex flex-col gap-4">
          <div class="flex items-center gap-2">
            <Tv class="w-4 h-4 text-primary" />
            <span class="text-base font-semibold text-foreground">{{ t('officialStreams') }}</span>
          </div>
          <template v-if="streams.length > 0">
            <a v-for="stream in streams" :key="stream.id"
              :href="'https://twitch.tv/' + stream.twitch_username" target="_blank" rel="noopener"
              class="rounded-md border border-border overflow-hidden hover:border-primary/40 transition-colors group">
              <div v-if="stream.is_live && stream.stream?.thumbnail_url" class="relative">
                <img :src="stream.stream.thumbnail_url" class="w-full aspect-video object-cover" />
                <span class="absolute top-2 left-2 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold bg-red-600 text-white">
                  {{ t('live') }}
                </span>
              </div>
              <div v-else class="w-full aspect-video bg-surface flex items-center justify-center">
                <Tv class="w-8 h-8 text-text-muted" />
              </div>
              <div class="flex items-center gap-2.5 p-3">
                <div class="relative shrink-0">
                  <img v-if="stream.profile_image_url" :src="stream.profile_image_url" class="w-9 h-9 rounded-full" />
                  <span v-if="stream.is_live" class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-red-500 border-2 border-card" />
                </div>
                <div class="min-w-0">
                  <p class="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">
                    {{ stream.is_live && stream.stream?.title ? stream.stream.title : (stream.title || stream.twitch_username) }}
                  </p>
                  <p class="text-xs text-muted-foreground truncate">{{ stream.twitch_username }}</p>
                </div>
              </div>
            </a>
          </template>
          <div v-else class="rounded-md bg-surface flex flex-col items-center justify-center gap-2 py-12">
            <Play class="w-10 h-10 text-text-tertiary" />
            <span class="text-sm text-text-tertiary">{{ t('noActiveStreams') || 'No active streams' }}</span>
          </div>
        </div>

        <!-- Schedule -->
        <div class="rounded-lg bg-card p-5 flex flex-col gap-4">
          <div class="flex items-center gap-2">
            <Calendar class="w-4 h-4 text-primary" />
            <span class="text-base font-semibold text-foreground">{{ t('schedule') }}</span>
          </div>
          <div class="flex flex-col">
            <div class="flex flex-col gap-1 py-3 border-b border-surface">
              <span class="text-[10px] font-semibold font-mono uppercase tracking-[1.5px] text-text-tertiary">{{ t('registrationOpens') || 'REGISTRATION OPEN' }}</span>
              <span class="text-sm text-foreground">{{ formatDate(comp.registration_start) }}</span>
            </div>
            <div class="flex flex-col gap-1 py-3 border-b border-surface">
              <span class="text-[10px] font-semibold font-mono uppercase tracking-[1.5px] text-text-tertiary">{{ t('registrationCloses') || 'REGISTRATION CLOSE' }}</span>
              <span class="text-sm text-foreground">{{ formatDate(comp.registration_end) }}</span>
            </div>
            <div class="flex flex-col gap-1 py-3">
              <span class="text-[10px] font-semibold font-mono uppercase tracking-[1.5px] text-text-tertiary">{{ t('draftStarts') || 'START / LIVE' }}</span>
              <span class="text-sm text-foreground">{{ formatDate(comp.starts_at) }}</span>
            </div>
          </div>
        </div>

        <!-- Draft Settings -->
        <div class="rounded-lg bg-card p-5 flex flex-col gap-4">
          <div class="flex items-center gap-2">
            <Settings class="w-4 h-4 text-primary" />
            <span class="text-base font-semibold text-foreground">{{ t('draftSettings') }}</span>
          </div>
          <div class="flex flex-col">
            <div class="flex items-center justify-between py-2.5 border-b border-surface">
              <span class="text-xs text-text-tertiary">{{ t('bidTimer') }}</span>
              <span class="text-sm font-medium font-mono text-foreground">{{ store.settings.bidTimer }}s</span>
            </div>
            <div class="flex items-center justify-between py-2.5 border-b border-surface">
              <span class="text-xs text-text-tertiary">{{ t('minimumBid') }}</span>
              <span class="text-sm font-medium font-mono text-foreground">{{ store.settings.minimumBid }}g</span>
            </div>
            <div class="flex items-center justify-between py-2.5 border-b border-surface">
              <span class="text-xs text-text-tertiary">{{ t('bidIncrement') }}</span>
              <span class="text-sm font-medium font-mono text-foreground">{{ store.settings.bidIncrement }}g</span>
            </div>
            <div class="flex items-center justify-between py-2.5 border-b border-surface">
              <span class="text-xs text-text-tertiary">{{ t('maxBid') }}</span>
              <span class="text-sm font-medium font-mono text-foreground">{{ store.settings.maxBid ? store.settings.maxBid + 'g' : t('noLimit') }}</span>
            </div>
            <div class="flex items-center justify-between py-2.5 border-b border-surface">
              <span class="text-xs text-text-tertiary">{{ t('budget') }}</span>
              <span class="text-sm font-medium font-mono text-foreground">{{ store.settings.startingBudget }}g</span>
            </div>
            <div class="flex items-center justify-between py-2.5 border-b border-surface">
              <span class="text-xs text-text-tertiary">{{ t('perTeam') }}</span>
              <span class="text-sm font-medium font-mono text-foreground">{{ store.settings.playersPerTeam }}</span>
            </div>
            <div class="flex items-center justify-between py-2.5">
              <span class="text-xs text-text-tertiary">{{ t('nominationOrder') }}</span>
              <span class="text-sm font-medium text-foreground">{{ store.settings.nominationOrder === 'normal' ? t('roundRobin') : store.settings.nominationOrder === 'lowest_avg' ? t('lowestAvgMmr') : t('fewestPlayersFirst') }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Captains Section (full width) -->
    <div v-if="store.captains.value.length > 0" class="max-w-[1200px] mx-auto w-full px-6 md:px-12 pb-12">
      <div class="h-px bg-border mb-5" />
      <div class="flex items-center gap-2 mb-5">
        <Users class="w-[18px] h-[18px] text-primary" />
        <span class="text-xl font-semibold text-foreground">{{ t('captains') }}</span>
        <span class="inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold font-mono bg-primary/20 text-primary">
          {{ store.captains.value.length }}
        </span>
      </div>
      <div class="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 gap-4">
        <div v-for="captain in store.captains.value" :key="captain.id" class="flex flex-col items-center gap-2">
          <router-link :to="{ name: 'team-profile', params: { id: captain.id } }" class="relative w-16 h-16 rounded-lg overflow-hidden bg-surface shrink-0 hover:ring-2 hover:ring-primary transition-all">
            <img v-if="captain.banner_url || captain.avatar_url" :src="captain.banner_url || captain.avatar_url" class="w-full h-full object-cover" />
            <div v-else class="w-full h-full flex items-center justify-center">
              <Trophy class="w-5 h-5 text-text-muted" />
            </div>
          </router-link>
          <!-- Upload/remove controls -->
          <div v-if="canEditBanner(captain)" class="flex gap-1 -mt-1">
            <label class="p-0.5 rounded bg-surface cursor-pointer hover:bg-accent transition-colors" :title="t('uploadBanner')">
              <Upload class="w-3 h-3 text-foreground" />
              <input type="file" accept="image/*" class="hidden" @change="openCropper(captain, $event)" :disabled="uploading" />
            </label>
            <button v-if="captain.banner_url" class="p-0.5 rounded bg-surface hover:bg-accent transition-colors" :title="t('removeBanner')" @click="confirmRemoveBanner(captain)">
              <X class="w-3 h-3 text-destructive" />
            </button>
          </div>
          <router-link :to="{ name: 'team-profile', params: { id: captain.id } }" class="text-xs font-medium text-foreground text-center w-full truncate hover:text-primary transition-colors">{{ captain.team || captain.name }}</router-link>
          <span class="text-[10px] font-mono text-text-tertiary text-center">{{ captain.name }}</span>
        </div>
      </div>
    </div>

    <ImageCropper
      :show="showCropper"
      :image-file="cropFile"
      :aspect-ratio="1"
      :output-size="256"
      @crop="handleCrop"
      @close="showCropper = false; cropFile = null"
    />

    <!-- Remove Banner Confirmation -->
    <ModalOverlay :show="showRemoveBanner" @close="showRemoveBanner = false">
      <div class="px-7 py-6 border-b border-border">
        <h2 class="text-xl font-semibold text-foreground">{{ t('removeBanner') }}</h2>
        <p class="text-sm text-muted-foreground mt-1">{{ t('removeBannerConfirm') }}</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3">
        <button class="btn-destructive w-full justify-center" @click="removeBanner">{{ t('remove') }}</button>
        <button class="btn-secondary w-full justify-center" @click="showRemoveBanner = false">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>
  </template>
</template>
