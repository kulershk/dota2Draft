import { Router } from 'express'
import fs from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { query, queryOne, execute } from '../db.js'
import { requirePermission } from '../middleware/permissions.js'
import { upload } from '../middleware/upload.js'
import { setSocketsEnabled, getSocketsEnabled } from '../socket/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const router = Router()

// In-memory cache for /api/site-settings. The payload is hit on every page
// load but only changes when an admin edits site settings, so a short TTL
// plus explicit invalidation on writes makes this effectively free.
let siteSettingsCache = null
let siteSettingsCacheExpiry = 0
const SITE_SETTINGS_TTL_MS = 60_000

function invalidateSiteSettings() {
  siteSettingsCache = null
  siteSettingsCacheExpiry = 0
}

router.get('/api/site-settings', async (req, res) => {
  const now = Date.now()
  if (siteSettingsCache && now < siteSettingsCacheExpiry) {
    return res.json(siteSettingsCache)
  }
  const rows = await query("SELECT key, value FROM settings WHERE key LIKE 'site_%'")
  const obj = {}
  for (const r of rows) obj[r.key] = r.value
  let sponsors = []
  try { sponsors = JSON.parse(obj.site_sponsors || '[]') } catch { sponsors = [] }
  const payload = {
    site_title: obj.site_title || '',
    site_subtitle: obj.site_subtitle || '',
    site_hero_paragraph: obj.site_hero_paragraph || '',
    site_discord_url: obj.site_discord_url || '',
    site_name: obj.site_name || '',
    site_logo_url: obj.site_logo_url || '',
    site_hero_banner_url: obj.site_hero_banner_url || '',
    site_sponsors: sponsors,
    // Boolean view of the persisted 'site_sockets_enabled' string. Default
    // is true if the row has never been written.
    sockets_enabled: obj.site_sockets_enabled !== 'false',
  }
  siteSettingsCache = payload
  siteSettingsCacheExpiry = now + SITE_SETTINGS_TTL_MS
  res.json(payload)
})

router.put('/api/site-settings', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_site_settings')
  if (!admin) return
  const { site_title, site_subtitle, site_hero_paragraph, site_discord_url, site_name, sockets_enabled } = req.body
  for (const [key, value] of [
    ['site_title', site_title],
    ['site_subtitle', site_subtitle],
    ['site_hero_paragraph', site_hero_paragraph],
    ['site_discord_url', site_discord_url],
    ['site_name', site_name],
  ]) {
    if (value !== undefined) {
      await execute(
        "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
        [key, value || '']
      )
    }
  }
  // Real-time kill switch. Persist as a string ('true'/'false'), update the
  // in-memory flag the connection-gate middleware reads, and on toggle to
  // false drop every currently-connected socket so the change takes effect
  // immediately rather than only blocking new handshakes.
  if (sockets_enabled !== undefined) {
    const next = !!sockets_enabled
    await execute(
      "INSERT INTO settings (key, value) VALUES ('site_sockets_enabled', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [next ? 'true' : 'false']
    )
    const wasEnabled = getSocketsEnabled()
    setSocketsEnabled(next)
    if (wasEnabled && !next) {
      const io = req.app.get('io')
      if (io) io.disconnectSockets(true)
    }
  }
  invalidateSiteSettings()
  res.json({ ok: true })
})

router.post('/api/site-settings/logo', upload.single('logo'), async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_site_settings')
  if (!admin) return
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  const logoUrl = `/uploads/${req.file.filename}`
  await execute(
    "INSERT INTO settings (key, value) VALUES ('site_logo_url', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
    [logoUrl]
  )
  invalidateSiteSettings()
  res.json({ site_logo_url: logoUrl })
})

// Hero banner upload
router.post('/api/site-settings/hero-banner', upload.single('banner'), async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_site_settings')
  if (!admin) return
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  const bannerUrl = `/uploads/${req.file.filename}`
  await execute(
    "INSERT INTO settings (key, value) VALUES ('site_hero_banner_url', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
    [bannerUrl]
  )
  invalidateSiteSettings()
  res.json({ site_hero_banner_url: bannerUrl })
})

