import { Router } from 'express'
import fs from 'fs'
import { join } from 'path'
import sharp from 'sharp'
import { queryOne, execute } from '../db.js'
import { getAuthPlayer } from '../middleware/auth.js'
import { requireCompPermission } from '../middleware/permissions.js'
import { upload, uploadsDir } from '../middleware/upload.js'
import { getCompetition, parseCompSettings, getCaptains, getCompPlayers } from '../helpers/competition.js'

export default function createCaptainsRouter(io) {
  const router = Router()

  router.get('/api/competitions/:compId/captains', async (req, res) => {
    res.json(await getCaptains(Number(req.params.compId)))
  })

  router.post('/api/competitions/:compId/captains/promote', async (req, res) => {
    const compId = Number(req.params.compId)
    const admin = await requireCompPermission(req, res, compId, 'manage_captains')
    if (!admin) return

    const { playerId, team } = req.body
    if (!playerId || !team) return res.status(400).json({ error: 'Player ID and team name required' })

    const player = await queryOne('SELECT * FROM players WHERE id = $1', [playerId])
    if (!player) return res.status(404).json({ error: 'Player not found' })
    if (!player.steam_id) return res.status(400).json({ error: 'Player must have a Steam account' })

    const existing = await queryOne('SELECT id FROM captains WHERE player_id = $1 AND competition_id = $2', [playerId, compId])
    if (existing) return res.status(409).json({ error: 'Player is already a captain in this competition' })

    const comp = await getCompetition(compId)
    const settings = parseCompSettings(comp)

    await queryOne(
      'INSERT INTO captains (competition_id, name, team, budget, status, mmr, player_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [compId, player.display_name || player.name, team, settings.startingBudget, 'Waiting', player.mmr, playerId]
    )

    const cp = await queryOne('SELECT id FROM competition_players WHERE competition_id = $1 AND player_id = $2', [compId, playerId])
    if (cp) {
      await execute('UPDATE competition_players SET in_pool = false WHERE id = $1', [cp.id])
    } else {
      await execute(
        `INSERT INTO competition_players (competition_id, player_id, roles, mmr, info, in_pool)
         VALUES ($1, $2, $3, $4, $5, false)`,
        [compId, playerId, player.roles || '[]', player.mmr, player.info || '']
      )
    }

    io.to(`comp:${compId}`).emit('captains:updated', await getCaptains(compId))
    io.to(`comp:${compId}`).emit('players:updated', await getCompPlayers(compId))
    res.status(201).json({ ok: true })
  })

  router.put('/api/competitions/:compId/captains/:id', async (req, res) => {
    const compId = Number(req.params.compId)
    const admin = await requireCompPermission(req, res, compId, 'manage_captains')
    if (!admin) return

    const captain = await queryOne('SELECT * FROM captains WHERE id = $1 AND competition_id = $2', [req.params.id, compId])
    if (!captain) return res.status(404).json({ error: 'Captain not found' })

    const { team, budget } = req.body
    await execute(
      'UPDATE captains SET team = $1, budget = $2 WHERE id = $3',
      [team ?? captain.team, budget ?? captain.budget, captain.id]
    )
    io.to(`comp:${compId}`).emit('captains:updated', await getCaptains(compId))
    res.json(await queryOne('SELECT * FROM captains WHERE id = $1', [captain.id]))
  })

  router.post('/api/competitions/:compId/captains/:id/banner', upload.single('banner'), async (req, res) => {
    const player = await getAuthPlayer(req)
    if (!player) return res.status(401).json({ error: 'Not authenticated' })
    const compId = Number(req.params.compId)
    const captainId = Number(req.params.id)

    const captain = await queryOne('SELECT * FROM captains WHERE id = $1 AND competition_id = $2', [captainId, compId])
    if (!captain) return res.status(404).json({ error: 'Captain not found' })

    if (captain.player_id !== player.id && !player.is_admin) {
      return res.status(403).json({ error: 'Only the team captain or an admin can upload a banner' })
    }

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })

    if (captain.banner_url) {
      const oldPath = join(uploadsDir, captain.banner_url.replace('/uploads/', ''))
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath)
    }

    // Resize to 256x256 square (crop to cover)
    const resizedFilename = `logo_${captainId}_${Date.now()}.png`
    const resizedPath = join(uploadsDir, resizedFilename)
    await sharp(req.file.path)
      .resize(256, 256, { fit: 'cover', position: 'center' })
      .png()
      .toFile(resizedPath)

    // Remove the original upload
    if (req.file.path !== resizedPath) {
      fs.unlinkSync(req.file.path)
    }

    const bannerUrl = `/uploads/${resizedFilename}`
    await execute('UPDATE captains SET banner_url = $1 WHERE id = $2', [bannerUrl, captainId])
    io.to(`comp:${compId}`).emit('captains:updated', await getCaptains(compId))
    res.json({ banner_url: bannerUrl })
  })

  router.delete('/api/competitions/:compId/captains/:id/banner', async (req, res) => {
    const player = await getAuthPlayer(req)
    if (!player) return res.status(401).json({ error: 'Not authenticated' })
    const compId = Number(req.params.compId)
    const captainId = Number(req.params.id)

    const captain = await queryOne('SELECT * FROM captains WHERE id = $1 AND competition_id = $2', [captainId, compId])
    if (!captain) return res.status(404).json({ error: 'Captain not found' })
    if (captain.player_id !== player.id && !player.is_admin) {
      return res.status(403).json({ error: 'Only the team captain or an admin can remove the banner' })
    }

    if (captain.banner_url) {
      const oldPath = join(uploadsDir, captain.banner_url.replace('/uploads/', ''))
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath)
      await execute('UPDATE captains SET banner_url = NULL WHERE id = $1', [captainId])
    }
    io.to(`comp:${compId}`).emit('captains:updated', await getCaptains(compId))
    res.json({ ok: true })
  })

  router.post('/api/competitions/:compId/captains/:id/demote', async (req, res) => {
    const compId = Number(req.params.compId)
    const admin = await requireCompPermission(req, res, compId, 'manage_captains')
    if (!admin) return

    const captain = await queryOne('SELECT player_id FROM captains WHERE id = $1 AND competition_id = $2', [req.params.id, compId])
    await execute('DELETE FROM captains WHERE id = $1', [req.params.id])

    if (captain?.player_id) {
      const cp = await queryOne('SELECT id FROM competition_players WHERE competition_id = $1 AND player_id = $2', [compId, captain.player_id])
      if (cp) {
        await execute('UPDATE competition_players SET in_pool = true WHERE id = $1', [cp.id])
      } else {
        const player = await queryOne('SELECT * FROM players WHERE id = $1', [captain.player_id])
        if (player) {
          await execute(
            `INSERT INTO competition_players (competition_id, player_id, roles, mmr, info, in_pool)
             VALUES ($1, $2, $3, $4, $5, true)`,
            [compId, captain.player_id, player.roles || '[]', player.mmr, player.info || '']
          )
        }
      }
    }

    io.to(`comp:${compId}`).emit('captains:updated', await getCaptains(compId))
    io.to(`comp:${compId}`).emit('players:updated', await getCompPlayers(compId))
    res.json({ ok: true })
  })

  return router
}
