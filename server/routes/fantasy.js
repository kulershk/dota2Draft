import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { getAuthPlayer } from '../middleware/auth.js'
import { requireCompPermission } from '../middleware/permissions.js'
import { getCompetition, parseCompSettings } from '../helpers/competition.js'
import { getStagePoints, getStageTopPicks, getPlayerCheckData } from '../helpers/fantasy.js'

const FANTASY_ROLE_TO_PLAYING_ROLE = { carry: 1, mid: 2, offlane: 3, pos4: 4, pos5: 5 }

export default function createFantasyRouter(io) {
  const router = Router()

  // Get all fantasy data for a competition
  router.get('/api/competitions/:compId/fantasy', async (req, res) => {
    try {
      const compId = Number(req.params.compId)
      if (!compId) return res.status(400).json({ error: 'Invalid competition ID' })
      const comp = await getCompetition(compId)
      if (!comp) return res.status(404).json({ error: 'Competition not found' })

      const stages = await query(
        'SELECT * FROM fantasy_stages WHERE competition_id = $1 ORDER BY stage_order, id',
        [compId]
      )

      // Get match assignments for each stage
      const stageIds = stages.map(s => s.id)
      let matchAssignments = []
      if (stageIds.length > 0) {
        matchAssignments = await query(
          'SELECT * FROM fantasy_stage_matches WHERE fantasy_stage_id = ANY($1)',
          [stageIds]
        )
      }

      for (const stage of stages) {
        stage.match_ids = matchAssignments
          .filter(a => a.fantasy_stage_id === stage.id)
          .map(a => a.match_id)
      }

      // Get current user's picks
      let myPicks = {}
      let myRepeats = {} // { stageId: Set<pickPlayerId> }
      const player = await getAuthPlayer(req)
      if (player && stageIds.length > 0) {
        const picks = await query(
          'SELECT * FROM fantasy_picks WHERE fantasy_stage_id = ANY($1) AND player_id = $2',
          [stageIds, player.id]
        )
        for (const p of picks) {
          if (!myPicks[p.fantasy_stage_id]) myPicks[p.fantasy_stage_id] = {}
          myPicks[p.fantasy_stage_id][p.role] = p.pick_player_id
        }

        // Compute repeats: for each stage, find picks that were also in the previous stage
        const sortedStages = [...stages].sort((a, b) => a.stage_order - b.stage_order)
        for (let i = 1; i < sortedStages.length; i++) {
          const prevPicks = myPicks[sortedStages[i - 1].id]
          const curPicks = myPicks[sortedStages[i].id]
          if (!prevPicks || !curPicks) continue
          const prevPlayerIds = new Set(Object.values(prevPicks))
          const repeats = []
          for (const pid of Object.values(curPicks)) {
            if (prevPlayerIds.has(pid)) repeats.push(pid)
          }
          if (repeats.length > 0) myRepeats[sortedStages[i].id] = repeats
        }
      }

      const settings = parseCompSettings(comp)

      // Compute locked picks (picks from teams no longer in the allowed list)
      let lockedPicks = {} // { stageId: { role: true } }
      if (player) {
        // Get all captains and build player→captain mapping
        const captainRows = await query(
          'SELECT id, player_id FROM captains WHERE competition_id = $1',
          [compId]
        )
        const playerIdToCaptainId = {}
        for (const cap of captainRows) {
          if (cap.player_id) playerIdToCaptainId[cap.player_id] = cap.id
        }

        for (const stage of stages) {
          const allowed = stage.allowed_captain_ids
          if (!allowed || !Array.isArray(allowed) || allowed.length === 0) continue
          const stagePicks = myPicks[stage.id]
          if (!stagePicks) continue

          for (const [role, pickPlayerId] of Object.entries(stagePicks)) {
            // Find which captain this picked player belongs to
            const cp = await queryOne(
              'SELECT drafted_by FROM competition_players WHERE competition_id = $1 AND player_id = $2',
              [compId, pickPlayerId]
            )
            const effectiveCaptainId = cp?.drafted_by || playerIdToCaptainId[pickPlayerId] || null
            if (effectiveCaptainId && !allowed.includes(effectiveCaptainId)) {
              if (!lockedPicks[stage.id]) lockedPicks[stage.id] = {}
              lockedPicks[stage.id][role] = true
            }
          }
        }
      }

      // Count participants per stage
      let participantCounts = {}
      if (stageIds.length > 0) {
        const counts = await query(
          `SELECT fantasy_stage_id, COUNT(DISTINCT player_id) as count
           FROM fantasy_picks WHERE fantasy_stage_id = ANY($1) GROUP BY fantasy_stage_id`,
          [stageIds]
        )
        for (const c of counts) {
          participantCounts[c.fantasy_stage_id] = Number(c.count)
        }
      }

      for (const stage of stages) {
        stage.participant_count = participantCounts[stage.id] || 0
      }

      res.json({ stages, myPicks, myRepeats, lockedPicks, repeatPenalty: settings.fantasyRepeatPenalty, enforceRoles: settings.fantasyEnforceRoles })
    } catch (e) {
      console.error('Fantasy GET error:', e.message)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // Get fantasy leaderboard
  router.get('/api/competitions/:compId/fantasy/leaderboard', async (req, res) => {
    try {
      const compId = Number(req.params.compId)
      if (!compId) return res.status(400).json({ error: 'Invalid competition ID' })
      const comp = await getCompetition(compId)
      if (!comp) return res.status(404).json({ error: 'Competition not found' })

      const settings = parseCompSettings(comp)
      const stages = await query(
        "SELECT * FROM fantasy_stages WHERE competition_id = $1 AND status IN ('pending', 'active', 'completed') ORDER BY stage_order, id",
        [compId]
      )

      if (stages.length === 0) return res.json({ stages: [], users: [] })

      const allUserPoints = {}

      for (const stage of stages) {
        const stagePoints = await getStagePoints(stage.id, settings.fantasyScoring, settings.fantasyRepeatPenalty)
        for (const [playerId, data] of Object.entries(stagePoints)) {
          if (!allUserPoints[playerId]) {
            allUserPoints[playerId] = { stages: {}, total: 0 }
          }
          allUserPoints[playerId].stages[stage.id] = data
          allUserPoints[playerId].total += data.total
        }
      }

      for (const uid in allUserPoints) {
        allUserPoints[uid].total = Math.round(allUserPoints[uid].total * 100) / 100
      }

      const playerIds = Object.keys(allUserPoints).map(Number)
      let playerInfo = []
      if (playerIds.length > 0) {
        playerInfo = await query(
          `SELECT id, COALESCE(display_name, name) AS name, avatar_url FROM players WHERE id = ANY($1)`,
          [playerIds]
        )
      }

      const users = playerInfo.map(p => ({
        playerId: p.id,
        name: p.name,
        avatar: p.avatar_url,
        stages: allUserPoints[p.id]?.stages || {},
        total: allUserPoints[p.id]?.total || 0,
      })).sort((a, b) => b.total - a.total)

      res.json({ stages, users })
    } catch (e) {
      console.error('Fantasy leaderboard error:', e.message)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // Create fantasy stage
  router.post('/api/competitions/:compId/fantasy/stages', async (req, res) => {
    try {
      const compId = Number(req.params.compId)
      if (!compId) return res.status(400).json({ error: 'Invalid competition ID' })
      const admin = await requireCompPermission(req, res, compId)
      if (!admin) return

      const { name, matchIds = [], allowedCaptainIds = null } = req.body
      if (!name) return res.status(400).json({ error: 'Name is required' })

      // Validate matches belong to this competition and aren't already assigned
      if (matchIds.length > 0) {
        const assigned = await query(`
          SELECT fsm.match_id FROM fantasy_stage_matches fsm
          JOIN fantasy_stages fs ON fs.id = fsm.fantasy_stage_id
          WHERE fs.competition_id = $1
        `, [compId])
        const assignedIds = new Set(assigned.map(a => a.match_id))
        const conflicts = matchIds.filter(id => assignedIds.has(id))
        if (conflicts.length > 0) {
          return res.status(400).json({ error: 'Some matches are already assigned to another stage' })
        }

        const validMatches = await query(
          'SELECT id FROM matches WHERE id = ANY($1) AND competition_id = $2',
          [matchIds, compId]
        )
        if (validMatches.length !== matchIds.length) {
          return res.status(400).json({ error: 'Some matches do not belong to this competition' })
        }
      }

      // Get next order
      const last = await queryOne(
        'SELECT MAX(stage_order) as max_order FROM fantasy_stages WHERE competition_id = $1',
        [compId]
      )
      const order = (last?.max_order ?? -1) + 1

      const stage = await queryOne(
        'INSERT INTO fantasy_stages (competition_id, name, stage_order, allowed_captain_ids) VALUES ($1, $2, $3, $4) RETURNING *',
        [compId, name, order, allowedCaptainIds ? JSON.stringify(allowedCaptainIds) : null]
      )

      // Assign matches
      for (const matchId of matchIds) {
        await execute(
          'INSERT INTO fantasy_stage_matches (fantasy_stage_id, match_id) VALUES ($1, $2)',
          [stage.id, matchId]
        )
      }

      io.to(`comp:${compId}`).emit('fantasy:updated')
      res.json({ ok: true, stage })
    } catch (e) {
      console.error('Fantasy create stage error:', e.message)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // Update fantasy stage
  router.put('/api/competitions/:compId/fantasy/stages/:stageId', async (req, res) => {
    try {
      const compId = Number(req.params.compId)
      const stageId = Number(req.params.stageId)
      if (!compId || !stageId) return res.status(400).json({ error: 'Invalid IDs' })
      const admin = await requireCompPermission(req, res, compId)
      if (!admin) return

      const stage = await queryOne(
        'SELECT * FROM fantasy_stages WHERE id = $1 AND competition_id = $2',
        [stageId, compId]
      )
      if (!stage) return res.status(404).json({ error: 'Stage not found' })

      const { name, status, matchIds, allowedCaptainIds } = req.body

      if (name !== undefined) {
        await execute('UPDATE fantasy_stages SET name = $1 WHERE id = $2', [name, stageId])
      }

      if (status !== undefined && ['upcoming', 'pending', 'active', 'completed'].includes(status)) {
        await execute('UPDATE fantasy_stages SET status = $1 WHERE id = $2', [status, stageId])
      }

      if (allowedCaptainIds !== undefined) {
        await execute(
          'UPDATE fantasy_stages SET allowed_captain_ids = $1 WHERE id = $2',
          [allowedCaptainIds ? JSON.stringify(allowedCaptainIds) : null, stageId]
        )
      }

      if (matchIds !== undefined) {
        const assigned = await query(`
          SELECT fsm.match_id FROM fantasy_stage_matches fsm
          JOIN fantasy_stages fs ON fs.id = fsm.fantasy_stage_id
          WHERE fs.competition_id = $1 AND fs.id != $2
        `, [compId, stageId])
        const assignedIds = new Set(assigned.map(a => a.match_id))
        const conflicts = matchIds.filter(id => assignedIds.has(id))
        if (conflicts.length > 0) {
          return res.status(400).json({ error: 'Some matches are already assigned to another stage' })
        }

        await execute('DELETE FROM fantasy_stage_matches WHERE fantasy_stage_id = $1', [stageId])
        for (const matchId of matchIds) {
          await execute(
            'INSERT INTO fantasy_stage_matches (fantasy_stage_id, match_id) VALUES ($1, $2)',
            [stageId, matchId]
          )
        }
      }

      io.to(`comp:${compId}`).emit('fantasy:updated')
      res.json({ ok: true })
    } catch (e) {
      console.error('Fantasy update stage error:', e.message)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // Delete fantasy stage
  router.delete('/api/competitions/:compId/fantasy/stages/:stageId', async (req, res) => {
    try {
      const compId = Number(req.params.compId)
      const stageId = Number(req.params.stageId)
      if (!compId || !stageId) return res.status(400).json({ error: 'Invalid IDs' })
      const admin = await requireCompPermission(req, res, compId)
      if (!admin) return

      const stage = await queryOne(
        'SELECT id FROM fantasy_stages WHERE id = $1 AND competition_id = $2',
        [stageId, compId]
      )
      if (!stage) return res.status(404).json({ error: 'Stage not found' })

      await execute('DELETE FROM fantasy_stages WHERE id = $1', [stageId])

      io.to(`comp:${compId}`).emit('fantasy:updated')
      res.json({ ok: true })
    } catch (e) {
      console.error('Fantasy delete stage error:', e.message)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // Save fantasy picks
  router.put('/api/competitions/:compId/fantasy/stages/:stageId/picks', async (req, res) => {
    try {
      const compId = Number(req.params.compId)
      const stageId = Number(req.params.stageId)
      if (!compId || !stageId) return res.status(400).json({ error: 'Invalid IDs' })
      const player = await getAuthPlayer(req)
      if (!player) return res.status(401).json({ error: 'Not authenticated' })

      const stage = await queryOne(
        'SELECT * FROM fantasy_stages WHERE id = $1 AND competition_id = $2',
        [stageId, compId]
      )
      if (!stage) return res.status(404).json({ error: 'Stage not found' })
      if (stage.status !== 'pending') {
        return res.status(400).json({ error: 'Picks are locked for this stage' })
      }

      const roles = ['carry', 'mid', 'offlane', 'pos4', 'pos5']
      const picks = req.body

      for (const role of roles) {
        if (!picks[role]) return res.status(400).json({ error: `Missing pick for ${role}` })
      }

      const pickPlayerIds = roles.map(r => picks[r])
      if (new Set(pickPlayerIds).size !== 5) {
        return res.status(400).json({ error: 'Cannot pick the same player for multiple roles' })
      }

      const compPlayers = await query(
        'SELECT player_id, playing_role, drafted_by FROM competition_players WHERE competition_id = $1 AND player_id = ANY($2)',
        [compId, pickPlayerIds]
      )
      if (compPlayers.length !== 5) {
        return res.status(400).json({ error: 'Some players do not belong to this competition' })
      }

      // Check allowed teams restriction
      const allowedCaptains = stage.allowed_captain_ids
      if (allowedCaptains && Array.isArray(allowedCaptains) && allowedCaptains.length > 0) {
        const captainRows = await query(
          'SELECT id, player_id FROM captains WHERE competition_id = $1',
          [compId]
        )
        const playerToCaptain = {}
        for (const cap of captainRows) {
          if (cap.player_id) playerToCaptain[cap.player_id] = cap.id
        }
        for (const cp of compPlayers) {
          const effectiveCaptainId = cp.drafted_by || playerToCaptain[cp.player_id] || null
          if (!effectiveCaptainId || !allowedCaptains.includes(effectiveCaptainId)) {
            return res.status(400).json({ error: 'Some players belong to teams not available for this stage' })
          }
        }
      }

      // Enforce role restrictions if enabled
      const comp = await getCompetition(compId)
      const settings = parseCompSettings(comp)
      if (settings.fantasyEnforceRoles) {
        const playerRoleMap = Object.fromEntries(compPlayers.map(p => [p.player_id, p.playing_role]))
        for (const role of roles) {
          const requiredRole = FANTASY_ROLE_TO_PLAYING_ROLE[role]
          const playerRole = playerRoleMap[picks[role]]
          if (playerRole !== requiredRole) {
            return res.status(400).json({ error: `Player ${playerRole ? 'is pos ' + playerRole : 'has no role assigned'}, cannot be picked as ${role}` })
          }
        }
      }

      for (const role of roles) {
        await execute(`
          INSERT INTO fantasy_picks (fantasy_stage_id, player_id, role, pick_player_id)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (fantasy_stage_id, player_id, role) DO UPDATE SET pick_player_id = $4
        `, [stageId, player.id, role, picks[role]])
      }

      io.to(`comp:${compId}`).emit('fantasy:updated')
      res.json({ ok: true })
    } catch (e) {
      console.error('Fantasy save picks error:', e.message)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // Save a single fantasy pick
  router.put('/api/competitions/:compId/fantasy/stages/:stageId/pick', async (req, res) => {
    try {
      const compId = Number(req.params.compId)
      const stageId = Number(req.params.stageId)
      if (!compId || !stageId) return res.status(400).json({ error: 'Invalid IDs' })
      const player = await getAuthPlayer(req)
      if (!player) return res.status(401).json({ error: 'Not authenticated' })

      const stage = await queryOne(
        'SELECT * FROM fantasy_stages WHERE id = $1 AND competition_id = $2',
        [stageId, compId]
      )
      if (!stage) return res.status(404).json({ error: 'Stage not found' })
      if (stage.status !== 'pending') {
        return res.status(400).json({ error: 'Picks are locked for this stage' })
      }

      const { role, playerId } = req.body
      const roles = ['carry', 'mid', 'offlane', 'pos4', 'pos5']
      if (!roles.includes(role)) return res.status(400).json({ error: 'Invalid role' })
      if (!playerId) return res.status(400).json({ error: 'Player ID required' })

      // Check if the existing pick for this role is locked (from a disallowed team)
      const allowedCaptains = stage.allowed_captain_ids
      if (allowedCaptains && Array.isArray(allowedCaptains) && allowedCaptains.length > 0) {
        const existingPick = await queryOne(
          'SELECT pick_player_id FROM fantasy_picks WHERE fantasy_stage_id = $1 AND player_id = $2 AND role = $3',
          [stageId, player.id, role]
        )
        if (existingPick) {
          const existingCp = await queryOne(
            'SELECT drafted_by FROM competition_players WHERE competition_id = $1 AND player_id = $2',
            [compId, existingPick.pick_player_id]
          )
          const existingCaptainSelf = await queryOne(
            'SELECT id FROM captains WHERE competition_id = $1 AND player_id = $2',
            [compId, existingPick.pick_player_id]
          )
          const existingCaptainId = existingCp?.drafted_by || (existingCaptainSelf ? existingCaptainSelf.id : null)
          if (existingCaptainId && !allowedCaptains.includes(existingCaptainId)) {
            return res.status(400).json({ error: 'This pick is locked — the team has been removed from this stage' })
          }
        }
      }

      // Verify player belongs to this competition
      const compPlayer = await queryOne(
        'SELECT player_id, playing_role, drafted_by FROM competition_players WHERE competition_id = $1 AND player_id = $2',
        [compId, playerId]
      )
      if (!compPlayer) return res.status(400).json({ error: 'Player not in this competition' })

      // Check new player's team is allowed
      if (allowedCaptains && Array.isArray(allowedCaptains) && allowedCaptains.length > 0) {
        // Find the captain this player belongs to (drafted_by or is captain)
        const playerCaptainId = compPlayer.drafted_by
        const isCaptainSelf = await queryOne(
          'SELECT id FROM captains WHERE competition_id = $1 AND player_id = $2',
          [compId, playerId]
        )
        const effectiveCaptainId = playerCaptainId || (isCaptainSelf ? isCaptainSelf.id : null)
        if (!effectiveCaptainId || !allowedCaptains.includes(effectiveCaptainId)) {
          return res.status(400).json({ error: 'This player\'s team is not available for this stage' })
        }
      }

      // Enforce role restrictions if enabled
      const comp = await getCompetition(compId)
      const settings = parseCompSettings(comp)
      if (settings.fantasyEnforceRoles) {
        const requiredRole = FANTASY_ROLE_TO_PLAYING_ROLE[role]
        if (compPlayer.playing_role !== requiredRole) {
          return res.status(400).json({ error: `Player ${compPlayer.playing_role ? 'is pos ' + compPlayer.playing_role : 'has no role assigned'}, cannot be picked as ${role}` })
        }
      }

      // Check player isn't already picked for another role in this stage
      const existing = await queryOne(
        'SELECT role FROM fantasy_picks WHERE fantasy_stage_id = $1 AND player_id = $2 AND pick_player_id = $3 AND role != $4',
        [stageId, player.id, playerId, role]
      )
      if (existing) return res.status(400).json({ error: `Player already picked as ${existing.role}` })

      await execute(`
        INSERT INTO fantasy_picks (fantasy_stage_id, player_id, role, pick_player_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (fantasy_stage_id, player_id, role) DO UPDATE SET pick_player_id = $4
      `, [stageId, player.id, role, playerId])

      res.json({ ok: true })
    } catch (e) {
      console.error('Fantasy save pick error:', e.message)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // Clear a single fantasy pick
  router.delete('/api/competitions/:compId/fantasy/stages/:stageId/pick/:role', async (req, res) => {
    try {
      const compId = Number(req.params.compId)
      const stageId = Number(req.params.stageId)
      const role = req.params.role
      if (!compId || !stageId) return res.status(400).json({ error: 'Invalid IDs' })
      const player = await getAuthPlayer(req)
      if (!player) return res.status(401).json({ error: 'Not authenticated' })

      const stage = await queryOne(
        'SELECT * FROM fantasy_stages WHERE id = $1 AND competition_id = $2',
        [stageId, compId]
      )
      if (!stage) return res.status(404).json({ error: 'Stage not found' })
      if (stage.status !== 'pending') {
        return res.status(400).json({ error: 'Picks are locked for this stage' })
      }

      // Check if this pick is locked due to team being disallowed
      const allowedCaptains = stage.allowed_captain_ids
      if (allowedCaptains && Array.isArray(allowedCaptains) && allowedCaptains.length > 0) {
        const existingPick = await queryOne(
          'SELECT pick_player_id FROM fantasy_picks WHERE fantasy_stage_id = $1 AND player_id = $2 AND role = $3',
          [stageId, player.id, role]
        )
        if (existingPick) {
          const compPlayer = await queryOne(
            'SELECT drafted_by FROM competition_players WHERE competition_id = $1 AND player_id = $2',
            [compId, existingPick.pick_player_id]
          )
          const isCaptainSelf = await queryOne(
            'SELECT id FROM captains WHERE competition_id = $1 AND player_id = $2',
            [compId, existingPick.pick_player_id]
          )
          const effectiveCaptainId = compPlayer?.drafted_by || (isCaptainSelf ? isCaptainSelf.id : null)
          if (effectiveCaptainId && !allowedCaptains.includes(effectiveCaptainId)) {
            return res.status(400).json({ error: 'This pick is locked — the team has been removed from this stage' })
          }
        }
      }

      await execute(
        'DELETE FROM fantasy_picks WHERE fantasy_stage_id = $1 AND player_id = $2 AND role = $3',
        [stageId, player.id, role]
      )

      res.json({ ok: true })
    } catch (e) {
      console.error('Fantasy clear pick error:', e.message)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // Check player: detailed per-game point breakdown for a player in a role
  router.get('/api/competitions/:compId/fantasy/stages/:stageId/player-check', async (req, res) => {
    try {
      const compId = Number(req.params.compId)
      const stageId = Number(req.params.stageId)
      const playerId = Number(req.query.playerId)
      const role = req.query.role
      if (!compId || !stageId || !playerId || !role) return res.status(400).json({ error: 'Missing parameters' })

      const comp = await getCompetition(compId)
      if (!comp) return res.status(404).json({ error: 'Competition not found' })

      const stage = await queryOne(
        'SELECT * FROM fantasy_stages WHERE id = $1 AND competition_id = $2',
        [stageId, compId]
      )
      if (!stage) return res.status(404).json({ error: 'Stage not found' })

      const settings = parseCompSettings(comp)
      const data = await getPlayerCheckData(stageId, playerId, role, settings.fantasyScoring)
      res.json(data)
    } catch (e) {
      console.error('Fantasy player check error:', e.message)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // Get top picks for a stage (all players ranked by points per role)
  router.get('/api/competitions/:compId/fantasy/stages/:stageId/top-picks', async (req, res) => {
    try {
      const compId = Number(req.params.compId)
      const stageId = Number(req.params.stageId)
      if (!compId || !stageId) return res.status(400).json({ error: 'Invalid IDs' })

      const comp = await getCompetition(compId)
      if (!comp) return res.status(404).json({ error: 'Competition not found' })

      const stage = await queryOne(
        'SELECT * FROM fantasy_stages WHERE id = $1 AND competition_id = $2',
        [stageId, compId]
      )
      if (!stage) return res.status(404).json({ error: 'Stage not found' })

      const settings = parseCompSettings(comp)
      const topPicks = await getStageTopPicks(stageId, compId, settings.fantasyScoring)
      res.json(topPicks)
    } catch (e) {
      console.error('Fantasy top picks error:', e.message)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // ─── Admin Fantasy Picks ────────────────────────────────────

  // Get all users' picks for a competition (admin)
  router.get('/api/competitions/:compId/fantasy/admin/picks', async (req, res) => {
    try {
      const compId = Number(req.params.compId)
      if (!compId) return res.status(400).json({ error: 'Invalid competition ID' })
      const admin = await requireCompPermission(req, res, compId)
      if (!admin) return

      const stages = await query(
        'SELECT * FROM fantasy_stages WHERE competition_id = $1 ORDER BY stage_order, id',
        [compId]
      )
      const stageIds = stages.map(s => s.id)
      if (stageIds.length === 0) return res.json({ stages, picks: {}, users: [] })

      // Get all picks across all stages
      const allPicks = await query(
        'SELECT * FROM fantasy_picks WHERE fantasy_stage_id = ANY($1)',
        [stageIds]
      )

      // Group: { playerId: { stageId: { role: pickPlayerId } } }
      const picks = {}
      const userIds = new Set()
      for (const p of allPicks) {
        userIds.add(p.player_id)
        if (!picks[p.player_id]) picks[p.player_id] = {}
        if (!picks[p.player_id][p.fantasy_stage_id]) picks[p.player_id][p.fantasy_stage_id] = {}
        picks[p.player_id][p.fantasy_stage_id][p.role] = p.pick_player_id
      }

      // Get user info
      let users = []
      if (userIds.size > 0) {
        users = await query(
          `SELECT id, COALESCE(display_name, name) AS name, avatar_url FROM players WHERE id = ANY($1)`,
          [[...userIds]]
        )
      }

      // Get competition players for name lookup
      const compPlayers = await query(
        `SELECT cp.player_id, COALESCE(p.display_name, p.name) AS name, p.avatar_url, cp.drafted_by, cp.playing_role
         FROM competition_players cp JOIN players p ON p.id = cp.player_id
         WHERE cp.competition_id = $1`,
        [compId]
      )

      // Get captains for team info
      const captains = await query(
        'SELECT id, name, team, player_id, avatar_url, banner_url FROM captains WHERE competition_id = $1',
        [compId]
      )

      res.json({ stages, picks, users, compPlayers, captains })
    } catch (e) {
      console.error('Admin fantasy picks GET error:', e.message)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // Admin: set a pick for a specific user
  router.put('/api/competitions/:compId/fantasy/admin/picks/:userId/stages/:stageId/pick', async (req, res) => {
    try {
      const compId = Number(req.params.compId)
      const userId = Number(req.params.userId)
      const stageId = Number(req.params.stageId)
      if (!compId || !userId || !stageId) return res.status(400).json({ error: 'Invalid IDs' })
      const admin = await requireCompPermission(req, res, compId)
      if (!admin) return

      const stage = await queryOne(
        'SELECT * FROM fantasy_stages WHERE id = $1 AND competition_id = $2',
        [stageId, compId]
      )
      if (!stage) return res.status(404).json({ error: 'Stage not found' })

      const { role, playerId } = req.body
      const roles = ['carry', 'mid', 'offlane', 'pos4', 'pos5']
      if (!roles.includes(role)) return res.status(400).json({ error: 'Invalid role' })
      if (!playerId) return res.status(400).json({ error: 'Player ID required' })

      // Verify pick player belongs to competition
      const compPlayer = await queryOne(
        'SELECT player_id FROM competition_players WHERE competition_id = $1 AND player_id = $2',
        [compId, playerId]
      )
      if (!compPlayer) return res.status(400).json({ error: 'Player not in this competition' })

      // Check player isn't already picked for another role by this user in this stage
      const existing = await queryOne(
        'SELECT role FROM fantasy_picks WHERE fantasy_stage_id = $1 AND player_id = $2 AND pick_player_id = $3 AND role != $4',
        [stageId, userId, playerId, role]
      )
      if (existing) return res.status(400).json({ error: `Player already picked as ${existing.role}` })

      await execute(`
        INSERT INTO fantasy_picks (fantasy_stage_id, player_id, role, pick_player_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (fantasy_stage_id, player_id, role) DO UPDATE SET pick_player_id = $4
      `, [stageId, userId, role, playerId])

      io.to(`comp:${compId}`).emit('fantasy:updated')
      res.json({ ok: true })
    } catch (e) {
      console.error('Admin fantasy set pick error:', e.message)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // Admin: clear a pick for a specific user
  router.delete('/api/competitions/:compId/fantasy/admin/picks/:userId/stages/:stageId/pick/:role', async (req, res) => {
    try {
      const compId = Number(req.params.compId)
      const userId = Number(req.params.userId)
      const stageId = Number(req.params.stageId)
      const role = req.params.role
      if (!compId || !userId || !stageId) return res.status(400).json({ error: 'Invalid IDs' })
      const admin = await requireCompPermission(req, res, compId)
      if (!admin) return

      await execute(
        'DELETE FROM fantasy_picks WHERE fantasy_stage_id = $1 AND player_id = $2 AND role = $3',
        [stageId, userId, role]
      )

      io.to(`comp:${compId}`).emit('fantasy:updated')
      res.json({ ok: true })
    } catch (e) {
      console.error('Admin fantasy clear pick error:', e.message)
      res.status(500).json({ error: 'Internal error' })
    }
  })

  return router
}
