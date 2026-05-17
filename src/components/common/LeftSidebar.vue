<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  Swords, Home, Calendar, Newspaper, Trophy, Medal, Settings, Shield, User, Radio,
  Store, HelpCircle, LogOut, LogIn, Sun, Moon,
} from 'lucide-vue-next'
import { useNavStore, type NavItem, type NavRoot } from '@/composables/useNavStore'
import { useDraftStore } from '@/composables/useDraftStore'

const props = defineProps<{
  siteName: string
  logoUrl: string
  isDark: boolean
  isLoggedIn: boolean
  myMatchCount: number
}>()

const emit = defineEmits<{
  toggleTheme: []
  login: []
  logout: []
}>()

const { t, locale } = useI18n()
const route = useRoute()
const navStore = useNavStore()
const store = useDraftStore()

const ICON_MAP: Record<string, any> = {
  Home, Swords, Calendar, Newspaper, Trophy, Medal, Settings, Shield, User, Radio,
}
function iconFor(name: string) { return ICON_MAP[name] || Swords }

function labelFor(item: NavItem): string {
  if (item.labels) {
    const cur = locale.value as 'en' | 'lv' | 'lt'
    const fromLabels = item.labels[cur] || item.labels.en
    if (fromLabels) return fromLabels
  }
  if (item.label_key) return t(item.label_key)
  return item.path || '?'
}

function isActive(item: NavItem): boolean {
  if (item.active_match) {
    try { return new RegExp(item.active_match).test(route.path) }
    catch { return route.path.startsWith(item.active_match) }
  }
  return route.path === item.path
}
function isAnyActive(root: NavRoot): boolean {
  return isActive(root) || root.children.some(isActive)
}

const brandName = computed(() => props.siteName || 'DOTA LATVIJA')
</script>

