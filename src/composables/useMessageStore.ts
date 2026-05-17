import { ref, computed } from 'vue'
import { useApi } from './useApi'

export interface MessagePeer {
  id: number
  name: string
  display_name: string | null
  steam_name: string
  avatar_url: string | null
  mmr: number
}

export interface DirectMessage {
  id: number
  sender_id: number
  recipient_id: number
  body: string
  created_at: string
  read_at: string | null
}

export interface MessageThread {
  peer: MessagePeer
  last_message: DirectMessage
  unread: number
}

const threads = ref<MessageThread[]>([])
const threadMessages = ref<Record<number, DirectMessage[]>>({})
const currentPeerId = ref<number | null>(null)
const loadedThreads = ref(false)

const unreadCount = computed(() =>
  threads.value.reduce((sum, t) => sum + (t.unread || 0), 0),
)

const currentMessages = computed(() => {
  if (currentPeerId.value == null) return []
  return threadMessages.value[currentPeerId.value] || []
})

const currentPeer = computed<MessagePeer | null>(() => {
  if (currentPeerId.value == null) return null
  return threads.value.find(t => t.peer.id === currentPeerId.value)?.peer || null
})

async function loadThreads() {
  const api = useApi()
  try {
    threads.value = await api.getMessageThreads()
    loadedThreads.value = true
  } catch {
    // best-effort
  }
}

async function openThread(peer: MessagePeer) {
  currentPeerId.value = peer.id
  if (!threads.value.find(t => t.peer.id === peer.id)) {
    // Inject a placeholder thread head so the conversation UI has the peer
    // info while we wait for first real message.
    threads.value = [
      ...threads.value,
      {
        peer,
        last_message: { id: 0, sender_id: 0, recipient_id: 0, body: '', created_at: new Date().toISOString(), read_at: null },
        unread: 0,
      },
    ]
  }
  const api = useApi()
  try {
    const msgs = await api.getMessageThread(peer.id)
    threadMessages.value = { ...threadMessages.value, [peer.id]: msgs }
    // Mark anything from peer as read.
    if (msgs.some(m => m.recipient_id !== peer.id && !m.read_at)) {
      await api.markMessagesRead(peer.id).catch(() => {})
      // Zero-out unread for this thread locally.
      const t = threads.value.find(x => x.peer.id === peer.id)
      if (t) t.unread = 0
    }
  } catch {
    threadMessages.value = { ...threadMessages.value, [peer.id]: [] }
  }
}

function closeThread() {
  currentPeerId.value = null
}

async function sendMessage(body: string): Promise<{ ok: boolean; error?: string }> {
  if (currentPeerId.value == null) return { ok: false, error: 'No thread open' }
  const api = useApi()
  try {
    const msg: DirectMessage = await api.sendMessage(currentPeerId.value, body)
    const peerId = currentPeerId.value
    const list = threadMessages.value[peerId] || []
    // Dedupe — the server also emits message:new to our own user room, so
    // the socket handler may have appended the row before this POST returned.
    if (!list.find(m => m.id === msg.id)) {
      threadMessages.value = { ...threadMessages.value, [peerId]: [...list, msg] }
    }
    // Bump the thread to the top of the list and update last_message.
    threads.value = [
      { ...(threads.value.find(t => t.peer.id === peerId)!), last_message: msg },
      ...threads.value.filter(t => t.peer.id !== peerId),
    ]
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Failed' }
  }
}

function onIncomingMessage(msg: DirectMessage, myId: number) {
  const peerId = msg.sender_id === myId ? msg.recipient_id : msg.sender_id
  const list = threadMessages.value[peerId]
  if (list) {
    // De-dup by id in case our own echo arrives after we already appended.
    if (!list.find(m => m.id === msg.id)) {
      threadMessages.value = { ...threadMessages.value, [peerId]: [...list, msg] }
    }
  }
  const existing = threads.value.find(t => t.peer.id === peerId)
  if (existing) {
    existing.last_message = msg
    if (msg.recipient_id === myId && currentPeerId.value !== peerId) {
      existing.unread = (existing.unread || 0) + 1
    }
    threads.value = [existing, ...threads.value.filter(t => t.peer.id !== peerId)]
  } else {
    // Unknown peer — refresh the threads list to get their player info.
    loadThreads()
  }
  // If the user is actively viewing this thread, tell the server we've
  // already seen the new message so reloading the app doesn't resurrect
  // the unread badge.
  if (msg.recipient_id === myId && currentPeerId.value === peerId) {
    const api = useApi()
    api.markMessagesRead(peerId).catch(() => {})
  }
}

function onMessagesRead(readerId: number, ids: number[]) {
  const list = threadMessages.value[readerId]
  if (!list) return
  const idSet = new Set(ids)
  threadMessages.value = {
    ...threadMessages.value,
    [readerId]: list.map(m => idSet.has(m.id) ? { ...m, read_at: new Date().toISOString() } : m),
  }
}

function reset() {
  threads.value = []
  threadMessages.value = {}
  currentPeerId.value = null
  loadedThreads.value = false
}

export function useMessageStore() {
  return {
    threads: computed(() => threads.value),
    currentMessages,
    currentPeer,
    currentPeerId: computed(() => currentPeerId.value),
    unreadCount,
    loaded: computed(() => loadedThreads.value),
    loadThreads,
    openThread,
    closeThread,
    sendMessage,
    onIncomingMessage,
    onMessagesRead,
    reset,
  }
}
