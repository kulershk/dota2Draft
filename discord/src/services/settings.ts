import { query } from './db.js'
import { Logger } from './logger.js'

// Bot reads its config from the same `settings` table the draft app uses,
// keyed under `discord_*`. Cached in-memory; refreshed on startup, every 60s,
// and on demand via POST /internal/reload-settings.

const SETTINGS_PREFIX = 'discord_'
const REFRESH_MS = 60_000

interface Cache {
  loaded: boolean
  values: Map<string, string>
  loadedAt: number
}

const cache: Cache = { loaded: false, values: new Map(), loadedAt: 0 }
let timer: NodeJS.Timeout | null = null

export async function loadSettings(): Promise<void> {
  try {
    const rows = await query<{ key: string; value: string }>(
      `SELECT key, value FROM settings WHERE key LIKE $1`,
      [`${SETTINGS_PREFIX}%`],
    )
    cache.values = new Map(rows.map((r) => [r.key, r.value]))
    cache.loaded = true
    cache.loadedAt = Date.now()
    Logger.info(`Loaded ${cache.values.size} discord_* settings`)
  } catch (err) {
    Logger.error('Failed to load discord_* settings', err)
  }
}

export function startSettingsRefresh(): void {
  if (timer) return
  timer = setInterval(() => {
    void loadSettings()
  }, REFRESH_MS)
}

export const Settings = {
  get(key: string, fallback = ''): string {
    return cache.values.get(`${SETTINGS_PREFIX}${key}`) ?? fallback
  },
  getBool(key: string, fallback = false): boolean {
    const v = cache.values.get(`${SETTINGS_PREFIX}${key}`)
    if (v === undefined) return fallback
    return v === 'true' || v === '1'
  },
  isLoaded(): boolean {
    return cache.loaded
  },
  reload: loadSettings,
}
