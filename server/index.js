import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import db from './db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const app = express()
const server = createServer(app)
const io = new Server(server, {
  cors: { origin: ['http://localhost:5173', 'http://localhost:3000'], methods: ['GET', 'POST'] }
})

app.use(cors())
app.use(express.json())

// Serve static files in production
const staticPath = join(__dirname, '..', 'dist')
app.use(express.static(staticPath))

// ─── Helpers ──────────────────────────────────────────────

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all()
  const obj = {}
  for (const r of rows) obj[r.key] = r.value
  return {
    playersPerTeam: Number(obj.playersPerTeam) || 5,
    nominationTime: Number(obj.nominationTime) || 180,
    bidTimer: Number(obj.bidTimer) || 30,
    startingBudget: Number(obj.startingBudget) || 1000,
    minimumBid: Number(obj.minimumBid) || 10,
    bidIncrement: Number(obj.bidIncrement) || 5,
    maxBid: Number(obj.maxBid) || 0,
    nominationOrder: obj.nominationOrder || 'normal',
    requireAllOnline: obj.requireAllOnline === 'false' ? false : true,
  }
}

function getAuctionState() {
  const rows = db.prepare('SELECT key, value FROM auction_state').all()
  const obj = {}
  for (const r of rows) obj[r.key] = r.value
  return obj
}

function setAuctionState(key, value) {
  db.prepare('INSERT OR REPLACE INTO auction_state (key, value) VALUES (?, ?)').run(key, String(value))
}

function getCaptains() {
  return db.prepare('SELECT id, name, team, budget, status, mmr, is_admin FROM captains ORDER BY id').all()
}

function isAdminSocket(socketId) {
  if (adminSockets.has(socketId)) return true
  const captainId = onlineCaptains.get(socketId)
  if (!captainId) return false
  const captain = db.prepare('SELECT is_admin FROM captains WHERE id = ?').get(captainId)
  return captain?.is_admin === 1
}

function getPlayers() {
  return db.prepare('SELECT * FROM players ORDER BY id').all().map(p => ({
    ...p,
    roles: JSON.parse(p.roles),
    drafted: !!p.drafted,
  }))
}

function getBidHistory(round) {
  if (round !== undefined) {
    return db.prepare('SELECT * FROM bid_history WHERE round = ? ORDER BY id DESC').all(round)
  }
  return db.prepare('SELECT * FROM bid_history ORDER BY id DESC LIMIT 50').all()
}

function saveAuctionLog(type, message) {
  db.prepare('INSERT INTO auction_log (type, message) VALUES (?, ?)').run(type, message)
}

function getAuctionLog() {
  return db.prepare('SELECT type, message, created_at as time FROM auction_log ORDER BY id DESC LIMIT 200').all()
    .map(r => ({ type: r.type, message: r.message, time: new Date(r.time + 'Z').getTime() }))
}

// ─── REST API: Auth ───────────────────────────────────────

app.post('/api/auth/admin', (req, res) => {
  const { password } = req.body
  const row = db.prepare("SELECT value FROM settings WHERE key = 'adminPassword'").get()
  const adminPassword = row?.value || 'admin'
  if (password === adminPassword) {
    return res.json({ ok: true })
  }
  res.status(401).json({ error: 'Invalid admin password' })
})

app.post('/api/auth/token', (req, res) => {
  const { token } = req.body
  if (!token) return res.status(400).json({ error: 'Token required' })
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf-8')
    const sep = decoded.indexOf(':')
    if (sep === -1) return res.status(401).json({ error: 'Invalid token' })
    const id = Number(decoded.slice(0, sep))
    const password = decoded.slice(sep + 1)
    const captain = db.prepare('SELECT id, name, team, budget, status, mmr, is_admin FROM captains WHERE id = ? AND password = ?').get(id, password)
    if (!captain) return res.status(401).json({ error: 'Invalid token' })
    res.json(captain)
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
})

app.get('/api/captains/:id/login-token', (req, res) => {
  const captain = db.prepare('SELECT id, password FROM captains WHERE id = ?').get(req.params.id)
  if (!captain) return res.status(404).json({ error: 'Captain not found' })
  const token = Buffer.from(`${captain.id}:${captain.password}`).toString('base64')
  res.json({ token })
})

