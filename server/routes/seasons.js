import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { requirePermission } from '../middleware/permissions.js'
import { adjustPlayerPoints } from '../services/seasonRankingApply.js'
import { withDefaults, computeDelta, clampPoints, teamAvgMmr } from '../services/seasonRating.js'

const ROUTER_TAGS = 'Seasons'

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

const SETTING_KEYS = [
  'starting_points', 'k_win', 'k_loss', 'mmr_scale',
  'min_points', 'max_points', 'min_games_for_leaderboard',
]

function sanitizeSettings(input) {
  if (!input || typeof input !== 'object') return {}
  const out = {}
  for (const k of SETTING_KEYS) {
    if (input[k] === undefined || input[k] === null) continue
    if (k === 'max_points' && input[k] === '') continue
    const n = Number(input[k])
    if (Number.isFinite(n)) out[k] = n
  }
  return out
}

export default function createSeasonsRouter(io) {
  const router = Router()

  // ── Public: list seasons (active + recently ended) ──
  router.get('/api/seasons', async (req, res) => {
    try {
      const seasons = await query(`
        SELECT s.id, s.name, s.slug, s.description, s.starts_at, s.ends_at, s.is_active, s.settings, s.created_at,
          (SELECT COUNT(*)::int FROM season_rankings WHERE season_id = s.id)            AS player_count,
          (SELECT COUNT(*)::int FROM season_match_log WHERE season_id = s.id AND queue_match_id IS NOT NULL) AS match_count
        FROM seasons s
        WHERE s.is_active = TRUE OR s.ends_at IS NULL OR s.ends_at > NOW() - INTERVAL '30 days'
        ORDER BY s.is_active DESC, COALESCE(s.starts_at, s.created_at) DESC
      `)
      res.json(seasons)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Public: single season meta by slug ──
  router.get('/api/seasons/:slug', async (req, res) => {
    try {
      const s = await queryOne(`
        SELECT s.*,
          (SELECT COUNT(*)::int FROM season_rankings WHERE season_id = s.id)            AS player_count,
          (SELECT COUNT(*)::int FROM season_match_log WHERE season_id = s.id AND queue_match_id IS NOT NULL) AS match_count
        FROM seasons s WHERE s.slug = $1
      `, [req.params.slug])
      if (!s) return res.status(404).json({ error: 'Season not found' })
      res.json(s)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Public: leaderboard ──
  router.get('/api/seasons/:slug/leaderboard', async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200)
      const offset = Number(req.query.offset) || 0
      const s = await queryOne('SELECT id, settings FROM seasons WHERE slug = $1', [req.params.slug])
      if (!s) return res.status(404).json({ error: 'Season not found' })
      const cfg = withDefaults(s.settings || {})
      const minGames = Math.max(0, Number(cfg.min_games_for_leaderboard) || 0)
      const rows = await query(`
        SELECT sr.player_id, sr.points, sr.peak_points, sr.games_played, sr.wins, sr.losses, sr.last_match_at,
          p.name, COALESCE(p.display_name, p.name) AS display_name, p.avatar_url, p.mmr
        FROM season_rankings sr
        JOIN players p ON p.id = sr.player_id
        WHERE sr.season_id = $1 AND sr.games_played >= $2
        ORDER BY sr.points DESC, sr.games_played DESC, p.name ASC
        LIMIT $3 OFFSET $4
      `, [s.id, minGames, limit, offset])
      res.json(rows)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Public: every season this player has played, with rank within it ──
  router.get('/api/players/:playerId/seasons', async (req, res) => {
    try {
      const playerId = Number(req.params.playerId)
      const rows = await query(`
        WITH ranked AS (
          SELECT sr.*,
            RANK() OVER (PARTITION BY sr.season_id ORDER BY sr.points DESC) AS rank
          FROM season_rankings sr
        )
        SELECT r.season_id, r.points, r.peak_points, r.games_played, r.wins, r.losses, r.last_match_at, r.rank,
          s.name AS season_name, s.slug AS season_slug, s.is_active
        FROM ranked r
        JOIN seasons s ON s.id = r.season_id
        WHERE r.player_id = $1
        ORDER BY s.is_active DESC, s.created_at DESC
      `, [playerId])
      res.json(rows)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Public: single player's stats in a season + recent log ──
  router.get('/api/seasons/:slug/players/:playerId', async (req, res) => {
    try {
      const s = await queryOne('SELECT id FROM seasons WHERE slug = $1', [req.params.slug])
      if (!s) return res.status(404).json({ error: 'Season not found' })
      const playerId = Number(req.params.playerId)
      const row = await queryOne(`
        SELECT sr.*, p.name, COALESCE(p.display_name, p.name) AS display_name, p.avatar_url, p.mmr
        FROM season_rankings sr
        JOIN players p ON p.id = sr.player_id
        WHERE sr.season_id = $1 AND sr.player_id = $2
      `, [s.id, playerId])
      const log = await query(`
        SELECT id, queue_match_id, team, won, points_before, points_after, delta,
          team_avg_mmr, opponent_avg_mmr, expected_win, k_used, reason, created_at
        FROM season_match_log
        WHERE season_id = $1 AND player_id = $2
        ORDER BY created_at DESC
        LIMIT 25
      `, [s.id, playerId])
      res.json({ ranking: row || null, recent: log })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: list all seasons (incl. archived) ──
  router.get('/api/admin/seasons', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_seasons')
    if (!admin) return
    try {
      const seasons = await query(`
        SELECT s.*,
          (SELECT COUNT(*)::int FROM queue_pools     WHERE season_id = s.id) AS pool_count,
          (SELECT COUNT(*)::int FROM season_rankings WHERE season_id = s.id) AS player_count,
          (SELECT COUNT(*)::int FROM season_match_log WHERE season_id = s.id AND queue_match_id IS NOT NULL) AS match_count
        FROM seasons s
        ORDER BY s.is_active DESC, COALESCE(s.starts_at, s.created_at) DESC
      `)
      res.json(seasons)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: single season + assigned pools ──
  router.get('/api/admin/seasons/:id', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_seasons')
    if (!admin) return
    try {
      const s = await queryOne('SELECT * FROM seasons WHERE id = $1', [req.params.id])
      if (!s) return res.status(404).json({ error: 'Season not found' })
      const pools = await query('SELECT id, name, enabled FROM queue_pools WHERE season_id = $1 ORDER BY id', [s.id])
      res.json({ ...s, pools })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: create season ──
  router.post('/api/admin/seasons', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_seasons')
    if (!admin) return
    try {
      const { name, slug, description, starts_at, ends_at, is_active, settings } = req.body
      if (!name) return res.status(400).json({ error: 'Name is required' })
      const finalSlug = (slug && slugify(slug)) || slugify(name)
      if (!finalSlug) return res.status(400).json({ error: 'Slug could not be generated from name' })
      const existing = await queryOne('SELECT 1 FROM seasons WHERE slug = $1', [finalSlug])
      if (existing) return res.status(409).json({ error: 'Slug already in use' })
      const created = await queryOne(`
        INSERT INTO seasons (name, slug, description, starts_at, ends_at, is_active, settings, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `, [
        name,
        finalSlug,
        description || '',
        starts_at || null,
        ends_at || null,
        is_active !== false,
        JSON.stringify(sanitizeSettings(settings)),
        admin.id,
      ])
      res.status(201).json(created)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: update season ──
  router.patch('/api/admin/seasons/:id', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_seasons')
    if (!admin) return
    try {
      const seasonId = Number(req.params.id)
      const existing = await queryOne('SELECT * FROM seasons WHERE id = $1', [seasonId])
      if (!existing) return res.status(404).json({ error: 'Season not found' })

      const setClauses = []
      const values = []
      const push = (col, val) => { values.push(val); setClauses.push(`${col} = $${values.length}`) }

      if (req.body.name !== undefined)        push('name', req.body.name)
      if (req.body.slug !== undefined) {
        const s = slugify(req.body.slug)
        if (!s) return res.status(400).json({ error: 'Invalid slug' })
        if (s !== existing.slug) {
          const dup = await queryOne('SELECT 1 FROM seasons WHERE slug = $1 AND id <> $2', [s, seasonId])
          if (dup) return res.status(409).json({ error: 'Slug already in use' })
        }
        push('slug', s)
      }
      if (req.body.description !== undefined) push('description', req.body.description || '')
      if (req.body.starts_at !== undefined)   push('starts_at', req.body.starts_at || null)
      if (req.body.ends_at   !== undefined)   push('ends_at',   req.body.ends_at   || null)
      if (req.body.is_active !== undefined)   push('is_active', !!req.body.is_active)
      if (req.body.settings  !== undefined)   push('settings',  JSON.stringify({ ...(existing.settings || {}), ...sanitizeSettings(req.body.settings) }))

      if (setClauses.length === 0) return res.json(existing)
      values.push(seasonId)
      const updated = await queryOne(
        `UPDATE seasons SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING *`,
        values
      )
      res.json(updated)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: delete season (cascades rankings + log) ──
  router.delete('/api/admin/seasons/:id', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_seasons')
    if (!admin) return
    try {
      // The pool fk is ON DELETE SET NULL so pools survive but lose their season link.
      await execute('DELETE FROM seasons WHERE id = $1', [req.params.id])
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: full leaderboard (no min_games filter, includes hidden) ──
  router.get('/api/admin/seasons/:id/leaderboard', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_seasons')
    if (!admin) return
    try {
      const rows = await query(`
        SELECT sr.player_id, sr.points, sr.peak_points, sr.games_played, sr.wins, sr.losses, sr.last_match_at,
          p.name, COALESCE(p.display_name, p.name) AS display_name, p.avatar_url, p.mmr
        FROM season_rankings sr
        JOIN players p ON p.id = sr.player_id
        WHERE sr.season_id = $1
        ORDER BY sr.points DESC, p.name ASC
      `, [req.params.id])
      res.json(rows)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: audit log (paginated, optional player filter) ──
  router.get('/api/admin/seasons/:id/audit', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_seasons')
    if (!admin) return
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 500)
      const offset = Number(req.query.offset) || 0
      const playerId = req.query.playerId ? Number(req.query.playerId) : null
      const params = [req.params.id]
      let where = 'season_id = $1'
      if (playerId) {
        params.push(playerId)
        where += ` AND player_id = $${params.length}`
      }
      params.push(limit, offset)
      const rows = await query(`
        SELECT sml.*,
          p.name AS player_name, COALESCE(p.display_name, p.name) AS player_display_name, p.avatar_url
        FROM season_match_log sml
        JOIN players p ON p.id = sml.player_id
        WHERE ${where}
        ORDER BY sml.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `, params)
      res.json(rows)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: manual point adjustment ──
  router.post('/api/admin/seasons/:id/adjust', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_seasons')
    if (!admin) return
    try {
      const { player_id, delta, reason } = req.body
      if (!player_id) return res.status(400).json({ error: 'player_id is required' })
      const d = Number(delta)
      if (!Number.isFinite(d) || d === 0) return res.status(400).json({ error: 'delta must be a non-zero number' })
      const result = await adjustPlayerPoints({
        seasonId: Number(req.params.id),
        playerId: Number(player_id),
        delta: d,
        reason,
        adminPlayerId: admin.id,
      })
      if (io) io.emit('season:rankUpdated', { seasonId: Number(req.params.id), playerIds: [Number(player_id)] })
      res.json(result)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: rebuild rankings by replaying every audit-log row ──
  // Useful if settings changed retroactively or rows were corrupted.
  router.post('/api/admin/seasons/:id/recompute', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_seasons')
    if (!admin) return
    try {
      const seasonId = Number(req.params.id)
      const s = await queryOne('SELECT id, settings FROM seasons WHERE id = $1', [seasonId])
      if (!s) return res.status(404).json({ error: 'Season not found' })
      const cfg = withDefaults(s.settings || {})

      // Reset rankings.
      await execute('DELETE FROM season_rankings WHERE season_id = $1', [seasonId])

      // Replay: for each completed queue match in order, recompute deltas with
      // current settings. Manual adjust rows replay verbatim (their delta is
      // applied on top of the current points value).
      const matches = await query(`
        SELECT id, team1_players, team2_players,
               (SELECT winner_captain_id FROM matches WHERE id = queue_matches.match_id) AS winner_captain_id,
               captain1_player_id, captain2_player_id, completed_at
        FROM queue_matches
        WHERE season_id = $1 AND status = 'completed'
        ORDER BY completed_at ASC NULLS LAST, id ASC
      `, [seasonId])

      const points = new Map() // player_id -> current points
      const stats  = new Map() // player_id -> { games, wins, losses, peak }

      function getPts(pid) { return points.has(pid) ? points.get(pid) : cfg.starting_points }
      function bumpStats(pid, won, newPts) {
        const cur = stats.get(pid) || { games: 0, wins: 0, losses: 0, peak: cfg.starting_points }
        cur.games++; if (won) cur.wins++; else cur.losses++
        if (newPts > cur.peak) cur.peak = newPts
        stats.set(pid, cur)
      }

      // Wipe old log rows that came from queue matches; manual adjusts (queue_match_id IS NULL) we keep
      // but they need to re-apply on top of the recomputed totals. We replay them in order with the rest.
      await execute('DELETE FROM season_match_log WHERE season_id = $1 AND queue_match_id IS NOT NULL', [seasonId])

      // Pull MMR for everyone we'll touch.
      const allIdsSet = new Set()
      for (const m of matches) {
        for (const p of (m.team1_players || [])) allIdsSet.add(p.playerId)
        for (const p of (m.team2_players || [])) allIdsSet.add(p.playerId)
      }
      const mmrRows = allIdsSet.size
        ? (await query('SELECT id, mmr FROM players WHERE id = ANY($1::int[])', [[...allIdsSet]]))
        : []
      const mmrById = Object.fromEntries(mmrRows.map(r => [r.id, Number(r.mmr) || 0]))

      // Pull manual adjusts in time order so we can interleave them with matches.
      const manualAdjusts = await query(`
        SELECT id, player_id, delta, reason, created_at
        FROM season_match_log
        WHERE season_id = $1 AND queue_match_id IS NULL
        ORDER BY created_at ASC, id ASC
      `, [seasonId])
      // Wipe and re-insert at the right position.
      await execute('DELETE FROM season_match_log WHERE season_id = $1 AND queue_match_id IS NULL', [seasonId])

      // Merge matches and adjusts in time order.
      const events = [
        ...matches.map(m => ({ kind: 'match', when: m.completed_at, data: m })),
        ...manualAdjusts.map(a => ({ kind: 'adjust', when: a.created_at, data: a })),
      ].sort((a, b) => new Date(a.when || 0) - new Date(b.when || 0))

      for (const ev of events) {
        if (ev.kind === 'match') {
          const m = ev.data
          const t1 = (m.team1_players || []).map(p => p.playerId)
          const t2 = (m.team2_players || []).map(p => p.playerId)
          const team1Won = !!m.winner_captain_id && m.winner_captain_id === m.captain1_player_id
          const team2Won = !!m.winner_captain_id && m.winner_captain_id === m.captain2_player_id
          if (!team1Won && !team2Won) continue
          const t1Avg = teamAvgMmr(t1.map(id => mmrById[id] || 0))
          const t2Avg = teamAvgMmr(t2.map(id => mmrById[id] || 0))
          for (const pid of t1) {
            const before = getPts(pid)
            const { delta, expected, kUsed } = computeDelta({ teamAvgMmr: t1Avg, oppAvgMmr: t2Avg, won: team1Won, settings: cfg })
            const after = clampPoints(before + delta, cfg)
            points.set(pid, after); bumpStats(pid, team1Won, after)
            await execute(`
              INSERT INTO season_match_log (season_id, queue_match_id, player_id, team, won,
                points_before, points_after, delta, team_avg_mmr, opponent_avg_mmr, expected_win, k_used, created_at)
              VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE($12, NOW()))
            `, [seasonId, m.id, pid, team1Won, before, after, after - before, t1Avg, t2Avg, expected, kUsed, m.completed_at])
          }
          for (const pid of t2) {
            const before = getPts(pid)
            const { delta, expected, kUsed } = computeDelta({ teamAvgMmr: t2Avg, oppAvgMmr: t1Avg, won: team2Won, settings: cfg })
            const after = clampPoints(before + delta, cfg)
            points.set(pid, after); bumpStats(pid, team2Won, after)
            await execute(`
              INSERT INTO season_match_log (season_id, queue_match_id, player_id, team, won,
                points_before, points_after, delta, team_avg_mmr, opponent_avg_mmr, expected_win, k_used, created_at)
              VALUES ($1,$2,$3,2,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE($12, NOW()))
            `, [seasonId, m.id, pid, team2Won, before, after, after - before, t2Avg, t1Avg, expected, kUsed, m.completed_at])
          }
        } else {
          const a = ev.data
          const pid = a.player_id
          const before = getPts(pid)
          const after = clampPoints(before + Number(a.delta), cfg)
          points.set(pid, after)
          const cur = stats.get(pid) || { games: 0, wins: 0, losses: 0, peak: cfg.starting_points }
          if (after > cur.peak) cur.peak = after
          stats.set(pid, cur)
          await execute(`
            INSERT INTO season_match_log (season_id, queue_match_id, player_id, team, won,
              points_before, points_after, delta, reason, created_at)
            VALUES ($1, NULL, $2, NULL, NULL, $3, $4, $5, $6, $7)
          `, [seasonId, pid, before, after, after - before, a.reason || null, a.created_at])
        }
      }

      // Persist final rankings.
      for (const [pid, pts] of points.entries()) {
        const st = stats.get(pid) || { games: 0, wins: 0, losses: 0, peak: cfg.starting_points }
        await execute(`
          INSERT INTO season_rankings (season_id, player_id, points, peak_points, games_played, wins, losses, last_match_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
          ON CONFLICT (season_id, player_id) DO UPDATE SET
            points = EXCLUDED.points, peak_points = EXCLUDED.peak_points,
            games_played = EXCLUDED.games_played, wins = EXCLUDED.wins, losses = EXCLUDED.losses,
            last_match_at = EXCLUDED.last_match_at
        `, [seasonId, pid, pts, st.peak, st.games, st.wins, st.losses])
      }

      if (io) io.emit('season:rankUpdated', { seasonId, recomputed: true })
      res.json({ ok: true, players: points.size, events: events.length })
    } catch (e) {
      console.error('[seasons recompute]', e)
      res.status(500).json({ error: e.message })
    }
  })

  return router
}

// Re-export for tests / future callers if needed.
export { ROUTER_TAGS }
