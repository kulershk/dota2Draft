import { ref, computed } from 'vue'

// Shared open/close state for the in-queue slot machine modal. Kept module-
// level so the trigger buttons (queue page, queue side panel) and the modal
// (mounted once in App.vue) share one source of truth.
const open = ref(false)

export function useSlotMachine() {
  return {
    isOpen: computed(() => open.value),
    openSlots() { open.value = true },
    closeSlots() { open.value = false },
  }
}
