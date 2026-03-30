<script setup lang="ts">
import { Settings, Save, Twitch, User, LinkIcon, Unlink, MessageCircle } from 'lucide-vue-next'
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'

const { t } = useI18n()
const api = useApi()
const store = useDraftStore()

const mmr = ref(0)
const info = ref('')
const selectedRoles = ref<string[]>([])
const saving = ref(false)
const saved = ref(false)
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
    mmr.value = store.currentUser.value.mmr || 0
    info.value = store.currentUser.value.info || ''
    selectedRoles.value = [...(store.currentUser.value.roles || [])]
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
      mmr: mmr.value,
      info: info.value,
      roles: selectedRoles.value,
    })
    if (store.currentUser.value) {
      store.currentUser.value.name = updated.name
      store.currentUser.value.mmr = updated.mmr
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
            <input type="number" v-model.number="mmr" class="input-field w-full max-w-[200px]" />
          </div>
          <div>
            <label class="block text-xs font-medium text-muted-foreground mb-1">{{ t('aboutYouLabel') }}</label>
            <textarea v-model="info" class="input-field w-full" rows="3" :placeholder="t('aboutYouPlaceholder')"></textarea>
          </div>
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
