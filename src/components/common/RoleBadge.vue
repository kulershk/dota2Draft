<script setup lang="ts">
import { roleColors } from '@/utils/roles'

defineProps<{
  role: string
  size?: 'sm' | 'xs'
}>()
</script>

<template>
  <span
    class="inline-flex items-center rounded-full font-medium"
    :class="[
      roleColors[role] || 'bg-muted text-muted-foreground',
      size === 'xs' ? 'px-1.5 py-0 text-[9px]' : 'px-2 py-0.5 text-[10px]'
    ]"
  >{{ role }}</span>
</template>