app.post('/api/auth/captain', (req, res) => {
  const { name, password } = req.body
  if (!name || !password) return res.status(400).json({ error: 'Name and password required' })
  const captain = db.prepare('SELECT id, name, team, budget, status, mmr, is_admin FROM captains WHERE name = ? AND password = ?').get(name, password)
  if (!captain) return res.status(401).json({ error: 'Invalid captain name or password' })
  res.json(captain)
})

// ─── REST API: Settings ───────────────────────────────────

app.get('/api/settings', (req, res) => {
  res.json(getSettings())
})

app.put('/api/settings', (req, res) => {
  const update = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
  for (const [key, value] of Object.entries(req.body)) {
    update.run(key, String(value))
  }
  const settings = getSettings()
  io.emit('settings:updated', settings)
  res.json(settings)
})

// ─── REST API: Captains ───────────────────────────────────

app.get('/api/captains', (req, res) => {
  res.json(getCaptains())
})

app.post('/api/captains', (req, res) => {
  const { name, team, budget, password, mmr, is_admin } = req.body
  if (!name || !team) return res.status(400).json({ error: 'Name and team required' })
  const settings = getSettings()
  const result = db.prepare('INSERT INTO captains (name, team, budget, status, password, mmr, is_admin) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(name, team, budget || settings.startingBudget, 'Waiting', password || '', mmr || 0, is_admin ? 1 : 0)
  const captain = db.prepare('SELECT id, name, team, budget, status, mmr, is_admin FROM captains WHERE id = ?').get(result.lastInsertRowid)
  io.emit('captains:updated', getCaptains())
  res.status(201).json(captain)
})

app.put('/api/captains/:id', (req, res) => {
  const { name, team, budget, status, password, mmr, is_admin } = req.body
  const captain = db.prepare('SELECT * FROM captains WHERE id = ?').get(req.params.id)
  if (!captain) return res.status(404).json({ error: 'Captain not found' })
  db.prepare('UPDATE captains SET name = ?, team = ?, budget = ?, status = ?, password = ?, mmr = ?, is_admin = ? WHERE id = ?')
    .run(name ?? captain.name, team ?? captain.team, budget ?? captain.budget, status ?? captain.status, password ?? captain.password, mmr ?? captain.mmr, is_admin !== undefined ? (is_admin ? 1 : 0) : captain.is_admin, req.params.id)
  io.emit('captains:updated', getCaptains())
  res.json(db.prepare('SELECT id, name, team, budget, status, mmr, is_admin FROM captains WHERE id = ?').get(req.params.id))
})

app.delete('/api/captains/:id', (req, res) => {
  db.prepare('DELETE FROM captains WHERE id = ?').run(req.params.id)
  io.emit('captains:updated', getCaptains())
  res.json({ ok: true })
})

// ─── REST API: Players ────────────────────────────────────

app.get('/api/players', (req, res) => {
  res.json(getPlayers())
})

app.post('/api/players', (req, res) => {
  const { name, roles, mmr, info } = req.body
  if (!name) return res.status(400).json({ error: 'Name is required' })
  const result = db.prepare('INSERT INTO players (name, roles, mmr, info) VALUES (?, ?, ?, ?)')
    .run(name, JSON.stringify(roles), mmr || 0, info || '')
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(result.lastInsertRowid)
  io.emit('players:updated', getPlayers())
  res.status(201).json({ ...player, roles: JSON.parse(player.roles), drafted: false })
})

app.put('/api/players/:id', (req, res) => {
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id)
  if (!player) return res.status(404).json({ error: 'Player not found' })
  const { name, roles, mmr, info } = req.body
  db.prepare('UPDATE players SET name = ?, roles = ?, mmr = ?, info = ? WHERE id = ?')
    .run(name ?? player.name, roles ? JSON.stringify(roles) : player.roles, mmr ?? player.mmr, info ?? player.info, req.params.id)
  io.emit('players:updated', getPlayers())
  res.json({ ...db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id), roles: JSON.parse(roles ? JSON.stringify(roles) : player.roles) })
})

app.delete('/api/players/:id', (req, res) => {
  db.prepare('DELETE FROM players WHERE id = ?').run(req.params.id)
  io.emit('players:updated', getPlayers())
  res.json({ ok: true })
})

// ─── REST API: Auction State ──────────────────────────────

