import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { getAuthPlayer } from '../middleware/auth.js'
import { requireCompPermission, hasPermission } from '../middleware/permissions.js'
import { getCompetition, parseCompSettings } from '../helpers/competition.js'

export default function createScrimsRouter(io) {
  const router = Router()

  async function getScrimWithNames(scrimId) {
    return await queryOne(`
      SELECT s.*,
        COALESCE(pp.display_name, pp.name) as posted_by_name,
        pp.avatar_url as posted_by_avatar,
        COALESCE(pc.team, COALESCE(pp.display_name, pp.name)) as posted_by_team,
        pc.banner_url as posted_by_banner,
        COALESCE(cp.display_name, cp.name) as claimed_by_name,
        cp.avatar_url as claimed_by_avatar,
        COALESCE(cc.team, COALESCE(cp.display_name, cp.name)) as claimed_by_team,
        cc.banner_url as claimed_by_banner
      FROM scrims s
      LEFT JOIN players pp ON s.posted_by = pp.id
      LEFT JOIN captains pc ON s.captain_id = pc.id
      LEFT JOIN players cp ON s.claimed_by = cp.id
      LEFT JOIN captains cc ON s.claimed_captain_id = cc.id
      WHERE s.id = $1
    `, [scrimId])
  }

  // List scrims for a competition
  router.get('/api/competitions/:compId/scrims', async (req, res) => {
    const compId = Number(req.params.compId)
    const rows = await query(`
      SELECT s.*,
        COALESCE(pp.display_name, pp.name) as posted_by_name,
        pp.avatar_url as posted_by_avatar,
        COALESCE(pc.team, COALESCE(pp.display_name, pp.name)) as posted_by_team,
        pc.banner_url as posted_by_banner,
        COALESCE(cp.display_name, cp.name) as claimed_by_name,
        cp.avatar_url as claimed_by_avatar,
        COALESCE(cc.team, COALESCE(cp.display_name, cp.name)) as claimed_by_team,
        cc.banner_url as claimed_by_banner
      FROM scrims s
      LEFT JOIN players pp ON s.posted_by = pp.id
      LEFT JOIN captains pc ON s.captain_id = pc.id
      LEFT JOIN players cp ON s.claimed_by = cp.id
      LEFT JOIN captains cc ON s.claimed_captain_id = cc.id
      WHERE s.competition_id = $1
      ORDER BY s.scheduled_at ASC
    `, [compId])
    res.json(rows)
  })

  // Post a new scrim
  router.post('/api/competitions/:compId/scrims', async (req, res) => {
    const player = await getAuthPlayer(req)
    if (!player) return res.status(401).json({ error: 'Not authenticated' })
    const compId = Number(req.params.compId)

    const comp = await getCompetition(compId)
    if (!comp) return res.status(404).json({ error: 'Competition not found' })
    const settings = parseCompSettings(comp)

    // Check permission based on scrimAccess setting
    const captain = await queryOne(
      'SELECT * FROM captains WHERE competition_id = $1 AND player_id = $2', [compId, player.id]
    )

    if (settings.scrimAccess === 'captains_only') {
      if (!captain) return res.status(403).json({ error: 'Only captains can post scrims' })
    } else {
      // all_players: must be in competition
      const compPlayer = await queryOne(
        'SELECT * FROM competition_players WHERE competition_id = $1 AND player_id = $2', [compId, player.id]
      )
      if (!compPlayer && !captain) return res.status(403).json({ error: 'You must be a participant in this competition' })
    }

    const { scheduled_at, message } = req.body
    if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at is required' })
    if (new Date(scheduled_at) <= new Date()) return res.status(400).json({ error: 'Scheduled time must be in the future' })
    if (message && message.length > 500) return res.status(400).json({ error: 'Message must be 500 characters or less' })

    // Find poster's captain_id (their own captain record, or the captain they're drafted by)
    let captainId = captain?.id || null
    if (!captainId) {
      const compPlayer = await queryOne(
        'SELECT drafted_by FROM competition_players WHERE competition_id = $1 AND player_id = $2', [compId, player.id]
      )
      captainId = compPlayer?.drafted_by || null
    }

    const row = await queryOne(`
      INSERT INTO scrims (competition_id, posted_by, captain_id, scheduled_at, message)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `, [compId, player.id, captainId, scheduled_at, message || ''])

    const scrim = await getScrimWithNames(row.id)
    io.to(`comp:${compId}`).emit('scrims:created', { scrim })
    res.status(201).json(scrim)
  })

  // Claim a scrim
  router.post('/api/competitions/:compId/scrims/:id/claim', async (req, res) => {
    const player = await getAuthPlayer(req)
    if (!player) return res.status(401).json({ error: 'Not authenticated' })
    const compId = Number(req.params.compId)
    const scrimId = Number(req.params.id)

    const captain = await queryOne(
      'SELECT * FROM captains WHERE competition_id = $1 AND player_id = $2', [compId, player.id]
    )
    if (!captain) return res.status(403).json({ error: 'Only captains can accept scrims' })

    const scrim = await queryOne('SELECT * FROM scrims WHERE id = $1 AND competition_id = $2', [scrimId, compId])
    if (!scrim) return res.status(404).json({ error: 'Scrim not found' })
    if (scrim.status !== 'open') return res.status(400).json({ error: 'Scrim is no longer open' })

    // Cannot claim your own team's scrim
    if (scrim.captain_id === captain.id) return res.status(400).json({ error: 'Cannot accept your own scrim' })
    // If poster is a drafted player on claimer's team
    if (scrim.captain_id && scrim.captain_id === captain.id) return res.status(400).json({ error: 'Cannot accept a scrim from your own team' })

    await execute(`
      UPDATE scrims SET status = 'claimed', claimed_by = $1, claimed_captain_id = $2, claimed_at = NOW()
      WHERE id = $3
    `, [player.id, captain.id, scrimId])

    const updated = await getScrimWithNames(scrimId)
    io.to(`comp:${compId}`).emit('scrims:claimed', { scrim: updated })
    res.json(updated)
  })

  // Cancel a scrim
  router.post('/api/competitions/:compId/scrims/:id/cancel', async (req, res) => {
    const player = await getAuthPlayer(req)
    if (!player) return res.status(401).json({ error: 'Not authenticated' })
    const compId = Number(req.params.compId)
    const scrimId = Number(req.params.id)

    const scrim = await queryOne('SELECT * FROM scrims WHERE id = $1 AND competition_id = $2', [scrimId, compId])
    if (!scrim) return res.status(404).json({ error: 'Scrim not found' })

    const isAdmin = await hasPermission(player, 'manage_competitions') ||
      await hasPermission(player, 'manage_own_competitions')
    const isPoster = scrim.posted_by === player.id
    const isClaimer = scrim.claimed_by === player.id

    if (!isPoster && !isClaimer && !isAdmin) return res.status(403).json({ error: 'Not authorized' })

    if (scrim.status === 'open' && (isPoster || isAdmin)) {
      // Poster or admin cancels an open scrim
      await execute("UPDATE scrims SET status = 'cancelled', cancelled_by = $1 WHERE id = $2", [player.id, scrimId])
    } else if (scrim.status === 'claimed' && isClaimer) {
      // Claimer backs out → revert to open
      await execute("UPDATE scrims SET status = 'open', claimed_by = NULL, claimed_captain_id = NULL, claimed_at = NULL, cancelled_by = NULL WHERE id = $1", [scrimId])
    } else if (scrim.status === 'claimed' && (isPoster || isAdmin)) {
      // Poster or admin cancels a claimed scrim
      await execute("UPDATE scrims SET status = 'cancelled', cancelled_by = $1 WHERE id = $2", [player.id, scrimId])
    } else {
      return res.status(400).json({ error: 'Cannot cancel this scrim' })
    }

    const updated = await getScrimWithNames(scrimId)
    io.to(`comp:${compId}`).emit('scrims:cancelled', { scrim: updated })
    res.json(updated)
  })

  // Admin delete
  router.delete('/api/competitions/:compId/scrims/:id', async (req, res) => {
    const compId = Number(req.params.compId)
    const admin = await requireCompPermission(req, res, compId)
    if (!admin) return

    const scrimId = Number(req.params.id)
    const scrim = await queryOne('SELECT * FROM scrims WHERE id = $1 AND competition_id = $2', [scrimId, compId])
    if (!scrim) return res.status(404).json({ error: 'Scrim not found' })

    await execute('DELETE FROM scrims WHERE id = $1', [scrimId])
    io.to(`comp:${compId}`).emit('scrims:deleted', { scrimId })
    res.json({ ok: true })
  })

  return router
}
