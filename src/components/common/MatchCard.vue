<script setup lang="ts">
defineProps<{
  leftTeam: string
  rightTeam: string
  leftScore: number
  rightScore: number
  leftAvatar?: string
  rightAvatar?: string
}>()
</script>

<template>
  <div class="flex items-center justify-between rounded-md bg-card px-5 py-3.5">
    <div class="flex items-center gap-2.5">
      <div class="h-7 w-7 rounded bg-surface overflow-hidden flex-shrink-0">
        <img v-if="leftAvatar" :src="leftAvatar" class="h-full w-full object-cover" :alt="leftTeam" />
      </div>
      <span class="text-sm font-medium text-foreground">{{ leftTeam }}</span>
    </div>
    <div class="flex items-center gap-2 font-mono text-lg font-bold">
      <span :class="leftScore > rightScore ? 'text-color-success' : 'text-destructive'">{{ leftScore }}</span>
      <span class="text-text-tertiary font-normal">:</span>
      <span :class="rightScore > leftScore ? 'text-color-success' : 'text-destructive'">{{ rightScore }}</span>
    </div>
    <div class="flex items-center gap-2.5">
      <span class="text-sm font-medium text-foreground">{{ rightTeam }}</span>
      <div class="h-7 w-7 rounded bg-surface overflow-hidden flex-shrink-0">
        <img v-if="rightAvatar" :src="rightAvatar" class="h-full w-full object-cover" :alt="rightTeam" />
      </div>
    </div>
  </div>
</template>
