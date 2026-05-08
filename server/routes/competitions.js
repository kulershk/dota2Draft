import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { getAuthPlayer } from '../middleware/auth.js'
import { hasPermission, requireCompPermission, isCompetitionHelper } from '../middleware/permissions.js'
import { getCompetition, parseCompSettings, parseAuctionState, computeAndSyncCompStatus } from '../helpers/competition.js'
import { discordBot } from '../services/discordBotClient.js'

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || ''

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
  let where = 'c.deleted_at IS NULL'
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
  // Pre-fetch which non-public comp ids the current player helps on, so the
  // filter loop stays sync. Empty set when not authed.
  const helperCompIds = new Set()
  if (player) {
    const rows = await query(
      'SELECT competition_id FROM competition_helpers WHERE player_id = $1',
      [player.id],
    )
    for (const r of rows) helperCompIds.add(r.competition_id)
  }
  const visible = allRows.filter(c => {
    if (c.is_public) return true
    if (!player) return false
    if (player.is_admin || canManageAll) return true
    if (c.created_by === player.id) return true
    if (helperCompIds.has(c.id)) return true
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
    WHERE c.id = $1 AND c.deleted_at IS NULL
  `, [req.params.id])
  if (!comp) return res.status(404).json({ error: 'Competition not found' })
  if (!comp.is_public) {
    const player = await getAuthPlayer(req)
    const canManageAll = player && await hasPermission(player, 'manage_competitions')
    let isHelper = false
    if (player && !player.is_admin && !canManageAll && comp.created_by !== player.id) {
      isHelper = await isCompetitionHelper(player.id, comp.id)
    }
    if (!player || (!player.is_admin && !canManageAll && comp.created_by !== player.id && !isHelper)) {
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

// Manually trigger the Discord embed for this competition. Idempotent: stamps
// `discord_announced_at` on success but allows re-announce (admin can correct
// a typo and post again — they just see the prior timestamp in the UI).
router.post('/api/competitions/:id/discord-announce', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' })
  const admin = await requireCompPermission(req, res, id)
  if (!admin) return

  const full = await queryOne(`
    SELECT c.*, COALESCE(p.display_name, p.name) AS created_by_name, p.avatar_url AS created_by_avatar
    FROM competitions c LEFT JOIN players p ON p.id = c.created_by
    WHERE c.id = $1 AND c.deleted_at IS NULL
  `, [id])
  if (!full) return res.status(404).json({ error: 'Competition not found' })

  const publicUrl = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL.replace(/\/$/, '')}/c/${full.id}/info` : null
  const result = await discordBot.tournamentAnnounce({
    id: full.id,
    name: full.name,
    description: full.description,
    startsAt: full.starts_at,
    registrationStart: full.registration_start,
    registrationEnd: full.registration_end,
    competitionType: full.competition_type,
    bannerUrl: null,
    publicUrl,
  })

  if (result?.ok === false) {
    return res.status(502).json({ error: result.reason || 'Bot rejected announcement', botResult: result })
  }

  await execute(`UPDATE competitions SET discord_announced_at = NOW() WHERE id = $1`, [id])
  const updated = await queryOne(`SELECT discord_announced_at FROM competitions WHERE id = $1`, [id])
  res.json({ ok: true, discord_announced_at: updated?.discord_announced_at, botResult: result })
})

// ──────────────────────────────────────────────────────────────────────────
// Competition helpers
// ──────────────────────────────────────────────────────────────────────────
// Helpers gain the same scoped management rights on this comp as the owner
// (see requireCompPermission). Only the owner or a global manage_competitions
// admin can add/remove helpers — helpers themselves see the list but can't
// modify it (prevents a helper from removing the owner).

async function isOwnerOrGlobalAdmin(req, res, compId) {
  const player = await getAuthPlayer(req)
  if (!player) { res.status(401).json({ error: 'Not authenticated' }); return null }
  if (await hasPermission(player, 'manage_competitions')) return player
  const comp = await getCompetition(compId)
  if (!comp) { res.status(404).json({ error: 'Competition not found' }); return null }
  if (comp.created_by !== player.id) {
    res.status(403).json({ error: 'Only the competition owner can manage helpers' })
    return null
  }
  return player
}

router.get('/api/competitions/:id/helpers', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' })
  // Anyone who can see/manage this comp can see who the helpers are.
  const player = await requireCompPermission(req, res, id)
  if (!player) return
  const rows = await query(
    `SELECT ch.player_id, ch.added_at, ch.added_by,
            COALESCE(p.display_name, p.name) AS name,
            p.avatar_url, p.steam_id
     FROM competition_helpers ch
     JOIN players p ON p.id = ch.player_id
     WHERE ch.competition_id = $1
     ORDER BY ch.added_at ASC`,
    [id],
  )
  res.json({ helpers: rows })
})

router.post('/api/competitions/:id/helpers', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' })
  const owner = await isOwnerOrGlobalAdmin(req, res, id)
  if (!owner) return

  const playerId = Number(req.body?.player_id)
  if (!Number.isFinite(playerId)) return res.status(400).json({ error: 'player_id required' })
  if (playerId === owner.id) return res.status(400).json({ error: 'You are already the owner' })

  const target = await queryOne('SELECT id FROM players WHERE id = $1', [playerId])
  if (!target) return res.status(404).json({ error: 'Player not found' })

  // Don't add helper if they're already the comp's creator.
  const comp = await getCompetition(id)
  if (comp?.created_by === playerId) {
    return res.status(400).json({ error: 'That player is the competition owner' })
  }

  await execute(
    `INSERT INTO competition_helpers (competition_id, player_id, added_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (competition_id, player_id) DO NOTHING`,
    [id, playerId, owner.id],
  )
  res.status(201).json({ ok: true })
})

router.delete('/api/competitions/:id/helpers/:playerId', async (req, res) => {
  const id = Number(req.params.id)
  const playerId = Number(req.params.playerId)
  if (!Number.isFinite(id) || !Number.isFinite(playerId)) {
    return res.status(400).json({ error: 'Invalid id' })
  }
  const owner = await isOwnerOrGlobalAdmin(req, res, id)
  if (!owner) return

  const r = await execute(
    'DELETE FROM competition_helpers WHERE competition_id = $1 AND player_id = $2',
    [id, playerId],
  )
  res.json({ ok: true, removed: r.rowCount ?? 0 })
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

  // Soft delete: keep the row + cascaded children intact, just hide it from
  // every public read path. Clears is_featured so the home-page slot is freed.
  await execute(
    'UPDATE competitions SET deleted_at = NOW(), is_featured = FALSE WHERE id = $1 AND deleted_at IS NULL',
    [req.params.id]
  )
  res.json({ ok: true })
})

export default router
