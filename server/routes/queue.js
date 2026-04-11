import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { requirePermission } from '../middleware/permissions.js'
import { getAuthPlayer } from '../middleware/auth.js'
import { activeQueueMatches, playerInMatch, clearPickTimer } from '../socket/queueState.js'
import { socketPlayers } from '../socket/state.js'

export default function createQueueRouter(io) {
  const router = Router()

  // ── Public: list enabled pools ──
  router.get('/api/queue/pools', async (req, res) => {
    try {
      const pools = await query('SELECT * FROM queue_pools WHERE enabled = true ORDER BY id')
      res.json(pools)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Public: pool details ──
  router.get('/api/queue/pools/:poolId', async (req, res) => {
    try {
      const pool = await queryOne('SELECT * FROM queue_pools WHERE id = $1', [req.params.poolId])
      if (!pool) return res.status(404).json({ error: 'Pool not found' })
      res.json(pool)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Public: queue match history ──
  router.get('/api/queue/history', async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 50)
    const offset = Number(req.query.offset) || 0
    const poolId = req.query.poolId ? Number(req.query.poolId) : null

    let sql = `
      SELECT qm.*,
        p1.name AS captain1_name, COALESCE(p1.display_name, p1.name) AS captain1_display_name, p1.avatar_url AS captain1_avatar,
        p2.name AS captain2_name, COALESCE(p2.display_name, p2.name) AS captain2_display_name, p2.avatar_url AS captain2_avatar,
        qp.name AS pool_name
      FROM queue_matches qm
      LEFT JOIN players p1 ON p1.id = qm.captain1_player_id
      LEFT JOIN players p2 ON p2.id = qm.captain2_player_id
      LEFT JOIN queue_pools qp ON qp.id = qm.pool_id
      WHERE qm.status IN ('live', 'completed')
    `
    const params = []
    if (poolId) {
      params.push(poolId)
      sql += ` AND qm.pool_id = $${params.length}`
    }
    sql += ` ORDER BY qm.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
    params.push(limit, offset)

    const matches = await query(sql, params)
    res.json(matches)
  })

  // ── Public: single queue match details ──
  router.get('/api/queue/match/:id', async (req, res) => {
    const qm = await queryOne(`
      SELECT qm.*,
        p1.name AS captain1_name, COALESCE(p1.display_name, p1.name) AS captain1_display_name, p1.avatar_url AS captain1_avatar, p1.steam_id AS captain1_steam_id,
        p2.name AS captain2_name, COALESCE(p2.display_name, p2.name) AS captain2_display_name, p2.avatar_url AS captain2_avatar, p2.steam_id AS captain2_steam_id,
        qp.name AS pool_name
      FROM queue_matches qm
      LEFT JOIN players p1 ON p1.id = qm.captain1_player_id
      LEFT JOIN players p2 ON p2.id = qm.captain2_player_id
      LEFT JOIN queue_pools qp ON qp.id = qm.pool_id
      WHERE qm.id = $1
    `, [req.params.id])
    if (!qm) return res.status(404).json({ error: 'Queue match not found' })

    // Include game stats if match has a linked match row
    let games = []
    if (qm.match_id) {
      games = await query('SELECT * FROM match_games WHERE match_id = $1 ORDER BY game_number', [qm.match_id])
    }

    res.json({ ...qm, games })
  })

  // ── Admin: list all pools ──
  router.get('/api/admin/queue/pools', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_competitions')
    if (!admin) return
    try {
      const pools = await query('SELECT * FROM queue_pools ORDER BY id')
      res.json(pools)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: create pool ──
  router.post('/api/admin/queue/pools', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_competitions')
    if (!admin) return

    const {
      name, enabled, min_mmr, max_mmr, pick_timer, best_of, team_size,
      lobby_server_region, lobby_game_mode, lobby_league_id,
      lobby_dotv_delay, lobby_cheats, lobby_allow_spectating,
      lobby_pause_setting, lobby_selection_priority, lobby_cm_pick,
      lobby_auto_assign_teams, lobby_penalty_radiant, lobby_penalty_dire,
      lobby_series_type, lobby_timeout_minutes,
      xp_win, xp_participate,
    } = req.body

    if (!name) return res.status(400).json({ error: 'Name is required' })

    try {
      const pool = await queryOne(`
        INSERT INTO queue_pools (
          name, enabled, min_mmr, max_mmr, pick_timer, best_of, team_size,
          lobby_server_region, lobby_game_mode, lobby_league_id,
          lobby_dotv_delay, lobby_cheats, lobby_allow_spectating,
          lobby_pause_setting, lobby_selection_priority, lobby_cm_pick,
          lobby_auto_assign_teams, lobby_penalty_radiant, lobby_penalty_dire,
          lobby_series_type, lobby_timeout_minutes,
          xp_win, xp_participate
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
        RETURNING *
      `, [
        name, enabled !== false, min_mmr || 0, max_mmr || 0,
        pick_timer || 30, best_of || 1, team_size || 5,
        lobby_server_region || 3, lobby_game_mode || 2, lobby_league_id || 0,
        lobby_dotv_delay ?? 1, !!lobby_cheats, lobby_allow_spectating !== false,
        lobby_pause_setting || 0, lobby_selection_priority || 0, lobby_cm_pick || 0,
        lobby_auto_assign_teams !== false, lobby_penalty_radiant || 0, lobby_penalty_dire || 0,
        lobby_series_type || 0, lobby_timeout_minutes || 10,
        xp_win ?? 15, xp_participate ?? 5,
      ])
      res.status(201).json(pool)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: update pool ──
  router.put('/api/admin/queue/pools/:id', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_competitions')
    if (!admin) return

    try {
      const poolId = Number(req.params.id)
      const existing = await queryOne('SELECT * FROM queue_pools WHERE id = $1', [poolId])
      if (!existing) return res.status(404).json({ error: 'Pool not found' })

      const fields = [
        'name', 'enabled', 'min_mmr', 'max_mmr', 'pick_timer', 'best_of', 'team_size',
        'lobby_server_region', 'lobby_game_mode', 'lobby_league_id',
        'lobby_dotv_delay', 'lobby_cheats', 'lobby_allow_spectating',
        'lobby_pause_setting', 'lobby_selection_priority', 'lobby_cm_pick',
        'lobby_auto_assign_teams', 'lobby_penalty_radiant', 'lobby_penalty_dire',
        'lobby_series_type', 'lobby_timeout_minutes',
        'xp_win', 'xp_participate',
      ]
      const setClauses = []
      const values = []
      for (const f of fields) {
        if (req.body[f] !== undefined) {
          values.push(req.body[f])
          setClauses.push(`${f} = $${values.length}`)
        }
      }
      if (setClauses.length === 0) return res.json(existing)

      values.push(poolId)
      const updated = await queryOne(
        `UPDATE queue_pools SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING *`,
        values
      )
      res.json(updated)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: delete pool ──
  router.delete('/api/admin/queue/pools/:id', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_competitions')
    if (!admin) return
    try {
      await execute('DELETE FROM queue_pools WHERE id = $1', [req.params.id])
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: list active queue matches ──
  router.get('/api/admin/queue/matches', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_competitions')
    if (!admin) return

    try {
      // Get matches from DB that are still active
      const dbMatches = await query(`
        SELECT qm.*,
          p1.name AS captain1_name, COALESCE(p1.display_name, p1.name) AS captain1_display_name, p1.avatar_url AS captain1_avatar,
          p2.name AS captain2_name, COALESCE(p2.display_name, p2.name) AS captain2_display_name, p2.avatar_url AS captain2_avatar,
          qp.name AS pool_name, qp.team_size AS pool_team_size,
          ml.game_name AS lobby_name, ml.password AS lobby_password, ml.status AS lobby_status
        FROM queue_matches qm
        LEFT JOIN players p1 ON p1.id = qm.captain1_player_id
        LEFT JOIN players p2 ON p2.id = qm.captain2_player_id
        LEFT JOIN queue_pools qp ON qp.id = qm.pool_id
        LEFT JOIN match_lobbies ml ON ml.match_id = qm.match_id AND ml.game_number = 1
        WHERE qm.status IN ('picking', 'lobby_creating', 'live')
        ORDER BY qm.created_at DESC
      `)

      // Enrich with in-memory state where available
      const result = dbMatches.map(qm => {
        const mem = activeQueueMatches.get(qm.id)
        return {
          ...qm,
          inMemory: !!mem,
          memStatus: mem?.status || null,
          team1: mem ? [mem.captain1, ...mem.captain1Picks] : qm.team1_players || [],
          team2: mem ? [mem.captain2, ...mem.captain2Picks] : qm.team2_players || [],
          pickIndex: mem?.pickIndex || null,
          pickOrderLength: mem?.pickOrder?.length || null,
        }
      })

      res.json(result)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: cancel a queue match ──
  router.post('/api/admin/queue/matches/:id/cancel', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_competitions')
    if (!admin) return

    const qmId = Number(req.params.id)
    try {
      const match = activeQueueMatches.get(qmId)
      if (match) {
        // Cancel in-memory match (picking / lobby_creating / live)
        clearPickTimer(qmId)
        io.to(`queue-match:${qmId}`).emit('queue:cancelled', { queueMatchId: qmId, reason: 'Cancelled by admin' })
        for (const p of match.allPlayers) {
          playerInMatch.delete(p.playerId)
        }
        const room = `queue-match:${qmId}`
        for (const [socketId, playerId] of socketPlayers) {
          if (match.allPlayers.some(p => p.playerId === playerId)) {
            const s = io.sockets.sockets.get(socketId)
            if (s) s.leave(room)
          }
        }
        activeQueueMatches.delete(qmId)
      }

      // Always update DB status
      await execute(`UPDATE queue_matches SET status = 'cancelled' WHERE id = $1`, [qmId])

      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  return router
}
