<script setup lang="ts">
defineProps<{
  variant: 'success' | 'warning' | 'error' | 'info' | 'accent' | 'purple'
}>()

const classes: Record<string, string> = {
  success: 'badge-success',
  warning: 'badge-warning',
  error: 'badge-danger',
  info: 'badge-info',
  accent: 'badge-accent',
  purple: 'badge-purple',
}
</script>

<template>
  <span :class="classes[variant]">
    <slot />
  </span>
</template>
