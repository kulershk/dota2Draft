import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import { WebSocketServer } from 'ws'
import cors from 'cors'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { readFileSync } from 'fs'
import { initDb } from './db.js'
import { uploadsDir } from './middleware/upload.js'
import swaggerUi from 'swagger-ui-express'

// Routes
import authRoutes from './routes/auth.js'
import competitionRoutes from './routes/competitions.js'
import createPlayersRouter from './routes/players.js'
import createCaptainsRouter from './routes/captains.js'
import auctionRoutes from './routes/auction.js'
import createTournamentRouter from './routes/tournament.js'
import createFantasyRouter from './routes/fantasy.js'
import createLobbyRouter from './routes/lobby.js'
import { botPool } from './services/botPool.js'
import dotaRoutes from './routes/dota.js'
import streamRoutes from './routes/streams.js'
import permissionRoutes from './routes/permissions.js'
import settingRoutes from './routes/settings.js'
import userRoutes from './routes/users.js'
import createNewsRouter from './routes/news.js'
import templateRoutes from './routes/templates.js'
import createQueueRouter from './routes/queue.js'
import createSeasonsRouter from './routes/seasons.js'
import jobRoutes from './routes/jobs.js'
import { startJobWorker, registerHandler, registerSchedule, enqueueJob } from './services/jobs.js'
import { fetchSteamMatchDetails } from './helpers/steam.js'
import { fetchOpenDotaMatch, saveMatchGameStats, requestOpenDotaParse } from './helpers/opendota.js'
import { queryOne } from './db.js'

// Socket
import { initSocket } from './socket/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const app = express()
app.set('trust proxy', true)
const server = createServer(app)
const io = new Server(server, {
  cors: { origin: ['http://localhost:5173', 'http://localhost:3000'], methods: ['GET', 'POST'] }
})

// Make io accessible from route handlers via req.app.get('io')
app.set('io', io)

app.use(cors())
app.use(express.json())

// Static files
// Hashed assets under /assets/* are immutable, so we can cache them aggressively.
// index.html (and the dir root) must always re-validate so users pick up the new
// build immediately after a deploy — otherwise they'd keep loading an old
// index.html that points at chunk filenames that no longer exist.
const staticPath = join(__dirname, '..', 'dist')
app.use(express.static(staticPath, {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    } else if (filePath.includes(`${join('dist', 'assets')}`) || /[\\/]assets[\\/]/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    }
  },
}))
app.use('/uploads', express.static(uploadsDir))

// App version — written by deploy workflow into server/.version. Changes every deploy.
const APP_VERSION = (() => {
  try { return readFileSync(join(__dirname, '.version'), 'utf-8').trim() } catch { return 'dev' }
})()
app.get('/api/version', (req, res) => res.json({ version: APP_VERSION }))

// API Docs
const openApiSpec = JSON.parse(readFileSync(join(__dirname, 'docs', 'openapi.json'), 'utf-8'))
app.get('/api/docs/openapi.json', (req, res) => res.json(openApiSpec))
app.get('/api/docs/asyncapi.json', (req, res) => {
  try {
    const spec = JSON.parse(readFileSync(join(__dirname, 'docs', 'asyncapi.json'), 'utf-8'))
    res.json(spec)
  } catch (e) {
    res.status(500).json({ error: 'Failed to load AsyncAPI spec' })
  }
})
app.get('/api/docs/socket', (req, res) => res.sendFile(join(__dirname, 'docs', 'asyncapi.html')))
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, { customSiteTitle: 'Dota 2 Draft — REST API Docs' }))

// Mount routes
app.use(authRoutes)
app.use(competitionRoutes)
app.use(createPlayersRouter(io))
app.use(createCaptainsRouter(io))
app.use(auctionRoutes)
app.use(createTournamentRouter(io))
app.use(createFantasyRouter(io))
app.use(createLobbyRouter(io))
app.use(dotaRoutes)
app.use(streamRoutes)
app.use(permissionRoutes)
app.use(settingRoutes)
app.use(userRoutes)
app.use(createNewsRouter(io))
app.use(templateRoutes)
app.use(createQueueRouter(io))
app.use(createSeasonsRouter(io))
app.use(jobRoutes)

// Socket.io
initSocket(io)

// SPA fallback
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.sendFile(join(staticPath, 'index.html'))
})

// Initialize DB and start server
const PORT = process.env.PORT || 3001
// WebSocket server for Go lobby bot service
const botWss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  if (url.pathname === '/ws/lobbybot') {
    const token = url.searchParams.get('token')
    const expected = process.env.BOT_SERVICE_TOKEN
    if (expected && token !== expected) {
      socket.destroy()
      return
    }
    botWss.handleUpgrade(req, socket, head, (ws) => {
      botWss.emit('connection', ws, req)
    })
  }
  // Let Socket.io handle its own upgrades (don't destroy)
})

