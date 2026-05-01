import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { requirePermission, hasPermission } from '../middleware/permissions.js'
import { getAuthPlayer } from '../middleware/auth.js'
import { getLiveSnapshot } from '../services/liveMatchPoller.js'

// Resolves the caller's queue-admin scope. Returns:
//   { player, canManageAll: true,  ownedPoolIds: null }  — full perm
//   { player, canManageAll: false, ownedPoolIds: Set<id> } — own perm only
// Writes the 401/403 response and returns null when the caller has neither perm.
async function getQueueAdminScope(req, res) {
  const player = await getAuthPlayer(req)
  if (!player) { res.status(401).json({ error: 'Not authenticated' }); return null }
  if (player.is_admin || await hasPermission(player, 'manage_queue_pools')) {
    return { player, canManageAll: true, ownedPoolIds: null }
  }
  if (await hasPermission(player, 'manage_own_queue_pools')) {
    const rows = await query('SELECT id FROM queue_pools WHERE created_by = $1', [player.id])
    return { player, canManageAll: false, ownedPoolIds: new Set(rows.map(r => r.id)) }
  }
  res.status(403).json({ error: 'Permission denied' })
  return null
}
import { activeQueueMatches, playerInMatch, playerInQueue, poolQueues, getPoolQueuePlayers, clearPickTimer } from '../socket/queueState.js'
import { socketPlayers } from '../socket/state.js'
import { botPool } from '../services/botPool.js'
import { kickPlayerFromQueue } from '../socket/queue.js'

