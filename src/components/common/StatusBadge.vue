<script setup lang="ts">
defineProps<{
  variant: 'success' | 'warning' | 'error' | 'info'
}>()

const classes: Record<string, string> = {
  success: 'bg-color-success text-color-success-foreground',
  warning: 'bg-color-warning text-color-warning-foreground',
  error: 'bg-color-error text-color-error-foreground',
  info: 'bg-color-info text-color-info-foreground',
}
</script>

<template>
  <span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium" :class="classes[variant]">
    <slot />
  </span>
</template>
