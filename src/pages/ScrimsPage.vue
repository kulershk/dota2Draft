<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import { getSocket } from '@/composables/useSocket'
import { formatMatchDate } from '@/utils/format'
import { CalendarDays, Plus, X, Trash2, Check } from 'lucide-vue-next'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import DatePicker from '@/components/common/DatePicker.vue'
import CaptainAvatar from '@/components/common/CaptainAvatar.vue'

const { t } = useI18n()
const api = useApi()
const store = useDraftStore()
const socket = getSocket()

interface Scrim {
  id: number
  competition_id: number
  posted_by: number
  captain_id: number | null
  scheduled_at: string
  message: string
  status: 'open' | 'claimed' | 'cancelled'
  claimed_by: number | null
  claimed_captain_id: number | null
  claimed_at: string | null
  cancelled_by: number | null
  created_at: string
  posted_by_name: string
  posted_by_avatar: string
  posted_by_team: string
  posted_by_banner: string | null
  claimed_by_name: string | null
  claimed_by_avatar: string | null
  claimed_by_team: string | null
  claimed_by_banner: string | null
}

const scrims = ref<Scrim[]>([])
const loading = ref(true)
const filter = ref<'open' | 'claimed' | 'all'>('open')
const showPostModal = ref(false)
const posting = ref(false)

// New scrim form
const newScheduledAt = ref('')
const newMessage = ref('')

const compId = computed(() => store.currentCompetitionId.value!)
const currentUserId = computed(() => store.currentUser.value?.id)
const isCaptain = computed(() => !!store.compUser.value?.captain)
const isAdmin = computed(() => store.isAdmin.value)

const canPost = computed(() => {
  if (!store.currentUser.value) return false
  if (store.settings.scrimAccess === 'captains_only') return isCaptain.value
  // all_players: must be in pool or be a captain
  return !!store.compUser.value
})

const filteredScrims = computed(() => {
  const now = new Date()
  let list = scrims.value
  if (filter.value === 'open') list = list.filter(s => s.status === 'open')
  else if (filter.value === 'claimed') list = list.filter(s => s.status === 'claimed')
  else list = list.filter(s => s.status !== 'cancelled')

  // Sort: upcoming first, then past
  return list.sort((a, b) => {
    const aIsPast = new Date(a.scheduled_at) < now ? 1 : 0
    const bIsPast = new Date(b.scheduled_at) < now ? 1 : 0
    if (aIsPast !== bIsPast) return aIsPast - bIsPast
    return new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime()
  })
})

function isPast(scrim: Scrim) {
  return new Date(scrim.scheduled_at) < new Date()
}

function canClaim(scrim: Scrim) {
  if (!isCaptain.value || scrim.status !== 'open' || isPast(scrim)) return false
  // Can't claim own team's scrim
  const myCaptainId = store.compUser.value?.captain?.id
  return scrim.captain_id !== myCaptainId
}

function canCancel(scrim: Scrim) {
  if (scrim.status === 'cancelled') return false
  if (isAdmin.value) return true
  if (scrim.status === 'open' && scrim.posted_by === currentUserId.value) return true
  if (scrim.status === 'claimed' && (scrim.posted_by === currentUserId.value || scrim.claimed_by === currentUserId.value)) return true
  return false
}

function cancelLabel(scrim: Scrim) {
  if (scrim.status === 'claimed' && scrim.claimed_by === currentUserId.value) return t('scrimUnclaim')
  return t('scrimCancel')
}

async function fetchScrims() {
  loading.value = true
  try {
    scrims.value = await api.getScrims(compId.value)
  } finally {
    loading.value = false
  }
}

async function postScrim() {
  if (!newScheduledAt.value) return
  posting.value = true
  try {
    await api.postScrim(compId.value, {
      scheduled_at: new Date(newScheduledAt.value).toISOString(),
      message: newMessage.value || undefined,
    })
    showPostModal.value = false
    newScheduledAt.value = ''
    newMessage.value = ''
  } catch (e: any) {
    alert(e.message)
  } finally {
    posting.value = false
  }
}

