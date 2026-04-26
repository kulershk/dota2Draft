<script setup lang="ts">
import { Settings, Save, Twitch, User, LinkIcon, Unlink, MessageCircle, Shield, Upload, CheckCircle2, XCircle, Clock, Eye, ExternalLink } from 'lucide-vue-next'
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'

const { t } = useI18n()
const api = useApi()
const store = useDraftStore()

const info = ref('')
const selectedRoles = ref<string[]>([])
const saving = ref(false)
const saved = ref(false)

// MMR verification flow — replaces direct self-edit of MMR
interface MmrVerification {
  id: number
  submitted_mmr: number
  screenshot_url: string
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  submitted_at: string
  reviewed_at: string | null
  reviewed_by_name: string | null
  review_note: string | null
}
const verifMmr = ref<number | null>(null)
const verifFile = ref<File | null>(null)
const verifSubmitting = ref(false)
const verifMessage = ref<{ type: 'ok' | 'err'; text: string } | null>(null)
const verifications = ref<MmrVerification[]>([])
const pendingVerification = computed(() => verifications.value.find(v => v.status === 'pending') || null)

async function loadVerifications() {
  try { verifications.value = await api.getMyMmrVerifications() } catch { verifications.value = [] }
}

function onPickFile(e: Event) {
  const input = e.target as HTMLInputElement
  verifFile.value = input.files && input.files[0] || null
}

const cancelling = ref(false)
async function cancelMyPending() {
  const pending = pendingVerification.value
  if (!pending) return
  if (!confirm(t('mmrVerificationCancelConfirm'))) return
  cancelling.value = true
  try {
    await api.cancelMmrVerification(pending.id)
    await loadVerifications()
  } catch (e: any) {
    verifMessage.value = { type: 'err', text: e.message || 'Cancel failed' }
  } finally {
    cancelling.value = false
  }
}

async function submitVerification() {
  if (!verifMmr.value || !verifFile.value) {
    verifMessage.value = { type: 'err', text: t('mmrVerificationMissingFields') }
    return
  }
  verifSubmitting.value = true
  verifMessage.value = null
  try {
    await api.submitMmrVerification(verifMmr.value, verifFile.value)
    verifMessage.value = { type: 'ok', text: t('mmrVerificationSubmitted') }
    verifMmr.value = null
    verifFile.value = null
    const fileInput = document.getElementById('mmrVerifFileInput') as HTMLInputElement | null
    if (fileInput) fileInput.value = ''
    await loadVerifications()
  } catch (e: any) {
    verifMessage.value = { type: 'err', text: e.message || 'Submission failed' }
  } finally {
    verifSubmitting.value = false
  }
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString()
}
const twitchLinking = ref(false)
const twitchUnlinking = ref(false)
const twitchMessage = ref('')
const discordLinking = ref(false)
const discordUnlinking = ref(false)
const discordMessage = ref('')

const allRoles = ['Carry', 'Mid', 'Offlane', 'Pos4', 'Pos5']

onMounted(async () => {
  await store.authReady
  if (store.currentUser.value) {
    info.value = store.currentUser.value.info || ''
    selectedRoles.value = [...(store.currentUser.value.roles || [])]
    loadVerifications()
  }

  // Handle Twitch callback params
  const params = new URLSearchParams(window.location.search)
  if (params.has('twitch_linked')) {
    twitchMessage.value = t('twitchLinkedSuccess')
    await store.restoreAuth()
    cleanUrl()
  } else if (params.has('twitch_error')) {
    twitchMessage.value = t('twitchLinkFailed')
    cleanUrl()
  }

  // Handle Discord callback params
  if (params.has('discord_linked')) {
    discordMessage.value = t('discordLinkedSuccess')
    await store.restoreAuth()
    cleanUrl()
  } else if (params.has('discord_error')) {
    discordMessage.value = t('discordLinkFailed')
    cleanUrl()
  }
})

function cleanUrl() {
  const url = new URL(window.location.href)
  url.searchParams.delete('twitch_linked')
  url.searchParams.delete('twitch_error')
  url.searchParams.delete('discord_linked')
  url.searchParams.delete('discord_error')
  window.history.replaceState({}, '', url.pathname + url.search)
  setTimeout(() => { twitchMessage.value = ''; discordMessage.value = '' }, 5000)
}

function toggleRole(role: string) {
  const idx = selectedRoles.value.indexOf(role)
  if (idx >= 0) selectedRoles.value.splice(idx, 1)
  else selectedRoles.value.push(role)
}

