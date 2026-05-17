import { ref, computed } from 'vue'
import { useApi } from './useApi'
import { useDraftStore } from './useDraftStore'

export interface FriendPlayer {
  id: number
  name: string
  display_name: string | null
  steam_name: string
  avatar_url: string | null
  mmr: number
}

export interface FriendEntry {
  id: number
  created_at: string
  responded_at?: string | null
  online?: boolean
  player: FriendPlayer
}

const friends = ref<FriendEntry[]>([])
const incoming = ref<FriendEntry[]>([])
const outgoing = ref<FriendEntry[]>([])
const blocks = ref<FriendEntry[]>([])
const loaded = ref(false)

async function loadAll() {
  const api = useApi()
  try {
    const [fs, rq, bl] = await Promise.all([
      api.getFriends(),
      api.getFriendRequests(),
      api.getFriendBlocks(),
    ])
    friends.value = fs
    incoming.value = rq.incoming
    outgoing.value = rq.outgoing
    blocks.value = bl
    loaded.value = true
  } catch {
    // Best-effort — friend system shouldn't block app boot.
  }
}

const pendingCount = computed(() => incoming.value.length)

export function useFriendStore() {
  const store = useDraftStore()
  function reset() {
    friends.value = []
    incoming.value = []
    outgoing.value = []
    blocks.value = []
    loaded.value = false
  }
  function bumpPendingFromBackend() {
    // Server tracks the canonical count too — keep currentUser in sync.
    const u = store.currentUser.value
    if (u) u.pending_friend_requests = incoming.value.length
  }
  return {
    friends: computed(() => friends.value),
    incoming: computed(() => incoming.value),
    outgoing: computed(() => outgoing.value),
    blocks: computed(() => blocks.value),
    pendingCount,
    loaded: computed(() => loaded.value),
    loadAll,
    reset,
    bumpPendingFromBackend,
  }
}
