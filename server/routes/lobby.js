import { Router } from 'express'
import multer from 'multer'
import sharp from 'sharp'
import { query, queryOne, execute } from '../db.js'
import { requirePermission, requireCompPermission, playerCanManageComp } from '../middleware/permissions.js'
import { getAuthPlayer } from '../middleware/auth.js'
import { botPool } from '../services/botPool.js'

// A match participant = a captain of either side, or a player drafted onto
// either side. Participants (and comp managers) may see the lobby password so
// they can join the in-game lobby; nobody else may.
export async function isMatchParticipant(playerId, matchId) {
  if (!playerId || !matchId) return false
  const row = await queryOne(
    `SELECT 1
       FROM matches m
       LEFT JOIN captains c1 ON c1.id = m.team1_captain_id
       LEFT JOIN captains c2 ON c2.id = m.team2_captain_id
      WHERE m.id = $1
        AND ( c1.player_id = $2 OR c2.player_id = $2
              OR EXISTS ( SELECT 1 FROM competition_players cp
                           WHERE cp.competition_id = m.competition_id
                             AND cp.player_id = $2
                             AND cp.drafted_by IN (m.team1_captain_id, m.team2_captain_id) )
              OR EXISTS ( SELECT 1 FROM match_standins ms
                           WHERE ms.match_id = m.id AND ms.standin_player_id = $2 ) )
      LIMIT 1`,
    [matchId, playerId],
  )
  return !!row
}

// Strip credential-ish fields from a lobby row before returning it to a client
// that isn't allowed to see the password.
function stripLobbyPassword(lobby) {
  if (!lobby) return lobby
  const { password, ...safe } = lobby
  return safe
}

// Only bot fields safe to return to an API caller — never the stored Steam
// password / refresh token / sentry / login key.
function publicBotFields(bot) {
  if (!bot) return bot
  return {
    id: bot.id,
    username: bot.username,
    display_name: bot.display_name,
    steam_id: bot.steam_id,
    status: bot.status,
    error_message: bot.error_message,
    auto_connect: bot.auto_connect,
    last_used_at: bot.last_used_at,
    created_at: bot.created_at,
  }
}

// Decides whether the GET-lobby route should auto-fix a row to 'error'
// because its bot went back to 'available' while the row still thinks it's
// waiting/launching for it. Skips lobbies with a dota_match_id set — that
// means the game already launched and players are loading in; completion
// and rollback for that state are owned by botPool._onDraftStarted /
// _onGameAborted, not this route. Pure so it's unit-testable without a DB.
export function shouldMarkBotDisconnected(lobby, botStatus) {
  if (!lobby || !lobby.bot_id) return false
  if (lobby.status !== 'waiting' && lobby.status !== 'launching') return false
  if (lobby.dota_match_id) return false
  return botStatus === 'available'
}

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
      // Reconcile the cached DB statuses against Go's LIVE state before reading,
      // so the page reflects reality instead of a possibly-stale column (e.g.
      // after a restart that reset everything to offline, or a dropped status
      // event). Best-effort: falls back to the cached values if Go is
      // unreachable or slow. `goConnected` + `syncedAt` let the UI flag whether
      // it's showing live status or last-known cache.
      const synced = await botPool._syncBotStatusesFromGo().catch(() => false)
      const bots = await botPool.getBotStatuses()
      res.json({
        bots,
        goConnected: botPool.isGoConnected(),
        syncedAt: synced ? new Date().toISOString() : null,
      })
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
      res.json(publicBotFields(bot))
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
      res.json(await botPool.getBotLogs(Number(req.params.botId)))
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.get('/api/admin/bots/:botId/status-history', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      const history = await botPool.getBotStatusHistory(Number(req.params.botId))
      res.json(history)
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

  // Auth guard runs BEFORE multer so an unauthenticated client can't make us
  // buffer a 5 MB upload into memory.
  const requireManageBots = async (req, res, next) => {
    const admin = await requirePermission(req, res, 'manage_bots')
    if (admin) next()
  }

  router.post('/api/admin/bots/avatar', requireManageBots, avatarUpload.single('avatar'), async (req, res) => {
    try {
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
      const compId = Number(req.params.compId)
      const matchId = Number(req.params.matchId)
      const gameNumber = Number(req.params.gameNumber)

      // Must be logged in. This is not admin-gated (players in the match need to
      // read the lobby to get the password), but it must never be anonymous.
      const player = await getAuthPlayer(req)
      if (!player) return res.status(401).json({ error: 'Not authenticated' })

      const lobby = await queryOne(
        "SELECT * FROM match_lobbies WHERE match_id = $1 AND game_number = $2 AND competition_id = $3 AND status NOT IN ('cancelled') ORDER BY id DESC LIMIT 1",
        [matchId, gameNumber, compId]
      )
      if (!lobby) return res.json({ lobby: null })
      // Auto-fix: if bot is no longer busy and lobby is still waiting/launching,
      // mark as error. Skips loading lobbies (dota_match_id set) — see
      // shouldMarkBotDisconnected.
      if (lobby.bot_id && (lobby.status === 'waiting' || lobby.status === 'launching')) {
        const bot = await queryOne('SELECT status FROM lobby_bots WHERE id = $1', [lobby.bot_id])
        if (shouldMarkBotDisconnected(lobby, bot?.status)) {
          lobby.status = 'error'
          lobby.error_message = 'Bot disconnected from lobby'
          await execute("UPDATE match_lobbies SET status = 'error', error_message = 'Bot disconnected from lobby' WHERE id = $1", [lobby.id])
        }
      }
      // Only match participants (and comp managers) may see the lobby password.
      const canSeePassword =
        (await isMatchParticipant(player.id, matchId)) ||
        (await playerCanManageComp(player, compId))
      res.json({ lobby: canSeePassword ? lobby : stripLobbyPassword(lobby) })
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
        "SELECT * FROM match_lobbies WHERE match_id = $1 AND game_number = $2 AND competition_id = $3 AND status = 'waiting'",
        [matchId, gameNumber, compId]
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
        "SELECT * FROM match_lobbies WHERE match_id = $1 AND game_number = $2 AND competition_id = $3 AND status NOT IN ('completed', 'cancelled')",
        [matchId, gameNumber, compId]
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

      // Cancel any still-live lobby first so the Go service destroys the in-game
      // lobby and frees the bot — otherwise a raw DELETE strands the bot 'busy'
      // with an orphaned live lobby. Scope to this competition so a manager of
      // one comp can't reset another comp's (or a queue) lobby.
      const activeLobbies = await query(
        "SELECT id FROM match_lobbies WHERE match_id = $1 AND game_number = $2 AND competition_id = $3 AND status NOT IN ('completed', 'cancelled')",
        [matchId, gameNumber, compId]
      )
      for (const l of activeLobbies) {
        await botPool.cancelLobby(l.id).catch((e) => console.error('[Lobby reset] cancel failed:', e.message))
      }

      // Clear all lobby rows for this game (scoped to the competition)
      await execute(
        'DELETE FROM match_lobbies WHERE match_id = $1 AND game_number = $2 AND competition_id = $3',
        [matchId, gameNumber, compId]
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