app.get('/api/auction', (req, res) => {
  const state = getAuctionState()
  const settings = getSettings()
  const nominatedPlayer = state.nominatedPlayerId
    ? db.prepare('SELECT * FROM players WHERE id = ?').get(state.nominatedPlayerId)
    : null
  const nominator = state.nominatorId
    ? db.prepare('SELECT id, name, team FROM captains WHERE id = ?').get(state.nominatorId)
    : null
  const currentBidder = state.currentBidderId
    ? db.prepare('SELECT id, name, team FROM captains WHERE id = ?').get(state.currentBidderId)
    : null
  const history = state.currentRound !== '0' ? getBidHistory(Number(state.currentRound)) : []

  res.json({
    status: state.status,
    currentRound: Number(state.currentRound),
    totalRounds: Number(state.totalRounds),
    nominator,
    nominatedPlayer: nominatedPlayer ? { ...nominatedPlayer, roles: JSON.parse(nominatedPlayer.roles), drafted: !!nominatedPlayer.drafted } : null,
    currentBid: Number(state.currentBid),
    currentBidder,
    bidTimerEnd: Number(state.bidTimerEnd),
    bidHistory: history,
    settings,
    captains: getCaptains(),
    players: getPlayers(),
  })
})

app.get('/api/auction/results', (req, res) => {
  const captains = getCaptains()
  const players = getPlayers()
  const results = captains.map(c => ({
    ...c,
    players: players.filter(p => p.drafted && p.drafted_by === c.id).map(p => ({
      ...p, roles: typeof p.roles === 'string' ? JSON.parse(p.roles) : p.roles
    })),
  }))
  res.json(results)
})

// ─── Socket.io: Auction Logic ─────────────────────────────

// Track online captains: socketId -> captainId (authenticated)
const onlineCaptains = new Map()
// Track admin sockets
const adminSockets = new Set()
// Track ready captains: Set of captainIds
const readyCaptains = new Set()

function getOnlineCaptainIds() {
  return [...new Set(onlineCaptains.values())]
}

function getReadyCaptainIds() {
  return [...readyCaptains]
}

function getCaptainPlayerCount(captainId) {
  return db.prepare('SELECT COUNT(*) as count FROM players WHERE drafted = 1 AND drafted_by = ?').get(captainId).count
}

function getCaptainAvgMmr(captain) {
  const players = db.prepare('SELECT mmr FROM players WHERE drafted = 1 AND drafted_by = ?').all(captain.id)
  const totalMmr = captain.mmr + players.reduce((s, p) => s + p.mmr, 0)
  return totalMmr / (1 + players.length)
}

function getNextNominator(round, captains, settings) {
  const active = captains.filter(c => getCaptainPlayerCount(c.id) < settings.playersPerTeam)
  if (active.length === 0) return captains[0]

  if (settings.nominationOrder === 'lowest_avg') {
    return active.reduce((lowest, c) => getCaptainAvgMmr(c) < getCaptainAvgMmr(lowest) ? c : lowest, active[0])
  }

  if (settings.nominationOrder === 'fewest_then_lowest') {
    let best = active[0]
    let bestCount = getCaptainPlayerCount(best.id)
    let bestAvg = getCaptainAvgMmr(best)
    for (let i = 1; i < active.length; i++) {
      const c = active[i]
      const count = getCaptainPlayerCount(c.id)
      const avg = getCaptainAvgMmr(c)
      if (count < bestCount || (count === bestCount && avg < bestAvg)) {
        best = c
        bestCount = count
        bestAvg = avg
      }
    }
    return best
  }

  // Normal: round-robin, skip full teams
  const nominatorIndex = (round - 1) % captains.length
  for (let i = 0; i < captains.length; i++) {
    const candidate = captains[(nominatorIndex + i) % captains.length]
    if (getCaptainPlayerCount(candidate.id) < settings.playersPerTeam) {
      return candidate
    }
  }
  return captains[nominatorIndex]
}

let bidTimer = null
let lastBidTime = 0
const BID_COOLDOWN_MS = 300

function clearBidTimer() {
  if (bidTimer) {
    clearTimeout(bidTimer)
    bidTimer = null
  }
}

function startBidTimer() {
  clearBidTimer()
  const settings = getSettings()
  const endTime = Date.now() + settings.bidTimer * 1000
  setAuctionState('bidTimerEnd', endTime)
  io.emit('auction:timerUpdate', { bidTimerEnd: endTime })

  bidTimer = setTimeout(() => {
    finalizeBid()
  }, settings.bidTimer * 1000)
}

