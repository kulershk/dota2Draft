import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import { io as ioClient } from 'socket.io-client'
import { initDb, query, queryOne, execute } from '../server/db.js'
import { initSocket } from '../server/socket/index.js'
import { createSession } from '../server/middleware/auth.js'

// Routes
import authRoutes from '../server/routes/auth.js'
import competitionRoutes from '../server/routes/competitions.js'
import createPlayersRouter from '../server/routes/players.js'
import createCaptainsRouter from '../server/routes/captains.js'
import auctionRoutes from '../server/routes/auction.js'
import permissionRoutes from '../server/routes/permissions.js'
import settingRoutes from '../server/routes/settings.js'
import userRoutes from '../server/routes/users.js'
import createNewsRouter from '../server/routes/news.js'

let app, server, io, baseUrl

export async function startServer() {
  app = express()
  app.set('trust proxy', true)
  server = createServer(app)
  io = new Server(server, { cors: { origin: '*' } })
  app.set('io', io)
  app.use(express.json())

  app.use(authRoutes)
  app.use(competitionRoutes)
  app.use(createPlayersRouter(io))
  app.use(createCaptainsRouter(io))
  app.use(auctionRoutes)
  app.use(permissionRoutes)
  app.use(settingRoutes)
  app.use(userRoutes)
  app.use(createNewsRouter(io))

  initSocket(io)

  await initDb()

  return new Promise((resolve) => {
    server.listen(0, () => {
      const port = server.address().port
      baseUrl = `http://localhost:${port}`
      resolve({ app, server, io, baseUrl, port })
    })
  })
}

export async function stopServer() {
  if (io) io.close()
  if (server) await new Promise(r => server.close(r))
}

export async function createTestPlayer(name, opts = {}) {
  const steamId = opts.steamId || `test_${Date.now()}_${Math.random().toString(36).slice(2)}`
  const player = await queryOne(
    'INSERT INTO players (name, steam_id, mmr, roles, is_admin) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [name, steamId, opts.mmr || 3000, JSON.stringify(opts.roles || ['Mid']), opts.isAdmin || false]
  )
  const token = createSession(player.id)
  return { player, token }
}

export async function createTestCompetition(token, name = 'Test Competition') {
  const res = await fetch(`${baseUrl}/api/competitions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, settings: { requireAllOnline: false, bidTimer: 5 } }),
  })
  return res.json()
}

export function connectSocket(port, token) {
  return ioClient(`http://localhost:${port}`, {
    auth: { token },
    transports: ['websocket'],
    forceNew: true,
  })
}

export function waitForEvent(socket, event, timeout = 5000, filter) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeout)
    function handler(data) {
      if (filter && !filter(data)) return // keep listening
      socket.off(event, handler)
      clearTimeout(timer)
      resolve(data)
    }
    socket.on(event, handler)
  })
}

export async function api(method, path, token, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (token) opts.headers.Authorization = `Bearer ${token}`
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(`${baseUrl}${path}`, opts)
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}

export async function cleanupDb() {
  await execute('DELETE FROM bid_history')
  await execute('DELETE FROM auction_log')
  await execute('DELETE FROM competition_players')
  await execute('DELETE FROM captains')
  await execute('DELETE FROM competitions')
  await execute('DELETE FROM player_permission_groups')
  await execute('DELETE FROM permission_groups')
  await execute('DELETE FROM players')
}

export { query, queryOne, execute }
