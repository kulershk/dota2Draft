<script setup lang="ts">
defineProps<{
  variant?: 'primary' | 'secondary' | 'destructive' | 'outline' | 'ghost'
  disabled?: boolean
}>()
</script>

<template>
  <button
    :class="[
      variant === 'destructive' ? 'btn-destructive' :
      variant === 'secondary' ? 'btn-secondary' :
      variant === 'outline' ? 'btn-outline' :
      variant === 'ghost' ? 'btn-ghost' :
      'btn-primary'
    ]"
    :disabled="disabled"
    v-bind="$attrs"
  >
    <slot />
  </button>
</template>
