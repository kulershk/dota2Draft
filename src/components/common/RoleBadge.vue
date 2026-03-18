<script setup lang="ts">
import { roleColors } from '@/utils/roles'

defineProps<{
  role: string
  size?: 'sm' | 'xs'
}>()
</script>

<template>
  <span
    :class="[
      roleColors[role] || 'badge-accent',
      size === 'xs' ? '!px-1.5 !py-0 !text-[9px]' : ''
    ]"
  >{{ role }}</span>
</template>
