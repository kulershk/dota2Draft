import { Router } from 'express'
import { query, queryOne } from '../db.js'

const router = Router()

// ── Headline counters for the hero stat chips ──
router.get('/api/home/stats', async (req, res) => {
  try {
    const [activePlayers, liveQueueMatches, liveTournamentMatches, activeTournaments] = await Promise.all([
      queryOne(`SELECT COUNT(*)::int AS n FROM players WHERE total_xp > 0 OR mmr > 0`),
      // Only games actually being played — skip 'picking' / 'lobby_creating'
      // (those are the draft + queue-up phases, not in-game). Also bound to
      // the last 4 hours to filter stale 'live' rows that never resolved.
      queryOne(`SELECT COUNT(*)::int AS n FROM queue_matches WHERE status = 'live' AND created_at > NOW() - INTERVAL '4 hours'`),
      queryOne(`SELECT COUNT(*)::int AS n FROM matches WHERE status = 'live'`),
      // "Active" = currently signing-up or currently running. Drafts, finished
      // and archived/cancelled don't count.
      queryOne(`SELECT COUNT(*)::int AS n FROM competitions WHERE is_public = TRUE AND status IN ('registration', 'registration_closed', 'active')`),
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

    // Pull upcoming/live matches for this competition (next 5).
    let upcoming_matches = []
    try {
      upcoming_matches = await query(`
        SELECT m.id, m.team1_captain_id, m.team2_captain_id, m.status, m.score1, m.score2,
          m.winner_captain_id, m.scheduled_at, m.best_of, m.label,
          c1.team AS team1, c1.banner_url AS team1_banner,
          c2.team AS team2, c2.banner_url AS team2_banner,
          ts.name AS stage_name
        FROM matches m
        LEFT JOIN captains c1 ON c1.id = m.team1_captain_id
        LEFT JOIN captains c2 ON c2.id = m.team2_captain_id
        LEFT JOIN tournament_stages ts ON ts.id = m.stage_id
        WHERE m.competition_id = $1
          AND m.status IN ('live', 'pending')
          AND m.hidden = false
        ORDER BY
          CASE WHEN m.status = 'live' THEN 0 ELSE 1 END,
          m.scheduled_at ASC NULLS LAST,
          m.id ASC
        LIMIT 5
      `, [comp.id])
    } catch (e) {
      // tournament_stages may not exist on older deployments — fall back gracefully.
      upcoming_matches = []
    }
    res.json({
      ...comp,
      upcoming_matches,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Top players for the home leaderboard ──
// When an active season exists, ranks by season points (DESC) and returns
// each player's current points + streak (count + won flag) from
// season_match_log. Without an active season, falls back to a plain MMR
// leaderboard. UI decides which column ("Points" or "MMR") to render based
// on whether `season` is non-null in the response.
router.get('/api/home/top-players', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 20)

    const season = await queryOne(`
      SELECT s.id, s.name, s.slug
      FROM seasons s
      WHERE s.is_active = TRUE
      ORDER BY (SELECT COUNT(*) FROM season_match_log WHERE season_id = s.id) DESC, s.id DESC
      LIMIT 1
    `)

    let players = []

    if (season) {
      // Season mode — pull from season_rankings, sorted by points
      players = await query(`
        SELECT p.id, COALESCE(p.display_name, p.name) AS name, p.avatar_url, p.mmr, p.mmr_verified_at,
          sr.points, sr.wins, sr.losses, sr.games_played
        FROM season_rankings sr
        JOIN players p ON p.id = sr.player_id
        WHERE sr.season_id = $1
        ORDER BY sr.points DESC, sr.games_played DESC, p.id ASC
        LIMIT $2
      `, [season.id, limit])
    } else {
      // No season — fall back to MMR leaderboard
      players = await query(`
        SELECT id, COALESCE(display_name, name) AS name, avatar_url, mmr, mmr_verified_at
        FROM players
        WHERE mmr > 0
        ORDER BY mmr DESC, id ASC
        LIMIT $1
      `, [limit])
    }

    if (!players.length) return res.json({ players: [], season })

    // Streaks (only meaningful when there's a season)
    let streakByPid = {}
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
    }

    res.json({
      season,
      players: players.map(p => ({
        id: p.id,
        name: p.name,
        avatar_url: p.avatar_url || null,
        mmr: p.mmr,
        mmr_verified_at: p.mmr_verified_at || null,
        // Season-only fields:
        points: p.points != null ? Math.round(Number(p.points)) : null,
        games_played: p.games_played != null ? Number(p.games_played) : null,
        streak: streakByPid[p.id] || null,
        win_rate: (() => {
          const w = (p.wins != null && p.losses != null) ? { wins: Number(p.wins), losses: Number(p.losses) } : null
          if (!w) return null
          const total = w.wins + w.losses
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