<template>
  <aside
    class="hidden md:flex flex-col shrink-0 w-[240px] gap-2 py-4 px-3 border-r overflow-y-auto"
    style="background:#0A0E12;border-color:#1F2731"
  >
    <!-- Brand -->
    <router-link to="/" class="flex items-center gap-2.5 px-1 py-1">
      <div
        v-if="logoUrl"
        class="w-8 h-8 rounded-[10px] overflow-hidden flex items-center justify-center shrink-0"
      >
        <img :src="logoUrl" class="w-full h-full object-cover" />
      </div>
      <div
        v-else
        class="w-8 h-8 rounded-[10px] flex items-center justify-center shrink-0"
        style="background:linear-gradient(135deg,#22D3EE,#0EA5E9)"
      >
        <Swords class="w-[22px] h-[22px]" style="color:#0A0F1C" />
      </div>
      <div class="flex flex-col leading-tight min-w-0">
        <span class="text-[13px] font-extrabold tracking-[1px] truncate" style="color:#F1F5F9">{{ brandName }}</span>
        <span class="text-[9px] font-medium" style="color:#475569">{{ t('siteTagline') }}</span>
      </div>
    </router-link>

    <div class="w-8 h-px ml-3" style="background:#1E293B" />

    <!-- NAVIGATE -->
    <div class="flex flex-col gap-0.5">
      <div class="px-3 pt-1 pb-1.5">
        <span class="text-[9px] font-extrabold tracking-[1.2px]" style="color:#475569">{{ t('navSectionNavigate') }}</span>
      </div>

      <template v-for="root in navStore.tree.value" :key="root.id">
        <a
          v-if="root.is_external && root.path"
          :href="root.path"
          target="_blank"
          rel="noopener"
          class="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-[13px] font-semibold transition-colors hover:bg-white/5"
          style="color:#CBD5E1"
        >
          <component :is="iconFor(root.icon)" class="w-[14px] h-[14px] shrink-0" style="color:#94A3B8" />
          <span class="flex-1 truncate">{{ labelFor(root) }}</span>
        </a>

        <router-link
          v-else-if="root.path"
          :to="root.path"
          class="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-[13px] font-semibold transition-colors"
          :class="isAnyActive(root) ? 'sidebar-item-active' : 'sidebar-item-idle'"
        >
          <component
            :is="iconFor(root.icon)"
            class="w-[14px] h-[14px] shrink-0"
            :style="{ color: isAnyActive(root) ? '#22D3EE' : '#94A3B8' }"
          />
          <span class="flex-1 truncate">{{ labelFor(root) }}</span>
          <span
            v-if="root.badge === 'my-matches' && myMatchCount > 0"
            class="inline-flex items-center justify-center text-[10px] font-extrabold text-white px-[7px] py-[1px] rounded-[5px]"
            style="background:#EF4444"
          >
            {{ myMatchCount }}
          </span>
        </router-link>

        <div
          v-else
          class="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-[13px] font-semibold select-none"
          style="color:#94A3B8"
        >
          <component :is="iconFor(root.icon)" class="w-[14px] h-[14px] shrink-0" style="color:#94A3B8" />
          <span class="flex-1 truncate">{{ labelFor(root) }}</span>
        </div>

        <!-- Child links nested under their parent -->
        <template v-for="child in root.children" :key="child.id">
          <a
            v-if="child.is_external && child.path"
            :href="child.path"
            target="_blank"
            rel="noopener"
            class="flex items-center gap-2.5 rounded-lg pl-9 pr-3 py-2 text-[12px] transition-colors hover:bg-white/5"
            style="color:#94A3B8"
          >
            <component :is="iconFor(child.icon)" class="w-[12px] h-[12px] shrink-0" />
            <span class="flex-1 truncate">{{ labelFor(child) }}</span>
          </a>
          <router-link
            v-else-if="child.path"
            :to="child.path"
            class="flex items-center gap-2.5 rounded-lg pl-9 pr-3 py-2 text-[12px] transition-colors"
            :class="isActive(child) ? 'sidebar-child-active' : 'sidebar-child-idle'"
          >
            <component
              :is="iconFor(child.icon)"
              class="w-[12px] h-[12px] shrink-0"
              :style="{ color: isActive(child) ? '#22D3EE' : '#94A3B8' }"
            />
            <span class="flex-1 truncate">{{ labelFor(child) }}</span>
          </router-link>
        </template>
      </template>
    </div>

    <div class="h-px w-full" style="background:#1E293B" />

    <!-- ACCOUNT -->
    <div class="flex flex-col gap-0.5">
      <div class="px-3 pt-1 pb-1.5">
        <span class="text-[9px] font-extrabold tracking-[1.2px]" style="color:#475569">{{ t('navSectionAccount') }}</span>
      </div>

      <router-link
        v-if="isLoggedIn"
        to="/settings"
        class="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-[13px] font-semibold transition-colors"
        :class="route.path === '/settings' ? 'sidebar-item-active' : 'sidebar-item-idle'"
      >
        <Settings class="w-[14px] h-[14px] shrink-0" :style="{ color: route.path === '/settings' ? '#22D3EE' : '#94A3B8' }" />
        <span class="flex-1 truncate">{{ t('settingsTitle') }}</span>
      </router-link>

      <router-link
        v-if="store.canAccessAdmin.value"
        to="/admin"
        class="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-[13px] font-semibold transition-colors"
        :class="route.path.startsWith('/admin') ? 'sidebar-item-active' : 'sidebar-item-idle'"
      >
        <Shield class="w-[14px] h-[14px] shrink-0" :style="{ color: route.path.startsWith('/admin') ? '#22D3EE' : '#94A3B8' }" />
        <span class="flex-1 truncate">{{ t('adminPanel') }}</span>
      </router-link>

      <button
        class="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-[13px] font-semibold sidebar-item-idle transition-colors"
        @click="emit('toggleTheme')"
      >
        <Moon v-if="isDark" class="w-[14px] h-[14px] shrink-0" style="color:#94A3B8" />
        <Sun v-else class="w-[14px] h-[14px] shrink-0" style="color:#94A3B8" />
        <span class="flex-1 truncate text-left">{{ isDark ? t('lightMode') : t('darkMode') }}</span>
      </button>

      <button
        v-if="isLoggedIn"
        class="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-[13px] font-semibold transition-colors hover:bg-white/5"
        style="color:#FCA5A5"
        @click="emit('logout')"
      >
        <LogOut class="w-[14px] h-[14px] shrink-0" />
        <span class="flex-1 truncate text-left">{{ t('logout') }}</span>
      </button>

      <button
        v-else
        class="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-[13px] font-semibold sidebar-item-idle transition-colors"
        @click="emit('login')"
      >
        <LogIn class="w-[14px] h-[14px] shrink-0" style="color:#94A3B8" />
        <span class="flex-1 truncate text-left">{{ t('loginWithSteam') }}</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.sidebar-item-idle {
  color: #CBD5E1;
}
.sidebar-item-idle:hover {
  background: rgba(255, 255, 255, 0.04);
}
.sidebar-item-active {
  color: #22D3EE;
  background: #0B1A2E;
  box-shadow: inset 0 0 0 1px #1E3A5F;
}
.sidebar-child-idle {
  color: #94A3B8;
}
.sidebar-child-idle:hover {
  background: rgba(255, 255, 255, 0.04);
}
.sidebar-child-active {
  color: #22D3EE;
  background: rgba(11, 26, 46, 0.7);
}
</style>
