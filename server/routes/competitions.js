import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { getAuthPlayer } from '../middleware/auth.js'
import { hasPermission, requireCompPermission } from '../middleware/permissions.js'
import { getCompetition, parseCompSettings, parseAuctionState, computeAndSyncCompStatus } from '../helpers/competition.js'

const router = Router()

router.get('/api/competitions', async (req, res) => {
  const player = await getAuthPlayer(req)
  // List endpoint — slim payload (no auction_state / tournament_state). Use
  // GET /api/competitions/:id for the full record. Supports ?limit + ?offset
  // for pagination. Default unbounded for backwards compatibility.
  const rawLimit = parseInt(req.query.limit, 10)
  const rawOffset = parseInt(req.query.offset, 10)
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : null
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0
  const search = (req.query.search || '').toString().trim()

  const params = []
  let where = '1=1'
  if (search) {
    params.push(`%${search.replace(/[%_]/g, '\\$&')}%`)
    where += ` AND c.name ILIKE $${params.length}`
  }

  // Pull only what the list view needs — drop auction_state, tournament_state.
  const allRows = await query(`
    SELECT c.id, c.name, c.description, c.status, c.starts_at, c.registration_start,
           c.registration_end, c.is_public, c.is_featured, c.competition_type,
           c.rules_title, c.rules_content, c.created_by, c.created_at,
           c.settings,
           COALESCE(p.display_name, p.name) AS created_by_name, p.avatar_url AS created_by_avatar
    FROM competitions c
    LEFT JOIN players p ON p.id = c.created_by
    WHERE ${where}
    ORDER BY
      CASE WHEN c.status = 'finished' THEN 1 ELSE 0 END,
      c.created_at DESC
  `, params)

  const canManageAll = player && await hasPermission(player, 'manage_competitions')
  const visible = allRows.filter(c => {
    if (c.is_public) return true
    if (!player) return false
    if (player.is_admin || canManageAll) return true
    if (c.created_by === player.id) return true
    return false
  })

  // Status sync in parallel — most calls return early since stored is final.
  await Promise.all(visible.map(c => computeAndSyncCompStatus(c)))

  const total = visible.length
  const sliced = limit !== null ? visible.slice(offset, offset + limit) : visible

  res.json({
    rows: sliced.map(c => ({
      ...c,
      settings: parseCompSettings(c),
    })),
    total,
    limit: limit !== null ? limit : total,
    offset,
  })
})

router.get('/api/competitions/:id', async (req, res) => {
  const comp = await queryOne(`
    SELECT c.*, COALESCE(p.display_name, p.name) AS created_by_name, p.avatar_url AS created_by_avatar
    FROM competitions c
    LEFT JOIN players p ON p.id = c.created_by
    WHERE c.id = $1
  `, [req.params.id])
  if (!comp) return res.status(404).json({ error: 'Competition not found' })
  if (!comp.is_public) {
    const player = await getAuthPlayer(req)
    const canManageAll = player && await hasPermission(player, 'manage_competitions')
    if (!player || (!player.is_admin && !canManageAll && comp.created_by !== player.id)) {
      return res.status(404).json({ error: 'Competition not found' })
    }
  }
  await computeAndSyncCompStatus(comp)
  res.json({
    ...comp,
    settings: parseCompSettings(comp),
    auction_state: parseAuctionState(comp),
  })
})

router.post('/api/competitions', async (req, res) => {
  const admin = await requireCompPermission(req, res, null)
  if (!admin) return

  const { name, description, starts_at, registration_start, registration_end, settings } = req.body
  if (!name) return res.status(400).json({ error: 'Name is required' })

  const defaultSettings = {
    playersPerTeam: 5, bidTimer: 30, startingBudget: 1000,
    minimumBid: 10, bidIncrement: 5, maxBid: 0,
    nominationOrder: 'normal', requireAllOnline: true, allowSteamRegistration: true,
  }

  const comp = await queryOne(
    `INSERT INTO competitions (name, description, starts_at, registration_start, registration_end, settings, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [name, description || '', starts_at || null, registration_start || null, registration_end || null, JSON.stringify({ ...defaultSettings, ...settings }), admin.id]
  )
  const full = await queryOne(`
    SELECT c.*, COALESCE(p.display_name, p.name) AS created_by_name, p.avatar_url AS created_by_avatar
    FROM competitions c LEFT JOIN players p ON p.id = c.created_by WHERE c.id = $1
  `, [comp.id])
  res.status(201).json({ ...full, settings: parseCompSettings(full) })
})

router.put('/api/competitions/:id', async (req, res) => {
  const admin = await requireCompPermission(req, res, Number(req.params.id))
  if (!admin) return

  const comp = await getCompetition(req.params.id)
  if (!comp) return res.status(404).json({ error: 'Competition not found' })

  const { name, description, starts_at, registration_start, registration_end, settings, status, is_public, rules_title, rules_content, competition_type, is_featured } = req.body

  const newSettings = settings ? { ...comp.settings, ...settings } : comp.settings
  const newStatus = status || comp.status
  const newIsPublic = is_public !== undefined ? is_public : comp.is_public
  const newIsFeatured = is_featured !== undefined ? !!is_featured : !!comp.is_featured
  // Only one competition can be the featured one — flip everyone else off when this one becomes featured.
  if (newIsFeatured && !comp.is_featured) {
    await execute('UPDATE competitions SET is_featured = FALSE WHERE id <> $1', [comp.id])
  }
  await execute(
    `UPDATE competitions SET name = $1, description = $2, starts_at = $3, registration_start = $4, registration_end = $5, settings = $6, status = $8, is_public = $9, rules_title = $10, rules_content = $11, competition_type = $12, is_featured = $13 WHERE id = $7`,
    [
      name ?? comp.name,
      description ?? comp.description,
      starts_at !== undefined ? starts_at : comp.starts_at,
      registration_start !== undefined ? registration_start : comp.registration_start,
      registration_end !== undefined ? registration_end : comp.registration_end,
      JSON.stringify(newSettings),
      comp.id,
      newStatus,
      newIsPublic,
      rules_title !== undefined ? rules_title : (comp.rules_title || ''),
      rules_content !== undefined ? rules_content : (comp.rules_content || ''),
      competition_type !== undefined ? competition_type : (comp.competition_type || ''),
      newIsFeatured,
    ]
  )

  const updated = await queryOne(`
    SELECT c.*, COALESCE(p.display_name, p.name) AS created_by_name, p.avatar_url AS created_by_avatar
    FROM competitions c LEFT JOIN players p ON p.id = c.created_by WHERE c.id = $1
  `, [comp.id])
  req.app.get('io').to(`comp:${comp.id}`).emit('settings:updated', parseCompSettings(updated))
  res.json({ ...updated, settings: parseCompSettings(updated) })
})

router.delete('/api/competitions/:id', async (req, res) => {
  const admin = await requireCompPermission(req, res, Number(req.params.id))
  if (!admin) return

  await execute('DELETE FROM competitions WHERE id = $1', [req.params.id])
  res.json({ ok: true })
})

export default router
