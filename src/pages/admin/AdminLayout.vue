<script setup lang="ts">
import { Settings, Newspaper, ChevronRight } from 'lucide-vue-next'
import { useRoute } from 'vue-router'

const route = useRoute()

const adminNav = [
  { label: 'News', icon: Newspaper, path: '/admin/news' },
  { label: 'Draft Setup', icon: Settings, path: '/admin/draft' },
]
</script>

<template>
  <div class="flex flex-1 overflow-hidden">
    <!-- Sidebar -->
    <aside class="hidden md:flex flex-col w-56 bg-sidebar border-r border-sidebar-border shrink-0">
      <div class="px-4 py-4 border-b border-sidebar-border">
        <h2 class="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Admin Panel</h2>
      </div>
      <nav class="flex flex-col gap-0.5 p-2">
        <router-link
          v-for="item in adminNav"
          :key="item.path"
          :to="item.path"
          class="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors"
          :class="route.path === item.path
            ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
            : 'text-sidebar-foreground hover:bg-accent'"
        >
          <component :is="item.icon" class="w-4 h-4" />
          {{ item.label }}
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
        :class="route.path === item.path
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
