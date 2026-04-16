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
import jobRoutes from './routes/jobs.js'
import { startJobWorker, registerHandler, registerSchedule } from './services/jobs.js'

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

  await startJobWorker()
  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`)
  })
})
