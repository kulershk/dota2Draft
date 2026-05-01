import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { requireCompPermission, requirePermission, hasPermission as _checkPerm } from '../middleware/permissions.js'
import { getSessionPlayerId, getTokenFromReq, getAuthPlayer } from '../middleware/auth.js'
import { getCompetition, getCaptains, parseCompSettings } from '../helpers/competition.js'
import { awardXp, getTeamPlayerIds, computeStagePlacements, awardStagePlacements } from '../helpers/xp.js'
import { advanceWinner, repairBracketAdvancement, generateEliminationBracket, generateGroupMatches, generateDoubleEliminationBracket, customBracketWouldCycle, validateCustomBracketStage } from '../helpers/tournament.js'
import { fetchAndSaveGameStats } from '../helpers/opendota.js'
import { getLiveSnapshot, startPolling as startLivePolling, stopPolling as stopLivePolling, updateServerSteamId as updateLivePollerServerSteamId, getPollerDebug, getActivePollerIds } from '../services/liveMatchPoller.js'

export default function createTournamentRouter(io) {
  const router = Router()

  // ── Public: latest live snapshot for any match (queue OR tournament) ──
  // Same shape as /api/queue/match/:id/live but keyed by matches.id directly.
  // Returns 200 + null when no poll is currently active for this match.
  router.get('/api/matches/:matchId/live', async (req, res) => {
    const id = Number(req.params.matchId)
    if (!id) return res.status(400).json({ error: 'Invalid matchId' })
    res.json(getLiveSnapshot(id))
  })

  // ── Admin: manually inject server_steam_id for a stuck match ──
  // When the bot's GC didn't surface a server_steam_id and the bootstrap
  // loop is failing (private Game Details on every player), an admin can
  // grab the id from server logs / a manual lookup and paste it here.
  // Persists it on the latest match_lobbies row and pushes it into the
  // running poller (or starts polling fresh if not running).
  // Permissions: admin, manage_competitions / manage_own_competitions for
  // tournament matches, manage_queue_pools / manage_own_queue_pools for
  // queue matches.
  router.post('/api/admin/matches/:matchId/live-server-id', async (req, res) => {
    const matchId = Number(req.params.matchId)
    const sid = String(req.body?.server_steam_id || '').trim()
    if (!matchId || !sid || sid === '0') return res.status(400).json({ error: 'matchId and server_steam_id required' })

    const player = await getAuthPlayer(req)
    if (!player) return res.status(401).json({ error: 'Not authenticated' })

    const match = await queryOne('SELECT id, competition_id FROM matches WHERE id = $1', [matchId])
    if (!match) return res.status(404).json({ error: 'Match not found' })

    let allowed = !!player.is_admin
    if (!allowed) {
      if (match.competition_id) {
        // Tournament: full or own-comp.
        if (await _checkPerm(player, 'manage_competitions')) allowed = true
        else if (await _checkPerm(player, 'manage_own_competitions')) {
          const comp = await queryOne('SELECT created_by FROM competitions WHERE id = $1', [match.competition_id])
          if (comp && comp.created_by === player.id) allowed = true
        }
      } else {
        // Queue: full or own-pool.
        if (await _checkPerm(player, 'manage_queue_pools')) allowed = true
        else if (await _checkPerm(player, 'manage_own_queue_pools')) {
          const qm = await queryOne('SELECT pool_id FROM queue_matches WHERE match_id = $1', [matchId])
          if (qm) {
            const pool = await queryOne('SELECT created_by FROM queue_pools WHERE id = $1', [qm.pool_id])
            if (pool && pool.created_by === player.id) allowed = true
          }
        }
      }
    }
    if (!allowed) return res.status(403).json({ error: 'Permission denied' })

    try {
      await execute(
        `UPDATE match_lobbies SET server_steam_id = $1
          WHERE id = (SELECT id FROM match_lobbies WHERE match_id = $2 ORDER BY id DESC LIMIT 1)`,
        [sid, matchId]
      )
      const injected = updateLivePollerServerSteamId(matchId, sid)
      if (!injected) await startLivePolling(matchId)
      res.json({ ok: true, injected })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: diagnose live poller state for a match ──
  // Returns a snapshot of the in-memory poller context PLUS the persisted
  // match_lobbies.server_steam_id so we can see why polling isn't producing
  // data after a deploy or for a stuck match. Permissions: any caller with
  // a permission that grants access to this match's admin actions.
  router.get('/api/admin/matches/:matchId/live-debug', async (req, res) => {
    const matchId = Number(req.params.matchId)
    if (!matchId) return res.status(400).json({ error: 'Invalid matchId' })

    const player = await getAuthPlayer(req)
    if (!player) return res.status(401).json({ error: 'Not authenticated' })

    const match = await queryOne('SELECT id, competition_id FROM matches WHERE id = $1', [matchId])
    if (!match) return res.status(404).json({ error: 'Match not found' })

    let allowed = !!player.is_admin
    if (!allowed) {
      if (match.competition_id) {
        if (await _checkPerm(player, 'manage_competitions')) allowed = true
        else if (await _checkPerm(player, 'manage_own_competitions')) {
          const comp = await queryOne('SELECT created_by FROM competitions WHERE id = $1', [match.competition_id])
          if (comp && comp.created_by === player.id) allowed = true
        }
      } else {
        if (await _checkPerm(player, 'manage_queue_pools')) allowed = true
        else if (await _checkPerm(player, 'manage_own_queue_pools')) {
          const qm = await queryOne('SELECT pool_id FROM queue_matches WHERE match_id = $1', [matchId])
          if (qm) {
            const pool = await queryOne('SELECT created_by FROM queue_pools WHERE id = $1', [qm.pool_id])
            if (pool && pool.created_by === player.id) allowed = true
          }
        }
      }
    }
    if (!allowed) return res.status(403).json({ error: 'Permission denied' })

    const lobby = await queryOne(
      `SELECT id, status, dota_match_id, server_steam_id, created_at, updated_at
         FROM match_lobbies
        WHERE match_id = $1
        ORDER BY id DESC
        LIMIT 1`,
      [matchId]
    )
    const game = await queryOne(
      'SELECT winner_captain_id FROM match_games WHERE match_id = $1 ORDER BY game_number DESC LIMIT 1',
      [matchId]
    )

    res.json({
      matchId,
      hasSteamApiKey: !!process.env.STEAM_API_KEY,
      poller: getPollerDebug(matchId),
      activePollers: getActivePollerIds(),
      latestLobby: lobby || null,
      latestGameWinnerSet: !!game?.winner_captain_id,
    })
  })

  // ── Admin: stop and restart polling for a match (clears bootstrap state) ──
  // Useful if the previous attempt gave up after 30 attempts.
  router.post('/api/admin/matches/:matchId/live-restart', async (req, res) => {
    const matchId = Number(req.params.matchId)
    if (!matchId) return res.status(400).json({ error: 'Invalid matchId' })

    const player = await getAuthPlayer(req)
    if (!player) return res.status(401).json({ error: 'Not authenticated' })

    const match = await queryOne('SELECT id, competition_id FROM matches WHERE id = $1', [matchId])
    if (!match) return res.status(404).json({ error: 'Match not found' })

    let allowed = !!player.is_admin
    if (!allowed) {
      if (match.competition_id) {
        if (await _checkPerm(player, 'manage_competitions')) allowed = true
        else if (await _checkPerm(player, 'manage_own_competitions')) {
          const comp = await queryOne('SELECT created_by FROM competitions WHERE id = $1', [match.competition_id])
          if (comp && comp.created_by === player.id) allowed = true
        }
      } else {
        if (await _checkPerm(player, 'manage_queue_pools')) allowed = true
        else if (await _checkPerm(player, 'manage_own_queue_pools')) {
          const qm = await queryOne('SELECT pool_id FROM queue_matches WHERE match_id = $1', [matchId])
          if (qm) {
            const pool = await queryOne('SELECT created_by FROM queue_pools WHERE id = $1', [qm.pool_id])
            if (pool && pool.created_by === player.id) allowed = true
          }
        }
      }
    }
    if (!allowed) return res.status(403).json({ error: 'Permission denied' })

    try {
      stopLivePolling(matchId)
      await startLivePolling(matchId)
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

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
        SELECT cap.id AS captain_id, cp.player_id, COALESCE(p.display_name, p.name) AS name, p.avatar_url,
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
          rosterMap[r.captain_id].push({ player_id: r.player_id, name: r.name, avatar: r.avatar_url || '', is_captain: r.is_captain })
        }
      }
    }

    res.json({
      tournament_state: comp.tournament_state || {},
      matches: matches.map(m => ({ ...m, games: gamesByMatch[m.id] || [] })),
      rosters: rosterMap,
    })
  })

  // All matches across all competitions (with filters + pagination + search)
  router.get('/api/matches', async (req, res) => {
    try {
      const { status, search } = req.query
      const rawLimit = parseInt(req.query.limit, 10)
      const rawOffset = parseInt(req.query.offset, 10)
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 30, 1), 100)
      const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0

      const params = []
      let where = 'm.hidden = false AND (m.team1_captain_id IS NOT NULL OR m.team2_captain_id IS NOT NULL)'
      if (status && status !== 'all') {
        params.push(status)
        where += ` AND m.status = $${params.length}`
      }
      if (search) {
        const like = `%${String(search).replace(/[%_]/g, '\\$&')}%`
        params.push(like)
        const idx = params.length
        where += ` AND (t1.team ILIKE $${idx} OR t2.team ILIKE $${idx} OR c.name ILIKE $${idx})`
      }

      // Count first (cheap — single aggregation, same WHERE).
      const countRow = await queryOne(`
        SELECT COUNT(*)::int AS total
        FROM matches m
        JOIN competitions c ON c.id = m.competition_id
        LEFT JOIN captains t1 ON t1.id = m.team1_captain_id
        LEFT JOIN captains t2 ON t2.id = m.team2_captain_id
        WHERE ${where}
      `, params)
      const total = countRow?.total || 0

      params.push(limit)
      const limitParam = params.length
      params.push(offset)
      const offsetParam = params.length

      const matches = await query(`
        SELECT m.id, m.scheduled_at, m.status, m.best_of, m.score1, m.score2,
          m.competition_id, m.team1_captain_id, m.team2_captain_id,
          m.winner_captain_id, m.group_name, m.stage,
          c.name AS competition_name,
          t1.team AS team1_name, COALESCE(p1.avatar_url, '') AS team1_avatar, t1.banner_url AS team1_banner,
          t2.team AS team2_name, COALESCE(p2.avatar_url, '') AS team2_avatar, t2.banner_url AS team2_banner,
          lg.last_game_at
        FROM matches m
        JOIN competitions c ON c.id = m.competition_id
        LEFT JOIN captains t1 ON t1.id = m.team1_captain_id
        LEFT JOIN players p1 ON p1.id = t1.player_id
        LEFT JOIN captains t2 ON t2.id = m.team2_captain_id
        LEFT JOIN players p2 ON p2.id = t2.player_id
        LEFT JOIN LATERAL (
          SELECT COALESCE(MAX(to_timestamp(g.start_time)), MAX(g.created_at)) AS last_game_at
          FROM match_games g WHERE g.match_id = m.id
        ) lg ON true
        WHERE ${where}
        ORDER BY
          CASE m.status WHEN 'live' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
          CASE WHEN m.status = 'pending' THEN m.scheduled_at END ASC NULLS LAST,
          CASE WHEN m.status = 'completed' THEN COALESCE(lg.last_game_at, m.scheduled_at) END DESC NULLS LAST,
          m.id DESC
        LIMIT $${limitParam} OFFSET $${offsetParam}
      `, params)

      // Mark matches the current user is in
      const playerId = getSessionPlayerId(getTokenFromReq(req))
      if (playerId) {
        const captainIds = [...new Set(matches.flatMap(m => [m.team1_captain_id, m.team2_captain_id].filter(Boolean)))]
        const myTeamCaptainIds = new Set()
        if (captainIds.length > 0) {
          const [capRows, draftRows, selfCapRows] = await Promise.all([
            query('SELECT id FROM captains WHERE id = ANY($1) AND player_id = $2', [captainIds, playerId]),
            query('SELECT DISTINCT drafted_by FROM competition_players WHERE player_id = $1 AND drafted_by = ANY($2) AND drafted_by IS NOT NULL', [playerId, captainIds]),
            query(`SELECT c.id FROM captains c
                   JOIN competition_players cp ON cp.competition_id = c.competition_id AND cp.player_id = c.player_id
                   WHERE c.id = ANY($1) AND c.player_id = $2`,
              [captainIds, playerId]),
          ])
          for (const r of capRows) myTeamCaptainIds.add(r.id)
          for (const r of draftRows) myTeamCaptainIds.add(r.drafted_by)
          for (const r of selfCapRows) myTeamCaptainIds.add(r.id)
        }
        for (const m of matches) {
          m.my_match = myTeamCaptainIds.has(m.team1_captain_id) || myTeamCaptainIds.has(m.team2_captain_id)
        }
      }

      res.json({ rows: matches, total, limit, offset })
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
    if (!format || !['single_elimination', 'double_elimination', 'group_stage', 'custom_bracket'].includes(format)) {
      return res.status(400).json({ error: 'Invalid format' })
    }

    const ts = comp.tournament_state || {}
    if (!ts.stages) ts.stages = []

    const stageId = (ts.stages.length > 0 ? Math.max(...ts.stages.map(s => s.id)) : 0) + 1
    const stage = { id: stageId, name: name || `Stage ${stageId}`, format, status: 'pending', bestOf }

    // Custom bracket: no generator. Stage starts as draft; admin adds
    // matches and links manually and then activates.
    if (format === 'custom_bracket') {
      stage.status = 'draft'
      ts.stages.push(stage)
      await execute('UPDATE competitions SET tournament_state = $1 WHERE id = $2', [JSON.stringify(ts), compId])
      io.to(`comp:${compId}`).emit('tournament:updated')
      return res.json({ ok: true, stageId })
    }

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
    if (status !== undefined && ['pending', 'active', 'completed', 'draft'].includes(status)) {
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

  // ── Custom bracket: per-match admin routes ─────────────────────────────

  // Create a new match inside a custom_bracket stage.
  router.post('/api/competitions/:compId/tournament/stages/:stageId/matches', async (req, res) => {
    const compId = Number(req.params.compId)
    const stageId = Number(req.params.stageId)
    const admin = await requireCompPermission(req, res, compId)
    if (!admin) return

    const comp = await getCompetition(compId)
    if (!comp) return res.status(404).json({ error: 'Competition not found' })
    const stage = (comp.tournament_state?.stages || []).find(s => s.id === stageId)
    if (!stage) return res.status(404).json({ error: 'Stage not found' })
    if (stage.format !== 'custom_bracket') return res.status(400).json({ error: 'Stage is not a custom bracket' })
    if (stage.status !== 'draft') return res.status(400).json({ error: 'Stage is locked (not in draft)' })

    const { best_of = 3, round = 1, match_order = 0, label = null, team1_captain_id = null, team2_captain_id = null } = req.body || {}
    if (![1, 3, 5, 7].includes(Number(best_of))) {
      return res.status(400).json({ error: 'best_of must be 1, 3, 5 or 7' })
    }

    const row = await queryOne(
      `INSERT INTO matches (competition_id, stage, round, match_order, best_of, label, team1_captain_id, team2_captain_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending') RETURNING *`,
      [compId, stageId, Number(round), Number(match_order), Number(best_of), label, team1_captain_id, team2_captain_id]
    )

    io.to(`comp:${compId}`).emit('tournament:updated')
    res.json(row)
  })

  // Update the simple fields of a custom match (best_of, round, match_order,
  // label). Allowed on a draft stage AND on an active stage as long as the
  // match hasn't started yet (status = 'pending' and no score).
  router.patch('/api/admin/matches/:id/meta', async (req, res) => {
    const matchId = Number(req.params.id)
    const match = await queryOne('SELECT * FROM matches WHERE id = $1', [matchId])
    if (!match) return res.status(404).json({ error: 'Match not found' })
    const admin = await requireCompPermission(req, res, match.competition_id)
    if (!admin) return

    if (match.status !== 'pending') return res.status(409).json({ error: 'Match already started' })

    const { best_of, round, match_order, label } = req.body || {}
    const sets = []
    const values = []
    let i = 1
    if (best_of !== undefined) {
      if (![1, 3, 5, 7].includes(Number(best_of))) return res.status(400).json({ error: 'best_of must be 1, 3, 5 or 7' })
      sets.push(`best_of = $${i++}`); values.push(Number(best_of))
    }
    if (round !== undefined) { sets.push(`round = $${i++}`); values.push(Number(round)) }
    if (match_order !== undefined) { sets.push(`match_order = $${i++}`); values.push(Number(match_order)) }
    if (label !== undefined) { sets.push(`label = $${i++}`); values.push(label || null) }
    if (sets.length === 0) return res.json({ ok: true })
    values.push(matchId)
    await execute(`UPDATE matches SET ${sets.join(', ')} WHERE id = $${i}`, values)

    io.to(`comp:${match.competition_id}`).emit('tournament:updated')
    res.json({ ok: true })
  })

  // Set team1/team2 captain id on a match slot (hard seed). Rejects if the
  // slot is already the target of an incoming link from another match.
  router.patch('/api/admin/matches/:id/teams', async (req, res) => {
    const matchId = Number(req.params.id)
    const match = await queryOne('SELECT * FROM matches WHERE id = $1', [matchId])
    if (!match) return res.status(404).json({ error: 'Match not found' })
    const admin = await requireCompPermission(req, res, match.competition_id)
    if (!admin) return

    if (match.status !== 'pending') return res.status(409).json({ error: 'Match already started' })

    const { team1_captain_id, team2_captain_id } = req.body || {}
    // Reject if slot has an incoming link
    const incoming = await query(
      `SELECT id, next_match_id, next_match_slot, loser_next_match_id, loser_next_match_slot
         FROM matches
        WHERE (next_match_id = $1 OR loser_next_match_id = $1)`,
      [matchId]
    )
    const linkedSlots = new Set()
    for (const row of incoming) {
      if (row.next_match_id === matchId && row.next_match_slot) linkedSlots.add(row.next_match_slot)
      if (row.loser_next_match_id === matchId && row.loser_next_match_slot) linkedSlots.add(row.loser_next_match_slot)
    }
    if (team1_captain_id !== undefined && linkedSlots.has(1)) {
      return res.status(409).json({ error: 'Slot 1 is fed by another match; clear the link first' })
    }
    if (team2_captain_id !== undefined && linkedSlots.has(2)) {
      return res.status(409).json({ error: 'Slot 2 is fed by another match; clear the link first' })
    }

    const sets = []
    const values = []
    let i = 1
    if (team1_captain_id !== undefined) { sets.push(`team1_captain_id = $${i++}`); values.push(team1_captain_id || null) }
    if (team2_captain_id !== undefined) { sets.push(`team2_captain_id = $${i++}`); values.push(team2_captain_id || null) }
    if (sets.length === 0) return res.json({ ok: true })
    values.push(matchId)
    await execute(`UPDATE matches SET ${sets.join(', ')} WHERE id = $${i}`, values)

    io.to(`comp:${match.competition_id}`).emit('tournament:updated')
    res.json({ ok: true })
  })

  // Update winner/loser forward links on a custom-bracket match.
  router.patch('/api/admin/matches/:id/links', async (req, res) => {
    const matchId = Number(req.params.id)
    const match = await queryOne('SELECT * FROM matches WHERE id = $1', [matchId])
    if (!match) return res.status(404).json({ error: 'Match not found' })
    const admin = await requireCompPermission(req, res, match.competition_id)
    if (!admin) return

    if (match.status !== 'pending') return res.status(409).json({ error: 'Match already started' })

    const { next_match_id, next_match_slot, loser_next_match_id, loser_next_match_slot } = req.body || {}

    async function validateLinkTarget(targetId, slot) {
      if (targetId == null) return null
      const target = await queryOne('SELECT competition_id, stage, team1_captain_id, team2_captain_id FROM matches WHERE id = $1', [targetId])
      if (!target) return 'Target match not found'
      if (target.competition_id !== match.competition_id || target.stage !== match.stage) return 'Target match must be in the same stage'
      if (slot !== 1 && slot !== 2) return 'Slot must be 1 or 2'
      const hardSeeded = slot === 1 ? target.team1_captain_id != null : target.team2_captain_id != null
      if (hardSeeded) return `Target slot ${slot} is already hard-seeded`
      if (await customBracketWouldCycle(matchId, targetId)) return 'Link would create a cycle'
      return null
    }

    if (next_match_id !== undefined) {
      const err = await validateLinkTarget(next_match_id, Number(next_match_slot))
      if (err) return res.status(400).json({ error: err })
    }
    if (loser_next_match_id !== undefined) {
      const err = await validateLinkTarget(loser_next_match_id, Number(loser_next_match_slot))
      if (err) return res.status(400).json({ error: err })
    }

    const sets = []
    const values = []
    let i = 1
    if (next_match_id !== undefined) { sets.push(`next_match_id = $${i++}`); values.push(next_match_id || null) }
    if (next_match_slot !== undefined) { sets.push(`next_match_slot = $${i++}`); values.push(next_match_slot || null) }
    if (loser_next_match_id !== undefined) { sets.push(`loser_next_match_id = $${i++}`); values.push(loser_next_match_id || null) }
    if (loser_next_match_slot !== undefined) { sets.push(`loser_next_match_slot = $${i++}`); values.push(loser_next_match_slot || null) }
    if (sets.length === 0) return res.json({ ok: true })
    values.push(matchId)
    await execute(`UPDATE matches SET ${sets.join(', ')} WHERE id = $${i}`, values)

    io.to(`comp:${match.competition_id}`).emit('tournament:updated')
    res.json({ ok: true })
  })

  // Delete a custom match (only if no forward link points at it).
  router.delete('/api/admin/matches/:id', async (req, res) => {
    const matchId = Number(req.params.id)
    const match = await queryOne('SELECT * FROM matches WHERE id = $1', [matchId])
    if (!match) return res.status(404).json({ error: 'Match not found' })
    const admin = await requireCompPermission(req, res, match.competition_id)
    if (!admin) return

    const comp = await getCompetition(match.competition_id)
    const stage = (comp?.tournament_state?.stages || []).find(s => s.id === match.stage)
    if (!stage || stage.format !== 'custom_bracket') return res.status(400).json({ error: 'Only custom bracket matches may be deleted this way' })
    if (stage.status !== 'draft') return res.status(409).json({ error: 'Stage is locked (not in draft)' })

    const referencing = await query(
      'SELECT id FROM matches WHERE next_match_id = $1 OR loser_next_match_id = $1',
      [matchId]
    )
    if (referencing.length > 0) {
      return res.status(409).json({ error: `Clear link(s) from match(es) ${referencing.map(r => '#' + r.id).join(', ')} first` })
    }

    await execute('DELETE FROM matches WHERE id = $1', [matchId])
    io.to(`comp:${match.competition_id}`).emit('tournament:updated')
    res.json({ ok: true })
  })

  // Activate a custom_bracket stage (draft → active) after validation.
  // Admin-triggered bracket repair. Walks completed matches and re-applies
  // advancement for any downstream slot that's still empty. Idempotent.
  router.post('/api/competitions/:compId/tournament/repair-advancement', async (req, res) => {
    const compId = Number(req.params.compId)
    const admin = await requireCompPermission(req, res, compId)
    if (!admin) return
    try {
      const fixed = await repairBracketAdvancement(compId)
      if (fixed > 0) io.to(`comp:${compId}`).emit('tournament:updated')
      res.json({ ok: true, fixed })
    } catch (e) {
      console.error('[repair] admin route failed:', e)
      res.status(500).json({ error: e.message || 'Repair failed' })
    }
  })

  router.post('/api/competitions/:compId/tournament/stages/:stageId/activate', async (req, res) => {
    const compId = Number(req.params.compId)
    const stageId = Number(req.params.stageId)
    const admin = await requireCompPermission(req, res, compId)
    if (!admin) return

    const comp = await getCompetition(compId)
    if (!comp) return res.status(404).json({ error: 'Competition not found' })
    const ts = comp.tournament_state || {}
    const stage = (ts.stages || []).find(s => s.id === stageId)
    if (!stage) return res.status(404).json({ error: 'Stage not found' })
    if (stage.format !== 'custom_bracket') return res.status(400).json({ error: 'Stage is not a custom bracket' })

    const errors = await validateCustomBracketStage(compId, stageId)
    if (errors.length > 0) return res.status(400).json({ error: 'Validation failed', errors })

    stage.status = 'active'
    await execute('UPDATE competitions SET tournament_state = $1 WHERE id = $2', [JSON.stringify(ts), compId])
    io.to(`comp:${compId}`).emit('tournament:updated')
    res.json({ ok: true })
  })

  // ── Match Standins ──

  router.get('/api/competitions/:compId/tournament/matches/:matchId/standins', async (req, res) => {
    const compId = Number(req.params.compId)
    const matchId = Number(req.params.matchId)
    const standins = await query(`
      SELECT ms.*,
        op.name AS original_name, COALESCE(op.display_name, op.name) AS original_display_name, op.avatar_url AS original_avatar, op.steam_id AS original_steam_id,
        sp.name AS standin_name, COALESCE(sp.display_name, sp.name) AS standin_display_name, sp.avatar_url AS standin_avatar, sp.steam_id AS standin_steam_id,
        c.team AS captain_team
      FROM match_standins ms
      JOIN players op ON op.id = ms.original_player_id
      JOIN players sp ON sp.id = ms.standin_player_id
      JOIN captains c ON c.id = ms.captain_id
      WHERE ms.match_id = $1
    `, [matchId])
    res.json(standins)
  })

  router.post('/api/competitions/:compId/tournament/matches/:matchId/standins', async (req, res) => {
    const compId = Number(req.params.compId)
    const matchId = Number(req.params.matchId)

    // Allow admins OR the captain of the team being modified
    const player = await getAuthPlayer(req)
    if (!player) return res.status(401).json({ error: 'Not authenticated' })

    const { original_player_id, standin_player_id, captain_id, match_game_id } = req.body
    if (!original_player_id || !standin_player_id || !captain_id) {
      return res.status(400).json({ error: 'original_player_id, standin_player_id, and captain_id required' })
    }

    const isAdmin = await requireCompPermission(req, { status: () => ({ json: () => {} }) }, compId)
    if (!isAdmin) {
      // Check if user is the captain for the team they're modifying
      const captain = await queryOne(
        'SELECT * FROM captains WHERE id = $1 AND competition_id = $2',
        [captain_id, compId]
      )
      if (!captain || captain.player_id !== player.id) {
        return res.status(403).json({ error: 'Permission denied' })
      }
      // Verify captain is in this match
      const match = await queryOne(
        'SELECT * FROM matches WHERE id = $1 AND (team1_captain_id = $2 OR team2_captain_id = $2)',
        [matchId, captain_id]
      )
      if (!match) return res.status(403).json({ error: 'Permission denied' })
    }

    try {
      const gameId = match_game_id || null

      // Block if the game already started (has dota_match_id)
      if (gameId) {
        const lobby = await queryOne(
          "SELECT dota_match_id FROM match_lobbies WHERE match_id = $1 AND game_number = (SELECT game_number FROM match_games WHERE id = $2) AND dota_match_id IS NOT NULL",
          [matchId, gameId]
        )
        if (lobby) return res.status(400).json({ error: 'Cannot change standins for a game that has already started' })
      }

      const standin = await queryOne(`
        INSERT INTO match_standins (match_id, original_player_id, standin_player_id, captain_id, match_game_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (match_id, original_player_id, COALESCE(match_game_id, 0))
        DO UPDATE SET standin_player_id = $3, captain_id = $4
        RETURNING *
      `, [matchId, original_player_id, standin_player_id, captain_id, gameId])
      if (io) io.to(`comp:${compId}`).emit('tournament:updated')
      res.status(201).json(standin)
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  router.delete('/api/competitions/:compId/tournament/matches/:matchId/standins/:id', async (req, res) => {
    const compId = Number(req.params.compId)
    const matchId = Number(req.params.matchId)
    const standinId = Number(req.params.id)

    const player = await getAuthPlayer(req)
    if (!player) return res.status(401).json({ error: 'Not authenticated' })

    const standinRow = await queryOne('SELECT * FROM match_standins WHERE id = $1 AND match_id = $2', [standinId, matchId])
    if (!standinRow) return res.status(404).json({ error: 'Standin not found' })

    const isAdmin = await requireCompPermission(req, { status: () => ({ json: () => {} }) }, compId)
    if (!isAdmin) {
      // Check if user is the captain who owns this standin
      const captain = await queryOne(
        'SELECT * FROM captains WHERE id = $1 AND competition_id = $2',
        [standinRow.captain_id, compId]
      )
      if (!captain || captain.player_id !== player.id) {
        return res.status(403).json({ error: 'Permission denied' })
      }
    }

    // Block if the game already started (has dota_match_id)
    if (standinRow.match_game_id) {
      const lobby = await queryOne(
        "SELECT dota_match_id FROM match_lobbies WHERE match_id = $1 AND game_number = (SELECT game_number FROM match_games WHERE id = $2) AND dota_match_id IS NOT NULL",
        [matchId, standinRow.match_game_id]
      )
      if (lobby) return res.status(400).json({ error: 'Cannot change standins for a game that has already started' })
    }

    await execute('DELETE FROM match_standins WHERE id = $1 AND match_id = $2', [standinId, matchId])
    if (io) io.to(`comp:${compId}`).emit('tournament:updated')
    res.json({ ok: true })
  })

  router.put('/api/competitions/:compId/tournament/matches/:matchId/penalties', async (req, res) => {
    const compId = Number(req.params.compId)
    const matchId = Number(req.params.matchId)
    const admin = await requireCompPermission(req, res, compId)
    if (!admin) return

    const match = await queryOne('SELECT * FROM matches WHERE id = $1 AND competition_id = $2', [matchId, compId])
    if (!match) return res.status(404).json({ error: 'Match not found' })

    const { penalty_radiant, penalty_dire } = req.body
    await execute(
      'UPDATE matches SET penalty_radiant = $1, penalty_dire = $2 WHERE id = $3',
      [penalty_radiant ?? null, penalty_dire ?? null, matchId]
    )

    if (io) io.to(`comp:${compId}`).emit('tournament:updated')
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

        // If dotabuff_id is being cleared OR changed to a different id, delete associated stats
        // (otherwise stale player rows from the previous match linger via ON CONFLICT updates)
        const existing = await queryOne(
          'SELECT id, dotabuff_id FROM match_games WHERE match_id = $1 AND game_number = $2',
          [matchId, game.game_number]
        )
        if (existing && existing.dotabuff_id && existing.dotabuff_id !== newDotabuffId) {
          await execute('DELETE FROM match_game_player_stats WHERE match_game_id = $1', [existing.id])
          await execute("UPDATE match_games SET parsed = false, picks_bans = '[]'::jsonb, start_time = NULL WHERE id = $1", [existing.id])
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
    // Self-heal any previously broken advancement in the same competition.
    // Idempotent — only writes when a downstream slot is still empty.
    try {
      const fixed = await repairBracketAdvancement(compId)
      if (fixed > 0) console.log(`[repair] score route auto-fixed ${fixed} slot(s) in comp #${compId}`)
    } catch (e) {
      console.error('[repair] auto-repair failed:', e.message)
    }

    const comp = await getCompetition(compId)
    const settings = parseCompSettings(comp)

    // ── XP: game win/loss ──
    if (games && Array.isArray(games)) {
      for (const game of games) {
        if (!game.winner_captain_id) continue
        const winCapId = game.winner_captain_id
        const loseCapId = winCapId === match.team1_captain_id ? match.team2_captain_id : match.team1_captain_id
        const winPlayers = await getTeamPlayerIds(winCapId, compId)
        const losePlayers = loseCapId ? await getTeamPlayerIds(loseCapId, compId) : []
        const winCap = await queryOne('SELECT team FROM captains WHERE id = $1', [winCapId])
        const loseCap = loseCapId ? await queryOne('SELECT team FROM captains WHERE id = $1', [loseCapId]) : null
        for (const pid of winPlayers) {
          awardXp(pid, settings.xpGameWin, 'game_win', 'match_game', `${matchId}:${game.game_number}:${pid}`, {
            competitionId: compId, competitionName: comp.name,
            detail: `Game ${game.game_number} win vs ${loseCap?.team || 'TBD'}`,
          })
        }
        for (const pid of losePlayers) {
          awardXp(pid, settings.xpGameLoss, 'game_loss', 'match_game', `${matchId}:${game.game_number}:${pid}`, {
            competitionId: compId, competitionName: comp.name,
            detail: `Game ${game.game_number} loss vs ${winCap?.team || 'TBD'}`,
          })
        }
      }
    }

    // ── XP: match win (series) ──
    if (winnerId && newStatus === 'completed') {
      const winPlayers = await getTeamPlayerIds(winnerId, compId)
      const loserId = winnerId === match.team1_captain_id ? match.team2_captain_id : match.team1_captain_id
      const loseCap = loserId ? await queryOne('SELECT team FROM captains WHERE id = $1', [loserId]) : null
      for (const pid of winPlayers) {
        awardXp(pid, settings.xpMatchWin, 'match_win', 'match', `${matchId}:${pid}`, {
          competitionId: compId, competitionName: comp.name,
          detail: `Series win vs ${loseCap?.team || 'TBD'}`,
        })
      }
    }

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
          await awardStagePlacements(comp, stage, settings)
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

    const mg = await queryOne('SELECT id, picks_bans FROM match_games WHERE match_id = $1 AND game_number = $2', [matchId, gameNumber])
    if (!mg) return res.json({ stats: [], picks_bans: [] })

    // Join with players table to get profile info (Steam32 to Steam64: steam64 = account_id + 76561197960265728)
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
      // Wipe existing stats first so a refetch fully replaces stale data
      // (e.g. when a wrong match id was previously parsed)
      await execute('DELETE FROM match_game_player_stats WHERE match_game_id = $1', [mg.id])
      await execute("UPDATE match_games SET parsed = false, picks_bans = '[]'::jsonb, start_time = NULL WHERE id = $1", [mg.id])

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
    const admin = await requirePermission(req, res, 'manage_games')
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

  // Admin: get all games with dotabuff IDs (for force refetch all)
  router.get('/api/admin/games/all', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_games')
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
      WHERE mg.dotabuff_id IS NOT NULL AND mg.dotabuff_id != ''
      ORDER BY mg.created_at DESC
    `)
    res.json(games)
  })

  // Admin: refetch a specific game by match_game id
  router.post('/api/admin/games/:gameId/refetch', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_games')
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

  // Preview placement XP awards for all non-group stages in a competition
  router.get('/api/competitions/:compId/placements/preview', async (req, res) => {
    const compId = Number(req.params.compId)
    const admin = await requireCompPermission(req, res, compId)
    if (!admin) return

    const comp = await getCompetition(compId)
    if (!comp) return res.status(404).json({ error: 'Competition not found' })
    const settings = parseCompSettings(comp)
    const ts = comp.tournament_state || {}
    const stages = Array.isArray(ts.stages) ? ts.stages : []
    const xpAmounts = { 1: settings.xpPlacement1st, 2: settings.xpPlacement2nd, 3: settings.xpPlacement3rd }
    const labels = { 1: '1st place', 2: '2nd place', 3: '3rd place' }

    const stageResults = []
    for (const stage of stages) {
      const { placements, blocked } = await computeStagePlacements(compId, stage)
      const placementList = []
      for (const [captainId, place] of placements) {
        const xp = xpAmounts[place] || 0
        const cap = await queryOne('SELECT id, team FROM captains WHERE id = $1', [captainId])
        const playerIds = await getTeamPlayerIds(captainId, compId)
        const players = playerIds.length > 0
          ? await query(
              `SELECT p.id, COALESCE(p.display_name, p.name) AS name FROM players p WHERE p.id = ANY($1::int[])`,
              [playerIds]
            )
          : []
        // Which of these players already have this placement XP logged?
        const alreadyRows = playerIds.length > 0
          ? await query(
              `SELECT player_id FROM xp_log
               WHERE reason = $1 AND ref_type = 'stage' AND ref_id LIKE $2 AND player_id = ANY($3::int[])`,
              [`placement_${place}`, `${compId}:${stage.id}:%`, playerIds]
            )
          : []
        const alreadySet = new Set(alreadyRows.map(r => r.player_id))
        placementList.push({
          place,
          label: labels[place],
          xp,
          captain: cap ? { id: cap.id, team: cap.team } : null,
          players: players.map(p => ({ id: p.id, name: p.name, alreadyAwarded: alreadySet.has(p.id) })),
        })
      }
      stageResults.push({
        id: stage.id,
        name: stage.name,
        format: stage.format,
        status: stage.status,
        blocked,
        placements: placementList,
      })
    }
    res.json({ stages: stageResults })
  })

  // Award placement XP for a specific stage (idempotent)
  router.post('/api/competitions/:compId/placements/:stageId/award', async (req, res) => {
    const compId = Number(req.params.compId)
    const stageId = Number(req.params.stageId)
    const admin = await requireCompPermission(req, res, compId)
    if (!admin) return

    const comp = await getCompetition(compId)
    if (!comp) return res.status(404).json({ error: 'Competition not found' })
    const settings = parseCompSettings(comp)
    const ts = comp.tournament_state || {}
    const stage = (ts.stages || []).find(s => s.id === stageId)
    if (!stage) return res.status(404).json({ error: 'Stage not found' })

    const result = await awardStagePlacements(comp, stage, settings)
    if (result.blocked) return res.status(409).json({ error: result.blocked })

    // Mark stage completed if it isn't already
    if (stage.status !== 'completed') {
      stage.status = 'completed'
      await execute('UPDATE competitions SET tournament_state = $1 WHERE id = $2', [JSON.stringify(ts), compId])
    }
    io.to(`comp:${compId}`).emit('tournament:updated')
    res.json({ ok: true, awarded: result.awarded, skipped: result.skipped })
  })

  return router
}
