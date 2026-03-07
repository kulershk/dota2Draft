<script setup lang="ts">
import { X } from 'lucide-vue-next'
defineProps<{ show: boolean; wide?: boolean }>()
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
      <div v-if="show" class="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/40">
        <div class="relative w-full max-h-[90vh] overflow-y-auto bg-card rounded-t-xl md:rounded border border-border shadow-lg" :class="wide ? 'md:w-[780px]' : 'md:w-[520px]'">
          <button class="absolute top-4 right-4 z-10 p-1.5 rounded-md hover:bg-accent transition-colors text-muted-foreground hover:text-foreground" @click="$emit('close')">
            <X class="w-4 h-4" />
          </button>
          <slot />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
