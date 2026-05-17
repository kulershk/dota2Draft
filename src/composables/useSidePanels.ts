import { ref, computed } from 'vue'

export type SidePanel = 'friends' | 'chats' | 'notifications' | 'profile' | 'queue' | null

const active = ref<SidePanel>(null)

function toggle(p: Exclude<SidePanel, null>) {
  active.value = active.value === p ? null : p
}

export function useSidePanels() {
  return {
    active: computed(() => active.value),
    openFriends() { toggle('friends') },
    openChats() { toggle('chats') },
    openNotifications() { toggle('notifications') },
    openProfile() { toggle('profile') },
    openQueue() { toggle('queue') },
    close() { active.value = null },
  }
}
