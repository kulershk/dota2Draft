<script setup lang="ts">
defineProps<{
  label: string
  value: string | number
  variant?: 'default' | 'accented' | 'mini'
}>()
</script>

<template>
  <div :class="variant === 'accented' ? 'stat-card-accented' : 'stat-card'">
    <span class="stat-card-label">{{ label }}</span>
    <span :class="variant === 'mini' ? 'stat-card-value-accent' : 'stat-card-value'">{{ value }}</span>
  </div>
</template>