function finalizeBid() {
  clearBidTimer()
  const state = getAuctionState()
  const playerId = Number(state.nominatedPlayerId)
  const bidderId = Number(state.currentBidderId)
  const bidAmount = Number(state.currentBid)

  if (playerId && bidderId && bidAmount >= 0) {
    // Mark player as drafted
    const draftRound = Number(state.currentRound)
    db.prepare('UPDATE players SET drafted = 1, drafted_by = ?, draft_price = ?, draft_round = ? WHERE id = ?')
      .run(bidderId, bidAmount, draftRound, playerId)
    // Deduct budget
    db.prepare('UPDATE captains SET budget = budget - ? WHERE id = ?')
      .run(bidAmount, bidderId)

    const winner = db.prepare('SELECT name FROM captains WHERE id = ?').get(bidderId)
    const player = db.prepare('SELECT name FROM players WHERE id = ?').get(playerId)

    io.emit('auction:sold', {
      playerName: player.name,
      captainName: winner.name,
      amount: bidAmount,
    })
    saveAuctionLog('sold', `${player.name} sold to ${winner.name} for ${bidAmount}g`)
    io.emit('auction:log', { type: 'sold', message: `${player.name} sold to ${winner.name} for ${bidAmount}g` })
  }

  // Move to next nomination or end
  const currentRound = Number(state.currentRound)
  const totalRounds = Number(state.totalRounds)
  const captains = getCaptains()
  const settings = getSettings()
  const totalPlayers = settings.playersPerTeam * captains.length

  const draftedCount = db.prepare('SELECT COUNT(*) as count FROM players WHERE drafted = 1').get().count

  if (draftedCount >= totalPlayers || currentRound >= totalRounds) {
    // End draft
    setAuctionState('status', 'finished')
    setAuctionState('nominatedPlayerId', '')
    setAuctionState('currentBid', '0')
    setAuctionState('currentBidderId', '')
    saveAuctionLog('end', 'Draft complete! All players drafted.')
    io.emit('auction:log', { type: 'end', message: 'Draft complete! All players drafted.' })
    io.emit('auction:finished', { results: 'Draft complete!' })
    io.emit('auction:stateChanged', getFullAuctionState())
  } else {
    // Next round: pick next nominator
    const nextRound = currentRound + 1
    const nextNominator = getNextNominator(nextRound, captains, settings)

    setAuctionState('status', 'nominating')
    setAuctionState('currentRound', nextRound)
    setAuctionState('nominatorId', nextNominator.id)
    setAuctionState('nominatedPlayerId', '')
    setAuctionState('currentBid', '0')
    setAuctionState('currentBidderId', '')
    setAuctionState('bidTimerEnd', '0')

    io.emit('auction:stateChanged', getFullAuctionState())
  }
}

