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
  const results = captains.map(c => ({
    ...c,
    players: players.filter(p => p.drafted && p.drafted_by === c.id).map(p => ({
      ...p, roles: typeof p.roles === 'string' ? JSON.parse(p.roles) : p.roles
    })),
  }))
  res.json(results)
})

export default router
