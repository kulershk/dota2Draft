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
  in_queue?: boolean
  in_match?: boolean
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

// Presence-only refresh: re-fetches just the friends list (which carries the
// online / in_queue / in_match flags) without touching requests or blocks.
// Cheap enough to poll on an interval so queue/match status stays live.
async function refreshPresence() {
  if (!loaded.value) return
  const api = useApi()
  try {
    friends.value = await api.getFriends()
  } catch {
    // Best-effort; a transient failure just leaves the last-known presence.
  }
}

// Patch a single friend's live presence from a server push (friend:presence),
// avoiding a full refetch. Deep reactivity on the ref array makes the in-place
// flag update flow through to the sidebar.
function applyPresence(p: { playerId: number; online: boolean; in_queue: boolean; in_match: boolean }) {
  if (!p?.playerId) return
  const f = friends.value.find(x => x.player.id === p.playerId)
  if (!f) return
  f.online = p.online
  f.in_queue = p.in_queue
  f.in_match = p.in_match
}

const pendingCount = computed(() => incoming.value.length)
const onlineCount = computed(() => friends.value.filter(f => f.online).length)

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
    onlineCount,
    loaded: computed(() => loaded.value),
    loadAll,
    refreshPresence,
    applyPresence,
    reset,
    bumpPendingFromBackend,
  }
}
