import { Router } from 'express'
import fs from 'fs'
import { join } from 'path'
import sharp from 'sharp'
import { query, queryOne, execute } from '../db.js'
import { getAuthPlayer } from '../middleware/auth.js'
import { requirePermission } from '../middleware/permissions.js'
import { upload, uploadsDir } from '../middleware/upload.js'
import { hasPerk, PERK } from '../helpers/subscription.js'

// Decorations are admin-managed cosmetic overlays (crowns, sunglasses, …) that
// subscribers with the avatar_decoration perk can wear on their avatar. Admin
// CRUD reuses the manage_subscription_plans permission (same audience); the
// picker + "who is wearing what" map are readable by any logged-in client.

// Resize an uploaded overlay to a 256×256 transparent PNG (contain, so tall
// art like crowns isn't cropped). Returns the public /uploads URL.
async function processDecorationImage(file, id) {
  const filename = `avatar_decoration_${id}_${Date.now()}.png`
  const outPath = join(uploadsDir, filename)
  await sharp(file.path)
    .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(outPath)
  if (file.path !== outPath) { try { fs.unlinkSync(file.path) } catch {} }
  return `/uploads/${filename}`
}

function unlinkPublic(url) {
  if (!url) return
  const p = join(uploadsDir, url.replace('/uploads/', ''))
  try { if (fs.existsSync(p)) fs.unlinkSync(p) } catch {}
}

// Clamp a positioning offset (percent from center) to a sane nudge range.
function clampOffset(v) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return 0
  return Math.max(-100, Math.min(100, n))
}

