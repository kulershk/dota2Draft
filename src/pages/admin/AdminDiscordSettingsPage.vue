<script setup lang="ts">
import { MessageSquare, Save, RefreshCw, ShieldCheck, Hash, Volume2, AlertTriangle, CheckCircle2, Swords, Puzzle, Settings as SettingsIcon, Trophy, UserPlus, Hand, Smile, Plus, Trash2, ExternalLink } from 'lucide-vue-next'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'
import ModalOverlay from '@/components/common/ModalOverlay.vue'

const { t } = useI18n()
const api = useApi()

interface RoleDto { id: string; name: string; color: number; managed: boolean }
interface ChannelDto { id: string; name: string; type: string; parentId: string | null }
interface PluginDto { name: string; description: string; class: string; enabled: boolean }

const guildId = ref('')
const roleVerifiedId = ref('')
const roleCasterId = ref('')
const roleSubscriberId = ref('')
const welcomeChannelId = ref('')
const tournamentChannelId = ref('')
const inhouseVoiceId = ref('')
const matchCategoryId = ref('')
const matchVoiceEnabled = ref(false)
const matchCleanupDelay = ref(10)
// Map<plugin.name, enabled>. Edited in-place by the toggle UI; saved with the
// rest of the settings on Save.
const pluginToggles = ref<Record<string, boolean>>({})

const roles = ref<RoleDto[]>([])
const channels = ref<ChannelDto[]>([])
const plugins = ref<PluginDto[]>([])

const loading = ref(true)
const refreshing = ref(false)
const saving = ref(false)
const saved = ref(false)
const errorMsg = ref('')
const health = ref<{ reachable: boolean; ready?: boolean; bot?: string | null; settingsLoaded?: boolean; error?: string } | null>(null)

// Tab nav state. 'general' is server-wide config (guild + roles + bot status).
// Each plugin gets its own tab keyed by its @Plugin({ name }). 'matchVoice' is
// here as a section even though it's not a true plugin yet.
type TabKey = 'general' | 'matchVoice' | string
const activeTab = ref<TabKey>('general')

// Static metadata for tabs that aren't dynamic plugins.
const FIXED_TABS = [
  { key: 'general', icon: SettingsIcon },
  { key: 'matchVoice', icon: Swords },
] as const

// Hook icon for known plugin names. Unknown plugins fall back to Puzzle.
const PLUGIN_ICONS: Record<string, any> = {
  autoVerify: ShieldCheck,
  welcome: Hand,
  tournamentAnnounce: Trophy,
  reactionRoles: Smile,
}
function pluginIcon(name: string) { return PLUGIN_ICONS[name] ?? Puzzle }
function pluginLabel(name: string) {
  // i18n key per plugin: discordPluginLabel_<name>. Fall back to the raw name.
  const key = `discordPluginLabel_${name}`
  const v = t(key)
  return v === key ? name : v
}

const textChannels = computed(() => channels.value.filter((c) => c.type === 'text' || c.type === 'announcement'))
const voiceChannels = computed(() => channels.value.filter((c) => c.type === 'voice' || c.type === 'stage'))
const categoryChannels = computed(() => channels.value.filter((c) => c.type === 'category'))

function colorHex(color: number): string {
  if (!color) return '#99a'
  return '#' + color.toString(16).padStart(6, '0')
}

// ─── Reaction Roles ───────────────────────────────────────────
interface ReactionRoleRow {
  id: number
  guild_id: string
  channel_id: string
  message_id: string
  emoji: string
  role_id: string
  label: string | null
  created_by: number | null
  created_by_name: string | null
  created_at: string
}
const reactionRoles = ref<ReactionRoleRow[]>([])
const reactionRolesLoading = ref(false)
const showRrModal = ref(false)
const rrForm = ref<{ message_link: string; emoji: string; role_id: string; label: string }>({
  message_link: '', emoji: '', role_id: '', label: '',
})
const rrSubmitting = ref(false)
const rrError = ref('')
const rrDeleteTarget = ref<ReactionRoleRow | null>(null)

