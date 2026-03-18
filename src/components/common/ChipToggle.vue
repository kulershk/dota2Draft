<script setup lang="ts">
defineProps<{
  active?: boolean
}>()

defineEmits<{
  click: []
}>()
</script>

<template>
  <button :class="active ? 'chip-active' : 'chip-default'" @click="$emit('click')">
    <slot />
  </button>
</template>
