import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { requireCompPermission, requirePermission } from '../middleware/permissions.js'
import { getSessionPlayerId, getTokenFromReq } from '../middleware/auth.js'
import { getCompetition, getCaptains } from '../helpers/competition.js'
import { advanceWinner, generateEliminationBracket, generateGroupMatches, generateDoubleEliminationBracket } from '../helpers/tournament.js'
import { fetchAndSaveGameStats } from '../helpers/opendota.js'

export default function createTournamentRouter(io) {
  const router = Router()

  router.get('/api/competitions/:compId/tournament', async (req, res) => {
    const compId = Number(req.params.compId)
    const comp = await getCompetition(compId)
    if (!comp) return res.status(404).json({ error: 'Competition not found' })

    const matches = await query(`
      SELECT m.*,
        t1.team AS team1_name, t1.name AS team1_captain, COALESCE(p1.avatar_url, '') AS team1_avatar, t1.banner_url AS team1_banner, t1.dota_team_id AS team1_dota_id,
        t2.team AS team2_name, t2.name AS team2_captain, COALESCE(p2.avatar_url, '') AS team2_avatar, t2.banner_url AS team2_banner, t2.dota_team_id AS team2_dota_id,
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

    // Check which games have stats
    const gameIds = games.map(g => g.id)
    let statsCountMap = {}
    if (gameIds.length > 0) {
      const statsCounts = await query(
        `SELECT match_game_id, COUNT(*) as count FROM match_game_player_stats WHERE match_game_id = ANY($1) GROUP BY match_game_id`,
        [gameIds]
      )
      for (const sc of statsCounts) {
        statsCountMap[sc.match_game_id] = Number(sc.count)
      }
    }

    // Attach has_stats flag; parsed comes directly from the match_games row
    for (const matchId in gamesByMatch) {
      for (const g of gamesByMatch[matchId]) {
        g.has_stats = (statsCountMap[g.id] || 0) > 0
        // g.parsed is already on the row from the DB query
      }
    }

    // Fetch rosters for all captains in this tournament
    const captainIds = [...new Set(matches.flatMap(m => [m.team1_captain_id, m.team2_captain_id].filter(Boolean)))]
    const rosterMap = {}
    if (captainIds.length > 0) {
      const rosterRows = await query(`
        SELECT cap.id AS captain_id, COALESCE(p.display_name, p.name) AS name, p.avatar_url, cp.mmr,
               (cp.player_id = cap.player_id) AS is_captain
        FROM captains cap
        JOIN competition_players cp ON cp.competition_id = cap.competition_id
          AND (cp.drafted_by = cap.id OR (cap.player_id IS NOT NULL AND cp.player_id = cap.player_id))
        JOIN players p ON p.id = cp.player_id
        WHERE cap.id = ANY($1)
        ORDER BY (cp.player_id = cap.player_id) DESC, cp.playing_role ASC NULLS LAST, p.name
      `, [captainIds])
      for (const r of rosterRows) {
        if (!rosterMap[r.captain_id]) rosterMap[r.captain_id] = []
        if (!rosterMap[r.captain_id].some(p => p.name === r.name)) {
          rosterMap[r.captain_id].push({ name: r.name, avatar: r.avatar_url || '', mmr: r.mmr || 0, is_captain: r.is_captain })
        }
      }
    }

    res.json({
      tournament_state: comp.tournament_state || {},
      matches: matches.map(m => ({ ...m, games: gamesByMatch[m.id] || [] })),
      rosters: rosterMap,
    })
  })

  // All matches across all competitions (with filters)
  router.get('/api/matches', async (req, res) => {
    try {
      const { status } = req.query
      let where = 'm.hidden = false'
      const params = []
      if (status && status !== 'all') {
        params.push(status)
        where += ` AND m.status = $${params.length}`
      }
      const matches = await query(`
        SELECT m.id, m.scheduled_at, m.status, m.best_of, m.score1, m.score2,
          m.competition_id, m.team1_captain_id, m.team2_captain_id,
          m.winner_captain_id, m.group_name, m.stage,
          c.name AS competition_name,
          t1.team AS team1_name, COALESCE(p1.avatar_url, '') AS team1_avatar, t1.banner_url AS team1_banner,
          t2.team AS team2_name, COALESCE(p2.avatar_url, '') AS team2_avatar, t2.banner_url AS team2_banner
        FROM matches m
        JOIN competitions c ON c.id = m.competition_id
        LEFT JOIN captains t1 ON t1.id = m.team1_captain_id
        LEFT JOIN players p1 ON p1.id = t1.player_id
        LEFT JOIN captains t2 ON t2.id = m.team2_captain_id
        LEFT JOIN players p2 ON p2.id = t2.player_id
        WHERE ${where}
          AND (m.team1_captain_id IS NOT NULL OR m.team2_captain_id IS NOT NULL)
        ORDER BY
          CASE WHEN m.status = 'live' THEN 0 ELSE 1 END,
          m.scheduled_at DESC NULLS LAST,
          m.id DESC
        LIMIT 200
      `, params)
      // Mark matches the current user is in
      const playerId = getSessionPlayerId(getTokenFromReq(req))
      if (playerId) {
        const captainIds = [...new Set(matches.flatMap(m => [m.team1_captain_id, m.team2_captain_id].filter(Boolean)))]
        const myTeamCaptainIds = new Set()
        if (captainIds.length > 0) {
          // Check if user is a captain of any team in these matches
          const capRows = await query('SELECT id FROM captains WHERE id = ANY($1) AND player_id = $2', [captainIds, playerId])
          for (const r of capRows) myTeamCaptainIds.add(r.id)
          // Check if user is drafted onto a team (drafted_by set)
          const draftRows = await query('SELECT DISTINCT drafted_by FROM competition_players WHERE player_id = $1 AND drafted_by = ANY($2) AND drafted_by IS NOT NULL', [playerId, captainIds])
          for (const r of draftRows) myTeamCaptainIds.add(r.drafted_by)
          // Check if user is on a team as the captain's own player entry (drafted_by may be NULL for captains)
          const selfCapRows = await query(
            `SELECT c.id FROM captains c
             JOIN competition_players cp ON cp.competition_id = c.competition_id AND cp.player_id = c.player_id
             WHERE c.id = ANY($1) AND c.player_id = $2`,
            [captainIds, playerId]
          )
          for (const r of selfCapRows) myTeamCaptainIds.add(r.id)
        }
        for (const m of matches) {
          m.my_match = myTeamCaptainIds.has(m.team1_captain_id) || myTeamCaptainIds.has(m.team2_captain_id)
        }
      }
      res.json(matches)
    } catch (err) {
      console.error('Error fetching all matches:', err)
      res.status(500).json({ error: 'Failed to fetch matches' })
    }
  })

  // Count of upcoming matches the current user is in
  router.get('/api/matches/my-upcoming-count', async (req, res) => {
    try {
      const playerId = getSessionPlayerId(getTokenFromReq(req))
      if (!playerId) return res.json({ count: 0 })
      const row = await queryOne(`
        SELECT COUNT(DISTINCT m.id)::int AS count
        FROM matches m
        JOIN captains t1 ON t1.id = m.team1_captain_id
        JOIN captains t2 ON t2.id = m.team2_captain_id
        WHERE m.status IN ('pending', 'live')
          AND m.hidden = false
          AND (
            t1.player_id = $1 OR t2.player_id = $1
            OR EXISTS (
              SELECT 1 FROM competition_players cp
              WHERE cp.competition_id = m.competition_id
                AND cp.player_id = $1
                AND (cp.drafted_by = t1.id OR cp.drafted_by = t2.id)
            )
          )
      `, [playerId])
      res.json({ count: row?.count || 0 })
    } catch (err) {
      console.error('Error fetching my upcoming match count:', err)
      res.json({ count: 0 })
    }
  })

  // Global upcoming matches across all competitions
  router.get('/api/upcoming-matches', async (req, res) => {
    try {
      const matches = await query(`
        SELECT m.id, m.scheduled_at, m.status, m.best_of, m.score1, m.score2, m.competition_id,
          m.team1_captain_id, m.team2_captain_id,
          c.name AS competition_name,
          t1.team AS team1_name, COALESCE(p1.avatar_url, '') AS team1_avatar, t1.banner_url AS team1_banner,
          t2.team AS team2_name, COALESCE(p2.avatar_url, '') AS team2_avatar, t2.banner_url AS team2_banner
        FROM matches m
        JOIN competitions c ON c.id = m.competition_id
        LEFT JOIN captains t1 ON t1.id = m.team1_captain_id
        LEFT JOIN players p1 ON p1.id = t1.player_id
        LEFT JOIN captains t2 ON t2.id = m.team2_captain_id
        LEFT JOIN players p2 ON p2.id = t2.player_id
        WHERE (m.scheduled_at IS NOT NULL OR m.status = 'live')
          AND m.status != 'completed'
          AND m.hidden = false
          AND c.status != 'finished'
        ORDER BY
          CASE WHEN m.status = 'live' THEN 0 ELSE 1 END,
          m.scheduled_at ASC NULLS LAST
        LIMIT 20
      `)

      // Fetch rosters for each match's teams (drafted players + captain themselves)
      const captainIds = [...new Set(matches.flatMap(m => [m.team1_captain_id, m.team2_captain_id].filter(Boolean)))]
      const rosterMap = {}
      if (captainIds.length > 0) {
        const rosterRows = await query(`
          SELECT cap.id AS captain_id, COALESCE(p.display_name, p.name) AS name, p.avatar_url, cp.playing_role, cp.mmr,
                 (cp.player_id = cap.player_id) AS is_captain
          FROM captains cap
          JOIN competition_players cp ON cp.competition_id = cap.competition_id
            AND (cp.drafted_by = cap.id OR (cap.player_id IS NOT NULL AND cp.player_id = cap.player_id))
          JOIN players p ON p.id = cp.player_id
          WHERE cap.id = ANY($1)
          ORDER BY (cp.player_id = cap.player_id) DESC, cp.playing_role ASC NULLS LAST, p.name
        `, [captainIds])
        for (const r of rosterRows) {
          if (!rosterMap[r.captain_id]) rosterMap[r.captain_id] = []
          // Avoid duplicates (captain could also be drafted_by themselves)
          if (!rosterMap[r.captain_id].some(p => p.name === r.name)) {
            rosterMap[r.captain_id].push({ name: r.name, avatar: r.avatar_url || '', playing_role: r.playing_role, mmr: r.mmr || 0 })
          }
        }
      }

      res.json(matches.map(m => ({
        ...m,
        team1_players: rosterMap[m.team1_captain_id] || [],
        team2_players: rosterMap[m.team2_captain_id] || [],
      })))
    } catch (err) {
      console.error('Error fetching upcoming matches:', err)
      res.status(500).json({ error: 'Failed to fetch upcoming matches' })
    }
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

    // Check if any seeds/teams are provided
    const hasSeeds = seeds && seeds.length > 0
    const hasRealTeams = hasSeeds && seeds.some(s => s != null)
    const hasGroupEntries = groups && Array.isArray(groups) && groups.some(g => g.teamIds?.length > 0)
    const hasRealGroupTeams = hasGroupEntries && groups.some(g => g.teamIds?.some(id => id != null))

    if (format === 'single_elimination' || format === 'double_elimination') {
      let teamIds = hasSeeds ? seeds : null
      if (!teamIds) {
        // No seeds at all — generate empty bracket based on captain count
        const captains = await getCaptains(compId)
        const teamCount = Math.max(captains.length, format === 'double_elimination' ? 3 : 2)
        teamIds = new Array(teamCount).fill(null)
      }
      if (teamIds.length < 2) return res.status(400).json({ error: 'Need at least 2 teams' })
      if (format === 'single_elimination') {
        const { bracketSize, totalRounds } = await generateEliminationBracket(compId, stageId, teamIds, bestOf)
        stage.bracketSize = bracketSize
        stage.totalRounds = totalRounds
      } else {
        if (teamIds.length < 3) return res.status(400).json({ error: 'Need at least 3 teams for double elimination' })
        const { bracketSize, ubRounds, lbTotalRounds } = await generateDoubleEliminationBracket(compId, stageId, teamIds, bestOf)
        stage.bracketSize = bracketSize
        stage.ubRounds = ubRounds
        stage.lbTotalRounds = lbTotalRounds
      }
      if (hasRealTeams) stage.status = 'active'
    } else if (hasGroupEntries) {
      if (!groups || !Array.isArray(groups) || groups.length === 0) {
        return res.status(400).json({ error: 'Groups required for group stage' })
      }
      stage.groups = groups
      await generateGroupMatches(compId, stageId, groups, bestOf)
      if (hasRealGroupTeams) stage.status = 'active'
    } else if (format === 'group_stage' && groups) {
      // Store group structure without matches (no teams assigned yet)
      stage.groups = groups
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

    const { name, status, seeds, groups, bestOf, regenerate } = req.body
    if (name !== undefined) stage.name = name
    if (bestOf !== undefined) stage.bestOf = bestOf
    if (status !== undefined && ['pending', 'active', 'completed'].includes(status)) {
      stage.status = status
    }

    // Only regenerate matches when explicitly requested
    if (regenerate) {
      const hasNewSeeds = seeds && seeds.length > 0
      const hasNewRealTeams = hasNewSeeds && seeds.some(s => s != null)
      const hasNewGroupEntries = groups && Array.isArray(groups) && groups.some(g => g.teamIds?.length > 0)
      const hasNewRealGroupTeams = hasNewGroupEntries && groups.some(g => g.teamIds?.some(id => id != null))

      if (hasNewSeeds && (stage.format === 'single_elimination' || stage.format === 'double_elimination')) {
        await execute('DELETE FROM matches WHERE competition_id = $1 AND stage = $2', [compId, stageId])
        const bo = stage.bestOf || 3

        if (stage.format === 'single_elimination') {
          if (seeds.length < 2) return res.status(400).json({ error: 'Need at least 2 teams' })
          const { bracketSize, totalRounds } = await generateEliminationBracket(compId, stageId, seeds, bo)
          stage.bracketSize = bracketSize
          stage.totalRounds = totalRounds
        } else {
          if (seeds.length < 3) return res.status(400).json({ error: 'Need at least 3 teams for double elimination' })
          const { bracketSize, ubRounds, lbTotalRounds } = await generateDoubleEliminationBracket(compId, stageId, seeds, bo)
          stage.bracketSize = bracketSize
          stage.ubRounds = ubRounds
          stage.lbTotalRounds = lbTotalRounds
        }
        if (hasNewRealTeams) stage.status = 'active'
      } else if (hasNewGroupEntries && stage.format === 'group_stage') {
        await execute('DELETE FROM matches WHERE competition_id = $1 AND stage = $2', [compId, stageId])
        const bo = stage.bestOf || 3
        stage.groups = groups
        await generateGroupMatches(compId, stageId, groups, bo)
        if (hasNewRealGroupTeams) stage.status = 'active'
      }
    } else if (stage.format === 'group_stage' && groups) {
      // Update group structure without regenerating matches
      stage.groups = groups
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

    const { score1, score2, games, status, hidden, scheduled_at } = req.body

    let winnerId = null
    if (score1 != null && score2 != null) {
      if (score1 > score2) winnerId = match.team1_captain_id
      else if (score2 > score1) winnerId = match.team2_captain_id
    }

    const newStatus = status || (winnerId ? 'completed' : match.status)
    const newHidden = hidden !== undefined ? hidden : (match.hidden || false)
    const newScheduledAt = scheduled_at !== undefined ? (scheduled_at || null) : match.scheduled_at

    await execute(
      `UPDATE matches SET score1 = $1, score2 = $2, winner_captain_id = $3, status = $4, hidden = $5, scheduled_at = $6 WHERE id = $7`,
      [score1 ?? match.score1, score2 ?? match.score2, winnerId, newStatus, newHidden, newScheduledAt, matchId]
    )

    if (games && Array.isArray(games)) {
      for (const game of games) {
        const newDotabuffId = game.dotabuff_id || null

        // If dotabuff_id is being cleared, delete associated stats
        if (!newDotabuffId) {
          const existing = await queryOne(
            'SELECT id, dotabuff_id FROM match_games WHERE match_id = $1 AND game_number = $2',
            [matchId, game.game_number]
          )
          if (existing && existing.dotabuff_id) {
            await execute('DELETE FROM match_game_player_stats WHERE match_game_id = $1', [existing.id])
          }
        }

        await execute(`
          INSERT INTO match_games (match_id, game_number, winner_captain_id, dotabuff_id, duration_minutes)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (match_id, game_number) DO UPDATE SET
            winner_captain_id = $3, dotabuff_id = $4, duration_minutes = $5
        `, [matchId, game.game_number, game.winner_captain_id || null, newDotabuffId, game.duration_minutes || null])
      }
    }

    // Auto-fetch OpenDota stats for games with dotabuff_id
    if (games && Array.isArray(games)) {
      for (const game of games) {
        if (game.dotabuff_id) {
          const mg = await queryOne(
            'SELECT id FROM match_games WHERE match_id = $1 AND game_number = $2',
            [matchId, game.game_number]
          )
          if (mg) {
            try {
              await fetchAndSaveGameStats(mg.id, game.dotabuff_id)
            } catch (e) {
              console.error(`OpenDota fetch failed for game ${game.game_number}:`, e.message)
            }
          }
        }
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

  // Get stats for a specific match game
  router.get('/api/competitions/:compId/tournament/matches/:matchId/games/:gameNumber/stats', async (req, res) => {
    const compId = Number(req.params.compId)
    const matchId = Number(req.params.matchId)
    const gameNumber = Number(req.params.gameNumber)

    const match = await queryOne('SELECT id FROM matches WHERE id = $1 AND competition_id = $2', [matchId, compId])
    if (!match) return res.status(404).json({ error: 'Match not found' })

    const mg = await queryOne('SELECT id FROM match_games WHERE match_id = $1 AND game_number = $2', [matchId, gameNumber])
    if (!mg) return res.json({ stats: [] })

    // Join with players table to get profile info (Steam32 to Steam64: steam64 = account_id + 76561197960265728)
    const stats = await query(
      `SELECT s.*, p.id AS profile_id, p.name AS profile_name, p.display_name AS profile_display_name, p.avatar_url AS profile_avatar
       FROM match_game_player_stats s
       LEFT JOIN players p ON p.steam_id = CAST((s.account_id + 76561197960265728) AS TEXT)
       WHERE s.match_game_id = $1
       ORDER BY s.is_radiant DESC, s.account_id`,
      [mg.id]
    )
    res.json({ stats })
  })

  // Refetch OpenDota stats for a specific match game
  router.post('/api/competitions/:compId/tournament/matches/:matchId/games/:gameNumber/refetch', async (req, res) => {
    const compId = Number(req.params.compId)
    const matchId = Number(req.params.matchId)
    const gameNumber = Number(req.params.gameNumber)
    const admin = await requireCompPermission(req, res, compId)
    if (!admin) return

    const match = await queryOne('SELECT id FROM matches WHERE id = $1 AND competition_id = $2', [matchId, compId])
    if (!match) return res.status(404).json({ error: 'Match not found' })

    let mg = await queryOne('SELECT id, dotabuff_id FROM match_games WHERE match_id = $1 AND game_number = $2', [matchId, gameNumber])
    if (!mg) return res.status(400).json({ error: 'Save the match score first before refetching stats' })
    if (!mg.dotabuff_id) return res.status(400).json({ error: 'No match ID set for this game' })

    try {
      const result = await fetchAndSaveGameStats(mg.id, mg.dotabuff_id)
      if (result.error) return res.status(404).json({ error: result.error })
      io.to(`comp:${compId}`).emit('tournament:updated')
      res.json({ ok: true, ...result })
    } catch (e) {
      res.status(500).json({ error: 'Failed to fetch from OpenDota: ' + e.message })
    }
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

  // Admin: get all unparsed games across all competitions
  router.get('/api/admin/games/unparsed', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_competitions')
    if (!admin) return

    const games = await query(`
      SELECT mg.id, mg.match_id, mg.game_number, mg.dotabuff_id, mg.parsed, mg.duration_minutes, mg.created_at,
        m.competition_id, m.team1_captain_id, m.team2_captain_id,
        c.name AS competition_name,
        c1.team AS team1_name, c2.team AS team2_name
      FROM match_games mg
      JOIN matches m ON m.id = mg.match_id
      JOIN competitions c ON c.id = m.competition_id
      LEFT JOIN captains c1 ON c1.id = m.team1_captain_id
      LEFT JOIN captains c2 ON c2.id = m.team2_captain_id
      WHERE mg.dotabuff_id IS NOT NULL AND mg.dotabuff_id != '' AND mg.parsed = false
      ORDER BY mg.created_at DESC
    `)
    res.json(games)
  })

  // Admin: refetch a specific game by match_game id
  router.post('/api/admin/games/:gameId/refetch', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_competitions')
    if (!admin) return

    const mg = await queryOne('SELECT id, dotabuff_id, match_id FROM match_games WHERE id = $1', [req.params.gameId])
    if (!mg) return res.status(404).json({ error: 'Game not found' })
    if (!mg.dotabuff_id) return res.status(400).json({ error: 'No match ID set' })

    try {
      const result = await fetchAndSaveGameStats(mg.id, mg.dotabuff_id)
      if (result.error) return res.status(404).json({ error: result.error })
      const match = await queryOne('SELECT competition_id FROM matches WHERE id = $1', [mg.match_id])
      if (match) io.to(`comp:${match.competition_id}`).emit('tournament:updated')
      res.json({ ok: true, ...result })
    } catch (e) {
      res.status(500).json({ error: 'Failed to fetch from OpenDota: ' + e.message })
    }
  })

  return router
}
