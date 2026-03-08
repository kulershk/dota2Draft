<script setup lang="ts">
import { Newspaper, Users, Trophy, ChevronRight, Settings, ShieldCheck } from 'lucide-vue-next'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const route = useRoute()

const adminNav = [
  { labelKey: 'adminCompetitions', icon: Trophy, path: '/admin/competitions' },
  { labelKey: 'users', icon: Users, path: '/admin/users' },
  { labelKey: 'newsAnnouncements', icon: Newspaper, path: '/admin/news' },
  { labelKey: 'siteSettings', icon: Settings, path: '/admin/settings' },
  { labelKey: 'permissionGroups', icon: ShieldCheck, path: '/admin/permissions' },
]
</script>

<template>
  <div class="flex flex-1 overflow-hidden">
    <!-- Sidebar -->
    <aside class="hidden md:flex flex-col w-56 bg-sidebar border-r border-sidebar-border shrink-0">
      <div class="px-4 py-4 border-b border-sidebar-border">
        <h2 class="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{{ t('adminPanel') }}</h2>
      </div>
      <nav class="flex flex-col gap-0.5 p-2">
        <router-link
          v-for="item in adminNav"
          :key="item.path"
          :to="item.path"
          class="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors"
          :class="route.path.startsWith(item.path)
            ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
            : 'text-sidebar-foreground hover:bg-accent'"
        >
          <component :is="item.icon" class="w-4 h-4" />
          {{ t(item.labelKey) }}
        </router-link>
      </nav>
    </aside>

    <!-- Mobile admin nav -->
    <div class="md:hidden flex items-center gap-1 px-4 py-2 border-b border-border bg-accent/30 w-full absolute z-10">
      <router-link
        v-for="item in adminNav"
        :key="item.path"
        :to="item.path"
        class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors"
        :class="route.path.startsWith(item.path)
          ? 'bg-primary text-primary-foreground font-medium'
          : 'text-muted-foreground hover:bg-accent'"
      >
        <component :is="item.icon" class="w-3.5 h-3.5" />
        {{ item.label }}
      </router-link>
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto">
      <div class="md:hidden h-11"></div>
      <router-view />
    </div>
  </div>
</template>
