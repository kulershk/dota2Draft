<script setup lang="ts">
const model = defineModel<string>({ default: '' })

defineProps<{
  placeholder?: string
}>()
</script>

<template>
  <div class="flex items-center gap-2 rounded-md border border-border bg-surface px-4 py-2.5 w-80 focus-within:ring-2 focus-within:ring-primary/20 focus-within:border-primary transition-colors">
    <svg class="h-3.5 w-3.5 text-text-tertiary flex-shrink-0" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
    <input
      v-model="model"
      type="text"
      :placeholder="placeholder || 'Search players...'"
      class="flex-1 bg-transparent text-sm text-foreground placeholder:text-text-muted outline-none"
    />
  </div>
</template>
