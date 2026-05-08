<script setup lang="ts">
import { MessageSquare, Save, RefreshCw, ShieldCheck, Hash, Volume2, AlertTriangle, CheckCircle2, Swords } from 'lucide-vue-next'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'

const { t } = useI18n()
const api = useApi()

interface RoleDto { id: string; name: string; color: number; managed: boolean }
interface ChannelDto { id: string; name: string; type: string; parentId: string | null }

const guildId = ref('')
const roleVerifiedId = ref('')
const roleCasterId = ref('')
const welcomeChannelId = ref('')
const autoVerifyEnabled = ref(true)
const inhouseVoiceId = ref('')
const matchCategoryId = ref('')
const matchVoiceEnabled = ref(false)
const matchCleanupDelay = ref(10)

const roles = ref<RoleDto[]>([])
const channels = ref<ChannelDto[]>([])

const loading = ref(true)
const refreshing = ref(false)
const saving = ref(false)
const saved = ref(false)
const errorMsg = ref('')
const health = ref<{ reachable: boolean; ready?: boolean; bot?: string | null; settingsLoaded?: boolean; error?: string } | null>(null)

const textChannels = computed(() => channels.value.filter((c) => c.type === 'text' || c.type === 'announcement'))
const voiceChannels = computed(() => channels.value.filter((c) => c.type === 'voice' || c.type === 'stage'))
const categoryChannels = computed(() => channels.value.filter((c) => c.type === 'category'))

function colorHex(color: number): string {
  if (!color) return '#99a'
  return '#' + color.toString(16).padStart(6, '0')
}

async function refreshFromBot() {
  refreshing.value = true
  errorMsg.value = ''
  try {
    const [r, c, h] = await Promise.all([
      api.getDiscordRoles().catch((e) => { throw new Error(`roles: ${e.message}`) }),
      api.getDiscordChannels().catch((e) => { throw new Error(`channels: ${e.message}`) }),
      api.getDiscordHealth(),
    ])
    roles.value = r.roles
    channels.value = c.channels
    health.value = h
    if (!guildId.value) guildId.value = r.guildId
  } catch (err) {
    errorMsg.value = (err as Error).message
    health.value = await api.getDiscordHealth().catch(() => ({ reachable: false }))
  } finally {
    refreshing.value = false
  }
}

onMounted(async () => {
  try {
    const settings = await api.getDiscordSettings()
    guildId.value = settings.discord_guild_id || ''
    roleVerifiedId.value = settings.discord_role_id_verified || ''
    roleCasterId.value = settings.discord_role_id_caster || ''
    welcomeChannelId.value = settings.discord_welcome_channel_id || ''
    autoVerifyEnabled.value = settings.discord_auto_verify_enabled !== 'false'
    inhouseVoiceId.value = settings.discord_inhouse_voice_id || ''
    matchCategoryId.value = settings.discord_match_category_id || ''
    matchVoiceEnabled.value = settings.discord_match_voice_enabled === 'true'
    matchCleanupDelay.value = Number(settings.discord_match_cleanup_delay_minutes || '0')
    await refreshFromBot()
  } finally {
    loading.value = false
  }
})

