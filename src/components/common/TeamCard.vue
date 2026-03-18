<script setup lang="ts">
defineProps<{
  name: string
  avatar?: string
  wins?: number
  losses?: number
  players?: Array<{ name: string; avatar?: string; role?: string }>
}>()
</script>

<template>
  <div class="rounded-lg bg-card overflow-hidden">
    <!-- Header -->
    <div class="flex items-center gap-3 bg-surface px-5 py-4">
      <div class="h-12 w-12 rounded-lg bg-card overflow-hidden flex-shrink-0">
        <img v-if="avatar" :src="avatar" class="h-full w-full object-cover" :alt="name" />
      </div>
      <div class="flex flex-col gap-1">
        <span class="text-base font-semibold text-foreground">{{ name }}</span>
        <div v-if="wins != null || losses != null" class="flex items-center gap-2">
          <span v-if="wins != null" class="map-win">W</span>
          <span v-if="wins != null" class="text-xs font-mono text-color-success">{{ wins }}</span>
          <span v-if="losses != null" class="map-loss">L</span>
          <span v-if="losses != null" class="text-xs font-mono text-destructive">{{ losses }}</span>
        </div>
      </div>
    </div>

    <!-- Players -->
    <div v-if="players?.length" class="flex flex-col gap-2 px-5 py-3">
      <div v-for="(player, i) in players" :key="i" class="flex items-center gap-2">
        <div class="h-6 w-6 rounded-full bg-surface overflow-hidden flex-shrink-0">
          <img v-if="player.avatar" :src="player.avatar" class="h-full w-full object-cover" :alt="player.name" />
        </div>
        <span class="text-sm text-foreground">{{ player.name }}</span>
        <span v-if="player.role" class="badge-accent">{{ player.role }}</span>
      </div>
    </div>

    <!-- Win/Loss bar -->
    <div v-if="wins != null && losses != null" class="flex h-1 rounded-b-lg overflow-hidden">
      <div class="bg-color-success" :style="{ width: `${(wins / (wins + losses)) * 100}%` }" />
      <div class="bg-destructive flex-1" />
    </div>
  </div>
</template>
