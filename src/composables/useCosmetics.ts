import { ref, computed } from 'vue'
import { useApi } from './useApi'

// Client-side cache of "which player is wearing which avatar decoration".
// One small fetch (only opted-in subscribers appear) keyed by player id, so the
// shared PlayerAvatar component can overlay a decoration anywhere it has a
// player id — without every backend list endpoint having to return it.

const wornById = ref<Record<number, string>>({})
const loaded = ref(false)

async function loadWorn() {
  const api = useApi()
  try {
    const rows: Array<{ player_id: number; image_url: string }> = await api.getWornAvatarDecorations()
    const map: Record<number, string> = {}
    for (const r of rows) map[r.player_id] = r.image_url
    wornById.value = map
    loaded.value = true
  } catch {
    // Best-effort — a missing decoration map just means no overlays.
  }
}

function decorationFor(playerId?: number | null): string | null {
  if (!playerId) return null
  return wornById.value[playerId] || null
}

// Optimistic local update so the wearer sees their change instantly without a
// full refetch (and other mounted avatars of them update too).
function setLocal(playerId: number, imageUrl: string | null) {
  const next = { ...wornById.value }
  if (imageUrl) next[playerId] = imageUrl
  else delete next[playerId]
  wornById.value = next
}

function reset() {
  wornById.value = {}
  loaded.value = false
}

export function useCosmetics() {
  return {
    wornById: computed(() => wornById.value),
    loaded: computed(() => loaded.value),
    loadWorn,
    decorationFor,
    setLocal,
    reset,
  }
}