async function claimScrim(scrimId: number) {
  try {
    await api.claimScrim(compId.value, scrimId)
  } catch (e: any) {
    alert(e.message)
  }
}

async function cancelScrim(scrimId: number) {
  try {
    await api.cancelScrim(compId.value, scrimId)
  } catch (e: any) {
    alert(e.message)
  }
}

async function deleteScrim(scrimId: number) {
  if (!confirm(t('scrimDeleteConfirm'))) return
  try {
    await api.deleteScrim(compId.value, scrimId)
  } catch (e: any) {
    alert(e.message)
  }
}

// Socket listeners
function onScrimCreated({ scrim }: { scrim: Scrim }) {
  scrims.value.push(scrim)
}

function onScrimClaimed({ scrim }: { scrim: Scrim }) {
  const idx = scrims.value.findIndex(s => s.id === scrim.id)
  if (idx >= 0) scrims.value[idx] = scrim
}

function onScrimCancelled({ scrim }: { scrim: Scrim }) {
  const idx = scrims.value.findIndex(s => s.id === scrim.id)
  if (idx >= 0) scrims.value[idx] = scrim
}

function onScrimDeleted({ scrimId }: { scrimId: number }) {
  scrims.value = scrims.value.filter(s => s.id !== scrimId)
}

onMounted(() => {
  fetchScrims()
  socket.on('scrims:created', onScrimCreated)
  socket.on('scrims:claimed', onScrimClaimed)
  socket.on('scrims:cancelled', onScrimCancelled)
  socket.on('scrims:deleted', onScrimDeleted)
})

