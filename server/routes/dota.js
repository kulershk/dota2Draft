import { Router } from 'express'
import { queryOne, execute } from '../db.js'

const router = Router()

const OPENDOTA_API = 'https://api.opendota.com/api'

// 24h refresh; constants change ~once per Dota patch (≤ once a month). The
// in-memory cache is mirrored to the `settings` table so a container restart
// or an OpenDota outage can't strand the UI without hero/item names + icons.
let heroesCache = null
let itemsCache = null
let cacheTime = 0
const CACHE_TTL = 24 * 60 * 60 * 1000

const KEY_HEROES = 'dota_constants_heroes'
const KEY_ITEMS = 'dota_constants_items'
const KEY_FETCHED_AT = 'dota_constants_fetched_at'

async function loadFromDb() {
  try {
    const heroesRow = await queryOne('SELECT value FROM settings WHERE key = $1', [KEY_HEROES])
    const itemsRow = await queryOne('SELECT value FROM settings WHERE key = $1', [KEY_ITEMS])
    const tsRow = await queryOne('SELECT value FROM settings WHERE key = $1', [KEY_FETCHED_AT])
    if (heroesRow && itemsRow) {
      heroesCache = JSON.parse(heroesRow.value)
      itemsCache = JSON.parse(itemsRow.value)
      cacheTime = tsRow ? Number(tsRow.value) : 0
      const ageHours = ((Date.now() - cacheTime) / 1000 / 60 / 60).toFixed(1)
      console.log(`[dota] loaded constants from DB — heroes=${Object.keys(heroesCache).length}, items=${Object.keys(itemsCache).length}, age=${ageHours}h`)
    }
  } catch (e) {
    console.error('[dota] failed to load constants from DB:', e.message)
  }
}

// Fire-and-await on first import; fetchConstants() awaits this so the very
// first request never beats the disk-load to a fresh OpenDota fetch.
const initialLoadPromise = loadFromDb()

async function persistToDb() {
  try {
    await execute(
      `INSERT INTO settings (key, value) VALUES ($1, $2), ($3, $4), ($5, $6)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [
        KEY_HEROES, JSON.stringify(heroesCache),
        KEY_ITEMS, JSON.stringify(itemsCache),
        KEY_FETCHED_AT, String(cacheTime),
      ],
    )
  } catch (e) {
    console.error('[dota] failed to persist constants to DB:', e.message)
  }
}

async function fetchConstants() {
  await initialLoadPromise
  const now = Date.now()
  if (heroesCache && itemsCache && (now - cacheTime) < CACHE_TTL) {
    return { heroes: heroesCache, items: itemsCache }
  }

  let fetchedAny = false
  try {
    const [heroesRes, itemsRes] = await Promise.all([
      fetch(`${OPENDOTA_API}/constants/heroes`),
      fetch(`${OPENDOTA_API}/constants/items`),
    ])

    if (heroesRes.ok) {
      const heroesData = await heroesRes.json()
      // { "1": { id, name, localized_name, img, ... } } -> { id -> slim shape }
      const next = {}
      for (const [id, hero] of Object.entries(heroesData)) {
        next[id] = {
          id: hero.id,
          name: hero.name?.replace('npc_dota_hero_', '') || '',
          localized_name: hero.localized_name || '',
          img: hero.img || '',
        }
      }
      heroesCache = next
      fetchedAny = true
    }

    if (itemsRes.ok) {
      const itemsData = await itemsRes.json()
      // { "blink": { id, img, ... } } -> { id -> slim shape }
      const next = {}
      for (const [key, item] of Object.entries(itemsData)) {
        if (item.id) {
          next[item.id] = {
            id: item.id,
            name: key,
            dname: item.dname || key,
            img: item.img || '',
          }
        }
      }
      itemsCache = next
      fetchedAny = true
    }

    if (fetchedAny) {
      cacheTime = now
      // Don't await — the caller doesn't need to wait on the disk write.
      persistToDb()
    }
  } catch (e) {
    console.error('[dota] OpenDota fetch failed, serving last-known cache:', e.message)
    // Fall through with whatever heroesCache/itemsCache we already had.
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
