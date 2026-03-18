<script setup lang="ts">
defineProps<{
  role: string
  playerName: string
  points?: string | number
  avatar?: string
  isTotal?: boolean
}>()
</script>

<template>
  <!-- Total variant -->
  <div v-if="isTotal" class="flex flex-col items-center gap-2 rounded-lg bg-primary/10 border border-primary/25 p-3 text-center">
    <span class="stat-card-label">TOTAL</span>
    <span class="text-[22px] font-bold font-mono text-primary">{{ points }} pts</span>
  </div>
  <!-- Regular pick card -->
  <div v-else class="flex flex-col items-center gap-2 rounded-lg bg-card p-3 text-center">
    <span class="stat-card-label">{{ role }}</span>
    <div class="h-12 w-12 rounded-full bg-surface overflow-hidden">
      <img v-if="avatar" :src="avatar" class="h-full w-full object-cover" :alt="playerName" />
    </div>
    <span class="text-xs font-medium text-foreground">{{ playerName }}</span>
    <span v-if="points" class="text-[11px] font-semibold font-mono text-primary">{{ points }} pts</span>
  </div>
</template>
