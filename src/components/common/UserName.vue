<script setup lang="ts">
defineProps<{
  id: number
  name: string
  avatarUrl?: string | null
  size?: 'xs' | 'sm' | 'md'
}>()

const avatarClass: Record<string, string> = {
  xs: 'w-4 h-4 text-[8px]',
  sm: 'w-5 h-5 text-[9px]',
  md: 'w-6 h-6 text-[10px]',
}

const textClass: Record<string, string> = {
  xs: 'text-[11px]',
  sm: 'text-xs',
  md: 'text-sm',
}
</script>

<template>
  <router-link
    :to="{ name: 'player-profile', params: { id } }"
    class="inline-flex items-center gap-1.5 hover:text-primary transition-colors min-w-0"
  >
    <div class="rounded-full bg-surface overflow-hidden shrink-0 flex items-center justify-center font-semibold text-muted-foreground" :class="avatarClass[size || 'md']">
      <img v-if="avatarUrl" :src="avatarUrl" class="w-full h-full object-cover" />
      <span v-else>{{ name.charAt(0).toUpperCase() }}</span>
    </div>
    <span class="font-medium text-foreground truncate" :class="textClass[size || 'md']"><slot>{{ name }}</slot></span>
  </router-link>
</template>