async function loadReactionRoles() {
  reactionRolesLoading.value = true
  try {
    const { rows } = await api.getDiscordReactionRoles()
    reactionRoles.value = rows
  } catch (err) {
    errorMsg.value = (err as Error).message
  } finally {
    reactionRolesLoading.value = false
  }
}

function openRrModal() {
  rrForm.value = { message_link: '', emoji: '', role_id: '', label: '' }
  rrError.value = ''
  showRrModal.value = true
}

async function submitRr() {
  rrError.value = ''
  if (!rrForm.value.emoji || !rrForm.value.role_id || !rrForm.value.message_link) {
    rrError.value = t('discordReactionRolesMissingFields')
    return
  }
  rrSubmitting.value = true
  try {
    await api.addDiscordReactionRole({
      message_link: rrForm.value.message_link.trim(),
      emoji: rrForm.value.emoji.trim(),
      role_id: rrForm.value.role_id,
      label: rrForm.value.label.trim() || null,
    })
    showRrModal.value = false
    await loadReactionRoles()
  } catch (err) {
    rrError.value = (err as Error).message
  } finally {
    rrSubmitting.value = false
  }
}

async function confirmDeleteRr() {
  if (!rrDeleteTarget.value) return
  try {
    await api.deleteDiscordReactionRole(rrDeleteTarget.value.id)
    rrDeleteTarget.value = null
    await loadReactionRoles()
  } catch (err) {
    errorMsg.value = (err as Error).message
  }
}

function roleName(id: string): string {
  return roles.value.find((r) => r.id === id)?.name ?? `#${id}`
}

function roleColor(id: string): string {
  const r = roles.value.find((x) => x.id === id)
  return r ? colorHex(r.color) : '#99a'
}

function messageLink(row: ReactionRoleRow): string {
  return `https://discord.com/channels/${row.guild_id}/${row.channel_id}/${row.message_id}`
}

async function refreshFromBot() {
  refreshing.value = true
  errorMsg.value = ''
  try {
    const [r, c, h, p] = await Promise.all([
      api.getDiscordRoles().catch((e) => { throw new Error(`roles: ${e.message}`) }),
      api.getDiscordChannels().catch((e) => { throw new Error(`channels: ${e.message}`) }),
      api.getDiscordHealth(),
      api.getDiscordPlugins().catch((e) => { throw new Error(`plugins: ${e.message}`) }),
    ])
    roles.value = r.roles
    channels.value = c.channels
    health.value = h
    plugins.value = p.plugins
    // Seed the local toggle map from the bot's view (which already merges DB
    // override with the @Plugin info default).
    for (const pl of p.plugins) {
      if (pluginToggles.value[pl.name] === undefined) pluginToggles.value[pl.name] = pl.enabled
    }
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
    roleSubscriberId.value = settings.discord_role_id_subscriber || ''
    welcomeChannelId.value = settings.discord_welcome_channel_id || ''
    tournamentChannelId.value = settings.discord_tournament_channel_id || ''
    inhouseVoiceId.value = settings.discord_inhouse_voice_id || ''
    matchCategoryId.value = settings.discord_match_category_id || ''
    matchVoiceEnabled.value = settings.discord_match_voice_enabled === 'true'
    matchCleanupDelay.value = Number(settings.discord_match_cleanup_delay_minutes || '0')
    // Seed plugin toggles from any persisted discord_plugin_*_enabled keys
    // BEFORE we hit the bot. refreshFromBot() will then overlay the bot's
    // canonical list (so unknown stale settings get dropped from the UI).
    for (const [k, v] of Object.entries(settings)) {
      const m = k.match(/^discord_plugin_(.+)_enabled$/)
      if (m) pluginToggles.value[m[1]] = v !== 'false'
    }
    await refreshFromBot()
    await loadReactionRoles()
  } finally {
    loading.value = false
  }
})

