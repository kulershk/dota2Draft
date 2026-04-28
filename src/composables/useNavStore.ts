import { ref, computed } from 'vue'
import { useApi } from './useApi'

export interface NavItem {
  id: number
  sort_order: number
  label_key: string | null
  labels: { en?: string; lv?: string; lt?: string } | null
  icon: string
  path: string
  is_external: boolean
  active_match: string | null
  requires_auth: boolean
  badge: string | null
}

const items = ref<NavItem[]>([])
const loaded = ref(false)
const loading = ref(false)

async function load(force = false) {
  if (loaded.value && !force) return
  if (loading.value) return
  loading.value = true
  try {
    const api = useApi()
    items.value = await api.getNavItems()
    loaded.value = true
  } catch (e) {
    console.error('Failed to load nav items', e)
  } finally {
    loading.value = false
  }
}

export function useNavStore() {
  return {
    items: computed(() => items.value),
    loaded: computed(() => loaded.value),
    load,
    refresh: () => load(true),
  }
}
