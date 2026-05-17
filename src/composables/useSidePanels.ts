import { ref, computed } from 'vue'

export type SidePanel = 'friends' | 'chats' | 'notifications' | 'profile' | null

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
    close() { active.value = null },
  }
}
