import { ref, computed } from 'vue'

export type FriendsTab = 'friends' | 'chats' | 'notifications'
export type SidePanel = 'friends' | 'profile' | null

const active = ref<SidePanel>(null)
const friendsTab = ref<FriendsTab>('friends')

export function useSidePanels() {
  // Re-clicking the same trigger closes the panel (and re-clicking the
  // already-active friends tab does the same).
  function openFriends(tab: FriendsTab = 'friends') {
    if (active.value === 'friends' && friendsTab.value === tab) {
      active.value = null
      return
    }
    friendsTab.value = tab
    active.value = 'friends'
  }
  function openProfile() {
    if (active.value === 'profile') {
      active.value = null
      return
    }
    active.value = 'profile'
  }
  function close() {
    active.value = null
  }
  return {
    active: computed(() => active.value),
    friendsTab: computed(() => friendsTab.value),
    setFriendsTab(tab: FriendsTab) { friendsTab.value = tab },
    openFriends,
    openProfile,
    close,
  }
}
