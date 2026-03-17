import { ref, watch, type Ref } from 'vue'

function getItem(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function setItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // localStorage might be full or disabled
  }
}

export function usePersistedRef<T>(key: string, defaultValue: T): Ref<T> {
  const stored = getItem(key)
  let initial: T = defaultValue
  if (stored !== null) {
    try {
      initial = JSON.parse(stored)
    } catch {
      initial = defaultValue
    }
  }
  const r = ref(initial) as Ref<T>
  watch(r, (v) => setItem(key, JSON.stringify(v)), { deep: true })
  return r
}
