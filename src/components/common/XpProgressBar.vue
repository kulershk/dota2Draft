<script setup lang="ts">
defineProps<{
  current: number
  max?: number
}>()
</script>

<template>
  <div class="flex items-center gap-2 w-full">
    <div class="flex-1 h-1.5 rounded-full bg-surface overflow-hidden">
      <div class="h-full rounded-full bg-primary transition-all" :style="{ width: `${Math.min(100, (current / (max || 1000)) * 100)}%` }" />
    </div>
    <span class="text-[11px] font-mono text-muted-foreground shrink-0">{{ current }}/{{ max || 1000 }}</span>
  </div>
</template>
