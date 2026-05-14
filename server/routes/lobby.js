import { Router } from 'express'
import multer from 'multer'
import sharp from 'sharp'
import { query, queryOne, execute } from '../db.js'
import { requirePermission, requireCompPermission } from '../middleware/permissions.js'
import { botPool } from '../services/botPool.js'

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true)
    else cb(new Error('Only JPEG, PNG, or WebP images are allowed'))
  },
})

export default function createLobbyRouter(io) {
  const router = Router()

  // ── Bot Management (global admin) ──

  router.get('/api/admin/bots', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      const bots = await botPool.getBotStatuses()
      res.json(bots)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.post('/api/admin/bots', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      const { username, password } = req.body
      if (!username || !password) return res.status(400).json({ error: 'Username and password required' })
      const bot = await botPool.addBot(username, password)
      res.json(bot)
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  router.post('/api/admin/bots/connect-all', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      const result = await botPool.connectAllBots()
      res.json({ ok: true, ...result })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  router.post('/api/admin/bots/disconnect-all', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      const result = await botPool.disconnectAllBots()
      res.json({ ok: true, ...result })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  router.delete('/api/admin/bots/:botId', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      await botPool.removeBot(Number(req.params.botId))
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  router.get('/api/admin/bots/:botId/logs', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      res.json(botPool.getBotLogs(Number(req.params.botId)))
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.post('/api/admin/bots/:botId/free', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      const botId = Number(req.params.botId)
      // Cancel any active lobbies for this bot
      const activeLobbies = await query(
        "SELECT id FROM match_lobbies WHERE bot_id = $1 AND status NOT IN ('completed', 'cancelled', 'error')",
        [botId]
      )
      for (const lobby of activeLobbies) {
        await botPool.cancelLobby(lobby.id)
      }
      // Force bot status to available
      await execute("UPDATE lobby_bots SET status = 'available' WHERE id = $1", [botId])
      if (io) io.to('perm:manage_bots').emit('bot:statusChanged', { botId, status: 'available' })
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  router.post('/api/admin/bots/:botId/connect', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      // Don't await - login happens in background, status updates via socket
      botPool.connectBot(Number(req.params.botId)).catch(() => {})
      res.json({ ok: true, status: 'connecting' })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  router.post('/api/admin/bots/:botId/disconnect', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      await botPool.disconnectBot(Number(req.params.botId))
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  router.post('/api/admin/bots/:botId/steam-guard', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      const { code } = req.body
      if (!code) return res.status(400).json({ error: 'Code required' })
      await botPool.submitSteamGuard(Number(req.params.botId), code)
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  router.post('/api/admin/bots/avatar', avatarUpload.single('avatar'), async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      if (!req.file) return res.status(400).json({ error: 'No image file provided' })

      // Normalize: square 512x512 JPEG so Steam never rejects it
      const jpegBuffer = await sharp(req.file.buffer)
        .resize(512, 512, { fit: 'cover', position: 'center' })
        .jpeg({ quality: 90 })
        .toBuffer()

      const results = await botPool.setAvatarForAllBots(jpegBuffer, 'image/jpeg', 'avatar.jpg')
      res.json({ results })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  router.put('/api/admin/bots/:botId/auto-connect', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      const { autoConnect } = req.body
      await execute('UPDATE lobby_bots SET auto_connect = $1 WHERE id = $2', [!!autoConnect, Number(req.params.botId)])
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  // ── Lobby Management (competition-scoped) ──

  router.post('/api/competitions/:compId/tournament/matches/:matchId/games/:gameNumber/lobby', async (req, res) => {
    try {
      const compId = Number(req.params.compId)
      const matchId = Number(req.params.matchId)
      const gameNumber = Number(req.params.gameNumber)
      if (!compId || !matchId || !gameNumber) return res.status(400).json({ error: 'Invalid IDs' })

      const admin = await requireCompPermission(req, res, compId)
      if (!admin) return

      const match = await queryOne('SELECT id FROM matches WHERE id = $1 AND competition_id = $2', [matchId, compId])
      if (!match) return res.status(404).json({ error: 'Match not found' })

      const lobby = await botPool.createLobby(compId, matchId, gameNumber, req.body || {})
      res.json(lobby)
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  router.get('/api/competitions/:compId/tournament/matches/:matchId/games/:gameNumber/lobby', async (req, res) => {
    try {
      const matchId = Number(req.params.matchId)
      const gameNumber = Number(req.params.gameNumber)

      const lobby = await queryOne(
        "SELECT * FROM match_lobbies WHERE match_id = $1 AND game_number = $2 AND status NOT IN ('cancelled') ORDER BY id DESC LIMIT 1",
        [matchId, gameNumber]
      )
      if (!lobby) return res.json({ lobby: null })
      // Auto-fix stale status: if we have a match ID, lobby is completed
      if (lobby.dota_match_id && lobby.status !== 'completed') {
        lobby.status = 'completed'
        await execute("UPDATE match_lobbies SET status = 'completed' WHERE id = $1", [lobby.id])
      }
      // Auto-fix: if bot is no longer busy and lobby is still waiting/launching, mark as error
      if ((lobby.status === 'waiting' || lobby.status === 'launching') && lobby.bot_id) {
        const bot = await queryOne('SELECT status FROM lobby_bots WHERE id = $1', [lobby.bot_id])
        if (bot && bot.status === 'available') {
          lobby.status = 'error'
          lobby.error_message = 'Bot disconnected from lobby'
          await execute("UPDATE match_lobbies SET status = 'error', error_message = 'Bot disconnected from lobby' WHERE id = $1", [lobby.id])
        }
      }
      res.json({ lobby })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.post('/api/competitions/:compId/tournament/matches/:matchId/games/:gameNumber/lobby/launch', async (req, res) => {
    try {
      const compId = Number(req.params.compId)
      const matchId = Number(req.params.matchId)
      const gameNumber = Number(req.params.gameNumber)

      const admin = await requireCompPermission(req, res, compId)
      if (!admin) return

      const lobby = await queryOne(
        "SELECT * FROM match_lobbies WHERE match_id = $1 AND game_number = $2 AND status = 'waiting'",
        [matchId, gameNumber]
      )
      if (!lobby) return res.status(404).json({ error: 'No active lobby found' })

      await botPool.forceLaunch(lobby.id, { skipValidation: true })
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  router.post('/api/competitions/:compId/tournament/matches/:matchId/games/:gameNumber/lobby/cancel', async (req, res) => {
    try {
      const compId = Number(req.params.compId)
      const matchId = Number(req.params.matchId)
      const gameNumber = Number(req.params.gameNumber)

      const admin = await requireCompPermission(req, res, compId)
      if (!admin) return

      const lobby = await queryOne(
        "SELECT * FROM match_lobbies WHERE match_id = $1 AND game_number = $2 AND status NOT IN ('completed', 'cancelled')",
        [matchId, gameNumber]
      )
      if (!lobby) return res.status(404).json({ error: 'No active lobby found' })

      await botPool.cancelLobby(lobby.id)
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  router.post('/api/competitions/:compId/tournament/matches/:matchId/games/:gameNumber/lobby/reset', async (req, res) => {
    try {
      const compId = Number(req.params.compId)
      const matchId = Number(req.params.matchId)
      const gameNumber = Number(req.params.gameNumber)

      const admin = await requireCompPermission(req, res, compId)
      if (!admin) return

      // Delete all lobbies for this game
      await execute(
        'DELETE FROM match_lobbies WHERE match_id = $1 AND game_number = $2',
        [matchId, gameNumber]
      )

      if (io) {
        io.to(`comp:${compId}`).emit('lobby:statusUpdate', {
          matchId, gameNumber, status: null,
        })
      }

      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  return router
}
