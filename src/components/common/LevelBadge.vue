<script setup lang="ts">
defineProps<{
  level: number
  size?: 'sm' | 'md' | 'lg'
}>()
</script>

<template>
  <span
    class="inline-flex items-center justify-center font-bold font-mono rounded-full bg-primary/15 text-primary border border-primary/25"
    :class="size === 'lg' ? 'w-10 h-10 text-base' : size === 'md' ? 'w-7 h-7 text-xs' : 'w-5 h-5 text-[10px]'"
    :title="`Level ${level}`"
  >{{ level }}</span>
</template>
