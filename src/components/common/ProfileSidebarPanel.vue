<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { User, X, Settings, Shield, LogOut, ChevronRight, BadgeCheck, Sun, Moon } from 'lucide-vue-next'
import { useDraftStore } from '@/composables/useDraftStore'
import { useSidePanels } from '@/composables/useSidePanels'
import { useTheme } from '@/composables/useTheme'

const { t } = useI18n()
const router = useRouter()
const store = useDraftStore()
const panels = useSidePanels()
const theme = useTheme()

const user = computed(() => store.currentUser.value)
const initial = computed(() => {
  const n = user.value?.display_name || user.value?.name || user.value?.steam_name || '?'
  return n.charAt(0).toUpperCase()
})
const roleLabel = computed(() => {
  if (!user.value) return ''
  const parts: string[] = []
  if (user.value.is_admin) parts.push(t('admin'))
  return parts.length ? parts.join(' / ') : t('player')
})

function go(path: string | { name: string; params?: any }) {
  router.push(path as any)
  panels.close()
}
function goProfile() {
  if (user.value?.id) go({ name: 'player-profile', params: { id: user.value.id } })
}
function logout() {
  store.logout()
  panels.close()
  if (router.currentRoute.value.path.startsWith('/admin')) router.push('/')
}
</script>

<template>
  <Teleport to="body">
    <Transition name="slide-right">
      <aside
        v-if="panels.active.value === 'profile' && user"
        class="fixed top-0 bottom-0 w-[320px] z-50 flex flex-col shadow-[0_0_60px_0_rgba(0,0,0,0.8)] md:right-[70px] right-0"
        style="background:#0F172A;border-left:1px solid #22D3EE;border-right:1px solid #1E293B"
      >
        <!-- Header -->
        <div
          class="flex items-center justify-between h-[54px] px-[18px] shrink-0"
          style="background:#0A0F1C;border-bottom:1px solid #1E293B"
        >
          <div class="flex items-center gap-2">
            <User class="w-[15px] h-[15px]" style="color:#22D3EE" />
            <span class="text-[15px] font-extrabold" style="color:#F1F5F9">{{ t('myProfile') }}</span>
          </div>
          <button
            class="w-[26px] h-[26px] rounded-md flex items-center justify-center transition-colors hover:opacity-80"
            style="background:#1E293B"
            :title="t('close')"
            @click="panels.close()"
          >
            <X class="w-[13px] h-[13px]" style="color:#94A3B8" />
          </button>
        </div>

        <!-- User block -->
        <div class="flex flex-col items-center gap-3 px-6 py-7" style="border-bottom:1px solid #1E293B">
          <div
            class="relative w-[88px] h-[88px] rounded-full flex items-center justify-center"
            style="background:linear-gradient(135deg,#22D3EE,#A21CAF)"
          >
            <img v-if="user.avatar_url" :src="user.avatar_url" class="w-full h-full rounded-full object-cover" />
            <span v-else class="text-white text-[36px] font-extrabold">{{ initial }}</span>
            <span
              class="absolute right-[2px] bottom-[2px] w-[14px] h-[14px] rounded-full"
              style="background:#22C55E;box-shadow:inset 0 0 0 2px #0F172A"
            />
          </div>
          <div class="text-center flex flex-col items-center gap-1">
            <div class="flex items-center gap-1.5">
              <span class="text-[16px] font-extrabold truncate max-w-[240px]" style="color:#F1F5F9">{{ user.display_name || user.name }}</span>
              <BadgeCheck v-if="user.mmr_verified_at" class="w-4 h-4 text-cyan-400" :title="t('mmrVerifiedTooltip')" />
            </div>
            <span class="text-[11px] font-mono font-bold tracking-[1px]" style="color:#22D3EE">{{ roleLabel.toUpperCase() }}</span>
          </div>
          <div class="flex items-center gap-4 mt-1">
            <div class="flex flex-col items-center">
              <span class="text-[11px] font-mono font-bold tracking-[1.2px]" style="color:#475569">MMR</span>
              <span class="text-[15px] font-extrabold font-mono" style="color:#22D3EE">{{ (user.mmr || 0).toLocaleString() }}</span>
            </div>
            <div class="w-px h-7" style="background:#1E293B" />
            <div class="flex flex-col items-center">
              <span class="text-[11px] font-mono font-bold tracking-[1.2px]" style="color:#475569">{{ t('dotacoins').toUpperCase() }}</span>
              <span class="text-[15px] font-extrabold font-mono" style="color:#FACC15">{{ (user.dotacoins || 0).toLocaleString() }}</span>
            </div>
          </div>
        </div>

        <!-- Menu -->
        <div class="flex-1 overflow-y-auto p-2 flex flex-col gap-0.5">
          <button class="profile-row" @click="goProfile">
            <span class="profile-row-icon">
              <User class="w-[14px] h-[14px]" style="color:#22D3EE" />
            </span>
            <span class="flex-1 text-left text-[13px] font-semibold" style="color:#F1F5F9">{{ t('myProfile') }}</span>
            <ChevronRight class="w-3.5 h-3.5" style="color:#475569" />
          </button>

          <button class="profile-row" @click="go('/settings')">
            <span class="profile-row-icon">
              <Settings class="w-[14px] h-[14px]" style="color:#22D3EE" />
            </span>
            <span class="flex-1 text-left text-[13px] font-semibold" style="color:#F1F5F9">{{ t('settingsTitle') }}</span>
            <ChevronRight class="w-3.5 h-3.5" style="color:#475569" />
          </button>

          <button v-if="store.canAccessAdmin.value" class="profile-row" @click="go('/admin')">
            <span class="profile-row-icon">
              <Shield class="w-[14px] h-[14px]" style="color:#22D3EE" />
            </span>
            <span class="flex-1 text-left text-[13px] font-semibold" style="color:#F1F5F9">{{ t('adminPanel') }}</span>
            <ChevronRight class="w-3.5 h-3.5" style="color:#475569" />
          </button>

          <button class="profile-row" @click="theme.toggle()">
            <span class="profile-row-icon">
              <Moon v-if="theme.isDark.value" class="w-[14px] h-[14px]" style="color:#22D3EE" />
              <Sun v-else class="w-[14px] h-[14px]" style="color:#22D3EE" />
            </span>
            <span class="flex-1 text-left text-[13px] font-semibold" style="color:#F1F5F9">
              {{ theme.isDark.value ? t('lightMode') : t('darkMode') }}
            </span>
          </button>

          <div class="my-2 mx-3 h-px" style="background:#1E293B" />

          <button class="profile-row" style="color:#FCA5A5" @click="logout">
            <span class="profile-row-icon" style="background:rgba(239,68,68,0.1);box-shadow:inset 0 0 0 1px rgba(239,68,68,0.25)">
              <LogOut class="w-[14px] h-[14px]" style="color:#EF4444" />
            </span>
            <span class="flex-1 text-left text-[13px] font-semibold">{{ t('logout') }}</span>
          </button>
        </div>
      </aside>
    </Transition>
  </Teleport>
</template>

<style scoped>
.slide-right-enter-active,
.slide-right-leave-active {
  transition: transform 220ms ease;
}
.slide-right-enter-from,
.slide-right-leave-to {
  transform: translateX(100%);
}
.profile-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  transition: background-color 0.15s;
}
.profile-row:hover {
  background: rgba(255, 255, 255, 0.04);
}
.profile-row-icon {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0B1A2E;
  box-shadow: inset 0 0 0 1px #1E3A5F;
}
</style>
