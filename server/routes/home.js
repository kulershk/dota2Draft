import { Router } from 'express'
import { query, queryOne } from '../db.js'

const router = Router()

// ── Headline counters for the hero stat chips ──
router.get('/api/home/stats', async (req, res) => {
  try {
    const [activePlayers, liveQueueMatches, liveTournamentMatches, activeTournaments] = await Promise.all([
      queryOne(`SELECT COUNT(*)::int AS n FROM players WHERE total_xp > 0 OR mmr > 0`),
      queryOne(`SELECT COUNT(*)::int AS n FROM queue_matches WHERE status IN ('live', 'lobby_creating', 'picking')`),
      queryOne(`SELECT COUNT(*)::int AS n FROM matches WHERE status = 'live'`),
      queryOne(`SELECT COUNT(*)::int AS n FROM competitions WHERE is_public = TRUE AND status NOT IN ('archived', 'cancelled')`),
    ])
    res.json({
      active_players: activePlayers?.n || 0,
      live_matches: (liveQueueMatches?.n || 0) + (liveTournamentMatches?.n || 0),
      active_tournaments: activeTournaments?.n || 0,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Featured tournament + bracket preview (current round) ──
// One competition can be flagged is_featured = TRUE. Returns the comp, its
// captain count (= "Teams"), and the most recent active stage's matches so
// the bracket preview block on the home page can render a few cells.
router.get('/api/home/featured-tournament', async (req, res) => {
  try {
    const comp = await queryOne(`
      SELECT c.id, c.name, c.description, c.starts_at, c.registration_start, c.registration_end,
        c.status, c.is_public, c.tournament_state, c.competition_type,
        (SELECT COUNT(*)::int FROM captains WHERE competition_id = c.id) AS captain_count
      FROM competitions c
      WHERE c.is_featured = TRUE AND c.is_public = TRUE
      LIMIT 1
    `)
    if (!comp) return res.json(null)

    // Pull the latest "live" or most-recent stage's matches as a bracket slice
    let bracket = []
    try {
      bracket = await query(`
        SELECT m.id, m.team1_captain_id, m.team2_captain_id, m.status, m.score1, m.score2,
          m.winner_captain_id, m.scheduled_at, m.round, m.match_order, m.label,
          c1.team AS team1, c1.banner_url AS team1_banner,
          c2.team AS team2, c2.banner_url AS team2_banner,
          ts.name AS stage_name
        FROM matches m
        LEFT JOIN captains c1 ON c1.id = m.team1_captain_id
        LEFT JOIN captains c2 ON c2.id = m.team2_captain_id
        LEFT JOIN tournament_stages ts ON ts.id = m.stage_id
        WHERE m.competition_id = $1
        ORDER BY
          CASE WHEN m.status = 'live' THEN 0 WHEN m.status = 'pending' THEN 1 ELSE 2 END,
          COALESCE(m.scheduled_at, m.created_at) ASC,
          m.round ASC, m.match_order ASC
        LIMIT 7
      `, [comp.id])
    } catch (e) {
      // tournament_stages may not exist on older deployments — fall back gracefully.
      bracket = []
    }
    res.json({
      ...comp,
      bracket,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Top players for the home leaderboard ──
// Sorted by MMR DESC. Each row carries a current streak (count + won flag)
// derived from season_match_log of the most-recent active season, so the
// table can render "W12" / "L2" badges. Streak is null when there's no
// active season or the player hasn't played any season matches yet.
router.get('/api/home/top-players', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 20)
    const players = await query(`
      SELECT id, COALESCE(display_name, name) AS name, avatar_url, mmr, mmr_verified_at
      FROM players
      WHERE mmr > 0
      ORDER BY mmr DESC, id ASC
      LIMIT $1
    `, [limit])
    if (!players.length) return res.json({ players: [], season: null })

    // Find the season we'll pull streaks from — the active season with the most matches.
    const season = await queryOne(`
      SELECT s.id, s.name, s.slug
      FROM seasons s
      WHERE s.is_active = TRUE
      ORDER BY (SELECT COUNT(*) FROM season_match_log WHERE season_id = s.id) DESC, s.id DESC
      LIMIT 1
    `)

    let streakByPid = {}
    let winsByPid = {}
    if (season) {
      const ids = players.map(p => p.id)
      const streakRows = await query(`
        WITH ordered AS (
          SELECT player_id, won, created_at,
            LAG(won) OVER (PARTITION BY player_id ORDER BY created_at DESC, id DESC) AS prev_won
          FROM season_match_log
          WHERE season_id = $1 AND queue_match_id IS NOT NULL
            AND player_id = ANY($2::int[]) AND won IS NOT NULL
        ),
        grouped AS (
          SELECT player_id, won, created_at,
            SUM(CASE WHEN prev_won IS NULL OR prev_won = won THEN 0 ELSE 1 END)
              OVER (PARTITION BY player_id ORDER BY created_at DESC, won) AS grp
          FROM ordered
        )
        SELECT player_id, won, COUNT(*)::int AS streak
        FROM grouped
        WHERE grp = 0
        GROUP BY player_id, won
      `, [season.id, ids])
      for (const r of streakRows) streakByPid[r.player_id] = { count: r.streak, won: r.won }

      const wlRows = await query(`
        SELECT player_id, wins, losses
        FROM season_rankings
        WHERE season_id = $1 AND player_id = ANY($2::int[])
      `, [season.id, ids])
      for (const r of wlRows) winsByPid[r.player_id] = { wins: r.wins, losses: r.losses }
    }

    res.json({
      season,
      players: players.map(p => ({
        id: p.id,
        name: p.name,
        avatar_url: p.avatar_url || null,
        mmr: p.mmr,
        mmr_verified_at: p.mmr_verified_at || null,
        streak: streakByPid[p.id] || null,
        win_rate: (() => {
          const w = winsByPid[p.id]
          if (!w) return null
          const total = (w.wins || 0) + (w.losses || 0)
          if (!total) return null
          return Math.round((w.wins / total) * 100)
        })(),
      })),
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Hero pick rate over the last N days ──
// Aggregates picks across all match_game_player_stats rows in the window.
// Returns the top heroes ranked by pick count.
router.get('/api/home/hero-pick-rate', async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90)
    const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 20)
    const rows = await query(`
      WITH window_games AS (
        SELECT id FROM match_games
        WHERE created_at >= NOW() - ($1 || ' days')::interval
      ),
      total AS (SELECT COUNT(*)::int AS n FROM match_game_player_stats WHERE match_game_id IN (SELECT id FROM window_games))
      SELECT s.hero_id, COUNT(*)::int AS picks,
        ROUND((COUNT(*)::numeric / NULLIF((SELECT n FROM total), 0)) * 100, 1) AS pick_rate
      FROM match_game_player_stats s
      WHERE s.match_game_id IN (SELECT id FROM window_games) AND s.hero_id > 0
      GROUP BY s.hero_id
      ORDER BY picks DESC
      LIMIT $2
    `, [days, limit])
    res.json({ days, heroes: rows })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
