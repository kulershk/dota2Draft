import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { requirePermission, ALL_PERMISSIONS } from '../middleware/permissions.js'

const router = Router()

router.get('/api/permissions/all', (req, res) => {
  res.json(ALL_PERMISSIONS)
})

router.get('/api/permission-groups', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_permissions')
  if (!admin) return
  const groups = await query('SELECT * FROM permission_groups ORDER BY name')
  res.json(groups.map(g => ({ ...g, permissions: g.permissions || [] })))
})

router.post('/api/permission-groups', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_permissions')
  if (!admin) return
  const { name, permissions } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })
  const group = await queryOne(
    'INSERT INTO permission_groups (name, permissions) VALUES ($1, $2) RETURNING *',
    [name.trim(), JSON.stringify(permissions || [])]
  )
  res.json({ ...group, permissions: group.permissions || [] })
})

router.put('/api/permission-groups/:id', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_permissions')
  if (!admin) return
  const { name, permissions } = req.body
  await execute(
    'UPDATE permission_groups SET name = COALESCE($1, name), permissions = COALESCE($2, permissions) WHERE id = $3',
    [name?.trim() || null, permissions ? JSON.stringify(permissions) : null, req.params.id]
  )
  const group = await queryOne('SELECT * FROM permission_groups WHERE id = $1', [req.params.id])
  res.json({ ...group, permissions: group.permissions || [] })
})

router.delete('/api/permission-groups/:id', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_permissions')
  if (!admin) return
  await execute('DELETE FROM permission_groups WHERE id = $1', [req.params.id])
  res.json({ ok: true })
})

router.get('/api/players/:id/groups', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_permissions')
  if (!admin) return
  const groups = await query(`
    SELECT pg.* FROM permission_groups pg
    JOIN player_permission_groups ppg ON ppg.group_id = pg.id
    WHERE ppg.player_id = $1
  `, [req.params.id])
  res.json(groups.map(g => ({ ...g, permissions: g.permissions || [] })))
})

router.put('/api/players/:id/groups', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_permissions')
  if (!admin) return
  const { groupIds } = req.body
  const playerId = req.params.id
  await execute('DELETE FROM player_permission_groups WHERE player_id = $1', [playerId])
  for (const gid of (groupIds || [])) {
    await execute(
      'INSERT INTO player_permission_groups (player_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [playerId, gid]
    )
  }
  res.json({ ok: true })
})

export default router
