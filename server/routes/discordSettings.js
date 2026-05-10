import { Router } from 'express'
import { query, execute } from '../db.js'
import { requirePermission } from '../middleware/permissions.js'

const router = Router()

const BOT_BASE = process.env.DISCORD_BOT_INTERNAL_URL || 'http://draft-discordbot:3030'
const BOT_TOKEN = process.env.INTERNAL_TOKEN || ''

// Static settings keys returned by GET and accepted by PUT. Plugin toggles
// (`discord_plugin_<name>_enabled`) are also accepted by PUT but are NOT
// listed here — they are dynamic, driven by what the bot reports at
// /internal/plugins.
const KEYS = [
  'discord_guild_id',
  'discord_role_id_verified',
  'discord_role_id_caster',
  'discord_welcome_channel_id',
  'discord_tournament_channel_id',
  'discord_inhouse_voice_id',
  'discord_match_category_id',
  'discord_match_voice_enabled',
  'discord_match_cleanup_delay_minutes',
]

const PLUGIN_KEY_RE = /^discord_plugin_[a-zA-Z0-9_]+_enabled$/

async function botGet(path) {
  const res = await fetch(`${BOT_BASE}${path}`, {
    headers: { Authorization: `Bearer ${BOT_TOKEN}` },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`bot ${path} ${res.status}: ${text}`)
  }
  return res.json()
}

async function botPost(path) {
  const res = await fetch(`${BOT_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${BOT_TOKEN}` },
  })
  if (!res.ok) throw new Error(`bot ${path} ${res.status}`)
  return res.json()
}

router.get('/api/admin/discord/settings', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_discord_settings')
  if (!admin) return
  // Return both the static KEYS and any persisted plugin toggle keys so the
  // admin UI can render their current state without a separate fetch.
  const rows = await query(
    `SELECT key, value FROM settings WHERE key = ANY($1::text[]) OR key LIKE 'discord_plugin_%'`,
    [KEYS],
  )
  const out = {}
  for (const k of KEYS) out[k] = ''
  for (const r of rows) out[r.key] = r.value
  res.json(out)
})

router.put('/api/admin/discord/settings', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_discord_settings')
  if (!admin) return
  const body = req.body || {}
  for (const [key, raw] of Object.entries(body)) {
    if (!KEYS.includes(key) && !PLUGIN_KEY_RE.test(key)) continue
    const value = String(raw ?? '')
    await execute(
      `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
      [key, value],
    )
  }
  // Best-effort live reload — bot polls every 60s anyway, this just makes the
  // change visible immediately.
  try {
    await botPost('/internal/reload-settings')
  } catch (err) {
    console.warn('[discord-settings] bot reload failed:', err.message)
  }
  res.json({ ok: true })
})

router.get('/api/admin/discord/plugins', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_discord_settings')
  if (!admin) return
  try {
    const data = await botGet('/internal/plugins')
    res.json(data)
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

router.get('/api/admin/discord/roles', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_discord_settings')
  if (!admin) return
  try {
    const data = await botGet('/internal/roles')
    res.json(data)
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

router.get('/api/admin/discord/channels', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_discord_settings')
  if (!admin) return
  try {
    const data = await botGet('/internal/channels')
    res.json(data)
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

// Lists guild members for the AdminUsersPage Discord-link picker. Gated on
// manage_users (not manage_discord_settings) since linking accounts is a
// user-management action.
router.get('/api/admin/discord/members', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_users')
  if (!admin) return
  try {
    const data = await botGet('/internal/members')
    res.json(data)
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

router.get('/api/admin/discord/health', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_discord_settings')
  if (!admin) return
  try {
    const r = await fetch(`${BOT_BASE}/internal/health`)
    const data = await r.json()
    res.json({ reachable: true, ...data })
  } catch (err) {
    res.json({ reachable: false, error: err.message })
  }
})

export default router
