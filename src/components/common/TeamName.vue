<script setup lang="ts">
defineProps<{
  id: number
  name: string
  avatarUrl?: string | null
  bannerUrl?: string | null
  size?: 'xs' | 'sm' | 'md'
  noLink?: boolean
  reverse?: boolean
}>()

const imgClass: Record<string, string> = {
  xs: 'w-4 h-4',
  sm: 'w-5 h-5',
  md: 'w-6 h-6',
}

const textClass: Record<string, string> = {
  xs: 'text-[11px]',
  sm: 'text-xs',
  md: 'text-sm',
}
</script>

<template>
  <component
    :is="noLink ? 'span' : 'router-link'"
    v-bind="noLink ? {} : { to: { name: 'team-profile', params: { id } } }"
    class="inline-flex items-center gap-1.5 min-w-0 group"
    :class="[noLink ? '' : 'hover:opacity-80 transition-opacity', reverse ? 'flex-row-reverse' : '']"
  >
    <div class="rounded bg-surface overflow-hidden shrink-0 flex items-center justify-center font-semibold text-muted-foreground" :class="imgClass[size || 'md']">
      <img v-if="bannerUrl || avatarUrl" :src="(bannerUrl || avatarUrl)!" class="w-full h-full object-cover" />
      <span v-else class="text-[9px]">{{ name.charAt(0).toUpperCase() }}</span>
    </div>
    <span class="font-medium text-foreground truncate transition-colors" :class="[textClass[size || 'md'], noLink ? '' : 'group-hover:text-primary']"><slot>{{ name }}</slot></span>
  </component>
</template>
