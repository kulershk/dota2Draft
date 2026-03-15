import { Router } from 'express'
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
  const results = captains.map(c => {
    // Find the captain's own player record for roles/mmr/avatar
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
    // Sort all players (captain + drafted) by MMR descending
    const allPlayers = [captainEntry, ...draftedPlayers].sort((a, b) => (b.mmr || 0) - (a.mmr || 0))
    return {
      ...c,
      players: allPlayers,
    }
  })
  res.json(results)
})

export default router
