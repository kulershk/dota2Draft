import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { requirePermission } from '../middleware/permissions.js'
import { getAuthPlayer } from '../middleware/auth.js'

export default function createQueueRouter(io) {
  const router = Router()

  // ── Public: list enabled pools ──
  router.get('/api/queue/pools', async (req, res) => {
    const pools = await query('SELECT * FROM queue_pools WHERE enabled = true ORDER BY id')
    res.json(pools)
  })

  // ── Public: pool details ──
  router.get('/api/queue/pools/:poolId', async (req, res) => {
    const pool = await queryOne('SELECT * FROM queue_pools WHERE id = $1', [req.params.poolId])
    if (!pool) return res.status(404).json({ error: 'Pool not found' })
    res.json(pool)
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
    const pools = await query('SELECT * FROM queue_pools ORDER BY id')
    res.json(pools)
  })

  // ── Admin: create pool ──
  router.post('/api/admin/queue/pools', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_competitions')
    if (!admin) return

    const {
      name, enabled, min_mmr, max_mmr, pick_timer, best_of,
      lobby_server_region, lobby_game_mode, lobby_league_id,
      lobby_dotv_delay, lobby_cheats, lobby_allow_spectating,
      lobby_pause_setting, lobby_selection_priority, lobby_cm_pick,
      lobby_series_type, lobby_timeout_minutes,
    } = req.body

    if (!name) return res.status(400).json({ error: 'Name is required' })

    const pool = await queryOne(`
      INSERT INTO queue_pools (
        name, enabled, min_mmr, max_mmr, pick_timer, best_of,
        lobby_server_region, lobby_game_mode, lobby_league_id,
        lobby_dotv_delay, lobby_cheats, lobby_allow_spectating,
        lobby_pause_setting, lobby_selection_priority, lobby_cm_pick,
        lobby_series_type, lobby_timeout_minutes
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING *
    `, [
      name, enabled !== false, min_mmr || 0, max_mmr || 0,
      pick_timer || 30, best_of || 1,
      lobby_server_region || 3, lobby_game_mode || 2, lobby_league_id || 0,
      lobby_dotv_delay ?? 1, !!lobby_cheats, lobby_allow_spectating !== false,
      lobby_pause_setting || 0, lobby_selection_priority || 0, lobby_cm_pick || 0,
      lobby_series_type || 0, lobby_timeout_minutes || 10,
    ])
    res.status(201).json(pool)
  })

  // ── Admin: update pool ──
  router.put('/api/admin/queue/pools/:id', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_competitions')
    if (!admin) return

    const poolId = Number(req.params.id)
    const existing = await queryOne('SELECT * FROM queue_pools WHERE id = $1', [poolId])
    if (!existing) return res.status(404).json({ error: 'Pool not found' })

    const fields = [
      'name', 'enabled', 'min_mmr', 'max_mmr', 'pick_timer', 'best_of',
      'lobby_server_region', 'lobby_game_mode', 'lobby_league_id',
      'lobby_dotv_delay', 'lobby_cheats', 'lobby_allow_spectating',
      'lobby_pause_setting', 'lobby_selection_priority', 'lobby_cm_pick',
      'lobby_series_type', 'lobby_timeout_minutes',
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
  })

  // ── Admin: delete pool ──
  router.delete('/api/admin/queue/pools/:id', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_competitions')
    if (!admin) return
    await execute('DELETE FROM queue_pools WHERE id = $1', [req.params.id])
    res.json({ ok: true })
  })

  return router
}
