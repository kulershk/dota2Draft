import { Router } from 'express'
import { query } from '../db.js'

const router = Router()

router.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim()
  if (!q || q.length < 2) return res.json({ players: [], matches: [], competitions: [], teams: [] })
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 20)

  // Player search: numeric id, 17-digit steam_id, or fuzzy name
  let players = []
  if (/^\d{1,9}$/.test(q)) {
    const playerId = parseInt(q, 10)
    const rows = await query(
      `SELECT id, name, display_name, avatar_url, steam_id, mmr, is_banned
         FROM players WHERE id = $1`,
      [playerId]
    )
    players = rows
  } else if (/^\d{17}$/.test(q)) {
    const rows = await query(
      `SELECT id, name, display_name, avatar_url, steam_id, mmr, is_banned
         FROM players WHERE steam_id = $1`,
      [q]
    )
    players = rows
  } else {
    const like = `%${q.replace(/[%_]/g, '\\$&')}%`
    const rows = await query(
      `SELECT id, name, display_name, avatar_url, steam_id, mmr, is_banned
         FROM players
         WHERE display_name ILIKE $1 OR name ILIKE $1
         ORDER BY
           CASE WHEN COALESCE(display_name, name) ILIKE $2 THEN 0 ELSE 1 END,
           last_online DESC NULLS LAST
         LIMIT $3`,
      [like, `${q}%`, limit]
    )
    players = rows
  }

  // Match search: by internal id (queue or tournament) or by Dota 2 match id
  // (stored in match_games.dotabuff_id, typically 10 digits → overflows INT4
  // so we only run the internal-id lookups when the value fits).
  let matches = []
  if (/^\d{1,12}$/.test(q)) {
    const PG_INT4_MAX = 2147483647
    const asNumber = Number(q)
    const fitsInt = asNumber <= PG_INT4_MAX

    if (fitsInt) {
      const queueRows = await query(
        `SELECT qm.id, qm.created_at, qm.completed_at, qm.status,
                qp.name AS pool_name,
                p1.name AS captain1_name, p1.id AS captain1_id,
                p2.name AS captain2_name, p2.id AS captain2_id
           FROM queue_matches qm
           LEFT JOIN queue_pools qp ON qp.id = qm.pool_id
           LEFT JOIN players p1 ON p1.id = qm.captain1_player_id
           LEFT JOIN players p2 ON p2.id = qm.captain2_player_id
           WHERE qm.id = $1
           LIMIT 1`,
        [asNumber]
      )
      for (const r of queueRows) {
        matches.push({
          type: 'queue',
          id: r.id,
          path: `/queue/match/${r.id}`,
          label: r.pool_name ? `${r.pool_name} #${r.id}` : `Queue match #${r.id}`,
          subtitle: [r.captain1_name, r.captain2_name].filter(Boolean).join(' vs ') || null,
          status: r.status,
          date: r.completed_at || r.created_at,
        })
      }
      const tournamentRows = await query(
        `SELECT m.id, m.competition_id, c.name AS competition_name, m.status,
                cap1.name AS team1_name, cap2.name AS team2_name,
                m.scheduled_at, m.created_at
           FROM matches m
           LEFT JOIN competitions c ON c.id = m.competition_id
           LEFT JOIN captains cap1 ON cap1.id = m.team1_captain_id
           LEFT JOIN captains cap2 ON cap2.id = m.team2_captain_id
           WHERE m.id = $1
           LIMIT 1`,
        [asNumber]
      )
      for (const r of tournamentRows) {
        matches.push({
          type: 'tournament',
          id: r.id,
          path: r.competition_id ? `/c/${r.competition_id}/match/${r.id}` : null,
          label: r.competition_name ? `${r.competition_name} #${r.id}` : `Match #${r.id}`,
          subtitle: [r.team1_name, r.team2_name].filter(Boolean).join(' vs ') || null,
          status: r.status,
          date: r.scheduled_at || r.created_at,
        })
      }
    }

    // Dota 2 match id (in-game match ID). Joined to whichever wrapper exists.
    const dotabuffRows = await query(
      `SELECT mg.id AS match_game_id, mg.match_id, mg.dotabuff_id, mg.game_number,
              mg.duration_minutes, mg.start_time,
              m.competition_id, c.name AS competition_name, m.status AS match_status,
              cap1.name AS team1_name, cap2.name AS team2_name,
              qm.id AS queue_match_id, qm.status AS queue_status,
              qp.name AS pool_name,
              qcap1.name AS queue_cap1_name, qcap2.name AS queue_cap2_name
         FROM match_games mg
         LEFT JOIN matches m ON m.id = mg.match_id
         LEFT JOIN competitions c ON c.id = m.competition_id
         LEFT JOIN captains cap1 ON cap1.id = m.team1_captain_id
         LEFT JOIN captains cap2 ON cap2.id = m.team2_captain_id
         LEFT JOIN queue_matches qm ON qm.match_id = mg.match_id
         LEFT JOIN queue_pools qp ON qp.id = qm.pool_id
         LEFT JOIN players qcap1 ON qcap1.id = qm.captain1_player_id
         LEFT JOIN players qcap2 ON qcap2.id = qm.captain2_player_id
         WHERE mg.dotabuff_id = $1
         LIMIT 5`,
      [String(q)]
    )
    for (const r of dotabuffRows) {
      const path = r.queue_match_id
        ? `/queue/match/${r.queue_match_id}`
        : (r.competition_id ? `/c/${r.competition_id}/match/${r.match_id}` : null)
      const teams = r.queue_match_id
        ? [r.queue_cap1_name, r.queue_cap2_name]
        : [r.team1_name, r.team2_name]
      const wrapper = r.pool_name || r.competition_name || null
      const subtitleParts = []
      if (teams.filter(Boolean).length === 2) subtitleParts.push(teams.join(' vs '))
      if (wrapper) subtitleParts.push(wrapper)
      subtitleParts.push(`Game ${r.game_number}`)
      matches.push({
        type: 'dotabuff',
        id: r.dotabuff_id,
        path,
        label: `Dota match ${r.dotabuff_id}`,
        subtitle: subtitleParts.join(' · '),
        status: r.queue_status || r.match_status || 'completed',
        date: r.start_time ? new Date(r.start_time * 1000).toISOString() : null,
      })
    }
  }

  // Competition search: by name, public only, ordered by status (active first)
  // then most recently created.
  const compLike = `%${q.replace(/[%_]/g, '\\$&')}%`
  const compRows = await query(
    `SELECT id, name, status, starts_at, is_public, competition_type
       FROM competitions
       WHERE is_public = TRUE
         AND name ILIKE $1
       ORDER BY
         CASE status
           WHEN 'in_progress' THEN 0
           WHEN 'active' THEN 0
           WHEN 'registration' THEN 1
           WHEN 'draft' THEN 2
           WHEN 'completed' THEN 3
           ELSE 4
         END,
         created_at DESC
       LIMIT $2`,
    [compLike, limit]
  )
  const competitions = compRows.map(c => ({
    id: c.id,
    name: c.name,
    status: c.status,
    starts_at: c.starts_at,
    competition_type: c.competition_type || null,
    path: `/c/${c.id}/info`,
  }))

  // Team search: by team name, only public competitions, showing the
  // tournament name. A "team" in this codebase is a row in the captains
  // table — its profile is at /team/:captainId.
  const teamLike = `%${q.replace(/[%_]/g, '\\$&')}%`
  const teamRows = await query(
    `SELECT cap.id, cap.team, cap.banner_url,
            cap.competition_id,
            c.name AS competition_name, c.status AS competition_status,
            cap.player_id,
            p.name AS captain_name, p.display_name AS captain_display_name
       FROM captains cap
       JOIN competitions c ON c.id = cap.competition_id
       LEFT JOIN players p ON p.id = cap.player_id
       WHERE c.is_public = TRUE
         AND cap.team ILIKE $1
       ORDER BY
         CASE c.status
           WHEN 'in_progress' THEN 0
           WHEN 'active' THEN 0
           WHEN 'registration' THEN 1
           WHEN 'draft' THEN 2
           WHEN 'completed' THEN 3
           ELSE 4
         END,
         c.created_at DESC
       LIMIT $2`,
    [teamLike, limit]
  )
  const teams = teamRows.map(t => ({
    id: t.id,
    team: t.team,
    banner_url: t.banner_url,
    competition_id: t.competition_id,
    competition_name: t.competition_name,
    competition_status: t.competition_status,
    captain_name: t.captain_display_name || t.captain_name || null,
    path: `/team/${t.id}`,
  }))

  res.json({
    players: players.map(p => ({
      id: p.id,
      name: p.display_name || p.name,
      steam_name: p.name,
      avatar_url: p.avatar_url,
      steam_id: p.steam_id,
      mmr: p.mmr,
      is_banned: !!p.is_banned,
    })),
    matches,
    competitions,
    teams,
  })
})

export default router
