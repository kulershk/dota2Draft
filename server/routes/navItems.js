import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { requirePermission } from '../middleware/permissions.js'

const router = Router()

// Public: visible nav items only, sorted.
router.get('/api/nav-items', async (req, res) => {
  const rows = await query(
    `SELECT id, sort_order, label_key, labels, icon, path, is_external,
            is_visible, active_match, requires_auth, badge
       FROM nav_items
       WHERE is_visible = TRUE
       ORDER BY sort_order ASC, id ASC`
  )
  res.json(rows.map(r => ({
    id: r.id,
    sort_order: r.sort_order,
    label_key: r.label_key,
    labels: r.labels || null,
    icon: r.icon,
    path: r.path,
    is_external: !!r.is_external,
    active_match: r.active_match,
    requires_auth: !!r.requires_auth,
    badge: r.badge || null,
  })))
})

// Admin: all items including hidden, with full fields.
router.get('/api/admin/nav-items', async (req, res) => {
  if (!await requirePermission(req, res, 'manage_menu')) return
  const rows = await query(
    `SELECT id, sort_order, label_key, labels, icon, path, is_external,
            is_visible, active_match, requires_auth, badge, created_at
       FROM nav_items
       ORDER BY sort_order ASC, id ASC`
  )
  res.json(rows)
})

router.post('/api/admin/nav-items', async (req, res) => {
  if (!await requirePermission(req, res, 'manage_menu')) return
  const {
    label_key, labels, icon, path, is_external,
    is_visible, active_match, requires_auth, badge, sort_order,
  } = req.body || {}
  if (typeof path !== 'string' || !path.trim()) {
    return res.status(400).json({ error: 'path required' })
  }
  if (typeof icon !== 'string' || !icon.trim()) {
    return res.status(400).json({ error: 'icon required' })
  }
  let order = Number(sort_order)
  if (!Number.isFinite(order)) {
    const max = await queryOne('SELECT COALESCE(MAX(sort_order), 0) AS m FROM nav_items')
    order = (max?.m || 0) + 10
  }
  const row = await queryOne(
    `INSERT INTO nav_items
       (sort_order, label_key, labels, icon, path, is_external, is_visible, active_match, requires_auth, badge)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      order,
      label_key || null,
      labels ? JSON.stringify(labels) : null,
      icon.trim(),
      path.trim(),
      !!is_external,
      is_visible !== false,
      active_match || null,
      !!requires_auth,
      badge || null,
    ]
  )
  res.json(row)
})

router.put('/api/admin/nav-items/reorder', async (req, res) => {
  if (!await requirePermission(req, res, 'manage_menu')) return
  const order = Array.isArray(req.body?.order) ? req.body.order : null
  if (!order) return res.status(400).json({ error: 'order array required' })
  for (let i = 0; i < order.length; i++) {
    await execute(
      'UPDATE nav_items SET sort_order = $1 WHERE id = $2',
      [(i + 1) * 10, Number(order[i])]
    )
  }
  res.json({ ok: true })
})

router.put('/api/admin/nav-items/:id', async (req, res) => {
  if (!await requirePermission(req, res, 'manage_menu')) return
  const id = Number(req.params.id)
  const existing = await queryOne('SELECT * FROM nav_items WHERE id = $1', [id])
  if (!existing) return res.status(404).json({ error: 'Not found' })

  const b = req.body || {}
  const next = {
    sort_order: b.sort_order !== undefined ? Number(b.sort_order) : existing.sort_order,
    label_key: b.label_key !== undefined ? (b.label_key || null) : existing.label_key,
    labels: b.labels !== undefined ? (b.labels ? JSON.stringify(b.labels) : null) : existing.labels,
    icon: b.icon !== undefined ? String(b.icon) : existing.icon,
    path: b.path !== undefined ? String(b.path) : existing.path,
    is_external: b.is_external !== undefined ? !!b.is_external : existing.is_external,
    is_visible: b.is_visible !== undefined ? !!b.is_visible : existing.is_visible,
    active_match: b.active_match !== undefined ? (b.active_match || null) : existing.active_match,
    requires_auth: b.requires_auth !== undefined ? !!b.requires_auth : existing.requires_auth,
    badge: b.badge !== undefined ? (b.badge || null) : existing.badge,
  }
  const row = await queryOne(
    `UPDATE nav_items
       SET sort_order = $1, label_key = $2, labels = $3, icon = $4, path = $5,
           is_external = $6, is_visible = $7, active_match = $8, requires_auth = $9, badge = $10
       WHERE id = $11
       RETURNING *`,
    [
      next.sort_order, next.label_key, next.labels, next.icon, next.path,
      next.is_external, next.is_visible, next.active_match, next.requires_auth,
      next.badge, id,
    ]
  )
  res.json(row)
})

router.delete('/api/admin/nav-items/:id', async (req, res) => {
  if (!await requirePermission(req, res, 'manage_menu')) return
  await execute('DELETE FROM nav_items WHERE id = $1', [req.params.id])
  res.json({ ok: true })
})

export default router
