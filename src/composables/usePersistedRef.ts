import { ref, watch, type Ref } from 'vue'

export function usePersistedRef<T>(key: string, defaultValue: T): Ref<T> {
  const stored = localStorage.getItem(key)
  let initial: T = defaultValue
  if (stored !== null) {
    try {
      initial = JSON.parse(stored)
    } catch {
      initial = defaultValue
    }
  }
  const r = ref(initial) as Ref<T>
  watch(r, (v) => localStorage.setItem(key, JSON.stringify(v)), { deep: true })
  return r
}
