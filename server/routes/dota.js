import { Router } from 'express'

const router = Router()

const OPENDOTA_API = 'https://api.opendota.com/api'

// Cache constants in memory (refresh every 24h)
let heroesCache = null
let itemsCache = null
let cacheTime = 0
const CACHE_TTL = 24 * 60 * 60 * 1000 // 24 hours

async function fetchConstants() {
  const now = Date.now()
  if (heroesCache && itemsCache && (now - cacheTime) < CACHE_TTL) {
    return { heroes: heroesCache, items: itemsCache }
  }

  try {
    const [heroesRes, itemsRes] = await Promise.all([
      fetch(`${OPENDOTA_API}/constants/heroes`),
      fetch(`${OPENDOTA_API}/constants/items`),
    ])

    if (heroesRes.ok) {
      const heroesData = await heroesRes.json()
      // Transform: { "1": { id, name, localized_name, img, ... } } -> { id -> { name, localized_name, img } }
      heroesCache = {}
      for (const [id, hero] of Object.entries(heroesData)) {
        heroesCache[id] = {
          id: hero.id,
          name: hero.name?.replace('npc_dota_hero_', '') || '',
          localized_name: hero.localized_name || '',
          img: hero.img || '',
        }
      }
    }

    if (itemsRes.ok) {
      const itemsData = await itemsRes.json()
      // Transform: { "blink": { id, img, ... } } -> { id -> { name, img } }
      itemsCache = {}
      for (const [key, item] of Object.entries(itemsData)) {
        if (item.id) {
          itemsCache[item.id] = {
            id: item.id,
            name: key,
            dname: item.dname || key,
            img: item.img || '',
          }
        }
      }
    }

    cacheTime = now
  } catch (e) {
    console.error('Failed to fetch Dota constants:', e.message)
    // Return stale cache if available
  }

  return { heroes: heroesCache || {}, items: itemsCache || {} }
}

// GET /api/dota/constants
router.get('/api/dota/constants', async (req, res) => {
  const data = await fetchConstants()
  res.set('Cache-Control', 'public, max-age=3600')
  res.json(data)
})

export default router
