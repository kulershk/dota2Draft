import { Router } from 'express'
import fs from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { query, queryOne, execute } from '../db.js'
import { requirePermission } from '../middleware/permissions.js'
import { upload } from '../middleware/upload.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const router = Router()

router.get('/api/site-settings', async (req, res) => {
  const rows = await query("SELECT key, value FROM settings WHERE key LIKE 'site_%'")
  const obj = {}
  for (const r of rows) obj[r.key] = r.value
  res.json({
    site_title: obj.site_title || '',
    site_subtitle: obj.site_subtitle || '',
    site_discord_url: obj.site_discord_url || '',
    site_name: obj.site_name || '',
    site_logo_url: obj.site_logo_url || '',
    site_hero_banner_url: obj.site_hero_banner_url || '',
  })
})

router.put('/api/site-settings', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_site_settings')
  if (!admin) return
  const { site_title, site_subtitle, site_discord_url, site_name } = req.body
  for (const [key, value] of [['site_title', site_title], ['site_subtitle', site_subtitle], ['site_discord_url', site_discord_url], ['site_name', site_name]]) {
    if (value !== undefined) {
      await execute(
        "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
        [key, value || '']
      )
    }
  }
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
  res.json({ ok: true })
})

export default router
