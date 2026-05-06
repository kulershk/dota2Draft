import { Router } from 'express'
import pool from '../db.js'
import { getAuthPlayer } from '../middleware/auth.js'
import { getCompetition, parseCompSettings, getCaptains, getCompPlayers } from '../helpers/competition.js'

export default function createTeamRegistrationRouter(io) {
  const router = Router()

  router.post('/api/competitions/:compId/team-registration', async (req, res) => {
    const player = await getAuthPlayer(req)
    if (!player) return res.status(401).json({ error: 'Not authenticated' })
    if (player.is_banned) return res.status(403).json({ error: 'Your account has been banned' })
    if (!player.steam_id) return res.status(400).json({ error: 'Captain must have a Steam account' })

    const compId = Number(req.params.compId)
    const comp = await getCompetition(compId)
    if (!comp) return res.status(404).json({ error: 'Competition not found' })

    const settings = parseCompSettings(comp)
    if (!settings.teamRegistrationMode) return res.status(400).json({ error: 'Team registration is not enabled for this competition' })
    if (!settings.teamRegistrationOpen) return res.status(403).json({ error: 'Team registration is closed' })

    const now = new Date()
    if (comp.registration_start && new Date(comp.registration_start) > now) {
      return res.status(403).json({ error: 'Registration has not opened yet' })
    }
    if (comp.registration_end && new Date(comp.registration_end) < now) {
      return res.status(403).json({ error: 'Registration has closed' })
    }

    const team = (req.body?.team || '').toString().trim()
    const members = Array.isArray(req.body?.members) ? req.body.members : null
    const captainRole = req.body?.captainRole != null ? Number(req.body.captainRole) : null

    if (!team) return res.status(400).json({ error: 'Team name is required' })
    if (team.length > 64) return res.status(400).json({ error: 'Team name too long' })
    if (!members) return res.status(400).json({ error: 'Members list is required' })

    const expectedMemberCount = settings.teamRegistrationSize - 1
    if (members.length !== expectedMemberCount) {
      return res.status(400).json({ error: `Expected ${expectedMemberCount} team members, got ${members.length}` })
    }

    const memberIds = members.map(m => Number(m?.playerId))
    if (memberIds.some(id => !Number.isInteger(id) || id <= 0)) {
      return res.status(400).json({ error: 'Invalid member playerId' })
    }
    if (memberIds.includes(player.id)) {
      return res.status(400).json({ error: 'Captain cannot be listed as a team member' })
    }
    if (new Set(memberIds).size !== memberIds.length) {
      return res.status(400).json({ error: 'Duplicate player in team' })
    }

    const memberRoles = members.map(m => {
      const r = m?.playingRole
      if (r == null || r === '') return null
      const n = Number(r)
      return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null
    })
    const filledRoles = memberRoles.filter(r => r != null)
    if (new Set(filledRoles).size !== filledRoles.length) {
      return res.status(400).json({ error: 'Two members cannot share the same role' })
    }
    const validatedCaptainRole = captainRole != null && Number.isInteger(captainRole) && captainRole >= 1 && captainRole <= 5
      ? captainRole
      : null
    if (validatedCaptainRole != null && filledRoles.includes(validatedCaptainRole)) {
      return res.status(400).json({ error: 'Captain role conflicts with a team member role' })
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      const existingCaptain = await client.query(
        'SELECT id FROM captains WHERE competition_id = $1 AND player_id = $2',
        [compId, player.id]
      )
      if (existingCaptain.rows.length) {
        await client.query('ROLLBACK')
        return res.status(409).json({ error: 'You are already a captain in this competition' })
      }

      const teamConflict = await client.query(
        'SELECT id FROM captains WHERE competition_id = $1 AND LOWER(team) = LOWER($2)',
        [compId, team]
      )
      if (teamConflict.rows.length) {
        await client.query('ROLLBACK')
        return res.status(409).json({ error: 'Team name already taken in this competition' })
      }

      // Validate every member: must exist, not banned, not already a captain or drafted in this comp
      const memberRows = (await client.query(
        `SELECT id, name, display_name, mmr, roles, info, is_banned
           FROM players WHERE id = ANY($1::int[])`,
        [memberIds]
      )).rows
      if (memberRows.length !== memberIds.length) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'One or more team members not found' })
      }
      const banned = memberRows.find(p => p.is_banned)
      if (banned) {
        await client.query('ROLLBACK')
        return res.status(409).json({ error: `${banned.display_name || banned.name} is banned` })
      }

      const memberCaptainConflict = await client.query(
        'SELECT player_id FROM captains WHERE competition_id = $1 AND player_id = ANY($2::int[])',
        [compId, memberIds]
      )
      if (memberCaptainConflict.rows.length) {
        const conflictId = memberCaptainConflict.rows[0].player_id
        const p = memberRows.find(r => r.id === conflictId)
        await client.query('ROLLBACK')
        return res.status(409).json({ error: `${p?.display_name || p?.name || 'Player'} is already a captain` })
      }

      const memberDraftedConflict = await client.query(
        `SELECT player_id FROM competition_players
           WHERE competition_id = $1 AND player_id = ANY($2::int[]) AND drafted_by IS NOT NULL`,
        [compId, memberIds]
      )
      if (memberDraftedConflict.rows.length) {
        const conflictId = memberDraftedConflict.rows[0].player_id
        const p = memberRows.find(r => r.id === conflictId)
        await client.query('ROLLBACK')
        return res.status(409).json({ error: `${p?.display_name || p?.name || 'Player'} is already on another team` })
      }

      // Insert/upsert captain's competition_players row (in_pool = false)
      const captainCp = await client.query(
        'SELECT id FROM competition_players WHERE competition_id = $1 AND player_id = $2',
        [compId, player.id]
      )
      if (captainCp.rows.length) {
        await client.query(
          `UPDATE competition_players
             SET in_pool = false, drafted = 0, drafted_by = NULL, draft_price = NULL, draft_round = NULL,
                 playing_role = $2
             WHERE id = $1`,
          [captainCp.rows[0].id, validatedCaptainRole]
        )
      } else {
        await client.query(
          `INSERT INTO competition_players (competition_id, player_id, roles, mmr, info, in_pool, playing_role)
           VALUES ($1, $2, $3, $4, $5, false, $6)`,
          [compId, player.id, player.roles || '[]', player.mmr || 0, player.info || '', validatedCaptainRole]
        )
      }

      // Insert captain row
      const insertedCaptain = await client.query(
        `INSERT INTO captains (competition_id, name, team, budget, status, mmr, player_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [compId, player.display_name || player.name, team, settings.startingBudget, 'Waiting', player.mmr || 0, player.id]
      )
      const captainId = insertedCaptain.rows[0].id

      // Insert/upsert each member as drafted by this captain
      for (let i = 0; i < memberIds.length; i++) {
        const memberId = memberIds[i]
        const memberRole = memberRoles[i]
        const memberRow = memberRows.find(r => r.id === memberId)
        const existingMemberCp = await client.query(
          'SELECT id FROM competition_players WHERE competition_id = $1 AND player_id = $2',
          [compId, memberId]
        )
        if (existingMemberCp.rows.length) {
          await client.query(
            `UPDATE competition_players
               SET in_pool = true, drafted = 1, drafted_by = $2, draft_price = 0, draft_round = 0,
                   playing_role = $3
               WHERE id = $1`,
            [existingMemberCp.rows[0].id, captainId, memberRole]
          )
        } else {
          await client.query(
            `INSERT INTO competition_players
               (competition_id, player_id, roles, mmr, info, in_pool, drafted, drafted_by, draft_price, draft_round, playing_role)
             VALUES ($1, $2, $3, $4, $5, true, 1, $6, 0, 0, $7)`,
            [compId, memberId, memberRow.roles || '[]', memberRow.mmr || 0, memberRow.info || '', captainId, memberRole]
          )
        }
      }

      await client.query('COMMIT')

      io.to(`comp:${compId}`).emit('captains:updated', await getCaptains(compId))
      io.to(`comp:${compId}`).emit('players:updated', await getCompPlayers(compId))
      res.status(201).json({ ok: true, captainId })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      console.error('[team-registration] error:', err)
      res.status(500).json({ error: 'Failed to register team' })
    } finally {
      client.release()
    }
  })

  return router
}
