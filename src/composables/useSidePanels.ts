import { ref, computed } from 'vue'

export type FriendsTab = 'friends' | 'chats'
export type SidePanel = 'friends' | 'profile' | null

const active = ref<SidePanel>(null)
const friendsTab = ref<FriendsTab>('friends')

export function useSidePanels() {
  function openFriends(tab: FriendsTab = 'friends') {
    friendsTab.value = tab
    active.value = 'friends'
  }
  function openProfile() {
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
