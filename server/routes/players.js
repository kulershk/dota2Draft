import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { getAuthPlayer } from '../middleware/auth.js'
import { requireCompPermission } from '../middleware/permissions.js'
import { getCompetition, getCompPlayers } from '../helpers/competition.js'
import { parseSteamIds, fetchSteamProfile } from '../helpers/steam.js'
import { steamIdToAccountId } from '../helpers/fantasy.js'

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
      if (comp.settings?.allowSteamRegistration === false) {
        return res.status(403).json({ error: 'Self-registration is disabled for this competition' })
      }
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

    const isVerified = !!player.mmr_verified_at
    const effectiveMmr = isVerified ? player.mmr : (mmr || 0)

    if (isVerified) {
      await execute(
        'UPDATE players SET roles = $1, info = $2 WHERE id = $3',
        [JSON.stringify(roles || []), info || '', player.id]
      )
    } else {
      await execute(
        'UPDATE players SET roles = $1, mmr = $2, info = $3 WHERE id = $4',
        [JSON.stringify(roles || []), effectiveMmr, info || '', player.id]
      )
    }

    if (existing) {
      await execute(
        'UPDATE competition_players SET roles = $1, mmr = $2, info = $3, in_pool = true WHERE id = $4',
        [JSON.stringify(roles || []), effectiveMmr, info || '', existing.id]
      )
    } else {
      await execute(
        `INSERT INTO competition_players (competition_id, player_id, roles, mmr, info, in_pool)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [compId, player.id, JSON.stringify(roles || []), effectiveMmr, info || '']
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

    const { name, roles, mmr, info, is_admin, playing_role } = req.body

    await execute(
      'UPDATE competition_players SET roles = $1, mmr = $2, info = $3, playing_role = $4 WHERE id = $5',
      [
        roles ? JSON.stringify(roles) : cp.roles,
        mmr ?? cp.mmr,
        info ?? cp.info,
        playing_role !== undefined ? (playing_role || null) : cp.playing_role,
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

  // Sync playing_role from most recent match lane_role
  router.post('/api/competitions/:compId/players/sync-roles', async (req, res) => {
    const compId = Number(req.params.compId)
    const admin = await requireCompPermission(req, res, compId, 'manage_players')
    if (!admin) return

    // Get all competition players with steam IDs
    const players = await query(`
      SELECT cp.player_id, p.steam_id
      FROM competition_players cp
      JOIN players p ON p.id = cp.player_id
      WHERE cp.competition_id = $1 AND cp.in_pool = true
    `, [compId])

    // Get all match game IDs for this competition
    const gameRows = await query(`
      SELECT mg.id FROM match_games mg
      JOIN matches m ON m.id = mg.match_id
      WHERE m.competition_id = $1
    `, [compId])
    const gameIds = gameRows.map(r => r.id)

    let updated = 0
    if (gameIds.length > 0) {
      for (const p of players) {
        const accountId = steamIdToAccountId(p.steam_id)
        if (!accountId) continue

        // Get most recent lane_role for this player
        const stat = await queryOne(`
          SELECT lane_role FROM match_game_player_stats
          WHERE account_id = $1 AND match_game_id = ANY($2) AND lane_role IS NOT NULL
          ORDER BY match_game_id DESC LIMIT 1
        `, [accountId, gameIds])

        if (stat?.lane_role) {
          // lane_role: 1=Safe, 2=Mid, 3=Off, 4=Jungle → playing_role 1-4
          const playingRole = stat.lane_role
          await execute(
            'UPDATE competition_players SET playing_role = $1 WHERE competition_id = $2 AND player_id = $3',
            [playingRole, compId, p.player_id]
          )
          updated++
        }
      }
    }

    io.to(`comp:${compId}`).emit('players:updated', await getCompPlayers(compId))
    res.json({ ok: true, updated })
  })

  // Admin: assign player to a captain's team
  router.post('/api/competitions/:compId/players/:playerId/assign', async (req, res) => {
    const compId = Number(req.params.compId)
    const admin = await requireCompPermission(req, res, compId, 'manage_players')
    if (!admin) return
    const playerId = Number(req.params.playerId)
    const { captainId } = req.body
    if (!captainId) return res.status(400).json({ error: 'captainId is required' })

    const cp = await queryOne(
      'SELECT * FROM competition_players WHERE competition_id = $1 AND player_id = $2',
      [compId, playerId]
    )
    if (!cp) return res.status(404).json({ error: 'Player not in this competition' })

    const captain = await queryOne('SELECT id FROM captains WHERE id = $1 AND competition_id = $2', [captainId, compId])
    if (!captain) return res.status(404).json({ error: 'Captain not found' })

    await execute(
      'UPDATE competition_players SET drafted = 1, drafted_by = $1 WHERE competition_id = $2 AND player_id = $3',
      [captainId, compId, playerId]
    )

    io.to(`comp:${compId}`).emit('players:updated', await getCompPlayers(compId))
    res.json({ ok: true })
  })

  // Admin: remove player from a captain's team
  router.post('/api/competitions/:compId/players/:playerId/unassign', async (req, res) => {
    const compId = Number(req.params.compId)
    const admin = await requireCompPermission(req, res, compId, 'manage_players')
    if (!admin) return
    const playerId = Number(req.params.playerId)

    await execute(
      'UPDATE competition_players SET drafted = 0, drafted_by = NULL, draft_price = NULL, draft_round = NULL WHERE competition_id = $1 AND player_id = $2',
      [compId, playerId]
    )

    io.to(`comp:${compId}`).emit('players:updated', await getCompPlayers(compId))
    res.json({ ok: true })
  })

  return router
}
