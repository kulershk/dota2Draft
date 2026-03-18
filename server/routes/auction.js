import { Router } from 'express'
import { query } from '../db.js'
import { getCaptains, getCompPlayers, getFullAuctionState } from '../helpers/competition.js'

const router = Router()

router.get('/api/competitions/:compId/auction', async (req, res) => {
  const compId = Number(req.params.compId)
  res.json(await getFullAuctionState(compId))
})

router.get('/api/competitions/:compId/auction/results', async (req, res) => {
  const compId = Number(req.params.compId)
  const captains = await getCaptains(compId)
  const players = await getCompPlayers(compId)
  // Get game wins/losses per captain
  const gameStats = {}
  const matchGames = await query(`
    SELECT mg.winner_captain_id, m.team1_captain_id, m.team2_captain_id
    FROM match_games mg
    JOIN matches m ON m.id = mg.match_id
    WHERE m.competition_id = $1 AND mg.winner_captain_id IS NOT NULL
  `, [compId])
  for (const g of matchGames) {
    if (!gameStats[g.team1_captain_id]) gameStats[g.team1_captain_id] = { gw: 0, gl: 0 }
    if (!gameStats[g.team2_captain_id]) gameStats[g.team2_captain_id] = { gw: 0, gl: 0 }
    if (g.winner_captain_id === g.team1_captain_id) {
      gameStats[g.team1_captain_id].gw++
      gameStats[g.team2_captain_id].gl++
    } else if (g.winner_captain_id === g.team2_captain_id) {
      gameStats[g.team2_captain_id].gw++
      gameStats[g.team1_captain_id].gl++
    }
  }

  const results = captains.map(c => {
    const captainPlayer = c.player_id ? players.find(p => p.id === c.player_id) : null
    const captainEntry = {
      id: c.player_id || c.id,
      name: c.name,
      roles: captainPlayer ? (typeof captainPlayer.roles === 'string' ? JSON.parse(captainPlayer.roles) : captainPlayer.roles) : [],
      mmr: c.mmr || (captainPlayer?.mmr ?? 0),
      draft_price: 0,
      avatar_url: captainPlayer?.avatar_url || c.avatar_url || null,
      steam_id: captainPlayer?.steam_id || null,
      is_captain: true,
    }
    const draftedPlayers = players.filter(p => p.drafted && p.drafted_by === c.id).map(p => ({
      ...p,
      roles: typeof p.roles === 'string' ? JSON.parse(p.roles) : p.roles,
      is_captain: false,
    }))
    const allPlayers = [captainEntry, ...draftedPlayers].sort((a, b) => (b.mmr || 0) - (a.mmr || 0))
    const stats = gameStats[c.id] || { gw: 0, gl: 0 }
    return {
      ...c,
      players: allPlayers,
      game_wins: stats.gw,
      game_losses: stats.gl,
    }
  })
  res.json(results)
})

export default router
