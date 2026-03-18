<script setup lang="ts">
defineProps<{
  result: 'W' | 'L' | 'D'
}>()

const classes: Record<string, string> = {
  W: 'map-win',
  L: 'map-loss',
  D: 'map-draw',
}
</script>

<template>
  <span :class="classes[result]">{{ result }}</span>
</template>
