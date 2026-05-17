import { ref, computed } from 'vue'
import { useApi } from './useApi'

export interface NotificationEntry {
  id: number
  type: string
  title: string
  body: string | null
  link: string | null
  recipient_id: number | null
  created_at: string
  read_at: string | null
}

const rows = ref<NotificationEntry[]>([])
const loaded = ref(false)

async function loadAll() {
  const api = useApi()
  try {
    const { rows: list } = await api.getNotifications()
    rows.value = list
    loaded.value = true
  } catch {
    // Best-effort.
  }
}

async function markRead(id: number) {
  const api = useApi()
  await api.markNotificationRead(id)
  const r = rows.value.find(x => x.id === id)
  if (r && !r.read_at) r.read_at = new Date().toISOString()
}

async function markAllRead() {
  const api = useApi()
  await api.markAllNotificationsRead()
  const now = new Date().toISOString()
  for (const r of rows.value) if (!r.read_at) r.read_at = now
}

function reset() {
  rows.value = []
  loaded.value = false
}

const unreadCount = computed(() => rows.value.filter(r => !r.read_at).length)

export function useNotificationStore() {
  return {
    rows: computed(() => rows.value),
    unreadCount,
    loaded: computed(() => loaded.value),
    loadAll,
    markRead,
    markAllRead,
    reset,
  }
}
