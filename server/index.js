import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { initDb } from './db.js'
import { uploadsDir } from './middleware/upload.js'

// Routes
import authRoutes from './routes/auth.js'
import competitionRoutes from './routes/competitions.js'
import createPlayersRouter from './routes/players.js'
import createCaptainsRouter from './routes/captains.js'
import auctionRoutes from './routes/auction.js'
import createTournamentRouter from './routes/tournament.js'
import streamRoutes from './routes/streams.js'
import permissionRoutes from './routes/permissions.js'
import settingRoutes from './routes/settings.js'
import userRoutes from './routes/users.js'
import createNewsRouter from './routes/news.js'

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
const staticPath = join(__dirname, '..', 'dist')
app.use(express.static(staticPath))
app.use('/uploads', express.static(uploadsDir))

// Mount routes
app.use(authRoutes)
app.use(competitionRoutes)
app.use(createPlayersRouter(io))
app.use(createCaptainsRouter(io))
app.use(auctionRoutes)
app.use(createTournamentRouter(io))
app.use(streamRoutes)
app.use(permissionRoutes)
app.use(settingRoutes)
app.use(userRoutes)
app.use(createNewsRouter(io))

// Socket.io
initSocket(io)

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(join(staticPath, 'index.html'))
})

// Initialize DB and start server
const PORT = process.env.PORT || 3001
initDb().then(() => {
  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`)
  })
})
