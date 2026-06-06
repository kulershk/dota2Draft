import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { requireSeasonPermission, hasPermission } from '../middleware/permissions.js'
import { getAuthPlayer } from '../middleware/auth.js'
import { adjustPlayerPoints, recomputeSeasonFromHistory, backfillSeasonFromPoolHistory } from '../services/seasonRankingApply.js'
import { applyFridayBonusForSeason } from '../services/inhouseFridayBonus.js'
import { fridayWindowSql, clampHour } from '../services/fridayWindow.js'
import { withDefaults } from '../services/seasonRating.js'
import { getProfileBannerPlayers } from '../helpers/subscription.js'
import { poolQueues, playerInQueue } from '../socket/queueState.js'
import { broadcastQueueUpdate } from '../socket/queue.js'

const ROUTER_TAGS = 'Seasons'

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

const NUMERIC_SETTING_KEYS = [
  'starting_points', 'k_win', 'k_loss', 'mmr_scale',
  'min_points', 'max_points', 'min_games_for_leaderboard',
]
const STRENGTH_BASIS_VALUES = ['mmr', 'points']

function sanitizeSettings(input) {
  if (!input || typeof input !== 'object') return {}
  const out = {}
  for (const k of NUMERIC_SETTING_KEYS) {
    if (input[k] === undefined || input[k] === null) continue
    if (k === 'max_points' && input[k] === '') continue
    const n = Number(input[k])
    if (Number.isFinite(n)) out[k] = n
  }
  if (input.strength_basis && STRENGTH_BASIS_VALUES.includes(input.strength_basis)) {
    out.strength_basis = input.strength_basis
  }
  // Overall-leaderboard prize tiers: [{ from, to, prize }] by finishing place.
  // Free-text prize (informational, not auto-paid). Drop invalid rows; cap count.
  if (Array.isArray(input.prizes)) {
    out.prizes = input.prizes
      .map(p => {
        const from = Math.trunc(Number(p?.from))
        const to = Math.trunc(Number(p?.to))
        const prize = String(p?.prize ?? '').trim().slice(0, 120)
        if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < from || !prize) return null
        return { from, to, prize }
      })
      .filter(Boolean)
      .slice(0, 50)
  }
  return out
}

