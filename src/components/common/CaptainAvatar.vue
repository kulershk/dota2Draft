<script setup lang="ts">
defineProps<{
  name: string
  online?: boolean
  size?: 'sm' | 'md'
}>()
</script>

<template>
  <div class="relative">
    <div
      class="rounded-full flex items-center justify-center font-semibold bg-secondary text-secondary-foreground"
      :class="size === 'sm' ? 'w-7 h-7 text-[10px]' : 'w-8 h-8 text-xs'"
    >
      {{ name.charAt(0) }}
    </div>
    <span v-if="online" class="absolute bottom-0 right-0 block rounded-full bg-green-500 ring-2 ring-card" :class="size === 'sm' ? 'w-2 h-2' : 'w-2.5 h-2.5'"></span>
  </div>
</template>
