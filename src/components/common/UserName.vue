<script setup lang="ts">
import { Crown } from 'lucide-vue-next'

defineProps<{
  id: number
  name: string
  avatarUrl?: string | null
  size?: 'xs' | 'sm' | 'md'
  noLink?: boolean
  isAdmin?: boolean
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

const crownClass: Record<string, string> = {
  xs: 'w-2.5 h-2.5 -top-1.5',
  sm: 'w-3 h-3 -top-2',
  md: 'w-3.5 h-3.5 -top-2',
}
</script>

<template>
  <component
    :is="noLink ? 'span' : 'router-link'"
    v-bind="noLink ? {} : { to: { name: 'player-profile', params: { id } } }"
    class="inline-flex items-center gap-1.5 min-w-0 group"
    :class="noLink ? '' : 'hover:opacity-80 transition-opacity'"
  >
    <div class="relative shrink-0">
      <Crown v-if="isAdmin" class="text-amber-500 absolute left-1/2 -translate-x-1/2 drop-shadow" :class="crownClass[size || 'md']" />
      <div class="rounded-full bg-surface overflow-hidden flex items-center justify-center font-semibold text-muted-foreground" :class="avatarClass[size || 'md']">
        <img v-if="avatarUrl" :src="avatarUrl" class="w-full h-full object-cover" />
        <span v-else>{{ name.charAt(0).toUpperCase() }}</span>
      </div>
    </div>
    <span class="font-medium text-foreground truncate transition-colors" :class="[textClass[size || 'md'], noLink ? '' : 'group-hover:!text-primary']"><slot>{{ name }}</slot></span>
  </component>
</template>