router.delete('/api/site-settings/hero-banner', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_site_settings')
  if (!admin) return
  const current = await queryOne("SELECT value FROM settings WHERE key = 'site_hero_banner_url'")
  if (current?.value) {
    const filePath = join(__dirname, '..', '..', current.value)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  }
  await execute("DELETE FROM settings WHERE key = 'site_hero_banner_url'")
  invalidateSiteSettings()
  res.json({ ok: true })
})

router.delete('/api/site-settings/logo', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_site_settings')
  if (!admin) return
  const current = await queryOne("SELECT value FROM settings WHERE key = 'site_logo_url'")
  if (current?.value) {
    const filePath = join(__dirname, '..', '..', current.value)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  }
  await execute("DELETE FROM settings WHERE key = 'site_logo_url'")
  invalidateSiteSettings()
  res.json({ ok: true })
})

// ─── Sponsors ─────────────────────────────────────────────
// Stored as a single JSON array under settings key `site_sponsors`:
//   [{ id, logo_url, alt, link }]
// Each upload is appended; delete-by-id removes the row + unlinks the file.
async function loadSponsors() {
  const row = await queryOne("SELECT value FROM settings WHERE key = 'site_sponsors'")
  try { return JSON.parse(row?.value || '[]') } catch { return [] }
}
async function saveSponsors(arr) {
  await execute(
    "INSERT INTO settings (key, value) VALUES ('site_sponsors', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
    [JSON.stringify(arr || [])]
  )
  invalidateSiteSettings()
}

router.post('/api/site-settings/sponsors', upload.single('logo'), async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_site_settings')
  if (!admin) {
    if (req.file) try { fs.unlinkSync(req.file.path) } catch {}
    return
  }
  if (!req.file) return res.status(400).json({ error: 'Logo image is required' })
  const sponsors = await loadSponsors()
  const id = (sponsors.reduce((m, s) => Math.max(m, Number(s.id) || 0), 0)) + 1
  sponsors.push({
    id,
    logo_url: `/uploads/${req.file.filename}`,
    alt: (req.body?.alt || '').toString().slice(0, 80),
    link: (req.body?.link || '').toString().slice(0, 500),
  })
  await saveSponsors(sponsors)
  res.status(201).json({ sponsors })
})

router.put('/api/site-settings/sponsors/:id', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_site_settings')
  if (!admin) return
  const id = Number(req.params.id)
  const sponsors = await loadSponsors()
  const idx = sponsors.findIndex(s => Number(s.id) === id)
  if (idx === -1) return res.status(404).json({ error: 'Sponsor not found' })
  if (req.body?.alt !== undefined)  sponsors[idx].alt  = String(req.body.alt).slice(0, 80)
  if (req.body?.link !== undefined) sponsors[idx].link = String(req.body.link).slice(0, 500)
  await saveSponsors(sponsors)
  res.json({ sponsors })
})

router.delete('/api/site-settings/sponsors/:id', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_site_settings')
  if (!admin) return
  const id = Number(req.params.id)
  const sponsors = await loadSponsors()
  const target = sponsors.find(s => Number(s.id) === id)
  if (target?.logo_url) {
    const filePath = join(__dirname, '..', '..', target.logo_url)
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath) } catch {}
  }
  const filtered = sponsors.filter(s => Number(s.id) !== id)
  await saveSponsors(filtered)
  res.json({ sponsors: filtered })
})

// Deploy status — lightweight endpoint for deploy banner
router.get('/api/deploy-status', async (req, res) => {
  const row = await queryOne("SELECT value FROM settings WHERE key = 'deploy_status'")
  res.json({ deploying: row?.value === 'true' })
})

router.post('/api/deploy-status', async (req, res) => {
  const token = req.headers['x-deploy-token'] || req.body?.token
  const expected = process.env.DEPLOY_TOKEN
  if (!expected || token !== expected) return res.status(403).json({ error: 'Forbidden' })
  const { deploying } = req.body
  await execute(
    "INSERT INTO settings (key, value) VALUES ('deploy_status', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
    [deploying ? 'true' : 'false']
  )
  res.json({ ok: true })
})

export default router
