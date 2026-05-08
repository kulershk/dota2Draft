import { Router } from 'express'
import { query, execute } from '../db.js'
import { requirePermission } from '../middleware/permissions.js'

const router = Router()

const BOT_BASE = process.env.DISCORD_BOT_INTERNAL_URL || 'http://draft-discordbot:3030'
const BOT_TOKEN = process.env.INTERNAL_TOKEN || ''

const KEYS = [
  'discord_guild_id',
  'discord_role_id_verified',
  'discord_role_id_caster',
  'discord_welcome_channel_id',
  'discord_auto_verify_enabled',
]

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
  const rows = await query(
    `SELECT key, value FROM settings WHERE key = ANY($1::text[])`,
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
  for (const key of KEYS) {
    if (body[key] === undefined) continue
    const value = String(body[key] ?? '')
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