initDb().then(async () => {
  await botPool.init(io, botWss)

  // Register recurring background jobs. Handlers are thin wrappers around
  // botPool methods so the logic stays in one place.
  registerHandler('poll_opendota_results', async () => {
    await botPool._pollUnresolvedGames()
    return { ok: true }
  })
  registerHandler('cleanup_stuck_queue_matches', async () => {
    await botPool._cleanupStuckQueueMatches()
    return { ok: true }
  })
  registerHandler('cleanup_stuck_creating_lobbies', async () => {
    await botPool._cleanupStuckCreatingLobbies()
    return { ok: true }
  })
  registerSchedule('poll_opendota_results', { everyMs: 60_000 })
  registerSchedule('cleanup_stuck_queue_matches', { everyMs: 5 * 60_000 })
  registerSchedule('cleanup_stuck_creating_lobbies', { everyMs: 60_000 })

  registerHandler('cleanup_zombie_lobbies', async () => {
    await botPool._cleanupZombieLobbies()
    return { ok: true }
  })
  registerSchedule('cleanup_zombie_lobbies', { everyMs: 5 * 60_000 })

  // ── Per-game stat fetching with tiered polling ──
  // Phase 1 (fetch_match_stats): GC every 60s until winner resolved
  // Phase 2 (enrich_match_stats): OpenDota every 10min for 2h, then every 1h for 3 days
  registerHandler('fetch_match_stats', async (payload) => {
    const { matchGameId, dotabuffId, matchId, gameNumber } = payload
    if (!matchGameId || !dotabuffId) throw new Error('Missing matchGameId or dotabuffId')

    const game = await queryOne(
      'SELECT id, winner_captain_id, parsed FROM match_games WHERE id = $1',
      [matchGameId]
    )
    if (!game) throw new Error(`match_games #${matchGameId} not found`)
    if (game.winner_captain_id) {
      // Winner already resolved (maybe by manual entry) — skip to enrichment
      if (!game.parsed) {
        await enqueueJob({ type: 'enrich_match_stats', payload: { matchGameId, dotabuffId, startedAt: Date.now() }, maxAttempts: 999 })
      }
      return { status: 'already_resolved', winner: true, parsed: !!game.parsed }
    }

    const result = { dotabuffId, gc: null, steam: null, winner: false }

    // Try GC first (works for practice lobbies, instant)
    try {
      const gcData = await botPool.requestMatchDetailsFromGC(dotabuffId)
      if (gcData && gcData.radiant_win != null) {
        const normalised = {
          radiant_win: gcData.radiant_win,
          duration: gcData.duration || 0,
          start_time: gcData.start_time || null,
          game_mode: gcData.game_mode,
          players: gcData.players || [],
          _source: 'gc',
        }
        await saveMatchGameStats(matchGameId, normalised)
        await botPool._autoFillGameWinner(matchId, gameNumber, gcData.radiant_win, normalised)
        result.gc = { players: gcData.players?.length || 0, radiantWin: gcData.radiant_win, duration: gcData.duration }
        result.winner = true
      } else {
        result.gc = { error: 'GC returned no match data (game likely still in progress)' }
      }
    } catch (e) {
      result.gc = { error: e.message }
    }

    // Steam Web API fallback
    if (!result.winner) {
      const steamData = await fetchSteamMatchDetails(dotabuffId)
      if (steamData && steamData.radiant_win != null) {
        await saveMatchGameStats(matchGameId, steamData)
        await botPool._autoFillGameWinner(matchId, gameNumber, steamData.radiant_win, steamData)
        result.steam = { players: steamData.players?.length || 0, radiantWin: steamData.radiant_win, duration: steamData.duration }
        result.winner = true
      } else {
        result.steam = { error: 'Not available on Steam API' }
      }
    }

    // Winner resolved → enqueue enrichment job, complete this one
    if (result.winner) {
      requestOpenDotaParse(dotabuffId).catch(() => {})
      await enqueueJob({ type: 'enrich_match_stats', payload: { matchGameId, dotabuffId, startedAt: Date.now() }, maxAttempts: 999 })
      return result
    }

    // Not resolved yet → schedule next GC poll in 60s
    await enqueueJob({
      type: 'fetch_match_stats',
      payload,
      maxAttempts: 999,
      runAt: new Date(Date.now() + 60_000),
    })
    // Complete this job (not fail) — the next poll is a new job
    return { ...result, status: 'game_in_progress_requeued_60s' }
  })

  // Phase 2+3: OpenDota enrichment with tiered polling
  // First 2h: every 10min. After 2h: every 1h. Give up after 3 days.
  registerHandler('enrich_match_stats', async (payload) => {
    const { matchGameId, dotabuffId, startedAt } = payload
    if (!matchGameId || !dotabuffId) throw new Error('Missing matchGameId or dotabuffId')

    const game = await queryOne('SELECT parsed FROM match_games WHERE id = $1', [matchGameId])
    if (!game) throw new Error(`match_games #${matchGameId} not found`)
    if (game.parsed) return { status: 'already_parsed' }

    const elapsed = Date.now() - (startedAt || Date.now())
    const THREE_DAYS = 3 * 24 * 60 * 60 * 1000
    const TWO_HOURS = 2 * 60 * 60 * 1000

    if (elapsed > THREE_DAYS) {
      return { status: 'gave_up_after_3_days', elapsed: Math.round(elapsed / 60000) + 'min' }
    }

    const odData = await fetchOpenDotaMatch(dotabuffId)
    if (odData) {
      const saveResult = await saveMatchGameStats(matchGameId, odData)
      if (saveResult.parsed) {
        return { status: 'parsed', players: saveResult.saved }
      }
    }

    // Request parse and schedule next check
    requestOpenDotaParse(dotabuffId).catch(() => {})
    const nextDelay = elapsed < TWO_HOURS ? 10 * 60_000 : 60 * 60_000
    const tier = elapsed < TWO_HOURS ? 'every 10min (first 2h)' : 'every 1h (after 2h)'

    await enqueueJob({
      type: 'enrich_match_stats',
      payload: { matchGameId, dotabuffId, startedAt: startedAt || Date.now() },
      maxAttempts: 999,
      runAt: new Date(Date.now() + nextDelay),
    })

    return { status: 'not_parsed_yet', tier, nextIn: Math.round(nextDelay / 60000) + 'min', odAvailable: !!odData }
  })

  await startJobWorker()
  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`)
  })
})
