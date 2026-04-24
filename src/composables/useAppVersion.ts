import { ref } from 'vue'

const POLL_INTERVAL_MS = 30_000

const initialVersion = ref<string | null>(null)
const currentVersion = ref<string | null>(null)
const updateAvailable = ref(false)

let timer: ReturnType<typeof setInterval> | null = null
let visibilityHandler: (() => void) | null = null
let started = false

async function fetchVersion(): Promise<string | null> {
  try {
    const res = await fetch('/api/version', { cache: 'no-store' })
    if (!res.ok) return null
    const data = await res.json()
    return typeof data.version === 'string' ? data.version : null
  } catch {
    return null
  }
}

async function poll() {
  if (document.visibilityState !== 'visible') return
  const v = await fetchVersion()
  if (!v) return
  currentVersion.value = v
  if (initialVersion.value && v !== initialVersion.value) {
    updateAvailable.value = true
    stop()
  }
}

function stop() {
  if (timer) { clearInterval(timer); timer = null }
  if (visibilityHandler) { document.removeEventListener('visibilitychange', visibilityHandler); visibilityHandler = null }
}

export function useAppVersion() {
  if (!started) {
    started = true
    // Capture initial version once, then start polling
    fetchVersion().then(v => {
      if (!v) return
      initialVersion.value = v
      currentVersion.value = v
      timer = setInterval(poll, POLL_INTERVAL_MS)
      visibilityHandler = () => { if (document.visibilityState === 'visible') poll() }
      document.addEventListener('visibilitychange', visibilityHandler)
    })
  }
  return { updateAvailable, initialVersion, currentVersion }
}
