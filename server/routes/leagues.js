import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { getAuthPlayer } from '../middleware/auth.js'
import { hasPermission, requireLeaguePermission } from '../middleware/permissions.js'

export default function createLeaguesRouter() {
  const router = Router()

  // Authenticated tournament makers see the dropdown options:
  //   - all `public = TRUE` rows (the "anyone making a tournament can pick this" set)
  //   - plus their own private rows
  //   - manage_leagues / is_admin sees every row
  // Page-level perms on AdminCompetitionSetupPage / AdminQueuePage already gate
  // who reaches the dropdown, so requiring login here is enough.
  router.get('/api/leagues', async (req, res) => {
    const player = await getAuthPlayer(req)
    if (!player) return res.status(401).json({ error: 'Not authenticated' })
    const canSeeAll = player.is_admin || await hasPermission(player, 'manage_leagues')
    const rows = canSeeAll
      ? await query(`
          SELECT l.id, l.name, l.dota_league_id, l.public, l.created_by, l.created_at,
                 COALESCE(p.display_name, p.name) AS created_by_name
          FROM leagues l
          LEFT JOIN players p ON p.id = l.created_by
          ORDER BY l.name ASC
        `)
      : await query(`
          SELECT l.id, l.name, l.dota_league_id, l.public, l.created_by, l.created_at,
                 COALESCE(p.display_name, p.name) AS created_by_name
          FROM leagues l
          LEFT JOIN players p ON p.id = l.created_by
          WHERE l.public = TRUE OR l.created_by = $1
          ORDER BY l.name ASC
        `, [player.id])
    res.json(rows)
  })

  router.post('/api/leagues', async (req, res) => {
    const admin = await requireLeaguePermission(req, res, null)
    if (!admin) return
    const { name, dota_league_id, public: isPublic } = req.body
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' })
    const dotaId = Number(dota_league_id)
    if (!Number.isFinite(dotaId) || dotaId <= 0) return res.status(400).json({ error: 'Valid dota_league_id is required' })

    try {
      const league = await queryOne(
        'INSERT INTO leagues (name, dota_league_id, public, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
        [String(name).trim(), dotaId, !!isPublic, admin.id]
      )
      res.status(201).json(league)
    } catch (e) {
      // Postgres unique_violation
      if (e.code === '23505') return res.status(409).json({ error: `Dota 2 league ID ${dotaId} is already registered` })
      throw e
    }
  })

  router.put('/api/leagues/:id', async (req, res) => {
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ error: 'Invalid id' })
    const admin = await requireLeaguePermission(req, res, id)
    if (!admin) return

    const existing = await queryOne('SELECT * FROM leagues WHERE id = $1', [id])
    if (!existing) return res.status(404).json({ error: 'League not found' })

    const { name, dota_league_id, public: isPublic } = req.body
    const newName = name !== undefined ? String(name).trim() : existing.name
    if (!newName) return res.status(400).json({ error: 'Name is required' })
    let newDotaId = existing.dota_league_id
    if (dota_league_id !== undefined) {
      const n = Number(dota_league_id)
      if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: 'Valid dota_league_id is required' })
      newDotaId = n
    }
    const newPublic = isPublic !== undefined ? !!isPublic : existing.public
    try {
      await execute('UPDATE leagues SET name = $1, dota_league_id = $2, public = $3 WHERE id = $4', [newName, newDotaId, newPublic, id])
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: `Dota 2 league ID ${newDotaId} is already registered` })
      throw e
    }
    const updated = await queryOne('SELECT * FROM leagues WHERE id = $1', [id])
    res.json(updated)
  })

  router.delete('/api/leagues/:id', async (req, res) => {
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ error: 'Invalid id' })
    const admin = await requireLeaguePermission(req, res, id)
    if (!admin) return
    await execute('DELETE FROM leagues WHERE id = $1', [id])
    res.json({ ok: true })
  })

  return router
}
