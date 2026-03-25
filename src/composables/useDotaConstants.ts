import { ref } from 'vue'
import { useApi } from './useApi'

interface HeroData {
  id: number
  name: string // internal name without prefix, e.g. "anti_mage"
  localized_name: string // e.g. "Anti-Mage"
  img: string
}

interface ItemData {
  id: number
  name: string // internal name, e.g. "blink"
  dname: string // display name, e.g. "Blink Dagger"
  img: string
}

const heroes = ref<Record<number, HeroData>>({})
const items = ref<Record<number, ItemData>>({})
const loaded = ref(false)
const loading = ref(false)

const CDN = 'https://cdn.cloudflare.steamstatic.com'

export function useDotaConstants() {
  const api = useApi()

  async function loadConstants() {
    if (loaded.value || loading.value) return
    loading.value = true
    try {
      const data = await api.getDotaConstants()
      heroes.value = data.heroes || {}
      items.value = data.items || {}
      loaded.value = true
    } catch {
      // Silently fail - images just won't show
    } finally {
      loading.value = false
    }
  }

  function heroImg(heroId: number): string {
    const hero = heroes.value[heroId]
    if (!hero?.img) return ''
    return `${CDN}${hero.img}`
  }

  function heroName(heroId: number): string {
    return heroes.value[heroId]?.localized_name || ''
  }

  function itemImg(itemId: number): string {
    if (!itemId) return ''
    const item = items.value[itemId]
    if (!item?.img) return ''
    return `${CDN}${item.img}`
  }

  function itemName(itemId: number): string {
    if (!itemId) return ''
    return items.value[itemId]?.dname || ''
  }

  return {
    heroes,
    items,
    loaded,
    loadConstants,
    heroImg,
    heroName,
    itemImg,
    itemName,
  }
}