async function saveProfile() {
  saving.value = true
  saved.value = false
  try {
    const updated = await api.updateMe({
      info: info.value,
      roles: selectedRoles.value,
    })
    if (store.currentUser.value) {
      store.currentUser.value.name = updated.name
      store.currentUser.value.info = updated.info
      store.currentUser.value.roles = updated.roles
    }
    saved.value = true
    setTimeout(() => { saved.value = false }, 3000)
  } finally {
    saving.value = false
  }
}

async function linkTwitch() {
  twitchLinking.value = true
  try {
    const { url } = await api.getTwitchLinkUrl()
    window.location.href = url
  } catch {
    twitchMessage.value = t('twitchLinkFailed')
    setTimeout(() => { twitchMessage.value = '' }, 4000)
    twitchLinking.value = false
  }
}

async function unlinkTwitch() {
  twitchUnlinking.value = true
  try {
    await api.unlinkTwitch()
    if (store.currentUser.value) {
      store.currentUser.value.twitch_username = null
    }
    twitchMessage.value = t('twitchUnlinked')
    setTimeout(() => { twitchMessage.value = '' }, 3000)
  } finally {
    twitchUnlinking.value = false
  }
}

async function linkDiscord() {
  discordLinking.value = true
  try {
    const { url } = await api.getDiscordLinkUrl()
    window.location.href = url
  } catch {
    discordMessage.value = t('discordLinkFailed')
    setTimeout(() => { discordMessage.value = '' }, 4000)
    discordLinking.value = false
  }
}

async function unlinkDiscord() {
  discordUnlinking.value = true
  try {
    await api.unlinkDiscord()
    if (store.currentUser.value) {
      store.currentUser.value.discord_username = null
    }
    discordMessage.value = t('discordUnlinked')
    setTimeout(() => { discordMessage.value = '' }, 3000)
  } finally {
    discordUnlinking.value = false
  }
}

