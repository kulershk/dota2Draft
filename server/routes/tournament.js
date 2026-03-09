import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { requireCompPermission } from '../middleware/permissions.js'
import { getCompetition, getCaptains } from '../helpers/competition.js'
import { advanceWinner, generateEliminationBracket, generateGroupMatches, generateDoubleEliminationBracket } from '../helpers/tournament.js'

export default function createTournamentRouter(io) {
  const router = Router()

  router.get('/api/competitions/:compId/tournament', async (req, res) => {
    const compId = Number(req.params.compId)
    const comp = await getCompetition(compId)
    if (!comp) return res.status(404).json({ error: 'Competition not found' })

    const matches = await query(`
      SELECT m.*,
        t1.team AS team1_name, t1.name AS team1_captain, COALESCE(p1.avatar_url, '') AS team1_avatar, t1.banner_url AS team1_banner,
        t2.team AS team2_name, t2.name AS team2_captain, COALESCE(p2.avatar_url, '') AS team2_avatar, t2.banner_url AS team2_banner,
        w.team AS winner_name
      FROM matches m
      LEFT JOIN captains t1 ON t1.id = m.team1_captain_id
      LEFT JOIN players p1 ON p1.id = t1.player_id
      LEFT JOIN captains t2 ON t2.id = m.team2_captain_id
      LEFT JOIN players p2 ON p2.id = t2.player_id
      LEFT JOIN captains w ON w.id = m.winner_captain_id
      WHERE m.competition_id = $1
      ORDER BY m.stage, m.round, m.match_order
    `, [compId])

    const games = await query(`
      SELECT mg.*, w.team AS winner_name
      FROM match_games mg
      JOIN matches m ON m.id = mg.match_id
      LEFT JOIN captains w ON w.id = mg.winner_captain_id
      WHERE m.competition_id = $1
      ORDER BY mg.match_id, mg.game_number
    `, [compId])

    const gamesByMatch = {}
    for (const g of games) {
      if (!gamesByMatch[g.match_id]) gamesByMatch[g.match_id] = []
      gamesByMatch[g.match_id].push(g)
    }

    res.json({
      tournament_state: comp.tournament_state || {},
      matches: matches.map(m => ({ ...m, games: gamesByMatch[m.id] || [] })),
    })
  })

  router.post('/api/competitions/:compId/tournament/stages', async (req, res) => {
    const compId = Number(req.params.compId)
    const admin = await requireCompPermission(req, res, compId)
    if (!admin) return

    const comp = await getCompetition(compId)
    if (!comp) return res.status(404).json({ error: 'Competition not found' })

    const { name, format, groups, bestOf = 3, seeds } = req.body
    if (!format || !['single_elimination', 'double_elimination', 'group_stage'].includes(format)) {
      return res.status(400).json({ error: 'Invalid format' })
    }

    const ts = comp.tournament_state || {}
    if (!ts.stages) ts.stages = []

    const stageId = (ts.stages.length > 0 ? Math.max(...ts.stages.map(s => s.id)) : 0) + 1
    const stage = { id: stageId, name: name || `Stage ${stageId}`, format, status: 'pending', bestOf }

    const captainsList = await getCaptains(compId)

    if (format === 'single_elimination') {
      const teamIds = seeds || captainsList.map(c => c.id)
      if (teamIds.length < 2) return res.status(400).json({ error: 'Need at least 2 teams' })
      const { bracketSize, totalRounds } = await generateEliminationBracket(compId, stageId, teamIds, bestOf)
      stage.bracketSize = bracketSize
      stage.totalRounds = totalRounds
      stage.status = 'active'
    } else if (format === 'double_elimination') {
      const teamIds = seeds || captainsList.map(c => c.id)
      if (teamIds.length < 3) return res.status(400).json({ error: 'Need at least 3 teams for double elimination' })
      const { bracketSize, ubRounds, lbTotalRounds } = await generateDoubleEliminationBracket(compId, stageId, teamIds, bestOf)
      stage.bracketSize = bracketSize
      stage.ubRounds = ubRounds
      stage.lbTotalRounds = lbTotalRounds
      stage.status = 'active'
    } else {
      if (!groups || !Array.isArray(groups) || groups.length === 0) {
        return res.status(400).json({ error: 'Groups required for group stage' })
      }
      stage.groups = groups
      await generateGroupMatches(compId, stageId, groups, bestOf)
      stage.status = 'active'
    }

    ts.stages.push(stage)
    await execute('UPDATE competitions SET tournament_state = $1 WHERE id = $2', [JSON.stringify(ts), compId])

    io.to(`comp:${compId}`).emit('tournament:updated')
    res.json({ ok: true, stageId })
  })

  router.put('/api/competitions/:compId/tournament/stages/:stageId', async (req, res) => {
    const compId = Number(req.params.compId)
    const stageId = Number(req.params.stageId)
    const admin = await requireCompPermission(req, res, compId)
    if (!admin) return

    const comp = await getCompetition(compId)
    if (!comp) return res.status(404).json({ error: 'Competition not found' })

    const ts = comp.tournament_state || {}
    if (!ts.stages) return res.status(404).json({ error: 'No stages' })

    const stage = ts.stages.find(s => s.id === stageId)
    if (!stage) return res.status(404).json({ error: 'Stage not found' })

    const { name, status } = req.body
    if (name !== undefined) stage.name = name
    if (status !== undefined && ['pending', 'active', 'completed'].includes(status)) {
      stage.status = status
    }

    await execute('UPDATE competitions SET tournament_state = $1 WHERE id = $2', [JSON.stringify(ts), compId])

    io.to(`comp:${compId}`).emit('tournament:updated')
    res.json({ ok: true })
  })

  router.delete('/api/competitions/:compId/tournament/stages/:stageId', async (req, res) => {
    const compId = Number(req.params.compId)
    const stageId = Number(req.params.stageId)
    const admin = await requireCompPermission(req, res, compId)
    if (!admin) return

    const comp = await getCompetition(compId)
    if (!comp) return res.status(404).json({ error: 'Competition not found' })

    const ts = comp.tournament_state || {}
    if (!ts.stages) return res.status(404).json({ error: 'No stages' })

    ts.stages = ts.stages.filter(s => s.id !== stageId)
    await execute('DELETE FROM matches WHERE competition_id = $1 AND stage = $2', [compId, stageId])
    await execute('UPDATE competitions SET tournament_state = $1 WHERE id = $2', [JSON.stringify(ts), compId])

    io.to(`comp:${compId}`).emit('tournament:updated')
    res.json({ ok: true })
  })

  router.put('/api/competitions/:compId/tournament/matches/:matchId/score', async (req, res) => {
    const compId = Number(req.params.compId)
    const matchId = Number(req.params.matchId)
    const admin = await requireCompPermission(req, res, compId)
    if (!admin) return

    const match = await queryOne('SELECT * FROM matches WHERE id = $1 AND competition_id = $2', [matchId, compId])
    if (!match) return res.status(404).json({ error: 'Match not found' })

    const { score1, score2, games, status } = req.body

    let winnerId = null
    if (score1 != null && score2 != null) {
      if (score1 > score2) winnerId = match.team1_captain_id
      else if (score2 > score1) winnerId = match.team2_captain_id
    }

    const newStatus = status || (winnerId ? 'completed' : match.status)

    await execute(
      `UPDATE matches SET score1 = $1, score2 = $2, winner_captain_id = $3, status = $4 WHERE id = $5`,
      [score1 ?? match.score1, score2 ?? match.score2, winnerId, newStatus, matchId]
    )

    if (games && Array.isArray(games)) {
      for (const game of games) {
        await execute(`
          INSERT INTO match_games (match_id, game_number, winner_captain_id, dotabuff_id, duration_minutes)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (match_id, game_number) DO UPDATE SET
            winner_captain_id = $3, dotabuff_id = $4, duration_minutes = $5
        `, [matchId, game.game_number, game.winner_captain_id || null, game.dotabuff_id || null, game.duration_minutes || null])
      }
    }

    if (winnerId && (match.next_match_id || match.loser_next_match_id)) {
      await advanceWinner(matchId, winnerId)
    }

    const comp = await getCompetition(compId)
    const ts = comp.tournament_state || {}
    if (ts.stages) {
      const stage = ts.stages.find(s => s.id === match.stage)
      if (stage) {
        const stageMatches = await query(
          "SELECT id FROM matches WHERE competition_id = $1 AND stage = $2 AND status != 'completed'",
          [compId, match.stage]
        )
        if (stageMatches.length === 0) {
          stage.status = 'completed'
          await execute('UPDATE competitions SET tournament_state = $1 WHERE id = $2', [JSON.stringify(ts), compId])
        }
      }
    }

    io.to(`comp:${compId}`).emit('tournament:updated')
    res.json({ ok: true })
  })

  router.delete('/api/competitions/:compId/tournament', async (req, res) => {
    const compId = Number(req.params.compId)
    const admin = await requireCompPermission(req, res, compId)
    if (!admin) return

    await execute('DELETE FROM matches WHERE competition_id = $1', [compId])
    await execute("UPDATE competitions SET tournament_state = '{}' WHERE id = $1", [compId])

    io.to(`comp:${compId}`).emit('tournament:updated')
    res.json({ ok: true })
  })

  return router
}
