import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { requirePermission } from '../middleware/permissions.js'
import { getAuthPlayer } from '../middleware/auth.js'
import { activeQueueMatches, playerInMatch, playerInQueue, poolQueues, getPoolQueuePlayers, clearPickTimer } from '../socket/queueState.js'
import { socketPlayers } from '../socket/state.js'
import { botPool } from '../services/botPool.js'
import { kickPlayerFromQueue } from '../socket/queue.js'

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

  // ── Public: per-player W/L over the last N completed queue matches in a pool ──
  // Used by the in-queue roster to show a mini form guide next to each player.
  router.get('/api/queue/players/stats', async (req, res) => {
    const poolId = Number(req.query.poolId)
    if (!poolId) return res.status(400).json({ error: 'poolId required' })
    const ids = String(req.query.playerIds || '')
      .split(',').map(s => Number(s)).filter(n => Number.isFinite(n) && n > 0)
    if (ids.length === 0) return res.json([])
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50)

    try {
      const rows = await query(`
        WITH player_list AS (
          SELECT unnest($1::int[]) AS player_id
        ),
        ranked AS (
          SELECT
            pl.player_id,
            qm.captain1_player_id,
            qm.captain2_player_id,
            m.winner_captain_id,
            CASE
              WHEN qm.captain1_player_id = pl.player_id
                OR qm.team1_players @> jsonb_build_array(jsonb_build_object('playerId', pl.player_id))
                THEN 1
              WHEN qm.captain2_player_id = pl.player_id
                OR qm.team2_players @> jsonb_build_array(jsonb_build_object('playerId', pl.player_id))
                THEN 2
            END AS player_team,
            ROW_NUMBER() OVER (
              PARTITION BY pl.player_id
              ORDER BY COALESCE(qm.completed_at, qm.created_at) DESC
            ) AS rn
          FROM player_list pl
          JOIN queue_matches qm
            ON qm.all_player_ids @> to_jsonb(pl.player_id)
           AND qm.pool_id = $2
           AND qm.status = 'completed'
          LEFT JOIN matches m ON m.id = qm.match_id
          WHERE m.winner_captain_id IS NOT NULL
        )
        SELECT
          player_id AS "playerId",
          COUNT(*) FILTER (WHERE
            (player_team = 1 AND winner_captain_id = captain1_player_id) OR
            (player_team = 2 AND winner_captain_id = captain2_player_id)
          )::int AS wins,
          COUNT(*) FILTER (WHERE player_team IS NOT NULL AND (
            (player_team = 1 AND winner_captain_id <> captain1_player_id) OR
            (player_team = 2 AND winner_captain_id <> captain2_player_id)
          ))::int AS losses
        FROM ranked
        WHERE rn <= $3 AND player_team IS NOT NULL
        GROUP BY player_id
      `, [ids, poolId, limit])
      res.json(rows)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
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

    // Include games with has_stats flag
    let games = []
    if (qm.match_id) {
      games = await query('SELECT * FROM match_games WHERE match_id = $1 ORDER BY game_number', [qm.match_id])
      if (games.length > 0) {
        const gameIds = games.map(g => g.id)
        const statsCounts = await query(
          'SELECT match_game_id, COUNT(*) as count FROM match_game_player_stats WHERE match_game_id = ANY($1) GROUP BY match_game_id',
          [gameIds]
        )
        const statsMap = {}
        for (const sc of statsCounts) statsMap[sc.match_game_id] = Number(sc.count)
        for (const g of games) g.has_stats = (statsMap[g.id] || 0) > 0
      }
    }

    res.json({ ...qm, games })
  })

  // ── Public: game stats for a queue match ──
  router.get('/api/queue/match/:id/games/:gameNumber/stats', async (req, res) => {
    const qm = await queryOne('SELECT match_id FROM queue_matches WHERE id = $1', [req.params.id])
    if (!qm?.match_id) return res.status(404).json({ error: 'Queue match not found' })

    const mg = await queryOne('SELECT id, picks_bans FROM match_games WHERE match_id = $1 AND game_number = $2', [qm.match_id, req.params.gameNumber])
    if (!mg) return res.json({ stats: [], picks_bans: [] })

    const stats = await query(
      `SELECT s.*, p.id AS profile_id, p.name AS profile_name, p.display_name AS profile_display_name, p.avatar_url AS profile_avatar
       FROM match_game_player_stats s
       LEFT JOIN players p ON p.steam_id = CAST((s.account_id + 76561197960265728) AS TEXT)
       WHERE s.match_game_id = $1
       ORDER BY s.is_radiant DESC, s.account_id`,
      [mg.id]
    )
    res.json({ stats, picks_bans: mg.picks_bans || [] })
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
          ml.game_name AS lobby_name, ml.password AS lobby_password, ml.status AS lobby_status,
          ml.error_message AS lobby_error, ml.bot_id AS lobby_bot_id,
          (SELECT COUNT(*)::int FROM match_lobbies WHERE match_id = qm.match_id AND status = 'error') AS lobby_error_count
        FROM queue_matches qm
        LEFT JOIN players p1 ON p1.id = qm.captain1_player_id
        LEFT JOIN players p2 ON p2.id = qm.captain2_player_id
        LEFT JOIN queue_pools qp ON qp.id = qm.pool_id
        LEFT JOIN LATERAL (
          SELECT game_name, password, status, error_message, bot_id
            FROM match_lobbies
           WHERE match_id = qm.match_id AND game_number = 1
           ORDER BY id DESC LIMIT 1
        ) ml ON TRUE
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

      // Cancel the Dota 2 lobby via bot if one exists
      const qm = await queryOne('SELECT match_id FROM queue_matches WHERE id = $1', [qmId])
      if (qm?.match_id) {
        const lobbies = await query(
          "SELECT id FROM match_lobbies WHERE match_id = $1 AND status NOT IN ('completed', 'cancelled', 'error')",
          [qm.match_id]
        )
        for (const lobby of lobbies) {
          try { await botPool.cancelLobby(lobby.id) } catch (e) { console.error('[Queue] Failed to cancel lobby:', e.message) }
        }
      }

      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: manually retry lobby creation for a queue match ──
  router.post('/api/admin/queue/matches/:id/retry-lobby', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_competitions')
    if (!admin) return
    const qmId = Number(req.params.id)
    try {
      const qm = await queryOne('SELECT match_id, status FROM queue_matches WHERE id = $1', [qmId])
      if (!qm) return res.status(404).json({ error: 'Queue match not found' })
      if (!qm.match_id) return res.status(400).json({ error: 'No match row linked to this queue match yet' })
      if (qm.status === 'cancelled' || qm.status === 'completed') {
        return res.status(409).json({ error: `Queue match is ${qm.status}` })
      }
      await botPool.adminRetryQueueLobby(qm.match_id)
      // Make sure queue_matches is flagged live so the usual flow resumes
      await execute(`UPDATE queue_matches SET status = 'live' WHERE id = $1 AND status IN ('lobby_creating', 'live')`, [qmId])
      res.json({ ok: true })
    } catch (e) {
      console.error('[Queue] Admin retry lobby failed:', e.message)
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: list currently queued players across all pools ──
  router.get('/api/admin/queue/players', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_competitions')
    if (!admin) return
    try {
      const out = []
      for (const [poolId] of poolQueues) {
        const players = getPoolQueuePlayers(poolId)
        for (const p of players) out.push({ ...p, poolId })
      }
      res.json(out)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: kick player from whatever queue they're in ──
  router.post('/api/admin/queue/kick/:playerId', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_competitions')
    if (!admin) return
    const playerId = Number(req.params.playerId)
    const reason = req.body?.reason || null
    try {
      const kicked = kickPlayerFromQueue(io, playerId, reason)
      res.json({ ok: true, kicked })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: list active queue bans ──
  router.get('/api/admin/queue/bans', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_competitions')
    if (!admin) return
    try {
      const rows = await query(`
        SELECT qb.player_id, qb.banned_until, qb.reason, qb.created_at,
               p.name, p.display_name, p.avatar_url,
               ab.name AS banned_by_name
          FROM queue_bans qb
          JOIN players p ON p.id = qb.player_id
          LEFT JOIN players ab ON ab.id = qb.banned_by
         WHERE qb.banned_until IS NULL OR qb.banned_until > NOW()
         ORDER BY qb.created_at DESC
      `)
      res.json(rows)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: create / update a queue ban ──
  // body: { player_id, duration_minutes (0 or null = permanent), reason }
  router.post('/api/admin/queue/bans', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_competitions')
    if (!admin) return
    const { player_id, duration_minutes, reason } = req.body || {}
    const pid = Number(player_id)
    if (!pid) return res.status(400).json({ error: 'player_id required' })

    const mins = Number(duration_minutes) || 0
    const bannedUntil = mins > 0 ? new Date(Date.now() + mins * 60_000) : null

    try {
      await execute(`
        INSERT INTO queue_bans (player_id, banned_until, reason, banned_by)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (player_id) DO UPDATE SET
          banned_until = EXCLUDED.banned_until,
          reason = EXCLUDED.reason,
          banned_by = EXCLUDED.banned_by,
          created_at = NOW()
      `, [pid, bannedUntil, reason || null, admin.id])

      // Kick them out if currently queued
      try { kickPlayerFromQueue(io, pid, reason || 'Banned from queue') } catch {}

      // Push the new ban state to any connected sockets of this player so
      // their client can immediately show the blocking banner + countdown.
      try {
        const banRow = await queryOne(
          `SELECT qb.banned_until, qb.reason, ab.name AS banned_by_name
             FROM queue_bans qb
             LEFT JOIN players ab ON ab.id = qb.banned_by
            WHERE qb.player_id = $1`,
          [pid]
        )
        const banPayload = banRow
          ? {
              bannedUntil: banRow.banned_until ? new Date(banRow.banned_until).toISOString() : null,
              reason: banRow.reason || null,
              bannedBy: banRow.banned_by_name || null,
            }
          : null
        for (const [sid, playerId] of socketPlayers) {
          if (playerId === pid) {
            const s = io.sockets.sockets.get(sid)
            if (s) s.emit('queue:myState', {
              inQueue: false, poolId: null, poolName: null,
              inMatch: false, queueMatchId: null, count: 0, players: [],
              ban: banPayload,
            })
          }
        }
      } catch {}

      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: remove a queue ban ──
  router.delete('/api/admin/queue/bans/:playerId', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_competitions')
    if (!admin) return
    const pid = Number(req.params.playerId)
    try {
      await execute('DELETE FROM queue_bans WHERE player_id = $1', [pid])
      // Push cleared ban to the player's sockets
      for (const [sid, playerId] of socketPlayers) {
        if (playerId === pid) {
          const s = io.sockets.sockets.get(sid)
          if (s) s.emit('queue:myState', {
            inQueue: false, poolId: null, poolName: null,
            inMatch: false, queueMatchId: null, count: 0, players: [],
            ban: null,
          })
        }
      }
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  return router
}