export default function createQueueRouter(io) {
  const router = Router()

  // ── Public: list enabled pools ──
  router.get('/api/queue/pools', async (req, res) => {
    try {
      const pools = await query(`
        SELECT qp.*, s.name AS season_name, s.slug AS season_slug,
               COALESCE(s.verified_mmr_only, FALSE) AS verified_mmr_only
        FROM queue_pools qp
        LEFT JOIN seasons s ON s.id = qp.season_id
        WHERE qp.enabled = true
        ORDER BY qp.id
      `)
      for (const p of pools) p.queue_count = poolQueues.get(p.id)?.size || 0
      res.json(pools)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Public: pool details ──
  router.get('/api/queue/pools/:poolId', async (req, res) => {
    try {
      const pool = await queryOne(`
        SELECT qp.*, s.name AS season_name, s.slug AS season_slug,
               COALESCE(s.verified_mmr_only, FALSE) AS verified_mmr_only
        FROM queue_pools qp
        LEFT JOIN seasons s ON s.id = qp.season_id
        WHERE qp.id = $1
      `, [req.params.poolId])
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
        p1.name AS captain1_name, COALESCE(p1.display_name, p1.name) AS captain1_display_name, p1.avatar_url AS captain1_avatar, p1.mmr_verified_at AS captain1_mmr_verified_at,
        p2.name AS captain2_name, COALESCE(p2.display_name, p2.name) AS captain2_display_name, p2.avatar_url AS captain2_avatar, p2.mmr_verified_at AS captain2_mmr_verified_at,
        qp.name AS pool_name,
        m.score1, m.score2, m.winner_captain_id, m.best_of
      FROM queue_matches qm
      LEFT JOIN players p1 ON p1.id = qm.captain1_player_id
      LEFT JOIN players p2 ON p2.id = qm.captain2_player_id
      LEFT JOIN queue_pools qp ON qp.id = qm.pool_id
      LEFT JOIN matches m ON m.id = qm.match_id
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

    // Aggregate per-side kills across all games of each match. m.score1/score2
    // is the games-won (Bo1=0/1, Bo3=0..2) result; users want the actual
    // in-game kill count to render in Recent Matches.
    //
    // match_game_player_stats stores account_id (32-bit Steam) — to map back
    // to players.id we join on steam_id = (account_id + 76561197960265728) as TEXT.
    const matchIds = matches.filter(m => m.match_id).map(m => m.match_id)
    if (matchIds.length) {
      const statRows = await query(`
        SELECT mg.match_id, p.id AS player_id, s.kills
        FROM match_game_player_stats s
        JOIN match_games mg ON mg.id = s.match_game_id
        LEFT JOIN players p ON p.steam_id = CAST((s.account_id + 76561197960265728) AS TEXT)
        WHERE mg.match_id = ANY($1::int[])
      `, [matchIds])
      const killsByMatchPlayer = new Map() // matchId -> Map<playerId, totalKills>
      for (const r of statRows) {
        if (!r.player_id) continue
        let m = killsByMatchPlayer.get(r.match_id)
        if (!m) { m = new Map(); killsByMatchPlayer.set(r.match_id, m) }
        m.set(r.player_id, (m.get(r.player_id) || 0) + Number(r.kills || 0))
      }
      for (const qm of matches) {
        const km = qm.match_id && killsByMatchPlayer.get(qm.match_id)
        if (!km) continue
        const team1Ids = (qm.team1_players || []).map(p => p.playerId)
        const team2Ids = (qm.team2_players || []).map(p => p.playerId)
        let t1 = 0, t2 = 0
        for (const pid of team1Ids) t1 += km.get(pid) || 0
        for (const pid of team2Ids) t2 += km.get(pid) || 0
        if (t1 > 0 || t2 > 0) {
          qm.team1_kills = t1
          qm.team2_kills = t2
        }
      }
    }

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
        p1.name AS captain1_name, COALESCE(p1.display_name, p1.name) AS captain1_display_name, p1.avatar_url AS captain1_avatar, p1.steam_id AS captain1_steam_id, p1.mmr_verified_at AS captain1_mmr_verified_at,
        p2.name AS captain2_name, COALESCE(p2.display_name, p2.name) AS captain2_display_name, p2.avatar_url AS captain2_avatar, p2.steam_id AS captain2_steam_id, p2.mmr_verified_at AS captain2_mmr_verified_at,
        qp.name AS pool_name,
        s.id AS season_id_full, s.name AS season_name, s.slug AS season_slug, s.is_active AS season_is_active
      FROM queue_matches qm
      LEFT JOIN players p1 ON p1.id = qm.captain1_player_id
      LEFT JOIN players p2 ON p2.id = qm.captain2_player_id
      LEFT JOIN queue_pools qp ON qp.id = qm.pool_id
      LEFT JOIN seasons s ON s.id = qm.season_id
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

    // Enrich every roster player with their current verified-MMR timestamp
    // so the UI can render the verified badge. team1_players / team2_players
    // are JSONB snapshots, so we join against the live players table here.
    const allRosterIds = [
      ...((qm.team1_players || []).map(p => p.playerId)),
      ...((qm.team2_players || []).map(p => p.playerId)),
    ]
    if (allRosterIds.length) {
      const verifiedRows = await query(
        'SELECT id, mmr_verified_at FROM players WHERE id = ANY($1::int[])',
        [allRosterIds]
      )
      const verifiedById = Object.fromEntries(verifiedRows.map(r => [r.id, r.mmr_verified_at || null]))
      const stamp = (p) => { p.mmr_verified_at = verifiedById[p.playerId] || null }
      ;(qm.team1_players || []).forEach(stamp)
      ;(qm.team2_players || []).forEach(stamp)
    }

    // Enrich players with season data (rating delta from this match + current standing).
    // Both lookups gracefully return empty if the match isn't attached to a season.
    let season = null
    if (qm.season_id) {
      season = {
        id: qm.season_id_full || qm.season_id,
        name: qm.season_name,
        slug: qm.season_slug,
        is_active: !!qm.season_is_active,
      }
      const allPlayerIds = [
        ...((qm.team1_players || []).map(p => p.playerId)),
        ...((qm.team2_players || []).map(p => p.playerId)),
      ]
      if (allPlayerIds.length) {
        const [logRows, rankRows] = await Promise.all([
          query(`
            SELECT player_id, points_before, points_after, delta
            FROM season_match_log
            WHERE season_id = $1 AND queue_match_id = $2
          `, [qm.season_id, qm.id]),
          query(`
            SELECT player_id, points, peak_points, games_played, wins, losses
            FROM season_rankings
            WHERE season_id = $1 AND player_id = ANY($2::int[])
          `, [qm.season_id, allPlayerIds]),
        ])
        const logByPid = Object.fromEntries(logRows.map(r => [r.player_id, r]))
        const rankByPid = Object.fromEntries(rankRows.map(r => [r.player_id, r]))
        const enrich = (p) => {
          const log = logByPid[p.playerId]
          const rank = rankByPid[p.playerId]
          if (log) {
            p.season_delta = Number(log.delta)
            p.points_before = Number(log.points_before)
            p.points_after = Number(log.points_after)
          }
          if (rank) {
            p.season_points = Number(rank.points)
            p.season_games = rank.games_played
            p.season_wins = rank.wins
            p.season_losses = rank.losses
          }
        }
        ;(qm.team1_players || []).forEach(enrich)
        ;(qm.team2_players || []).forEach(enrich)
      }
    }
    delete qm.season_id_full
    delete qm.season_name
    delete qm.season_slug
    delete qm.season_is_active

    res.json({ ...qm, games, season })
  })

  // ── Public: latest live snapshot for a queue match ──
  // Returns the in-memory snapshot from liveMatchPoller (per-player heroes,
  // KDA, NW, level, items, plus team scores and game time). Used by the match
  // page on mount so a refresh / late-join sees current state without waiting
  // up to 12s for the next poll tick. Returns 200 + null if no live data.
  router.get('/api/queue/match/:id/live', async (req, res) => {
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ error: 'Invalid id' })
    res.json(getLiveSnapshot(id))
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
    const scope = await getQueueAdminScope(req, res)
    if (!scope) return
    try {
      const baseSelect = `
        SELECT qp.*, s.name AS season_name, s.slug AS season_slug,
               COALESCE(s.verified_mmr_only, FALSE) AS verified_mmr_only
        FROM queue_pools qp
        LEFT JOIN seasons s ON s.id = qp.season_id
      `
      const pools = scope.canManageAll
        ? await query(`${baseSelect} ORDER BY qp.id`)
        : await query(`${baseSelect} WHERE qp.created_by = $1 ORDER BY qp.id`, [scope.player.id])
      res.json(pools)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: create pool ──
  router.post('/api/admin/queue/pools', async (req, res) => {
    const scope = await getQueueAdminScope(req, res)
    if (!scope) return
    const admin = scope.player

    const {
      name, enabled, min_mmr, max_mmr, pick_timer, best_of, team_size,
      lobby_server_region, lobby_game_mode, lobby_league_id,
      lobby_dotv_delay, lobby_cheats, lobby_allow_spectating,
      lobby_pause_setting, lobby_selection_priority, lobby_cm_pick,
      lobby_auto_assign_teams, lobby_penalty_radiant, lobby_penalty_dire,
      lobby_series_type, lobby_timeout_minutes,
      xp_win, xp_participate,
      accept_timer, decline_ban_minutes,
      season_id,
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
          xp_win, xp_participate,
          accept_timer, decline_ban_minutes,
          season_id, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
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
        accept_timer ?? 20, decline_ban_minutes ?? 5,
        season_id || null, admin.id,
      ])
      res.status(201).json(pool)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: update pool ──
  router.put('/api/admin/queue/pools/:id', async (req, res) => {
    const scope = await getQueueAdminScope(req, res)
    if (!scope) return

    try {
      const poolId = Number(req.params.id)
      const existing = await queryOne('SELECT * FROM queue_pools WHERE id = $1', [poolId])
      if (!existing) return res.status(404).json({ error: 'Pool not found' })
      if (!scope.canManageAll && existing.created_by !== scope.player.id) {
        return res.status(403).json({ error: 'Permission denied — you can only edit pools you created' })
      }

      const fields = [
        'name', 'enabled', 'min_mmr', 'max_mmr', 'pick_timer', 'best_of', 'team_size',
        'lobby_server_region', 'lobby_game_mode', 'lobby_league_id',
        'lobby_dotv_delay', 'lobby_cheats', 'lobby_allow_spectating',
        'lobby_pause_setting', 'lobby_selection_priority', 'lobby_cm_pick',
        'lobby_auto_assign_teams', 'lobby_penalty_radiant', 'lobby_penalty_dire',
        'lobby_series_type', 'lobby_timeout_minutes',
        'xp_win', 'xp_participate',
        'accept_timer', 'decline_ban_minutes',
        'season_id',
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
    const scope = await getQueueAdminScope(req, res)
    if (!scope) return
    try {
      const poolId = Number(req.params.id)
      const existing = await queryOne('SELECT created_by FROM queue_pools WHERE id = $1', [poolId])
      if (!existing) return res.status(404).json({ error: 'Pool not found' })
      if (!scope.canManageAll && existing.created_by !== scope.player.id) {
        return res.status(403).json({ error: 'Permission denied — you can only delete pools you created' })
      }
      await execute('DELETE FROM queue_pools WHERE id = $1', [poolId])
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: list active queue matches ──
  router.get('/api/admin/queue/matches', async (req, res) => {
    const scope = await getQueueAdminScope(req, res)
    if (!scope) return

    try {
      // Filter to owned pools when caller has only manage_own_queue_pools.
      const params = []
      let scopeFilter = ''
      if (!scope.canManageAll) {
        const ids = [...scope.ownedPoolIds]
        if (ids.length === 0) return res.json([])
        params.push(ids)
        scopeFilter = ` AND qm.pool_id = ANY($${params.length}::int[])`
      }
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
          ${scopeFilter}
        ORDER BY qm.created_at DESC
      `, params)

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
    const scope = await getQueueAdminScope(req, res)
    if (!scope) return

    const qmId = Number(req.params.id)
    try {
      // Refuse cancel once the bot has started the match and left the lobby.
      // match_lobbies.status flips to 'completed' on game_started — past that
      // point, the Dota match is running on its own and there's nothing to cancel.
      const qmRow = await queryOne('SELECT match_id, pool_id FROM queue_matches WHERE id = $1', [qmId])
      if (qmRow && !scope.canManageAll && !scope.ownedPoolIds.has(qmRow.pool_id)) {
        return res.status(403).json({ error: 'Permission denied — match is not in a pool you own' })
      }
      if (qmRow?.match_id) {
        const latestLobby = await queryOne(
          'SELECT status FROM match_lobbies WHERE match_id = $1 ORDER BY id DESC LIMIT 1',
          [qmRow.match_id]
        )
        if (latestLobby?.status === 'completed') {
          return res.status(409).json({ error: 'Match already started — bot has left the lobby' })
        }
      }

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

      // Safety net: even if the in-memory match was already gone (state drifted
      // out of sync — e.g. server restart, half-cleaned lobby, race), the
      // playerInMatch map can still hold stale entries that lock people out of
      // re-queuing. Walk the persisted roster and free anyone still pinned to
      // this queueMatchId. Idempotent and safe — the equality check ensures we
      // never free a player who's been since pulled into a different match.
      try {
        const roster = await queryOne(
          'SELECT team1_players, team2_players FROM queue_matches WHERE id = $1',
          [qmId]
        )
        const allIds = [
          ...((roster?.team1_players || []).map(p => p.playerId)),
          ...((roster?.team2_players || []).map(p => p.playerId)),
        ]
        for (const pid of allIds) {
          if (playerInMatch.get(pid) === qmId) playerInMatch.delete(pid)
        }
        activeQueueMatches.delete(qmId)
      } catch (e) {
        console.error('[Queue cancel] roster cleanup failed:', e.message)
      }

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
    const scope = await getQueueAdminScope(req, res)
    if (!scope) return
    const qmId = Number(req.params.id)
    try {
      const qm = await queryOne('SELECT match_id, status, pool_id FROM queue_matches WHERE id = $1', [qmId])
      if (!qm) return res.status(404).json({ error: 'Queue match not found' })
      if (!scope.canManageAll && !scope.ownedPoolIds.has(qm.pool_id)) {
        return res.status(403).json({ error: 'Permission denied — match is not in a pool you own' })
      }
      if (!qm.match_id) return res.status(400).json({ error: 'No match row linked to this queue match yet' })
      if (qm.status === 'cancelled' || qm.status === 'completed') {
        return res.status(409).json({ error: `Queue match is ${qm.status}` })
      }
      const latestLobby = await queryOne(
        'SELECT status FROM match_lobbies WHERE match_id = $1 ORDER BY id DESC LIMIT 1',
        [qm.match_id]
      )
      if (latestLobby?.status === 'completed') {
        return res.status(409).json({ error: 'Match already started — bot has left the lobby' })
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
    const scope = await getQueueAdminScope(req, res)
    if (!scope) return
    try {
      const out = []
      for (const [poolId] of poolQueues) {
        if (!scope.canManageAll && !scope.ownedPoolIds.has(poolId)) continue
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
    const scope = await getQueueAdminScope(req, res)
    if (!scope) return
    const playerId = Number(req.params.playerId)
    const reason = req.body?.reason || null
    try {
      // Own-perm callers can only kick from their pools.
      const onlyInPool = scope.canManageAll
        ? null
        : (() => {
            const poolId = playerInQueue.get(playerId)
            return poolId && scope.ownedPoolIds.has(poolId) ? poolId : -1
          })()
      if (onlyInPool === -1) return res.status(403).json({ error: 'Player is not in a pool you own' })
      const kicked = kickPlayerFromQueue(io, playerId, reason, onlyInPool)
      res.json({ ok: true, kicked })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: list active queue bans ──
  // Optional ?pool_id=N to filter to one pool (use 'global' to filter to NULL).
  // own_queue_pools holders only see bans on pools they own (global bans are hidden).
  router.get('/api/admin/queue/bans', async (req, res) => {
    const scope = await getQueueAdminScope(req, res)
    if (!scope) return
    try {
      const params = []
      const conditions = ['(qb.banned_until IS NULL OR qb.banned_until > NOW())']

      if (scope.canManageAll) {
        if (req.query.pool_id === 'global') {
          conditions.push('qb.pool_id IS NULL')
        } else if (req.query.pool_id) {
          params.push(Number(req.query.pool_id))
          conditions.push(`qb.pool_id = $${params.length}`)
        }
      } else {
        const ids = [...scope.ownedPoolIds]
        if (ids.length === 0) return res.json([])
        params.push(ids)
        conditions.push(`qb.pool_id = ANY($${params.length}::int[])`)
      }

      const rows = await query(`
        SELECT qb.id, qb.player_id, qb.pool_id, qb.banned_until, qb.reason, qb.created_at,
               p.name, p.display_name, p.avatar_url,
               qp.name AS pool_name,
               ab.name AS banned_by_name
          FROM queue_bans qb
          JOIN players p ON p.id = qb.player_id
          LEFT JOIN queue_pools qp ON qp.id = qb.pool_id
          LEFT JOIN players ab ON ab.id = qb.banned_by
         WHERE ${conditions.join(' AND ')}
         ORDER BY qb.created_at DESC
      `, params)
      res.json(rows)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: create / update a queue ban ──
  // body: { player_id, pool_id (null = applies to all pools), duration_minutes (0 or null = permanent), reason }
  // own_queue_pools holders cannot create global bans (pool_id required) and the
  // pool_id must be one they own.
  router.post('/api/admin/queue/bans', async (req, res) => {
    const scope = await getQueueAdminScope(req, res)
    if (!scope) return
    const admin = scope.player
    const { player_id, pool_id, duration_minutes, reason } = req.body || {}
    const pid = Number(player_id)
    if (!pid) return res.status(400).json({ error: 'player_id required' })

    const poolId = pool_id == null ? null : Number(pool_id)
    if (poolId != null && !Number.isFinite(poolId)) return res.status(400).json({ error: 'pool_id must be an integer or null' })

    if (!scope.canManageAll) {
      if (poolId == null) return res.status(403).json({ error: 'You can only create bans for pools you own — global bans require manage_queue_pools' })
      if (!scope.ownedPoolIds.has(poolId)) return res.status(403).json({ error: 'You can only create bans for pools you own' })
    }

    const mins = Number(duration_minutes) || 0
    const bannedUntil = mins > 0 ? new Date(Date.now() + mins * 60_000) : null

    // Use the partial unique index that matches (NULL vs NOT NULL pool_id).
    const conflictTarget = poolId == null
      ? '(player_id) WHERE pool_id IS NULL'
      : '(player_id, pool_id) WHERE pool_id IS NOT NULL'

    try {
      await execute(`
        INSERT INTO queue_bans (player_id, pool_id, banned_until, reason, banned_by)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT ${conflictTarget} DO UPDATE SET
          banned_until = EXCLUDED.banned_until,
          reason = EXCLUDED.reason,
          banned_by = EXCLUDED.banned_by,
          created_at = NOW()
      `, [pid, poolId, bannedUntil, reason || null, admin.id])

      // Kick them out if currently queued in the affected pool (or any, for global).
      try { kickPlayerFromQueue(io, pid, reason || 'Banned from queue', poolId) } catch {}

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

  // ── Admin: remove a queue ban (by ban id) ──
  router.delete('/api/admin/queue/bans/:id', async (req, res) => {
    const scope = await getQueueAdminScope(req, res)
    if (!scope) return
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ error: 'Invalid id' })
    try {
      const ban = await queryOne('SELECT player_id, pool_id FROM queue_bans WHERE id = $1', [id])
      if (!ban) return res.status(404).json({ error: 'Ban not found' })
      if (!scope.canManageAll) {
        if (ban.pool_id == null) return res.status(403).json({ error: 'Cannot remove global bans without manage_queue_pools' })
        if (!scope.ownedPoolIds.has(ban.pool_id)) return res.status(403).json({ error: 'Ban is not on a pool you own' })
      }
      await execute('DELETE FROM queue_bans WHERE id = $1', [id])
      // If the player has no remaining active bans, push cleared state to their sockets.
      const remaining = await queryOne(
        `SELECT 1 FROM queue_bans WHERE player_id = $1 AND (banned_until IS NULL OR banned_until > NOW()) LIMIT 1`,
        [ban.player_id]
      )
      if (!remaining) {
        for (const [sid, playerId] of socketPlayers) {
          if (playerId === ban.player_id) {
            const s = io.sockets.sockets.get(sid)
            if (s) s.emit('queue:myState', {
              inQueue: false, poolId: null, poolName: null,
              inMatch: false, queueMatchId: null, count: 0, players: [],
              ban: null,
            })
          }
        }
      }
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  return router
}