onUnmounted(() => {
  socket.off('scrims:created', onScrimCreated)
  socket.off('scrims:claimed', onScrimClaimed)
  socket.off('scrims:cancelled', onScrimCancelled)
  socket.off('scrims:deleted', onScrimDeleted)
})
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 max-w-[1200px] mx-auto w-full flex flex-col gap-5">
    <!-- Header -->
    <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl md:text-3xl font-bold text-foreground">{{ t('scrimBoard') }}</h1>
        <p class="text-sm text-muted-foreground mt-1">{{ t('scrimBoardDescription') }}</p>
      </div>
      <button v-if="canPost" class="btn-primary text-sm" @click="showPostModal = true">
        <Plus class="w-4 h-4" />
        {{ t('postScrim') }}
      </button>
    </div>

    <!-- Filter chips -->
    <div class="flex gap-2">
      <button
        v-for="f in (['open', 'claimed', 'all'] as const)" :key="f"
        class="px-3 py-1.5 rounded text-sm font-medium transition-colors"
        :class="filter === f ? 'bg-primary text-primary-foreground' : 'bg-accent text-muted-foreground hover:text-foreground'"
        @click="filter = f"
      >{{ t(`scrimFilter${f.charAt(0).toUpperCase() + f.slice(1)}`) }}</button>
    </div>

    <!-- Scrim list -->
    <div v-if="loading" class="card px-4 py-10 text-center text-sm text-muted-foreground">
      {{ t('loading') }}
    </div>

    <div v-else-if="filteredScrims.length === 0" class="card px-4 py-10 text-center text-sm text-muted-foreground">
      {{ filter === 'open' ? t('scrimNoOpenScrims') : t('scrimNoScrims') }}
    </div>

    <div v-else class="flex flex-col gap-3">
      <div
        v-for="scrim in filteredScrims" :key="scrim.id"
        class="card px-4 py-4 flex flex-col sm:flex-row items-start sm:items-center gap-3 transition-opacity"
        :class="{ 'opacity-50': isPast(scrim) }"
      >
        <!-- Left: date + team info -->
        <div class="flex-1 min-w-0 flex flex-col gap-1.5">
          <div class="flex items-center gap-2 text-sm">
            <CalendarDays class="w-4 h-4 text-muted-foreground shrink-0" />
            <span class="font-semibold text-foreground">{{ formatMatchDate(scrim.scheduled_at, t) }}</span>
            <span v-if="isPast(scrim)" class="text-xs text-muted-foreground">({{ t('scrimPast') }})</span>
          </div>
          <div class="flex items-center gap-2">
            <CaptainAvatar :url="scrim.posted_by_banner || scrim.posted_by_avatar" class="w-6 h-6 rounded-full" />
            <span class="text-sm text-foreground font-medium truncate">{{ scrim.posted_by_team }}</span>
            <template v-if="scrim.status === 'claimed' && scrim.claimed_by_team">
              <span class="text-xs text-muted-foreground">{{ t('scrimVs') }}</span>
              <CaptainAvatar :url="scrim.claimed_by_banner || scrim.claimed_by_avatar" class="w-6 h-6 rounded-full" />
              <span class="text-sm text-foreground font-medium truncate">{{ scrim.claimed_by_team }}</span>
            </template>
          </div>
          <p v-if="scrim.message" class="text-xs text-muted-foreground line-clamp-2">{{ scrim.message }}</p>
        </div>

        <!-- Right: status + actions -->
        <div class="flex items-center gap-2 shrink-0">
          <span
            class="text-xs font-medium px-2 py-0.5 rounded-full"
            :class="{
              'bg-color-success/10 text-color-success': scrim.status === 'open' && !isPast(scrim),
              'bg-primary/10 text-primary': scrim.status === 'claimed',
              'bg-accent text-muted-foreground': scrim.status === 'cancelled' || (scrim.status === 'open' && isPast(scrim)),
            }"
          >{{ t(`scrimStatus${scrim.status.charAt(0).toUpperCase() + scrim.status.slice(1)}`) }}</span>

          <button
            v-if="canClaim(scrim)"
            class="btn-primary text-xs py-1 px-2.5"
            @click="claimScrim(scrim.id)"
          >
            <Check class="w-3.5 h-3.5" />
            {{ t('scrimAcceptChallenge') }}
          </button>

          <button
            v-if="canCancel(scrim)"
            class="btn-ghost text-xs py-1 px-2.5"
            @click="cancelScrim(scrim.id)"
          >
            <X class="w-3.5 h-3.5" />
            {{ cancelLabel(scrim) }}
          </button>

          <button
            v-if="isAdmin"
            class="btn-ghost p-1.5 text-destructive"
            :title="t('delete')"
            @click="deleteScrim(scrim.id)"
          >
            <Trash2 class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>

    <!-- Post Scrim Modal -->
    <ModalOverlay :show="showPostModal" @close="showPostModal = false">
      <div class="p-6 flex flex-col gap-4">
        <h2 class="text-lg font-semibold text-foreground">{{ t('postScrim') }}</h2>

        <DatePicker
          mode="single"
          show-time
          :label="t('scrimScheduledAt')"
          :model-value="newScheduledAt"
          @update:model-value="newScheduledAt = $event"
        />

        <div>
          <label class="label-text">{{ t('scrimMessage') }}</label>
          <textarea
            v-model="newMessage"
            class="textarea-field w-full mt-1"
            rows="3"
            maxlength="500"
            :placeholder="t('scrimMessagePlaceholder')"
          />
          <p class="text-xs text-muted-foreground mt-1">{{ newMessage.length }}/500</p>
        </div>

        <div class="flex gap-2 justify-end">
          <button class="btn-ghost text-sm" @click="showPostModal = false">{{ t('cancel') }}</button>
          <button
            class="btn-primary text-sm"
            :disabled="!newScheduledAt || posting"
            @click="postScrim"
          >{{ posting ? t('loading') : t('postScrim') }}</button>
        </div>
      </div>
    </ModalOverlay>
  </div>
</template>
