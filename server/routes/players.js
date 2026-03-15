import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { getAuthPlayer } from '../middleware/auth.js'
import { requireCompPermission } from '../middleware/permissions.js'
import { getCompetition, getCompPlayers } from '../helpers/competition.js'
import { parseSteamIds, fetchSteamProfile } from '../helpers/steam.js'

export default function createPlayersRouter(io) {
  const router = Router()

  router.get('/api/competitions/:compId/players', async (req, res) => {
    res.json(await getCompPlayers(Number(req.params.compId)))
  })

  router.post('/api/competitions/:compId/players/register', async (req, res) => {
    const player = await getAuthPlayer(req)
    if (!player) return res.status(401).json({ error: 'Not authenticated' })
    if (player.is_banned) return res.status(403).json({ error: 'Your account has been banned' })
    const compId = Number(req.params.compId)

    if (!player.is_admin) {
      const comp = await getCompetition(compId)
      if (!comp) return res.status(404).json({ error: 'Competition not found' })
      const now = new Date()
      if (comp.registration_start && new Date(comp.registration_start) > now) {
        return res.status(403).json({ error: 'Registration has not opened yet' })
      }
      if (comp.registration_end && new Date(comp.registration_end) < now) {
        return res.status(403).json({ error: 'Registration has closed' })
      }
    }

    const existing = await queryOne(
      'SELECT * FROM competition_players WHERE competition_id = $1 AND player_id = $2',
      [compId, player.id]
    )
    if (existing?.in_pool) return res.status(409).json({ error: 'Already registered as a participant' })

    const { roles, mmr, info } = req.body

    await execute(
      'UPDATE players SET roles = $1, mmr = $2, info = $3 WHERE id = $4',
      [JSON.stringify(roles || []), mmr || 0, info || '', player.id]
    )

    if (existing) {
      await execute(
        'UPDATE competition_players SET roles = $1, mmr = $2, info = $3, in_pool = true WHERE id = $4',
        [JSON.stringify(roles || []), mmr || 0, info || '', existing.id]
      )
    } else {
      await execute(
        `INSERT INTO competition_players (competition_id, player_id, roles, mmr, info, in_pool)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [compId, player.id, JSON.stringify(roles || []), mmr || 0, info || '']
      )
    }

    io.to(`comp:${compId}`).emit('players:updated', await getCompPlayers(compId))
    res.json({ ok: true })
  })

  router.put('/api/competitions/:compId/players/:playerId', async (req, res) => {
    const compId = Number(req.params.compId)
    const admin = await requireCompPermission(req, res, compId, 'manage_players')
    if (!admin) return
    const playerId = Number(req.params.playerId)

    const cp = await queryOne(
      'SELECT * FROM competition_players WHERE competition_id = $1 AND player_id = $2',
      [compId, playerId]
    )
    if (!cp) return res.status(404).json({ error: 'Player not in this competition' })

    const { name, roles, mmr, info, is_admin } = req.body

    await execute(
      'UPDATE competition_players SET roles = $1, mmr = $2, info = $3 WHERE id = $4',
      [
        roles ? JSON.stringify(roles) : cp.roles,
        mmr ?? cp.mmr,
        info ?? cp.info,
        cp.id,
      ]
    )

    if (name !== undefined || is_admin !== undefined) {
      const player = await queryOne('SELECT * FROM players WHERE id = $1', [playerId])
      await execute(
        'UPDATE players SET name = $1, is_admin = $2 WHERE id = $3',
        [name ?? player.name, is_admin !== undefined ? is_admin : player.is_admin, playerId]
      )
    }

    io.to(`comp:${compId}`).emit('players:updated', await getCompPlayers(compId))
    res.json({ ok: true })
  })

  router.delete('/api/competitions/:compId/players/:playerId', async (req, res) => {
    const compId = Number(req.params.compId)
    const admin = await requireCompPermission(req, res, compId, 'manage_players')
    if (!admin) return
    const playerId = Number(req.params.playerId)

    await execute(
      'UPDATE competition_players SET in_pool = false, drafted = 0, drafted_by = NULL, draft_price = NULL, draft_round = NULL WHERE competition_id = $1 AND player_id = $2',
      [compId, playerId]
    )

    io.to(`comp:${compId}`).emit('players:updated', await getCompPlayers(compId))
    res.json({ ok: true })
  })

  // Admin: add user to competition pool
  router.post('/api/competitions/:compId/users/:userId/add-to-pool', async (req, res) => {
    const compId = Number(req.params.compId)
    const admin = await requireCompPermission(req, res, compId, 'manage_players')
    if (!admin) return
    const userId = Number(req.params.userId)

    const player = await queryOne('SELECT * FROM players WHERE id = $1', [userId])
    if (!player) return res.status(404).json({ error: 'User not found' })

    const existing = await queryOne(
      'SELECT * FROM competition_players WHERE competition_id = $1 AND player_id = $2',
      [compId, userId]
    )

    if (existing) {
      if (existing.in_pool) return res.status(409).json({ error: 'Already in pool' })
      await execute(
        'UPDATE competition_players SET in_pool = true, mmr = $1, roles = $2, info = $3 WHERE id = $4',
        [player.mmr, player.roles || '[]', player.info || '', existing.id]
      )
    } else {
      await execute(
        `INSERT INTO competition_players (competition_id, player_id, roles, mmr, info, in_pool)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [compId, userId, player.roles || '[]', player.mmr, player.info || '']
      )
    }

    io.to(`comp:${compId}`).emit('players:updated', await getCompPlayers(compId))
    res.json({ ok: true })
  })

  router.post('/api/competitions/:compId/users/:userId/remove-from-pool', async (req, res) => {
    const compId = Number(req.params.compId)
    const admin = await requireCompPermission(req, res, compId, 'manage_players')
    if (!admin) return
    const userId = Number(req.params.userId)

    await execute(
      'UPDATE competition_players SET in_pool = false WHERE competition_id = $1 AND player_id = $2',
      [compId, userId]
    )

    io.to(`comp:${compId}`).emit('players:updated', await getCompPlayers(compId))
    res.json({ ok: true })
  })

  // Import participants from Steam IDs
  router.post('/api/competitions/:compId/import-steam-participants', async (req, res) => {
    const compId = Number(req.params.compId)
    const admin = await requireCompPermission(req, res, compId, 'manage_players')
    if (!admin) return

    const { steamId } = req.body
    if (!steamId) return res.status(400).json({ error: 'steamId is required' })

    // Find or create the global player
    let player = await queryOne('SELECT id, name, avatar_url, roles, mmr, info FROM players WHERE steam_id = $1', [steamId])
    let userStatus = 'existed'

    if (!player) {
      const { personaName, avatarUrl } = await fetchSteamProfile(steamId)
      player = await queryOne(
        'INSERT INTO players (name, steam_id, avatar_url) VALUES ($1, $2, $3) RETURNING id, name, avatar_url, roles, mmr, info',
        [personaName, steamId, avatarUrl]
      )
      userStatus = 'created'
    }

    // Check if already a captain
    const captain = await queryOne(
      'SELECT id FROM captains WHERE competition_id = $1 AND player_id = $2',
      [compId, player.id]
    )
    if (captain) {
      return res.json({ steamId, name: player.name, avatarUrl: player.avatar_url, status: 'captain', id: player.id })
    }

    // Add to competition pool
    const existing = await queryOne(
      'SELECT * FROM competition_players WHERE competition_id = $1 AND player_id = $2',
      [compId, player.id]
    )

    if (existing) {
      if (existing.in_pool) {
        return res.json({ steamId, name: player.name, avatarUrl: player.avatar_url, status: 'already_in_pool', id: player.id })
      }
      await execute(
        'UPDATE competition_players SET in_pool = true, mmr = $1, roles = $2, info = $3 WHERE id = $4',
        [player.mmr, player.roles || '[]', player.info || '', existing.id]
      )
    } else {
      await execute(
        `INSERT INTO competition_players (competition_id, player_id, roles, mmr, info, in_pool)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [compId, player.id, player.roles || '[]', player.mmr, player.info || '']
      )
    }

    io.to(`comp:${compId}`).emit('players:updated', await getCompPlayers(compId))
    res.json({ steamId, name: player.name, avatarUrl: player.avatar_url, status: 'added', id: player.id })
  })

  return router
}
