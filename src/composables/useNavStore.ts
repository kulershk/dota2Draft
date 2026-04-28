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
  parent_id: number | null
  column_group: string | null
}

export interface NavRoot extends NavItem {
  children: NavItem[]
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

// Build a {root, children[]} tree from the flat list. Roots keep their
// document order; children are attached to their parent in document order.
const tree = computed<NavRoot[]>(() => {
  const childMap = new Map<number, NavItem[]>()
  for (const item of items.value) {
    if (item.parent_id) {
      if (!childMap.has(item.parent_id)) childMap.set(item.parent_id, [])
      childMap.get(item.parent_id)!.push(item)
    }
  }
  return items.value
    .filter(i => !i.parent_id)
    .map(i => ({ ...i, children: childMap.get(i.id) || [] }))
})

export function useNavStore() {
  return {
    items: computed(() => items.value),
    tree,
    loaded: computed(() => loaded.value),
    load,
    refresh: () => load(true),
  }
}