async function save() {
  saving.value = true
  saved.value = false
  errorMsg.value = ''
  try {
    await api.updateDiscordSettings({
      discord_guild_id: guildId.value,
      discord_role_id_verified: roleVerifiedId.value,
      discord_role_id_caster: roleCasterId.value,
      discord_welcome_channel_id: welcomeChannelId.value,
      discord_auto_verify_enabled: autoVerifyEnabled.value ? 'true' : 'false',
      discord_inhouse_voice_id: inhouseVoiceId.value,
      discord_match_category_id: matchCategoryId.value,
      discord_match_voice_enabled: matchVoiceEnabled.value ? 'true' : 'false',
      discord_match_cleanup_delay_minutes: String(matchCleanupDelay.value),
    })
    saved.value = true
    setTimeout(() => { saved.value = false }, 3000)
  } catch (err) {
    errorMsg.value = (err as Error).message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[var(--admin-content-max,1200px)] w-full">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-semibold text-foreground">{{ t('discordSettings') }}</h1>
        <p class="text-sm text-muted-foreground mt-1">{{ t('discordSettingsDesc') }}</p>
      </div>
      <div class="flex gap-2">
        <button class="btn-secondary text-sm" :disabled="refreshing" @click="refreshFromBot">
          <RefreshCw :class="['w-4 h-4', refreshing && 'animate-spin']" />
          {{ t('discordRefreshFromBot') }}
        </button>
        <button class="btn-primary text-sm" :disabled="saving" @click="save">
          <Save class="w-4 h-4" />
          {{ saving ? t('loading') : saved ? t('saved') : t('save') }}
        </button>
      </div>
    </div>

    <div v-if="errorMsg" class="card px-4 py-3 flex items-start gap-2 text-sm text-destructive border-destructive/40">
      <AlertTriangle class="w-4 h-4 mt-0.5 flex-shrink-0" />
      <span>{{ errorMsg }}</span>
    </div>

    <!-- Bot status -->
    <div class="card">
      <div class="flex items-center gap-2 px-5 py-3 border-b border-border">
        <MessageSquare class="w-4 h-4 text-foreground" />
        <span class="text-sm font-semibold text-foreground">{{ t('discordBotStatus') }}</span>
      </div>
      <div class="px-5 py-4 grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
        <div>
          <div class="text-[11px] uppercase tracking-wide text-muted-foreground">{{ t('discordBotReachable') }}</div>
          <div class="mt-1 flex items-center gap-1.5">
            <CheckCircle2 v-if="health?.reachable" class="w-4 h-4 text-green-500" />
            <AlertTriangle v-else class="w-4 h-4 text-destructive" />
            <span>{{ health?.reachable ? t('yes') : t('no') }}</span>
          </div>
        </div>
        <div>
          <div class="text-[11px] uppercase tracking-wide text-muted-foreground">{{ t('discordBotAccount') }}</div>
          <div class="mt-1">{{ health?.bot ?? '—' }}</div>
        </div>
        <div>
          <div class="text-[11px] uppercase tracking-wide text-muted-foreground">{{ t('discordSettingsLoaded') }}</div>
          <div class="mt-1">{{ health?.settingsLoaded ? t('yes') : t('no') }}</div>
        </div>
      </div>
    </div>

    <!-- Guild + roles -->
    <div class="card">
      <div class="flex items-center gap-2 px-5 py-3 border-b border-border">
        <ShieldCheck class="w-4 h-4 text-foreground" />
        <span class="text-sm font-semibold text-foreground">{{ t('discordRolesSection') }}</span>
      </div>
      <div class="px-5 py-4 flex flex-col gap-4">
        <div>
          <label class="block text-xs font-medium text-muted-foreground mb-1">{{ t('discordGuildId') }}</label>
          <input type="text" v-model="guildId" class="input-field w-full font-mono" placeholder="123456789012345678" />
          <p class="text-[11px] text-muted-foreground mt-1">{{ t('discordGuildIdHint') }}</p>
        </div>

        <div>
          <label class="block text-xs font-medium text-muted-foreground mb-1">{{ t('discordRoleVerified') }}</label>
          <select v-model="roleVerifiedId" class="input-field w-full">
            <option value="">{{ t('discordRoleNone') }}</option>
            <option v-for="r in roles" :key="r.id" :value="r.id" :disabled="r.managed">
              {{ r.name }} {{ r.managed ? '(managed)' : '' }}
            </option>
          </select>
          <p class="text-[11px] text-muted-foreground mt-1">{{ t('discordRoleVerifiedHint') }}</p>
        </div>

        <div>
          <label class="block text-xs font-medium text-muted-foreground mb-1">{{ t('discordRoleCaster') }}</label>
          <select v-model="roleCasterId" class="input-field w-full">
            <option value="">{{ t('discordRoleNone') }}</option>
            <option v-for="r in roles" :key="r.id" :value="r.id" :disabled="r.managed">
              {{ r.name }} {{ r.managed ? '(managed)' : '' }}
            </option>
          </select>
          <p class="text-[11px] text-muted-foreground mt-1">{{ t('discordRoleCasterHint') }}</p>
        </div>
      </div>
    </div>

    <!-- Channels -->
    <div class="card">
      <div class="flex items-center gap-2 px-5 py-3 border-b border-border">
        <Hash class="w-4 h-4 text-foreground" />
        <span class="text-sm font-semibold text-foreground">{{ t('discordChannelsSection') }}</span>
      </div>
      <div class="px-5 py-4 flex flex-col gap-4">
        <div>
          <label class="block text-xs font-medium text-muted-foreground mb-1">{{ t('discordWelcomeChannel') }}</label>
          <select v-model="welcomeChannelId" class="input-field w-full">
            <option value="">{{ t('discordChannelNone') }}</option>
            <option v-for="c in textChannels" :key="c.id" :value="c.id">#{{ c.name }}</option>
          </select>
          <p class="text-[11px] text-muted-foreground mt-1">{{ t('discordWelcomeChannelHint') }}</p>
        </div>
      </div>
    </div>

    <!-- Auto-verify -->
    <div class="card">
      <div class="flex items-center gap-2 px-5 py-3 border-b border-border">
        <ShieldCheck class="w-4 h-4 text-foreground" />
        <span class="text-sm font-semibold text-foreground">{{ t('discordAutoVerifySection') }}</span>
      </div>
      <div class="px-5 py-4">
        <label class="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            class="mt-1"
            :checked="autoVerifyEnabled"
            @change="autoVerifyEnabled = ($event.target as HTMLInputElement).checked"
          />
          <span class="flex-1">
            <span class="block text-sm font-medium text-foreground">{{ t('discordAutoVerifyEnabled') }}</span>
            <span class="block text-[11px] text-muted-foreground mt-0.5">{{ t('discordAutoVerifyEnabledHint') }}</span>
          </span>
        </label>
      </div>
    </div>

    <!-- Match voice channels -->
    <div class="card">
      <div class="flex items-center gap-2 px-5 py-3 border-b border-border">
        <Swords class="w-4 h-4 text-foreground" />
        <span class="text-sm font-semibold text-foreground">{{ t('discordMatchVoiceSection') }}</span>
      </div>
      <div class="px-5 py-4 flex flex-col gap-4">
        <label class="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            class="mt-1"
            :checked="matchVoiceEnabled"
            @change="matchVoiceEnabled = ($event.target as HTMLInputElement).checked"
          />
          <span class="flex-1">
            <span class="block text-sm font-medium text-foreground">{{ t('discordMatchVoiceEnabled') }}</span>
            <span class="block text-[11px] text-muted-foreground mt-0.5">{{ t('discordMatchVoiceEnabledHint') }}</span>
          </span>
        </label>

        <div>
          <label class="block text-xs font-medium text-muted-foreground mb-1">
            <Volume2 class="w-3 h-3 inline-block mr-1" />
            {{ t('discordInhouseVoice') }}
          </label>
          <select v-model="inhouseVoiceId" class="input-field w-full">
            <option value="">{{ t('discordChannelNone') }}</option>
            <option v-for="c in voiceChannels" :key="c.id" :value="c.id">🔊 {{ c.name }}</option>
          </select>
          <p class="text-[11px] text-muted-foreground mt-1">{{ t('discordInhouseVoiceHint') }}</p>
        </div>

        <div>
          <label class="block text-xs font-medium text-muted-foreground mb-1">{{ t('discordMatchCategory') }}</label>
          <select v-model="matchCategoryId" class="input-field w-full">
            <option value="">{{ t('discordCategoryNone') }}</option>
            <option v-for="c in categoryChannels" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <p class="text-[11px] text-muted-foreground mt-1">{{ t('discordMatchCategoryHint') }}</p>
        </div>

        <div>
          <label class="block text-xs font-medium text-muted-foreground mb-1">{{ t('discordMatchCleanupDelay') }}</label>
          <input type="number" v-model.number="matchCleanupDelay" min="0" max="120" class="input-field w-full max-w-[120px]" />
          <p class="text-[11px] text-muted-foreground mt-1">{{ t('discordMatchCleanupDelayHint') }}</p>
        </div>
      </div>
    </div>

    <div v-if="loading" class="text-center text-sm text-muted-foreground py-4">{{ t('loading') }}</div>
  </div>
</template>