export default function createSeasonsRouter(io) {
  const router = Router()

  // ── Public: list seasons (active + recently ended) ──
  router.get('/api/seasons', async (req, res) => {
    try {
      const seasons = await query(`
        SELECT s.id, s.name, s.slug, s.description, s.starts_at, s.ends_at, s.is_active, s.verified_mmr_only, s.settings, s.created_at,
          (SELECT COUNT(*)::int FROM season_rankings WHERE season_id = s.id)            AS player_count,
          (SELECT COUNT(DISTINCT queue_match_id)::int FROM season_match_log WHERE season_id = s.id AND queue_match_id IS NOT NULL) AS match_count
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
          (SELECT COUNT(DISTINCT queue_match_id)::int FROM season_match_log WHERE season_id = s.id AND queue_match_id IS NOT NULL) AS match_count
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
          sr.current_winstreak, sr.peak_winstreak,
          p.name, COALESCE(p.display_name, p.name) AS display_name, p.avatar_url, p.mmr, p.mmr_verified_at,
          p.leaderboard_banner_url
        FROM season_rankings sr
        JOIN players p ON p.id = sr.player_id
        WHERE sr.season_id = $1 AND sr.games_played >= $2
        ORDER BY sr.points DESC, sr.games_played DESC, p.name ASC
        LIMIT $3 OFFSET $4
      `, [s.id, minGames, limit, offset])
      // Attach each player's custom-group memberships so the frontend
      // can pick a border colour. Highest-priority group first
      // (captains_drawn_from > min_per_match desc > id asc).
      const playerIds = rows.map(r => r.player_id)
      if (playerIds.length) {
        const memberRows = await query(`
          SELECT m.player_id, g.id AS group_id, g.name, g.border_color,
                 g.captains_drawn_from, g.min_per_match, g.display_only
            FROM season_player_group_members m
            JOIN season_player_groups g ON g.id = m.group_id
           WHERE g.season_id = $1 AND m.player_id = ANY($2::int[])
           ORDER BY g.captains_drawn_from DESC, g.min_per_match DESC, g.id ASC
        `, [s.id, playerIds])
        const byPid = {}
        for (const m of memberRows) {
          ;(byPid[m.player_id] ||= []).push({
            group_id: m.group_id,
            name: m.name,
            border_color: m.border_color,
            captains_drawn_from: !!m.captains_drawn_from,
          })
        }
        for (const r of rows) r.groups = byPid[r.player_id] || []

        // Profile-banner perk: surface each subscriber's leaderboard-slot banner
        // so the leaderboard can paint it behind their row. Gated by the active
        // perk (same rule queue.js uses), so a lapsed sub hides the banner
        // without deleting the file; everyone else gets null. Returned as the
        // generic `banner_url` the frontend reads — the column is slot-specific.
        const bannerPerk = await getProfileBannerPlayers(playerIds)
        for (const r of rows) {
          r.banner_url = bannerPerk.has(r.player_id) ? (r.leaderboard_banner_url || null) : null
          delete r.leaderboard_banner_url
        }
      } else {
        for (const r of rows) r.groups = []
      }
      res.json(rows)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Public: per-Friday inhouse standings ("Friday top") ──
  // Only meaningful when the season has an inhouse-enabled pool: inhouse runs a
  // special Friday with a top-3 bonus. For each Friday window that had matches
  // we rank players by wins − losses in that window, tiebroken by net season
  // points (MMR) earned (the pool's configurable Europe/Riga window, see
  // services/fridayWindow.js), and re-derive the podium + bonus with the same
  // slot/tie rule the Friday
  // aggregator uses. Re-deriving (rather than reading the synthetic
  // friday_top_bonus rows) is deliberate: it works even before the aggregator
  // has finalised the window.
  router.get('/api/seasons/:slug/fridays', async (req, res) => {
    try {
      const s = await queryOne('SELECT id FROM seasons WHERE slug = $1', [req.params.slug])
      if (!s) return res.status(404).json({ error: 'Season not found' })

      // Bonus amounts + the Friday window come from the season's inhouse pool
      // (smallest id wins, matching inhouseFridayBonus). No inhouse pool ⇒ off.
      const inhousePool = await queryOne(
        `SELECT friday_top1_bonus, friday_top2_bonus, friday_top3_bonus,
                friday_window_start_hour, friday_window_end_hour
           FROM queue_pools WHERE season_id = $1 AND inhouse_enabled = TRUE ORDER BY id LIMIT 1`,
        [s.id]
      )
      if (!inhousePool) return res.json({ enabled: false, fridays: [] })

      // Map each match-derived row to its Friday window date (NULL outside any
      // window). Synthetic friday_top_bonus rows (queue_match_id IS NULL) are
      // excluded. Window is keyed on queue_matches.created_at (match START),
      // not season_match_log.created_at (match END), so a game started in the
      // Friday window but recorded after still appears on that Friday.
      // Pre-sorted for the JS grouping below.
      const windowExpr = fridayWindowSql('qm.created_at',
        clampHour(inhousePool.friday_window_start_hour), clampHour(inhousePool.friday_window_end_hour))
      const rows = await query(`
        SELECT
          to_char(${windowExpr}, 'YYYY-MM-DD') AS date,
          sml.player_id,
          COALESCE(p.display_name, p.name) AS display_name,
          p.name, p.avatar_url, p.mmr, p.mmr_verified_at,
          SUM(sml.delta)::float8 AS net_points,
          (COUNT(*) FILTER (WHERE sml.won IS TRUE) - COUNT(*) FILTER (WHERE sml.won IS FALSE))::int AS net_wins,
          COUNT(*)::int                                 AS games,
          COUNT(*) FILTER (WHERE sml.won IS TRUE)::int  AS wins,
          COUNT(*) FILTER (WHERE sml.won IS FALSE)::int AS losses
        FROM season_match_log sml
        JOIN queue_matches qm ON qm.id = sml.queue_match_id
        JOIN players p ON p.id = sml.player_id
        WHERE sml.season_id = $1
          AND sml.queue_match_id IS NOT NULL
          AND (${windowExpr}) IS NOT NULL
        GROUP BY date, sml.player_id, display_name, p.name, p.avatar_url, p.mmr, p.mmr_verified_at
        ORDER BY date DESC, net_wins DESC, net_points DESC, display_name ASC
      `, [s.id])

      // friday_topN_bonus slot prizes, in order.
      const slots = [
        Number(inhousePool.friday_top1_bonus ?? 12),
        Number(inhousePool.friday_top2_bonus ?? 6),
        Number(inhousePool.friday_top3_bonus ?? 6),
      ]

      // Group the already-sorted rows by date.
      const byDate = new Map()
      for (const r of rows) {
        if (!byDate.has(r.date)) byDate.set(r.date, [])
        byDate.get(r.date).push({
          player_id: r.player_id,
          display_name: r.display_name,
          name: r.name,
          avatar_url: r.avatar_url,
          mmr: r.mmr,
          mmr_verified_at: r.mmr_verified_at,
          net_points: r.net_points,
          net_wins: r.net_wins,
          games: r.games,
          wins: r.wins,
          losses: r.losses,
          place: null,   // 1|2|3 once a podium slot is assigned
          bonus: 0,      // Friday-top bonus this player would collect
        })
      }

      // Re-derive the podium per day. Rank is wins − losses (net_wins) only —
      // players with equal net_wins are tied regardless of MMR. Place = rank of
      // the net_wins tier (best W−L = 1st, next = 2nd, next = 3rd); only the top
      // 3 tiers are eligible, and everyone in a tier gets the FULL prize for
      // that place — no splitting (mirrors inhouseFridayBonus).
      const fridays = []
      for (const [date, players] of byDate) {
        const eligible = players.filter(pl => pl.net_wins > 0)
        let place = 0 // 0-based index into slots
        let i = 0
        while (place < slots.length && i < eligible.length) {
          const prize = slots[place]
          const placeNum = place + 1
          const tiedWins = eligible[i].net_wins
          while (i < eligible.length && eligible[i].net_wins === tiedWins) {
            eligible[i].place = placeNum
            eligible[i].bonus = prize
            i++
          }
          place++
        }
        fridays.push({ date, players })
      }

      res.json({ enabled: true, fridays })
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

  // ── Public: a player's full points-change timeline for one season ──
  // Powers the season-points graph on the profile page. Ordered ASC so the
  // client can plot it left-to-right without re-sorting; includes the starting
  // baseline (points_before of the first row) as a synthetic anchor point so
  // the line begins at the season's starting points rather than after game 1.
  router.get('/api/players/:playerId/seasons/:seasonId/points-history', async (req, res) => {
    try {
      const playerId = Number(req.params.playerId)
      const seasonId = Number(req.params.seasonId)
      if (!Number.isInteger(playerId) || !Number.isInteger(seasonId)) {
        return res.status(400).json({ error: 'invalid playerId or seasonId' })
      }
      // Per-game stats (hero, KDA, score) live in match_game_player_stats keyed
      // by the Dota 3.2bn account id, so resolve the player's steam32 first.
      const player = await queryOne('SELECT steam_id FROM players WHERE id = $1', [playerId])
      const steam32 = player?.steam_id
        ? (BigInt(player.steam_id) - 76561197960265728n).toString()
        : null
      // Enrich each log row with the player's stat line for that match's game
      // (latest game if it was a series) plus the game's team kill totals for a
      // full scoreline. Synthetic rows (Friday bonus, admin adjust) have no
      // queue_match_id and fall through with null stats.
      const rows = await query(`
        SELECT sml.id, sml.queue_match_id, sml.won, sml.points_before, sml.points_after,
               sml.delta, sml.reason, sml.created_at,
               ps.hero_id, ps.kills, ps.deaths, ps.assists, ps.is_radiant,
               sc.radiant_kills, sc.dire_kills
        FROM season_match_log sml
        LEFT JOIN queue_matches qm ON qm.id = sml.queue_match_id
        LEFT JOIN LATERAL (
          SELECT s.hero_id, s.kills, s.deaths, s.assists, s.is_radiant, s.match_game_id
          FROM match_game_player_stats s
          JOIN match_games g ON g.id = s.match_game_id
          WHERE g.match_id = qm.match_id AND $3::bigint IS NOT NULL AND s.account_id = $3::bigint
          ORDER BY g.game_number DESC
          LIMIT 1
        ) ps ON TRUE
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(ms.kills) FILTER (WHERE ms.is_radiant), 0)::int AS radiant_kills,
                 COALESCE(SUM(ms.kills) FILTER (WHERE NOT ms.is_radiant), 0)::int AS dire_kills
          FROM match_game_player_stats ms
          WHERE ms.match_game_id = ps.match_game_id
        ) sc ON TRUE
        WHERE sml.season_id = $1 AND sml.player_id = $2
        -- Friday top-3 bonuses are stored dated to their Friday at NOON (the
        -- idempotency index keys on DATE(created_at)), but the prize is earned
        -- after that Friday's games — and its points_before reflects the
        -- end-of-Friday total. Sort those synthetic rows to the END of their
        -- Friday (next midnight) so they fall AFTER the day's games instead of
        -- ahead of them, keeping the running-total line continuous.
        ORDER BY
          (CASE WHEN sml.reason = 'friday_top_bonus'
                THEN DATE(sml.created_at) + INTERVAL '1 day'
                ELSE sml.created_at END) ASC,
          sml.id ASC
      `, [seasonId, playerId, steam32])
      res.json({ rows })
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
        -- Same as the points-history graph: place Friday top-3 bonuses (dated
        -- to their Friday noon for idempotency) at the END of their Friday so
        -- they list after that day's games, not interleaved before them.
        ORDER BY
          (CASE WHEN reason = 'friday_top_bonus'
                THEN DATE(created_at) + INTERVAL '1 day'
                ELSE created_at END) DESC,
          id DESC
        LIMIT 25
      `, [s.id, playerId])
      res.json({ ranking: row || null, recent: log })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: list seasons (incl. archived). manage_seasons sees all;
  // manage_own_seasons sees only seasons they created. ──
  router.get('/api/admin/seasons', async (req, res) => {
    const admin = await requireSeasonPermission(req, res, null)
    if (!admin) return
    try {
      const ownAll = await hasPermission(admin, 'manage_seasons')
      const params = []
      let where = ''
      if (!ownAll) { params.push(admin.id); where = 'WHERE s.created_by = $1' }
      const seasons = await query(`
        SELECT s.*,
          (SELECT COUNT(*)::int FROM queue_pools     WHERE season_id = s.id) AS pool_count,
          (SELECT COUNT(*)::int FROM season_rankings WHERE season_id = s.id) AS player_count,
          (SELECT COUNT(DISTINCT queue_match_id)::int FROM season_match_log WHERE season_id = s.id AND queue_match_id IS NOT NULL) AS match_count
        FROM seasons s
        ${where}
        ORDER BY s.is_active DESC, COALESCE(s.starts_at, s.created_at) DESC
      `, params)
      res.json(seasons)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: single season + assigned pools ──
  router.get('/api/admin/seasons/:id', async (req, res) => {
    const admin = await requireSeasonPermission(req, res, Number(req.params.id))
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

  // ── Admin: create season (manage_seasons or manage_own_seasons) ──
  router.post('/api/admin/seasons', async (req, res) => {
    const admin = await requireSeasonPermission(req, res, null)
    if (!admin) return
    try {
      const { name, slug, description, starts_at, ends_at, is_active, verified_mmr_only, settings } = req.body
      if (!name) return res.status(400).json({ error: 'Name is required' })
      const finalSlug = (slug && slugify(slug)) || slugify(name)
      if (!finalSlug) return res.status(400).json({ error: 'Slug could not be generated from name' })
      const existing = await queryOne('SELECT 1 FROM seasons WHERE slug = $1', [finalSlug])
      if (existing) return res.status(409).json({ error: 'Slug already in use' })
      const created = await queryOne(`
        INSERT INTO seasons (name, slug, description, starts_at, ends_at, is_active, verified_mmr_only, settings, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
      `, [
        name,
        finalSlug,
        description || '',
        starts_at || null,
        ends_at || null,
        is_active !== false,
        !!verified_mmr_only,
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
    const admin = await requireSeasonPermission(req, res, Number(req.params.id))
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
      if (req.body.verified_mmr_only !== undefined) push('verified_mmr_only', !!req.body.verified_mmr_only)
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
    const admin = await requireSeasonPermission(req, res, Number(req.params.id))
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
    const admin = await requireSeasonPermission(req, res, Number(req.params.id))
    if (!admin) return
    try {
      const rows = await query(`
        SELECT sr.player_id, sr.points, sr.peak_points, sr.games_played, sr.wins, sr.losses, sr.last_match_at,
          p.name, COALESCE(p.display_name, p.name) AS display_name, p.avatar_url, p.mmr, p.mmr_verified_at
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
    const admin = await requireSeasonPermission(req, res, Number(req.params.id))
    if (!admin) return
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 500)
      const offset = Number(req.query.offset) || 0
      const playerId = req.query.playerId ? Number(req.query.playerId) : null
      const filterParams = [req.params.id]
      let where = 'season_id = $1'
      if (playerId) {
        filterParams.push(playerId)
        where += ` AND player_id = $${filterParams.length}`
      }
      const totalRows = await query(`SELECT COUNT(*)::int AS total FROM season_match_log WHERE ${where}`, filterParams)
      const total = totalRows[0]?.total || 0
      const rows = await query(`
        SELECT sml.*,
          p.name AS player_name, COALESCE(p.display_name, p.name) AS player_display_name, p.avatar_url
        FROM season_match_log sml
        JOIN players p ON p.id = sml.player_id
        WHERE ${where}
        ORDER BY sml.created_at DESC
        LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}
      `, [...filterParams, limit, offset])
      res.json({ rows, total })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: wintrade / collusion detection (suspicious player pairs) ──
  // Self-joins season_match_log on queue_match_id within the season to build,
  // for every unordered player pair (a_id < b_id), their record as TEAMMATES
  // (same team) and as OPPONENTS (different team), plus the net season points
  // that moved between them in head-to-head games. Four boolean flags surface
  // the classic win-trade signatures; rows are ranked by how many flags they
  // trip. Synthetic rows (queue_match_id IS NULL: Friday bonus, manual adjust)
  // are excluded. Optional playerId narrows to pairs involving that player so
  // the UI can investigate one player. Thresholds below are tunable constants.
  const WT_LOPSIDED_MIN_GAMES = 5     // min opposed games before a one-sided H2H counts
  const WT_LOPSIDED_DOMINANCE = 0.85  // dominant side wins ≥85% of opposed games
  const WT_DUO_MIN_GAMES      = 5     // min games together before a high duo win% counts
  const WT_DUO_WINPCT         = 80    // pair wins ≥80% when on the same team
  const WT_TRANSFER_POINTS    = 150   // net points moved one way in head-to-heads
  const WT_FREQUENT_MULTIPLE  = 3     // co-appear ≥3× the average pair's encounters
  router.get('/api/admin/seasons/:id/wintrade', async (req, res) => {
    const admin = await requireSeasonPermission(req, res, Number(req.params.id))
    if (!admin) return
    try {
      const minEncounters = Math.max(1, Number(req.query.minEncounters) || 5)
      const playerId = req.query.playerId ? Number(req.query.playerId) : null
      const limit = Math.min(Number(req.query.limit) || 100, 500)
      const rows = await query(`
        WITH log AS (
          SELECT queue_match_id, player_id, team, won, delta
          FROM season_match_log
          WHERE season_id = $1 AND queue_match_id IS NOT NULL AND team IS NOT NULL
        ),
        pairs AS (
          SELECT l1.player_id AS a_id, l2.player_id AS b_id,
                 (l1.team = l2.team) AS same_team,
                 l1.won AS a_won, l1.delta AS a_delta, l2.delta AS b_delta
          FROM log l1
          JOIN log l2 ON l1.queue_match_id = l2.queue_match_id
                     AND l1.player_id < l2.player_id
        ),
        agg AS (
          SELECT a_id, b_id,
            COUNT(*) FILTER (WHERE same_team)::int                   AS teammate_games,
            COUNT(*) FILTER (WHERE same_team AND a_won)::int         AS teammate_wins,
            COUNT(*) FILTER (WHERE NOT same_team)::int               AS opponent_games,
            COUNT(*) FILTER (WHERE NOT same_team AND a_won)::int     AS a_beats_b,
            COUNT(*) FILTER (WHERE NOT same_team AND NOT a_won)::int AS b_beats_a,
            (COALESCE(SUM(a_delta) FILTER (WHERE NOT same_team),0)
              - COALESCE(SUM(b_delta) FILTER (WHERE NOT same_team),0))::real AS net_points_a_from_b,
            COUNT(*)::int                                            AS total_encounters
          FROM pairs GROUP BY a_id, b_id
        ),
        scored AS (
          SELECT *,
            AVG(total_encounters) OVER ()                           AS avg_encounters,
            CASE WHEN teammate_games > 0
                 THEN ROUND((teammate_wins::numeric / teammate_games) * 100, 1)::float8 END AS teammate_winpct,
            CASE WHEN opponent_games > 0
                 THEN (GREATEST(a_beats_b, b_beats_a)::numeric / opponent_games)::float8 END  AS h2h_dominance
          FROM agg
        )
        SELECT s.a_id, s.b_id, s.teammate_games, s.teammate_wins, s.teammate_winpct,
               s.opponent_games, s.a_beats_b, s.b_beats_a, s.net_points_a_from_b,
               s.total_encounters, s.h2h_dominance,
               (s.opponent_games >= ${WT_LOPSIDED_MIN_GAMES} AND s.h2h_dominance >= ${WT_LOPSIDED_DOMINANCE}) AS flag_lopsided,
               (s.teammate_games >= ${WT_DUO_MIN_GAMES} AND s.teammate_winpct >= ${WT_DUO_WINPCT})            AS flag_duo,
               (s.opponent_games >= ${WT_LOPSIDED_MIN_GAMES} AND ABS(s.net_points_a_from_b) >= ${WT_TRANSFER_POINTS}) AS flag_transfer,
               (s.total_encounters >= GREATEST($2, ${WT_FREQUENT_MULTIPLE} * s.avg_encounters))               AS flag_frequent,
               pa.name AS a_name, COALESCE(pa.display_name, pa.name) AS a_display_name,
               pa.avatar_url AS a_avatar_url, pa.mmr AS a_mmr,
               pb.name AS b_name, COALESCE(pb.display_name, pb.name) AS b_display_name,
               pb.avatar_url AS b_avatar_url, pb.mmr AS b_mmr
        FROM scored s
        JOIN players pa ON pa.id = s.a_id
        JOIN players pb ON pb.id = s.b_id
        WHERE s.total_encounters >= $2
          AND ($3::int IS NULL OR s.a_id = $3 OR s.b_id = $3)
        ORDER BY
          ((s.opponent_games >= ${WT_LOPSIDED_MIN_GAMES} AND s.h2h_dominance >= ${WT_LOPSIDED_DOMINANCE})::int
           + (s.teammate_games >= ${WT_DUO_MIN_GAMES} AND s.teammate_winpct >= ${WT_DUO_WINPCT})::int
           + (s.opponent_games >= ${WT_LOPSIDED_MIN_GAMES} AND ABS(s.net_points_a_from_b) >= ${WT_TRANSFER_POINTS})::int
           + (s.total_encounters >= GREATEST($2, ${WT_FREQUENT_MULTIPLE} * s.avg_encounters))::int) DESC,
          GREATEST(COALESCE(s.h2h_dominance, 0), COALESCE(s.teammate_winpct, 0) / 100) DESC,
          s.total_encounters DESC
        LIMIT $4
      `, [req.params.id, minEncounters, playerId, limit])
      res.json({ rows })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: manual point adjustment ──
  router.post('/api/admin/seasons/:id/adjust', async (req, res) => {
    const admin = await requireSeasonPermission(req, res, Number(req.params.id))
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
    const admin = await requireSeasonPermission(req, res, Number(req.params.id))
    if (!admin) return
    try {
      const seasonId = Number(req.params.id)
      const s = await queryOne('SELECT id FROM seasons WHERE id = $1', [seasonId])
      if (!s) return res.status(404).json({ error: 'Season not found' })
      const result = await recomputeSeasonFromHistory(seasonId)
      if (io) io.emit('season:rankUpdated', { seasonId, recomputed: true })
      res.json({ ok: true, ...result })
    } catch (e) {
      console.error('[seasons recompute]', e)
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: claim past completed matches in this season's pools, then recompute ──
  // Sets queue_matches.season_id on previously-orphaned (NULL) matches that
  // belong to a pool currently assigned to this season and fall in the
  // season's date window. Then runs a full recompute so points reflect them.
  router.post('/api/admin/seasons/:id/backfill', async (req, res) => {
    const admin = await requireSeasonPermission(req, res, Number(req.params.id))
    if (!admin) return
    try {
      const seasonId = Number(req.params.id)
      const s = await queryOne('SELECT id FROM seasons WHERE id = $1', [seasonId])
      if (!s) return res.status(404).json({ error: 'Season not found' })
      const claimed = await backfillSeasonFromPoolHistory(seasonId)
      const result = await recomputeSeasonFromHistory(seasonId)
      if (io) io.emit('season:rankUpdated', { seasonId, recomputed: true })
      res.json({ ok: true, claimed, ...result })
    } catch (e) {
      console.error('[seasons backfill]', e)
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: trigger inhouse Friday top-3 aggregator for a specific Friday ──
  // Idempotent — re-running for the same date no-ops via the
  // season_match_log_friday_top_unique partial index. Body: { friday_date:
  // 'YYYY-MM-DD' }. Useful for testing and for back-filling a day that the
  // scheduler missed (e.g. server downtime). `force` bypasses the window-closed
  // guard so an admin can finalize a Friday whose window is still open.
  router.post('/api/admin/seasons/:id/friday-bonus', async (req, res) => {
    const admin = await requireSeasonPermission(req, res, Number(req.params.id))
    if (!admin) return
    try {
      const seasonId = Number(req.params.id)
      const fridayDate = String(req.body?.friday_date || '').trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fridayDate)) return res.status(400).json({ error: 'friday_date required (YYYY-MM-DD)' })
      const s = await queryOne('SELECT id FROM seasons WHERE id = $1', [seasonId])
      if (!s) return res.status(404).json({ error: 'Season not found' })
      const result = await applyFridayBonusForSeason(seasonId, fridayDate, { force: true })
      if (io) io.emit('season:rankUpdated', { seasonId, fridayDate })
      res.json({ ok: true, ...result })
    } catch (e) {
      console.error('[seasons friday-bonus]', e)
      res.status(500).json({ error: e.message })
    }
  })

  // Legacy /player-flags routes lived here. They managed captain_pool /
  // shadow_pool on the dropped season_player_flags table — now expressible
  // via custom groups (see below). Removed entirely; any cached client
  // call resolves to 404.

  // ── Custom per-season player groups ──
  // Generic admin-defined groups (in addition to the built-in captain /
  // shadow flags). Each group can carry simple matchmaking rules:
  //   * min_per_match: when > 0, ready-check requires at least N members
  //     in the 10-player group; otherwise it tries to swap others out
  //     for members still queued (mirrors hard-shadow behaviour).
  //   * display_only: badge/colour only, no matchmaking effect.
  // border_color is a CSS colour string used by the avatar ring helper.

  router.get('/api/admin/seasons/:id/groups', async (req, res) => {
    const admin = await requireSeasonPermission(req, res, Number(req.params.id))
    if (!admin) return
    const seasonId = Number(req.params.id)
    try {
      const groups = await query(`
        SELECT g.*, COUNT(m.player_id)::int AS member_count
          FROM season_player_groups g
          LEFT JOIN season_player_group_members m ON m.group_id = g.id
         WHERE g.season_id = $1
         GROUP BY g.id
         ORDER BY g.created_at ASC
      `, [seasonId])
      // Pull member rosters in a second query — avoids row explosion on
      // groups with many members.
      const groupIds = groups.map(g => g.id)
      const members = groupIds.length
        ? await query(`
            SELECT m.group_id, m.player_id, m.added_at,
                   p.name, COALESCE(p.display_name, p.name) AS display_name, p.avatar_url, p.mmr
              FROM season_player_group_members m
              JOIN players p ON p.id = m.player_id
             WHERE m.group_id = ANY($1::int[])
             ORDER BY display_name ASC
          `, [groupIds])
        : []
      const membersByGroup = {}
      for (const m of members) {
        ;(membersByGroup[m.group_id] ||= []).push(m)
      }
      for (const g of groups) g.members = membersByGroup[g.id] || []
      res.json(groups)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.post('/api/admin/seasons/:id/groups', async (req, res) => {
    const admin = await requireSeasonPermission(req, res, Number(req.params.id))
    if (!admin) return
    const seasonId = Number(req.params.id)
    const name = String(req.body?.name || '').trim()
    if (!name) return res.status(400).json({ error: 'name is required' })
    const description = req.body?.description ? String(req.body.description).trim() : null
    const borderColor = String(req.body?.border_color || '#FFD700').trim()
    const minPerMatch = Math.max(0, Math.min(10, Number(req.body?.min_per_match) || 0))
    const displayOnly = !!req.body?.display_only
    const requirePeerWhenPresent = !!req.body?.require_peer_when_present
    const captainsDrawnFrom = !!req.body?.captains_drawn_from
    const peerGroupIds = Array.isArray(req.body?.peer_group_ids)
      ? req.body.peer_group_ids.map(Number).filter(Number.isFinite)
      : []
    try {
      const row = await queryOne(`
        INSERT INTO season_player_groups (season_id, name, description, border_color, min_per_match, display_only, require_peer_when_present, captains_drawn_from, peer_group_ids)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        RETURNING *
      `, [seasonId, name, description, borderColor, minPerMatch, displayOnly, requirePeerWhenPresent, captainsDrawnFrom, JSON.stringify(peerGroupIds)])
      res.status(201).json(row)
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'A group with that name already exists in this season' })
      res.status(500).json({ error: e.message })
    }
  })

  router.patch('/api/admin/seasons/:id/groups/:groupId', async (req, res) => {
    const admin = await requireSeasonPermission(req, res, Number(req.params.id))
    if (!admin) return
    const seasonId = Number(req.params.id)
    const groupId = Number(req.params.groupId)
    const fields = ['name', 'description', 'border_color', 'min_per_match', 'display_only', 'require_peer_when_present', 'captains_drawn_from', 'peer_group_ids']
    const updates = []
    const values = []
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(req.body, f)) {
        let v = req.body[f]
        let cast = ''
        if (f === 'name') v = String(v || '').trim()
        else if (f === 'description') v = v ? String(v).trim() : null
        else if (f === 'border_color') v = String(v || '#FFD700').trim()
        else if (f === 'min_per_match') v = Math.max(0, Math.min(10, Number(v) || 0))
        else if (f === 'display_only' || f === 'require_peer_when_present' || f === 'captains_drawn_from') v = !!v
        else if (f === 'peer_group_ids') {
          v = JSON.stringify(Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : [])
          cast = '::jsonb'
        }
        values.push(v)
        updates.push(`${f} = $${values.length}${cast}`)
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' })
    values.push(seasonId, groupId)
    try {
      const row = await queryOne(
        `UPDATE season_player_groups SET ${updates.join(', ')}
          WHERE season_id = $${values.length - 1} AND id = $${values.length}
          RETURNING *`,
        values
      )
      if (!row) return res.status(404).json({ error: 'Group not found' })
      res.json(row)
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Name already in use in this season' })
      res.status(500).json({ error: e.message })
    }
  })

  router.delete('/api/admin/seasons/:id/groups/:groupId', async (req, res) => {
    const admin = await requireSeasonPermission(req, res, Number(req.params.id))
    if (!admin) return
    const seasonId = Number(req.params.id)
    const groupId = Number(req.params.groupId)
    try {
      const r = await execute(
        `DELETE FROM season_player_groups WHERE season_id = $1 AND id = $2`,
        [seasonId, groupId]
      )
      if (!r.rowCount) return res.status(404).json({ error: 'Group not found' })
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // Re-resolve the player's group ids + metadata for the season and
  // mutate every in-memory queue entry attached to pools on this season
  // so the queue / draft / lobby tiles refresh borders immediately.
  async function _syncGroupSnapshotInQueue(seasonId, playerId) {
    const rows = await query(`
      SELECT g.id, g.name, g.border_color, g.captains_drawn_from
        FROM season_player_group_members m
        JOIN season_player_groups g ON g.id = m.group_id
       WHERE m.player_id = $1 AND g.season_id = $2
       ORDER BY g.captains_drawn_from DESC, g.min_per_match DESC, g.id ASC
    `, [playerId, seasonId])
    const groupIds = rows.map(r => Number(r.id))
    const groups = rows.map(r => ({
      id: Number(r.id),
      name: r.name,
      border_color: r.border_color,
      captains_drawn_from: !!r.captains_drawn_from,
    }))
    const pools = await query('SELECT id FROM queue_pools WHERE season_id = $1', [seasonId])
    for (const { id: poolId } of pools) {
      const q = poolQueues.get(poolId)
      const entry = q?.get(playerId)
      if (entry) {
        entry.groupIds = groupIds
        entry.groups = groups
      }
    }
  }

  router.post('/api/admin/seasons/:id/groups/:groupId/members', async (req, res) => {
    const admin = await requireSeasonPermission(req, res, Number(req.params.id))
    if (!admin) return
    const seasonId = Number(req.params.id)
    const groupId = Number(req.params.groupId)
    const playerId = Number(req.body?.player_id)
    if (!playerId) return res.status(400).json({ error: 'player_id required' })
    try {
      // Verify the group belongs to the season (defence-in-depth).
      const group = await queryOne('SELECT id FROM season_player_groups WHERE id = $1 AND season_id = $2', [groupId, seasonId])
      if (!group) return res.status(404).json({ error: 'Group not found' })
      await execute(
        `INSERT INTO season_player_group_members (group_id, player_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [groupId, playerId]
      )
      await _syncGroupSnapshotInQueue(seasonId, playerId)
      const playerPool = playerInQueue.get(playerId)
      if (playerPool) broadcastQueueUpdate(io, playerPool)
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.delete('/api/admin/seasons/:id/groups/:groupId/members/:playerId', async (req, res) => {
    const admin = await requireSeasonPermission(req, res, Number(req.params.id))
    if (!admin) return
    const seasonId = Number(req.params.id)
    const groupId = Number(req.params.groupId)
    const playerId = Number(req.params.playerId)
    try {
      const group = await queryOne('SELECT id FROM season_player_groups WHERE id = $1 AND season_id = $2', [groupId, seasonId])
      if (!group) return res.status(404).json({ error: 'Group not found' })
      await execute(`DELETE FROM season_player_group_members WHERE group_id = $1 AND player_id = $2`, [groupId, playerId])
      await _syncGroupSnapshotInQueue(seasonId, playerId)
      const playerPool = playerInQueue.get(playerId)
      if (playerPool) broadcastQueueUpdate(io, playerPool)
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  return router
}

// Re-export for tests / future callers if needed.
export { ROUTER_TAGS }
