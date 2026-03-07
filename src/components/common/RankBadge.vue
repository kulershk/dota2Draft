<script setup lang="ts">
import { getRank } from '@/utils/ranks'

defineProps<{
  mmr: number
  size?: 'sm' | 'md' | 'lg'
}>()

const sizeClass: Record<string, string> = { sm: 'w-5 h-5', md: 'w-8 h-8', lg: 'w-12 h-12' }
</script>

<template>
  <span class="relative flex-shrink-0" :class="sizeClass[size || 'sm']" :title="getRank(mmr).label">
    <img :src="getRank(mmr).icon" :alt="getRank(mmr).label" :class="sizeClass[size || 'sm']" />
    <img v-if="getRank(mmr).star" :src="getRank(mmr).star" class="absolute inset-0" :class="sizeClass[size || 'sm']" />
  </span>
</template>
