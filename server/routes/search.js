import { Router } from 'express'
import { query } from '../db.js'

const router = Router()

router.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim()
  if (!q || q.length < 2) return res.json({ players: [], matches: [] })
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

  // Match search: numeric id (queue match or competition match) or dotabuff_id
  let matches = []
  if (/^\d{1,12}$/.test(q)) {
    const id = parseInt(q, 10)
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
      [id]
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
      [id]
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
    const dotabuffRows = await query(
      `SELECT mg.id, mg.match_id, mg.dotabuff_id, mg.game_number,
              m.competition_id, qm.id AS queue_match_id
         FROM match_games mg
         LEFT JOIN matches m ON m.id = mg.match_id
         LEFT JOIN queue_matches qm ON qm.match_id = mg.match_id
         WHERE mg.dotabuff_id = $1
         LIMIT 1`,
      [String(q)]
    )
    for (const r of dotabuffRows) {
      const path = r.queue_match_id
        ? `/queue/match/${r.queue_match_id}`
        : (r.competition_id ? `/c/${r.competition_id}/match/${r.match_id}` : null)
      matches.push({
        type: 'dotabuff',
        id: r.dotabuff_id,
        path,
        label: `Dota match ${r.dotabuff_id}`,
        subtitle: `Game ${r.game_number}`,
        status: 'completed',
        date: null,
      })
    }
  }

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
  })
})

export default router