const isLoggedIn = computed(() => !!store.currentUser.value)
const hasTwitch = computed(() => !!store.currentUser.value?.twitch_username)
const hasDiscord = computed(() => !!store.currentUser.value?.discord_username)
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-6 max-w-[800px] mx-auto w-full">
    <div>
      <h1 class="text-2xl font-semibold text-foreground flex items-center gap-2">
        <Settings class="w-6 h-6" />
        {{ t('settingsTitle') }}
      </h1>
      <p class="text-sm text-muted-foreground mt-1">{{ t('settingsSubtitle') }}</p>
    </div>

    <div v-if="!isLoggedIn" class="card px-6 py-10 text-center text-sm text-muted-foreground">
      {{ t('settingsLoginRequired') }}
    </div>

    <template v-else>
      <!-- Profile Info -->
      <div class="card">
        <div class="flex items-center gap-2 px-5 py-3 border-b border-border">
          <User class="w-4 h-4 text-foreground" />
          <span class="text-sm font-semibold text-foreground">{{ t('profileInfo') }}</span>
        </div>
        <div class="px-5 py-4 flex flex-col gap-4">
          <div>
            <label class="block text-xs font-medium text-muted-foreground mb-1">{{ t('yourRoles') }}</label>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="role in allRoles"
                :key="role"
                class="px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors"
                :class="selectedRoles.includes(role)
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-accent text-muted-foreground border-border hover:border-foreground/20'"
                @click="toggleRole(role)"
              >
                {{ role }}
              </button>
            </div>
          </div>
          <div>
            <label class="block text-xs font-medium text-muted-foreground mb-1">{{ t('mmr') }}</label>
            <div class="flex items-center gap-3">
              <div class="px-3 py-2 rounded bg-accent/40 border border-border/40 text-sm font-mono font-bold tabular-nums min-w-[100px]">
                {{ store.currentUser.value?.mmr ?? 0 }}
              </div>
              <span class="text-[11px] text-muted-foreground">{{ t('mmrLockedHint') }}</span>
            </div>
          </div>
          <div>
            <label class="block text-xs font-medium text-muted-foreground mb-1">{{ t('aboutYouLabel') }}</label>
            <textarea v-model="info" class="input-field w-full" rows="3" :placeholder="t('aboutYouPlaceholder')"></textarea>
          </div>
        </div>
      </div>

      <!-- MMR Verification -->
      <div class="card">
        <div class="flex items-center gap-2 px-5 py-3 border-b border-border">
          <Shield class="w-4 h-4 text-primary" />
          <span class="text-sm font-semibold text-foreground">{{ t('mmrVerificationTitle') }}</span>
        </div>
        <div class="px-5 py-4 flex flex-col gap-4">
          <p class="text-xs text-muted-foreground">{{ t('mmrVerificationDesc') }}</p>

          <!-- Pending submission banner -->
          <div v-if="pendingVerification" class="flex items-start gap-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
            <Clock class="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
            <div class="flex-1 text-xs">
              <p class="font-semibold text-amber-300">{{ t('mmrVerificationPending') }}</p>
              <p class="text-muted-foreground mt-0.5">
                {{ t('mmrVerificationPendingDetail', { mmr: pendingVerification.submitted_mmr, when: fmtTime(pendingVerification.submitted_at) }) }}
              </p>
            </div>
            <button
              type="button"
              class="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 transition-colors disabled:opacity-40"
              :disabled="cancelling"
              @click="cancelMyPending"
            >
              {{ cancelling ? `${t('saving')}…` : t('mmrVerificationCancel') }}
            </button>
          </div>

          <!-- Submission form -->
          <div class="grid grid-cols-1 md:grid-cols-[160px_1fr_auto] gap-3 items-end">
            <div>
              <label class="block text-[11px] font-medium text-muted-foreground mb-1">{{ t('mmrVerificationMmrLabel') }}</label>
              <input
                v-model.number="verifMmr" type="number" min="0" max="13000"
                class="input-field w-full" :placeholder="t('mmrVerificationMmrPlaceholder')"
              />
            </div>
            <div>
              <label class="block text-[11px] font-medium text-muted-foreground mb-1">{{ t('mmrVerificationScreenshotLabel') }}</label>
              <input
                id="mmrVerifFileInput" type="file" accept="image/*" @change="onPickFile"
                class="block w-full text-xs text-muted-foreground file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-primary file:text-[#0A0F1C] file:font-semibold hover:file:brightness-110 file:cursor-pointer"
              />
            </div>
            <button
              type="button"
              class="btn-primary px-3 py-2 text-sm flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              :disabled="verifSubmitting || !verifMmr || !verifFile"
              @click="submitVerification"
            >
              <Upload class="w-3.5 h-3.5" />
              {{ verifSubmitting ? `${t('saving')}…` : t('mmrVerificationSubmit') }}
            </button>
          </div>

          <div v-if="verifMessage" class="text-xs" :class="verifMessage.type === 'ok' ? 'text-green-500' : 'text-destructive'">
            {{ verifMessage.text }}
          </div>

          <!-- History -->
          <div v-if="verifications.length" class="border-t border-border/40 pt-3">
            <p class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">{{ t('mmrVerificationHistory') }}</p>
            <div class="flex flex-col gap-2">
              <div v-for="v in verifications" :key="v.id"
                class="flex items-center gap-3 p-2.5 rounded-md bg-accent/30 border border-border/40">
                <span
                  class="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide shrink-0"
                  :class="v.status === 'approved' ? 'bg-green-500/15 text-green-500'
                       : v.status === 'rejected' ? 'bg-red-500/15 text-red-500'
                       : v.status === 'cancelled' ? 'bg-muted/40 text-muted-foreground'
                       : 'bg-amber-500/15 text-amber-400'"
                >
                  <component :is="v.status === 'approved' ? CheckCircle2 : (v.status === 'rejected' || v.status === 'cancelled') ? XCircle : Clock" class="w-3 h-3 inline -mt-0.5 mr-1" />
                  {{ t('mmrVerificationStatus_' + v.status) }}
                </span>
                <span class="text-sm font-mono font-bold tabular-nums shrink-0">{{ v.submitted_mmr }} MMR</span>
                <a :href="v.screenshot_url" target="_blank" class="text-xs text-primary hover:underline">{{ t('mmrVerificationScreenshot') }}</a>
                <span class="flex-1"></span>
                <span class="text-[10px] text-muted-foreground font-mono tabular-nums">{{ fmtTime(v.submitted_at) }}</span>
                <span v-if="v.review_note" class="text-[11px] italic text-muted-foreground truncate max-w-[260px]" :title="v.review_note">"{{ v.review_note }}"</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Live Stats / Steam Privacy -->
      <div class="card">
        <div class="flex items-center gap-2 px-5 py-3 border-b border-border">
          <Eye class="w-4 h-4 text-cyan-400" />
          <span class="text-sm font-semibold text-foreground">{{ t('liveStatsTitle') }}</span>
        </div>
        <div class="px-5 py-4 flex flex-col gap-3">
          <p class="text-xs text-muted-foreground leading-relaxed">{{ t('liveStatsDesc') }}</p>
          <ol class="text-xs text-muted-foreground leading-relaxed space-y-1.5 list-decimal list-inside">
            <li>{{ t('liveStatsStep1') }}</li>
            <li>{{ t('liveStatsStep2') }}</li>
            <li>{{ t('liveStatsStep3') }}</li>
          </ol>
          <a
            :href="store.currentUser.value?.steam_id ? `https://steamcommunity.com/profiles/${store.currentUser.value.steam_id}/edit/settings` : 'https://steamcommunity.com/my/edit/settings'"
            target="_blank" rel="noopener"
            class="self-start inline-flex items-center gap-2 mt-1 px-3 py-2 rounded-md bg-cyan-500/15 text-cyan-400 text-xs font-bold hover:bg-cyan-500/25 transition-colors"
          >
            <ExternalLink class="w-3.5 h-3.5" />
            {{ t('liveStatsOpenSteam') }}
          </a>
        </div>
      </div>

      <!-- Twitch Integration -->
      <div class="card">
        <div class="flex items-center gap-2 px-5 py-3 border-b border-border">
          <Twitch class="w-4 h-4 text-[#9146FF]" />
          <span class="text-sm font-semibold text-foreground">{{ t('twitchIntegration') }}</span>
        </div>
        <div class="px-5 py-4 flex flex-col gap-3">
          <p class="text-xs text-muted-foreground">{{ t('twitchDesc') }}</p>

          <!-- Linked state -->
          <div v-if="hasTwitch" class="flex items-center gap-3 p-3 rounded-lg bg-[#9146FF]/10 border border-[#9146FF]/20">
            <Twitch class="w-5 h-5 text-[#9146FF]" />
            <div class="flex-1">
              <p class="text-sm font-medium text-foreground">{{ store.currentUser.value?.twitch_username }}</p>
              <p class="text-xs text-muted-foreground">{{ t('twitchLinked') }}</p>
            </div>
            <button class="btn-secondary text-xs py-1.5 px-3" :disabled="twitchUnlinking" @click="unlinkTwitch">
              <Unlink class="w-3.5 h-3.5" />
              {{ t('twitchUnlinkBtn') }}
            </button>
          </div>

          <!-- Not linked state -->
          <div v-else>
            <button class="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white bg-[#9146FF] hover:bg-[#7c3aed] transition-colors" :disabled="twitchLinking" @click="linkTwitch">
              <Twitch class="w-4 h-4" />
              {{ twitchLinking ? t('loading') : t('twitchLinkBtn') }}
            </button>
          </div>

          <p v-if="twitchMessage" class="text-sm font-medium" :class="twitchMessage.includes('!') ? 'text-color-success' : 'text-destructive'">{{ twitchMessage }}</p>
        </div>
      </div>

      <!-- Discord Integration -->
      <div class="card">
        <div class="flex items-center gap-2 px-5 py-3 border-b border-border">
          <MessageCircle class="w-4 h-4 text-[#5865F2]" />
          <span class="text-sm font-semibold text-foreground">{{ t('discordIntegration') }}</span>
        </div>
        <div class="px-5 py-4 flex flex-col gap-3">
          <p class="text-xs text-muted-foreground">{{ t('discordLinkDesc') }}</p>

          <!-- Linked state -->
          <div v-if="hasDiscord" class="flex items-center gap-3 p-3 rounded-lg bg-[#5865F2]/10 border border-[#5865F2]/20">
            <MessageCircle class="w-5 h-5 text-[#5865F2]" />
            <div class="flex-1">
              <p class="text-sm font-medium text-foreground">{{ store.currentUser.value?.discord_username }}</p>
              <p class="text-xs text-muted-foreground">{{ t('discordLinked') }}</p>
            </div>
            <button class="btn-secondary text-xs py-1.5 px-3" :disabled="discordUnlinking" @click="unlinkDiscord">
              <Unlink class="w-3.5 h-3.5" />
              {{ t('twitchUnlinkBtn') }}
            </button>
          </div>

          <!-- Not linked state -->
          <div v-else>
            <button class="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white bg-[#5865F2] hover:bg-[#4752C4] transition-colors" :disabled="discordLinking" @click="linkDiscord">
              <MessageCircle class="w-4 h-4" />
              {{ discordLinking ? t('loading') : t('discordLinkBtn') }}
            </button>
          </div>

          <p v-if="discordMessage" class="text-sm font-medium" :class="discordMessage.includes('!') ? 'text-color-success' : 'text-destructive'">{{ discordMessage }}</p>
        </div>
      </div>

      <!-- Save -->
      <div class="flex items-center gap-3">
        <button class="btn-primary" :disabled="saving" @click="saveProfile">
          <Save class="w-4 h-4" />
          {{ saving ? t('saving') : t('saveSettings') }}
        </button>
        <span v-if="saved" class="text-sm text-color-success font-medium">{{ t('settingsSaved') }}</span>
      </div>
    </template>
  </div>
</template>