function getFullAuctionState() {
  const state = getAuctionState()
  const nominatedPlayer = state.nominatedPlayerId
    ? db.prepare('SELECT * FROM players WHERE id = ?').get(state.nominatedPlayerId)
    : null
  const nominator = state.nominatorId
    ? db.prepare('SELECT id, name, team FROM captains WHERE id = ?').get(state.nominatorId)
    : null
  const currentBidder = state.currentBidderId
    ? db.prepare('SELECT id, name, team FROM captains WHERE id = ?').get(state.currentBidderId)
    : null
  const history = state.currentRound !== '0' ? getBidHistory(Number(state.currentRound)) : []

  return {
    status: state.status,
    currentRound: Number(state.currentRound),
    totalRounds: Number(state.totalRounds),
    nominator,
    nominatedPlayer: nominatedPlayer ? { ...nominatedPlayer, roles: JSON.parse(nominatedPlayer.roles), drafted: !!nominatedPlayer.drafted } : null,
    currentBid: Number(state.currentBid),
    currentBidder,
    bidTimerEnd: Number(state.bidTimerEnd),
    bidHistory: history,
    captains: getCaptains(),
    players: getPlayers(),
  }
}

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`)

  // Send current state on connect
  socket.emit('server:time', Date.now())
  socket.emit('auction:stateChanged', getFullAuctionState())
  socket.emit('captains:online', getOnlineCaptainIds())
  socket.emit('captains:ready', getReadyCaptainIds())
  socket.emit('auction:logHistory', getAuctionLog())

  // Time sync
  socket.on('server:ping', () => {
    socket.emit('server:time', Date.now())
  })

  // Authenticate as admin via socket
  socket.on('auth:admin', (password) => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'adminPassword'").get()
    const adminPassword = row?.value || 'admin'
    if (password === adminPassword) {
      adminSockets.add(socket.id)
      socket.emit('auth:ok', { role: 'admin' })
    } else {
      socket.emit('auction:error', { message: 'Invalid admin password' })
    }
  })

  // Captain identifies themselves (with password verification)
  socket.on('captain:login', ({ captainId, password }) => {
    // Support legacy format (just captainId number) for backwards compat during transition
    const id = Number(captainId)
    if (password) {
      const captain = db.prepare('SELECT id FROM captains WHERE id = ? AND password = ?').get(id, password)
      if (!captain) {
        socket.emit('auction:error', { message: 'Invalid captain credentials' })
        return
      }
    } else {
      // If no password, check if captain exists at minimum
      const captain = db.prepare('SELECT id FROM captains WHERE id = ?').get(id)
      if (!captain) {
        socket.emit('auction:error', { message: 'Captain not found' })
        return
      }
    }
    onlineCaptains.set(socket.id, id)
    io.emit('captains:online', getOnlineCaptainIds())
  })

  socket.on('captain:logout', () => {
    const captainId = onlineCaptains.get(socket.id)
    onlineCaptains.delete(socket.id)
    adminSockets.delete(socket.id)
    if (captainId) {
      readyCaptains.delete(captainId)
      io.emit('captains:ready', getReadyCaptainIds())
    }
    io.emit('captains:online', getOnlineCaptainIds())
  })

  socket.on('captain:ready', (captainId) => {
    // Only allow if this socket owns this captainId
    if (onlineCaptains.get(socket.id) !== captainId) {
      socket.emit('auction:error', { message: 'Not authorized' })
      return
    }
    readyCaptains.add(captainId)
    io.emit('captains:ready', getReadyCaptainIds())
  })

  socket.on('captain:unready', (captainId) => {
    if (onlineCaptains.get(socket.id) !== captainId) {
      socket.emit('auction:error', { message: 'Not authorized' })
      return
    }
    readyCaptains.delete(captainId)
    io.emit('captains:ready', getReadyCaptainIds())
  })

  // Start draft (admin only)
  socket.on('auction:start', () => {
    if (!isAdminSocket(socket.id)) {
      socket.emit('auction:error', { message: 'Admin access required' })
      return
    }
    const captains = getCaptains()
    if (captains.length < 2) {
      socket.emit('auction:error', { message: 'Need at least 2 captains' })
      return
    }

    const settings = getSettings()

    if (settings.requireAllOnline) {
      const allReady = captains.every(c => readyCaptains.has(c.id))
      if (!allReady) {
        socket.emit('auction:error', { message: 'All captains must be ready before starting' })
        return
      }
    }
    const totalRounds = settings.playersPerTeam * captains.length

    // Set captains status to Ready (keep their current budgets)
    db.prepare('UPDATE captains SET status = ?').run('Ready')
    // Reset drafted players
    db.prepare('UPDATE players SET drafted = 0, drafted_by = NULL, draft_price = NULL, draft_round = NULL').run()
    // Clear bid history and auction log
    db.prepare('DELETE FROM bid_history').run()
    db.prepare('DELETE FROM auction_log').run()

    setAuctionState('status', 'nominating')
    setAuctionState('currentRound', '1')
    setAuctionState('totalRounds', String(totalRounds))
    const firstNominator = getNextNominator(1, getCaptains(), settings)
    setAuctionState('nominatorId', String(firstNominator.id))
    setAuctionState('nominatedPlayerId', '')
    setAuctionState('currentBid', '0')
    setAuctionState('currentBidderId', '')
    setAuctionState('bidTimerEnd', '0')

    readyCaptains.clear()
    io.emit('captains:ready', getReadyCaptainIds())
    saveAuctionLog('start', `Draft started with ${captains.length} captains`)
    io.emit('auction:log', { type: 'start', message: `Draft started with ${captains.length} captains` })
    io.emit('auction:started')
    io.emit('auction:stateChanged', getFullAuctionState())
    io.emit('captains:updated', getCaptains())
    io.emit('players:updated', getPlayers())
  })

  // Nominate a player (must be the nominator or admin)
  socket.on('auction:nominate', ({ playerId, startingBid }) => {
    const socketCaptainId = onlineCaptains.get(socket.id)
    const isAdmin = isAdminSocket(socket.id)
    const currentState = getAuctionState()
    if (!isAdmin && socketCaptainId !== Number(currentState.nominatorId)) {
      socket.emit('auction:error', { message: 'Not your turn to nominate' })
      return
    }
    const state = getAuctionState()
    if (state.status !== 'nominating') {
      socket.emit('auction:error', { message: 'Not in nomination phase' })
      return
    }

    const onlineIds = getOnlineCaptainIds()
    const allCaptains = getCaptains()
    const settings = getSettings()
    const activeCaptains = allCaptains.filter(c => getCaptainPlayerCount(c.id) < settings.playersPerTeam)
    if (settings.requireAllOnline) {
      const allOnline = activeCaptains.every(c => onlineIds.includes(c.id))
      if (!allOnline) {
        const offlineNames = activeCaptains.filter(c => !onlineIds.includes(c.id)).map(c => c.name)
        socket.emit('auction:error', { message: `Waiting for: ${offlineNames.join(', ')}` })
        return
      }
    }

    const player = db.prepare('SELECT * FROM players WHERE id = ? AND drafted = 0').get(playerId)
    if (!player) {
      socket.emit('auction:error', { message: 'Player not available' })
      return
    }

    const nominator = db.prepare('SELECT * FROM captains WHERE id = ?').get(state.nominatorId)
    const bid = nominator && nominator.budget === 0 ? 0 : Math.max(settings.minimumBid, Number(startingBid) || settings.minimumBid)

    // Check nominator can afford the starting bid
    if (nominator && bid > nominator.budget) {
      socket.emit('auction:error', { message: `Starting bid ${bid}g exceeds your budget of ${nominator.budget}g` })
      return
    }

    // Check nominator team is not full
    if (nominator && getCaptainPlayerCount(nominator.id) >= settings.playersPerTeam) {
      socket.emit('auction:error', { message: 'Your team is already full' })
      return
    }

    setAuctionState('status', 'bidding')
    setAuctionState('nominatedPlayerId', String(playerId))
    setAuctionState('currentBid', String(bid))
    setAuctionState('currentBidderId', state.nominatorId)

    // Record initial bid
    db.prepare('INSERT INTO bid_history (round, player_id, captain_id, captain_name, amount) VALUES (?, ?, ?, ?, ?)')
      .run(Number(state.currentRound), playerId, Number(state.nominatorId),
        db.prepare('SELECT name FROM captains WHERE id = ?').get(state.nominatorId).name,
        bid)

    const nominatorName = db.prepare('SELECT name FROM captains WHERE id = ?').get(state.nominatorId)?.name
    saveAuctionLog('nomination', `${nominatorName} nominated ${player.name} for ${bid}g`)
    io.emit('auction:log', { type: 'nomination', message: `${nominatorName} nominated ${player.name} for ${bid}g` })
    startBidTimer()
    io.emit('auction:stateChanged', getFullAuctionState())
  })

  // Place a bid (must be authenticated as this captain)
  socket.on('auction:bid', ({ captainId, amount }) => {
    const socketCaptainId = onlineCaptains.get(socket.id)
    if (socketCaptainId !== captainId) {
      socket.emit('auction:error', { message: 'Not authorized to bid as this captain' })
      return
    }

    const now = Date.now()
    if (now - lastBidTime < BID_COOLDOWN_MS) {
      socket.emit('auction:error', { message: 'Too fast! Wait a moment before bidding.' })
      return
    }

    const state = getAuctionState()
    if (state.status !== 'bidding') {
      socket.emit('auction:error', { message: 'Not in bidding phase' })
      return
    }

    const captain = db.prepare('SELECT * FROM captains WHERE id = ?').get(captainId)
    if (!captain) {
      socket.emit('auction:error', { message: 'Captain not found' })
      return
    }

    const settings = getSettings()
    if (getCaptainPlayerCount(captainId) >= settings.playersPerTeam) {
      socket.emit('auction:error', { message: 'Your team is already full' })
      return
    }

    const currentBid = Number(state.currentBid)

    if (amount <= currentBid) {
      socket.emit('auction:error', { message: `Bid must be higher than ${currentBid}g` })
      return
    }

    if (amount - currentBid < settings.bidIncrement) {
      socket.emit('auction:error', { message: `Minimum increment is ${settings.bidIncrement}g` })
      return
    }

    if (amount > captain.budget) {
      socket.emit('auction:error', { message: 'Insufficient budget' })
      return
    }

    if (settings.maxBid > 0 && amount > settings.maxBid) {
      socket.emit('auction:error', { message: `Max bid is ${settings.maxBid}g` })
      return
    }

    setAuctionState('currentBid', String(amount))
    setAuctionState('currentBidderId', String(captainId))
    lastBidTime = Date.now()

    db.prepare('INSERT INTO bid_history (round, player_id, captain_id, captain_name, amount) VALUES (?, ?, ?, ?, ?)')
      .run(Number(state.currentRound), Number(state.nominatedPlayerId), captainId, captain.name, amount)

    const bidPlayer = db.prepare('SELECT name FROM players WHERE id = ?').get(state.nominatedPlayerId)
    saveAuctionLog('bid', `${captain.name} bid ${amount}g on ${bidPlayer?.name}`)
    io.emit('auction:log', { type: 'bid', message: `${captain.name} bid ${amount}g on ${bidPlayer?.name}` })

    // Reset timer
    startBidTimer()
    io.emit('auction:stateChanged', getFullAuctionState())
  })

  // Pause auction (admin only)
  socket.on('auction:pause', () => {
    if (!isAdminSocket(socket.id)) {
      socket.emit('auction:error', { message: 'Admin access required' })
      return
    }
    clearBidTimer()
    setAuctionState('bidTimerEnd', '0')
    setAuctionState('status', 'paused')
    saveAuctionLog('pause', 'Auction paused by admin')
    io.emit('auction:log', { type: 'pause', message: 'Auction paused by admin' })
    io.emit('auction:stateChanged', getFullAuctionState())
  })

  // Resume auction (admin only)
  socket.on('auction:resume', () => {
    if (!isAdminSocket(socket.id)) {
      socket.emit('auction:error', { message: 'Admin access required' })
      return
    }
    const state = getAuctionState()
    if (state.nominatedPlayerId) {
      setAuctionState('status', 'bidding')
      startBidTimer()
    } else {
      setAuctionState('status', 'nominating')
    }
    saveAuctionLog('resume', 'Auction resumed by admin')
    io.emit('auction:log', { type: 'resume', message: 'Auction resumed by admin' })
    io.emit('auction:stateChanged', getFullAuctionState())
  })

  // End draft early (admin only)
  socket.on('auction:end', () => {
    if (!isAdminSocket(socket.id)) {
      socket.emit('auction:error', { message: 'Admin access required' })
      return
    }
    clearBidTimer()
    setAuctionState('status', 'finished')
    setAuctionState('nominatedPlayerId', '')
    setAuctionState('currentBid', '0')
    setAuctionState('currentBidderId', '')
    saveAuctionLog('end', 'Draft ended by admin')
    io.emit('auction:log', { type: 'end', message: 'Draft ended by admin' })
    io.emit('auction:finished', { results: 'Draft ended by admin' })
    io.emit('auction:stateChanged', getFullAuctionState())
  })

  // Undo last action (admin only)
  socket.on('auction:undo', () => {
    if (!isAdminSocket(socket.id)) {
      socket.emit('auction:error', { message: 'Admin access required' })
      return
    }
    const state = getAuctionState()

    // Case 1: Currently in bidding or paused with a nomination — undo the current nomination, go back to nominating
    if (state.status === 'bidding' || (state.status === 'paused' && state.nominatedPlayerId)) {
      clearBidTimer()
      const nominatedPlayer = db.prepare('SELECT name FROM players WHERE id = ?').get(state.nominatedPlayerId)
      // Remove bid history for this round
      db.prepare('DELETE FROM bid_history WHERE round = ?').run(Number(state.currentRound))
      setAuctionState('status', 'nominating')
      setAuctionState('nominatedPlayerId', '')
      setAuctionState('currentBid', '0')
      setAuctionState('currentBidderId', '')
      setAuctionState('bidTimerEnd', '0')
      io.emit('auction:undone', { message: `Nomination of ${nominatedPlayer?.name || 'player'} was cancelled` })
      saveAuctionLog('undo', `Undo: nomination of ${nominatedPlayer?.name || 'player'} cancelled`)
      io.emit('auction:log', { type: 'undo', message: `Undo: nomination of ${nominatedPlayer?.name || 'player'} cancelled` })
      io.emit('auction:stateChanged', getFullAuctionState())
      return
    }

    // Case 2: In nominating phase, paused without nomination, or finished — undo the last sold player
    if (state.status === 'nominating' || state.status === 'finished' || state.status === 'paused') {
      const currentRound = Number(state.currentRound)
      const prevRound = state.status === 'finished' ? currentRound : currentRound - 1
      if (prevRound < 1) {
        socket.emit('auction:error', { message: 'Nothing to undo' })
        return
      }

      // Find the last drafted player by looking at bid history for prev round
      const lastBid = db.prepare('SELECT * FROM bid_history WHERE round = ? ORDER BY id DESC LIMIT 1').get(prevRound)
      if (!lastBid) {
        socket.emit('auction:error', { message: 'Nothing to undo' })
        return
      }

      const player = db.prepare('SELECT * FROM players WHERE id = ?').get(lastBid.player_id)
      if (!player || !player.drafted) {
        socket.emit('auction:error', { message: 'Nothing to undo' })
        return
      }

      const buyer = db.prepare('SELECT name FROM captains WHERE id = ?').get(player.drafted_by)
      const undoMsg = `${player.name} (${player.draft_price}g from ${buyer?.name || 'unknown'}) was reversed`
      // Refund the captain
      db.prepare('UPDATE captains SET budget = budget + ? WHERE id = ?').run(player.draft_price, player.drafted_by)
      // Undraft the player
      db.prepare('UPDATE players SET drafted = 0, drafted_by = NULL, draft_price = NULL, draft_round = NULL WHERE id = ?').run(player.id)
      // Remove bid history for that round
      db.prepare('DELETE FROM bid_history WHERE round = ?').run(prevRound)

      // Go back to nominating for that round
      const captains = getCaptains()
      const settings = getSettings()
      const nextNominator = getNextNominator(prevRound, captains, settings)

      setAuctionState('status', 'nominating')
      setAuctionState('currentRound', String(prevRound))
      setAuctionState('nominatorId', String(nextNominator.id))
      setAuctionState('nominatedPlayerId', '')
      setAuctionState('currentBid', '0')
      setAuctionState('currentBidderId', '')
      setAuctionState('bidTimerEnd', '0')

      io.emit('auction:undone', { message: undoMsg })
      saveAuctionLog('undo', `Undo: ${undoMsg}`)
      io.emit('auction:log', { type: 'undo', message: `Undo: ${undoMsg}` })
      io.emit('auction:stateChanged', getFullAuctionState())
      io.emit('captains:updated', getCaptains())
      io.emit('players:updated', getPlayers())
      return
    }

    socket.emit('auction:error', { message: 'Nothing to undo' })
  })

  // Reset draft (admin only)
  socket.on('auction:reset', () => {
    if (!isAdminSocket(socket.id)) {
      socket.emit('auction:error', { message: 'Admin access required' })
      return
    }
    clearBidTimer()
    readyCaptains.clear()
    const settings = getSettings()
    db.prepare('UPDATE captains SET budget = ?, status = ?').run(settings.startingBudget, 'Waiting')
    db.prepare('UPDATE players SET drafted = 0, drafted_by = NULL, draft_price = NULL, draft_round = NULL').run()
    db.prepare('DELETE FROM bid_history').run()
    db.prepare('DELETE FROM auction_log').run()
    setAuctionState('status', 'idle')
    setAuctionState('currentRound', '0')
    setAuctionState('nominatorId', '')
    setAuctionState('nominatedPlayerId', '')
    setAuctionState('currentBid', '0')
    setAuctionState('currentBidderId', '')
    setAuctionState('bidTimerEnd', '0')
    io.emit('captains:ready', getReadyCaptainIds())
    io.emit('auction:stateChanged', getFullAuctionState())
    io.emit('captains:updated', getCaptains())
    io.emit('players:updated', getPlayers())
  })

  socket.on('disconnect', () => {
    const captainId = onlineCaptains.get(socket.id)
    onlineCaptains.delete(socket.id)
    adminSockets.delete(socket.id)
    if (captainId) {
      readyCaptains.delete(captainId)
      io.emit('captains:ready', getReadyCaptainIds())
    }
    io.emit('captains:online', getOnlineCaptainIds())
    console.log(`Client disconnected: ${socket.id}`)
  })
})

// SPA fallback - serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(join(staticPath, 'index.html'))
})

const PORT = process.env.PORT || 3001
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})