export default function createAvatarDecorationsRouter() {
  const router = Router()

  // Public list of active decorations — powers the player picker.
  router.get('/api/avatar-decorations', async (_req, res) => {
    const rows = await query(
      `SELECT id, name, category, image_url, sort_order, offset_x, offset_y
         FROM avatar_decorations
        WHERE is_active = TRUE
        ORDER BY sort_order ASC, id ASC`
    )
    res.json(rows)
  })

  // Map of player_id → image_url for every player currently *wearing* a
  // decoration whose active plan still grants the perk. Small payload (only
  // opted-in subscribers); the client caches it and overlays by player id.
  router.get('/api/avatar-decorations/worn', async (_req, res) => {
    const rows = await query(
      `SELECT p.id AS player_id, d.image_url, d.offset_x, d.offset_y
         FROM players p
         JOIN avatar_decorations d ON d.id = p.avatar_decoration_id AND d.is_active = TRUE
         JOIN user_subscriptions us ON us.player_id = p.id AND us.status = 'active'
              AND (us.expires_at IS NULL OR us.expires_at > NOW())
         JOIN subscription_plans sp ON sp.id = us.plan_id
        WHERE p.avatar_decoration_id IS NOT NULL
          AND sp.perks->>'avatar_decoration' = 'true'`
    )
    res.json(rows)
  })

  // Set / clear my own decoration. Gated on the perk; validates the target is
  // a real, active decoration.
  router.put('/api/me/avatar-decoration', async (req, res) => {
    const player = await getAuthPlayer(req)
    if (!player) return res.status(401).json({ error: 'Not authenticated' })
    if (!(await hasPerk(player.id, PERK.AVATAR_DECORATION))) {
      return res.status(403).json({ error: 'Your subscription does not include avatar decorations' })
    }
    const raw = req.body?.decoration_id
    if (raw === null || raw === undefined || raw === '') {
      await execute('UPDATE players SET avatar_decoration_id = NULL WHERE id = $1', [player.id])
      return res.json({ avatar_decoration_id: null })
    }
    const decorationId = Number(raw)
    if (!Number.isInteger(decorationId) || decorationId <= 0) {
      return res.status(400).json({ error: 'invalid decoration_id' })
    }
    const deco = await queryOne('SELECT id FROM avatar_decorations WHERE id = $1 AND is_active = TRUE', [decorationId])
    if (!deco) return res.status(404).json({ error: 'decoration not found' })
    await execute('UPDATE players SET avatar_decoration_id = $1 WHERE id = $2', [decorationId, player.id])
    res.json({ avatar_decoration_id: decorationId })
  })

  // ── Admin CRUD (manage_subscription_plans) ──────────────────────────────
  router.get('/api/admin/avatar-decorations', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_subscription_plans')
    if (!admin) return
    const rows = await query(
      `SELECT d.id, d.name, d.category, d.image_url, d.is_active, d.sort_order,
              d.offset_x, d.offset_y, d.created_at,
              COALESCE(c.cnt, 0)::int AS worn_count
         FROM avatar_decorations d
         LEFT JOIN (
           SELECT avatar_decoration_id, COUNT(*) AS cnt
             FROM players WHERE avatar_decoration_id IS NOT NULL
            GROUP BY avatar_decoration_id
         ) c ON c.avatar_decoration_id = d.id
        ORDER BY d.sort_order ASC, d.id ASC`
    )
    res.json(rows)
  })

  // Create with the image in one multipart call (image is required).
  router.post('/api/admin/avatar-decorations', upload.single('image'), async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_subscription_plans')
    if (!admin) { if (req.file) { try { fs.unlinkSync(req.file.path) } catch {} } return }
    const { name, category, is_active, sort_order, offset_x, offset_y } = req.body || {}
    if (!name || !String(name).trim()) {
      if (req.file) { try { fs.unlinkSync(req.file.path) } catch {} }
      return res.status(400).json({ error: 'name is required' })
    }
    if (!req.file) return res.status(400).json({ error: 'image is required' })
    const sortOrder = Number.isFinite(Number(sort_order)) ? Math.floor(Number(sort_order)) : 0
    // Insert first to get the id, then attach the processed image.
    const row = await queryOne(
      `INSERT INTO avatar_decorations (name, category, image_url, is_active, sort_order, offset_x, offset_y)
       VALUES ($1, $2, '', $3, $4, $5, $6) RETURNING *`,
      [String(name).trim(), category ? String(category).trim() : null, is_active !== 'false' && is_active !== false, sortOrder, clampOffset(offset_x), clampOffset(offset_y)]
    )
    const imageUrl = await processDecorationImage(req.file, row.id)
    await execute('UPDATE avatar_decorations SET image_url = $1 WHERE id = $2', [imageUrl, row.id])
    res.status(201).json({ ...row, image_url: imageUrl })
  })

  router.put('/api/admin/avatar-decorations/:id', async (req, res) => {
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ error: 'invalid id' })
    const admin = await requirePermission(req, res, 'manage_subscription_plans')
    if (!admin) return
    const existing = await queryOne('SELECT * FROM avatar_decorations WHERE id = $1', [id])
    if (!existing) return res.status(404).json({ error: 'decoration not found' })
    const { name, category, is_active, sort_order, offset_x, offset_y } = req.body || {}
    const newName = name !== undefined ? String(name).trim() : existing.name
    if (!newName) return res.status(400).json({ error: 'name is required' })
    await execute(
      `UPDATE avatar_decorations
          SET name = $1, category = $2, is_active = $3, sort_order = $4, offset_x = $5, offset_y = $6
        WHERE id = $7`,
      [
        newName,
        category !== undefined ? (category ? String(category).trim() : null) : existing.category,
        is_active !== undefined ? !!is_active : existing.is_active,
        sort_order !== undefined && Number.isFinite(Number(sort_order)) ? Math.floor(Number(sort_order)) : existing.sort_order,
        offset_x !== undefined ? clampOffset(offset_x) : existing.offset_x,
        offset_y !== undefined ? clampOffset(offset_y) : existing.offset_y,
        id,
      ]
    )
    res.json(await queryOne('SELECT * FROM avatar_decorations WHERE id = $1', [id]))
  })

  router.post('/api/admin/avatar-decorations/:id/image', upload.single('image'), async (req, res) => {
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ error: 'invalid id' })
    const admin = await requirePermission(req, res, 'manage_subscription_plans')
    if (!admin) { if (req.file) { try { fs.unlinkSync(req.file.path) } catch {} } return }
    const deco = await queryOne('SELECT id, image_url FROM avatar_decorations WHERE id = $1', [id])
    if (!deco) return res.status(404).json({ error: 'decoration not found' })
    if (!req.file) return res.status(400).json({ error: 'no file uploaded' })
    const imageUrl = await processDecorationImage(req.file, id)
    unlinkPublic(deco.image_url)
    await execute('UPDATE avatar_decorations SET image_url = $1 WHERE id = $2', [imageUrl, id])
    res.json({ image_url: imageUrl })
  })

  // Delete: unlink the file, clear it off any player wearing it, drop the row.
  router.delete('/api/admin/avatar-decorations/:id', async (req, res) => {
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ error: 'invalid id' })
    const admin = await requirePermission(req, res, 'manage_subscription_plans')
    if (!admin) return
    const deco = await queryOne('SELECT id, image_url FROM avatar_decorations WHERE id = $1', [id])
    if (!deco) return res.status(404).json({ error: 'decoration not found' })
    await execute('UPDATE players SET avatar_decoration_id = NULL WHERE avatar_decoration_id = $1', [id])
    await execute('DELETE FROM avatar_decorations WHERE id = $1', [id])
    unlinkPublic(deco.image_url)
    res.json({ ok: true })
  })

  return router
}
