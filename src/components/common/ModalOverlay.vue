<script setup lang="ts">
defineProps<{ show: boolean }>()
defineEmits<{ close: [] }>()
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-200"
      leave-active-class="transition-opacity duration-200"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div v-if="show" class="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/40" @click.self="$emit('close')">
        <div class="w-full md:w-[520px] max-h-[90vh] overflow-y-auto bg-card rounded-t-xl md:rounded border border-border shadow-lg">
          <slot />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