async function save() {
  saving.value = true
  saved.value = false
  errorMsg.value = ''
  try {
    const payload: Record<string, string> = {
      discord_guild_id: guildId.value,
      discord_role_id_verified: roleVerifiedId.value,
      discord_role_id_caster: roleCasterId.value,
      discord_role_id_subscriber: roleSubscriberId.value,
      discord_welcome_channel_id: welcomeChannelId.value,
      discord_tournament_channel_id: tournamentChannelId.value,
      discord_inhouse_voice_id: inhouseVoiceId.value,
      discord_match_category_id: matchCategoryId.value,
      discord_match_voice_enabled: matchVoiceEnabled.value ? 'true' : 'false',
      discord_match_cleanup_delay_minutes: String(matchCleanupDelay.value),
    }
    for (const [name, on] of Object.entries(pluginToggles.value)) {
      payload[`discord_plugin_${name}_enabled`] = on ? 'true' : 'false'
    }
    await api.updateDiscordSettings(payload)
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

    <!-- Layout: tab nav + active panel -->
    <div class="flex flex-col md:flex-row gap-4 md:gap-6">
      <!-- Tab nav -->
      <nav class="flex md:flex-col md:w-56 gap-1 overflow-x-auto md:overflow-visible flex-shrink-0">
        <button
          class="flex items-center gap-2 px-3 py-2 text-sm rounded-md whitespace-nowrap transition-colors text-left"
          :class="activeTab === 'general' ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-accent/30 hover:text-foreground'"
          @click="activeTab = 'general'"
        >
          <SettingsIcon class="w-4 h-4" />
          <span>{{ t('discordTabGeneral') }}</span>
        </button>

        <button
          v-for="p in plugins"
          :key="p.name"
          class="flex items-center gap-2 px-3 py-2 text-sm rounded-md whitespace-nowrap transition-colors text-left"
          :class="activeTab === p.name ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-accent/30 hover:text-foreground'"
          @click="activeTab = p.name"
        >
          <component :is="pluginIcon(p.name)" class="w-4 h-4" />
          <span class="flex-1">{{ pluginLabel(p.name) }}</span>
          <span v-if="pluginToggles[p.name] === false" class="text-[10px] uppercase text-muted-foreground">{{ t('discordTabOff') }}</span>
        </button>

        <button
          class="flex items-center gap-2 px-3 py-2 text-sm rounded-md whitespace-nowrap transition-colors text-left"
          :class="activeTab === 'matchVoice' ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-accent/30 hover:text-foreground'"
          @click="activeTab = 'matchVoice'"
        >
          <Swords class="w-4 h-4" />
          <span>{{ t('discordMatchVoiceSection') }}</span>
        </button>
      </nav>

      <!-- Active panel -->
      <div class="flex-1 flex flex-col gap-4 md:gap-6 min-w-0">
        <!-- ========== GENERAL ========== -->
        <template v-if="activeTab === 'general'">
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
              <div>
                <label class="block text-xs font-medium text-muted-foreground mb-1">{{ t('discordRoleSubscriber') }}</label>
                <select v-model="roleSubscriberId" class="input-field w-full">
                  <option value="">{{ t('discordRoleNone') }}</option>
                  <option v-for="r in roles" :key="r.id" :value="r.id" :disabled="r.managed">
                    {{ r.name }} {{ r.managed ? '(managed)' : '' }}
                  </option>
                </select>
                <p class="text-[11px] text-muted-foreground mt-1">{{ t('discordRoleSubscriberHint') }}</p>
              </div>
            </div>
          </div>
        </template>

        <!-- ========== PLUGIN PANELS ========== -->
        <template v-for="p in plugins" :key="p.name">
          <template v-if="activeTab === p.name">
            <!-- Generic enable + description card for every plugin -->
            <div class="card">
              <div class="flex items-center gap-2 px-5 py-3 border-b border-border">
                <component :is="pluginIcon(p.name)" class="w-4 h-4 text-foreground" />
                <span class="text-sm font-semibold text-foreground">{{ pluginLabel(p.name) }}</span>
              </div>
              <div class="px-5 py-4 flex flex-col gap-3">
                <p class="text-sm text-muted-foreground">{{ p.description }}</p>
                <label class="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    class="mt-1"
                    :checked="pluginToggles[p.name] !== false"
                    @change="pluginToggles[p.name] = ($event.target as HTMLInputElement).checked"
                  />
                  <span class="flex-1">
                    <span class="block text-sm font-medium text-foreground">{{ t('discordPluginEnableLabel') }}</span>
                    <span class="block text-[11px] text-muted-foreground mt-0.5">{{ t('discordPluginEnableHint') }}</span>
                  </span>
                </label>
              </div>
            </div>

            <!-- Per-plugin extra settings -->
            <div v-if="p.name === 'welcome'" class="card">
              <div class="flex items-center gap-2 px-5 py-3 border-b border-border">
                <Hash class="w-4 h-4 text-foreground" />
                <span class="text-sm font-semibold text-foreground">{{ t('discordWelcomeChannel') }}</span>
              </div>
              <div class="px-5 py-4">
                <select v-model="welcomeChannelId" class="input-field w-full">
                  <option value="">{{ t('discordChannelNone') }}</option>
                  <option v-for="c in textChannels" :key="c.id" :value="c.id">#{{ c.name }}</option>
                </select>
                <p class="text-[11px] text-muted-foreground mt-1">{{ t('discordWelcomeChannelHint') }}</p>
              </div>
            </div>

            <div v-if="p.name === 'tournamentAnnounce'" class="card">
              <div class="flex items-center gap-2 px-5 py-3 border-b border-border">
                <Hash class="w-4 h-4 text-foreground" />
                <span class="text-sm font-semibold text-foreground">{{ t('discordTournamentChannel') }}</span>
              </div>
              <div class="px-5 py-4">
                <select v-model="tournamentChannelId" class="input-field w-full">
                  <option value="">{{ t('discordChannelNone') }}</option>
                  <option v-for="c in textChannels" :key="c.id" :value="c.id">#{{ c.name }}</option>
                </select>
                <p class="text-[11px] text-muted-foreground mt-1">{{ t('discordTournamentChannelHint') }}</p>
              </div>
            </div>

            <div v-if="p.name === 'reactionRoles'" class="card">
              <div class="flex items-center justify-between gap-2 px-5 py-3 border-b border-border">
                <div class="flex items-center gap-2">
                  <Smile class="w-4 h-4 text-foreground" />
                  <span class="text-sm font-semibold text-foreground">{{ t('discordReactionRolesSection') }}</span>
                </div>
                <button class="btn-primary text-xs" @click="openRrModal">
                  <Plus class="w-3.5 h-3.5" />
                  {{ t('discordReactionRolesAdd') }}
                </button>
              </div>
              <div class="px-5 py-4">
                <p class="text-[11px] text-muted-foreground mb-3">{{ t('discordReactionRolesHint') }}</p>
                <div v-if="reactionRolesLoading" class="text-sm text-muted-foreground py-4 text-center">{{ t('loading') }}</div>
                <div v-else-if="!reactionRoles.length" class="text-sm text-muted-foreground py-4 text-center">{{ t('discordReactionRolesEmpty') }}</div>
                <table v-else class="w-full text-sm">
                  <thead>
                    <tr class="text-left text-[11px] uppercase tracking-wide text-muted-foreground border-b border-border">
                      <th class="py-2 pr-3">{{ t('discordReactionRolesMessage') }}</th>
                      <th class="py-2 pr-3">{{ t('discordReactionRolesEmoji') }}</th>
                      <th class="py-2 pr-3">{{ t('discordReactionRolesRole') }}</th>
                      <th class="py-2 pr-3">{{ t('discordReactionRolesLabel') }}</th>
                      <th class="py-2 pr-3">{{ t('createdBy') }}</th>
                      <th class="py-2 w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in reactionRoles" :key="row.id" class="border-b border-border/50 last:border-0">
                      <td class="py-2 pr-3 font-mono text-xs">
                        <a :href="messageLink(row)" target="_blank" rel="noopener" class="text-primary hover:underline inline-flex items-center gap-1">
                          {{ row.message_id }}
                          <ExternalLink class="w-3 h-3" />
                        </a>
                      </td>
                      <td class="py-2 pr-3">{{ row.emoji }}</td>
                      <td class="py-2 pr-3">
                        <span class="inline-flex items-center gap-1.5">
                          <span class="w-2 h-2 rounded-full" :style="{ backgroundColor: roleColor(row.role_id) }" />
                          {{ roleName(row.role_id) }}
                        </span>
                      </td>
                      <td class="py-2 pr-3 text-muted-foreground">{{ row.label || '—' }}</td>
                      <td class="py-2 pr-3 text-muted-foreground">{{ row.created_by_name || '—' }}</td>
                      <td class="py-2">
                        <button class="text-destructive hover:text-destructive/80" :title="t('delete')" @click="rrDeleteTarget = row">
                          <Trash2 class="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </template>
        </template>

        <!-- ========== MATCH VOICE ========== -->
        <template v-if="activeTab === 'matchVoice'">
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
        </template>

        <div v-if="loading" class="text-center text-sm text-muted-foreground py-4">{{ t('loading') }}</div>
      </div>
    </div>

    <ModalOverlay :show="showRrModal" @close="showRrModal = false">
      <div class="px-7 py-6 flex flex-col gap-4">
        <div>
          <h2 class="text-xl font-semibold text-foreground flex items-center gap-2">
            <Smile class="w-5 h-5 text-primary" />
            {{ t('discordReactionRolesAdd') }}
          </h2>
          <p class="text-sm text-muted-foreground mt-2">{{ t('discordReactionRolesModalHint') }}</p>
        </div>
        <div>
          <label class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t('discordReactionRolesMessageLink') }}</label>
          <input
            v-model="rrForm.message_link"
            type="text"
            class="input-field w-full mt-1.5 font-mono text-xs"
            placeholder="https://discord.com/channels/.../.../..."
          />
        </div>
        <div>
          <label class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t('discordReactionRolesEmoji') }}</label>
          <input
            v-model="rrForm.emoji"
            type="text"
            class="input-field w-full mt-1.5"
            :placeholder="t('discordReactionRolesEmojiPlaceholder')"
          />
          <p class="text-[11px] text-muted-foreground mt-1">{{ t('discordReactionRolesEmojiHint') }}</p>
        </div>
        <div>
          <label class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t('discordReactionRolesRole') }}</label>
          <select v-model="rrForm.role_id" class="input-field w-full mt-1.5">
            <option value="">{{ t('discordRoleNone') }}</option>
            <option v-for="r in roles" :key="r.id" :value="r.id" :disabled="r.managed">
              {{ r.name }} {{ r.managed ? '(managed)' : '' }}
            </option>
          </select>
        </div>
        <div>
          <label class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t('discordReactionRolesLabel') }}</label>
          <input
            v-model="rrForm.label"
            type="text"
            class="input-field w-full mt-1.5"
            maxlength="120"
          />
        </div>
        <p v-if="rrError" class="text-sm text-destructive">{{ rrError }}</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" :disabled="rrSubmitting" @click="submitRr">
          <Plus class="w-4 h-4" />
          {{ rrSubmitting ? t('loading') : t('add') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showRrModal = false">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>

    <ModalOverlay :show="!!rrDeleteTarget" @close="rrDeleteTarget = null">
      <div class="px-7 py-6 flex flex-col gap-4">
        <div>
          <h2 class="text-xl font-semibold text-foreground">{{ t('discordReactionRolesDeleteTitle') }}</h2>
          <p class="text-sm text-muted-foreground mt-2">{{ t('discordReactionRolesDeleteHint') }}</p>
        </div>
        <div v-if="rrDeleteTarget" class="rounded-md bg-accent/40 border border-border p-3 text-sm">
          <div class="flex justify-between gap-3"><span class="text-muted-foreground">{{ t('discordReactionRolesEmoji') }}</span><span class="font-mono">{{ rrDeleteTarget.emoji }}</span></div>
          <div class="flex justify-between gap-3"><span class="text-muted-foreground">{{ t('discordReactionRolesRole') }}</span><span>{{ roleName(rrDeleteTarget.role_id) }}</span></div>
          <div class="flex justify-between gap-3"><span class="text-muted-foreground">{{ t('discordReactionRolesMessage') }}</span><span class="font-mono text-xs">{{ rrDeleteTarget.message_id }}</span></div>
        </div>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-destructive w-full justify-center" @click="confirmDeleteRr">
          <Trash2 class="w-4 h-4" />
          {{ t('delete') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="rrDeleteTarget = null">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>
  </div>
</template>
