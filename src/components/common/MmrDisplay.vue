<script setup lang="ts">
import RankBadge from './RankBadge.vue'

defineProps<{
  mmr: number
  size?: 'sm' | 'md' | 'lg'
}>()

const textClass: Record<string, string> = { sm: 'text-sm', md: 'text-base', lg: 'text-xl font-semibold' }
</script>

<template>
  <span class="inline-flex items-center gap-2">
    <RankBadge :mmr="mmr" :size="size || 'sm'" />
    <span class="font-mono text-foreground" :class="textClass[size || 'sm']">{{ mmr.toLocaleString() }}</span>
  </span>
</template>
