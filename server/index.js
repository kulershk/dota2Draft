import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import pool, { query, queryOne, execute, initDb } from './db.js'

// Temporary store for verified Steam registrations (token -> steam data)
const steamPendingRegistrations = new Map()
const STEAM_TOKEN_TTL = 5 * 60 * 1000 // 5 minutes

// Base URL for redirects (frontend origin)
const BASE_URL = process.env.BASE_URL || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5173')

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

async function getSettings() {
  const rows = await query('SELECT key, value FROM settings')
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
    allowSteamRegistration: obj.allowSteamRegistration === 'true' ? true : false,
  }
}

async function getAuctionState() {
  const rows = await query('SELECT key, value FROM auction_state')
  const obj = {}
  for (const r of rows) obj[r.key] = r.value
  return obj
}

async function setAuctionState(key, value) {
  await execute(
    'INSERT INTO auction_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, String(value)]
  )
}

async function getCaptains() {
  return await query('SELECT id, name, team, budget, status, mmr, is_admin FROM captains ORDER BY id')
}

async function isAdminSocket(socketId) {
  if (adminSockets.has(socketId)) return true
  const captainId = onlineCaptains.get(socketId)
  if (!captainId) return false
  const captain = await queryOne('SELECT is_admin FROM captains WHERE id = $1', [captainId])
  return captain?.is_admin === 1
}

async function getPlayers() {
  const rows = await query('SELECT * FROM players ORDER BY id')
  return rows.map(p => ({
    ...p,
    roles: JSON.parse(p.roles),
    drafted: !!p.drafted,
    steam_id: p.steam_id || null,
    avatar_url: p.avatar_url || null,
  }))
}

async function getBidHistory(round) {
  if (round !== undefined) {
    return await query('SELECT * FROM bid_history WHERE round = $1 ORDER BY id DESC', [round])
  }
  return await query('SELECT * FROM bid_history ORDER BY id DESC LIMIT 50')
}

async function saveAuctionLog(type, message) {
  await execute('INSERT INTO auction_log (type, message) VALUES ($1, $2)', [type, message])
}

async function getAuctionLog() {
  const rows = await query('SELECT type, message, created_at as time FROM auction_log ORDER BY id DESC LIMIT 200')
  return rows.map(r => ({ type: r.type, message: r.message, time: new Date(r.time).getTime() }))
}

async function getCaptainPlayerCount(captainId) {
  const row = await queryOne('SELECT COUNT(*) as count FROM players WHERE drafted = 1 AND drafted_by = $1', [captainId])
  return parseInt(row.count)
}

async function getCaptainAvgMmr(captain) {
  const players = await query('SELECT mmr FROM players WHERE drafted = 1 AND drafted_by = $1', [captain.id])
  const totalMmr = captain.mmr + players.reduce((s, p) => s + p.mmr, 0)
  return totalMmr / (1 + players.length)
}

async function getNextNominator(round, captains, settings) {
  const active = []
  for (const c of captains) {
    if (await getCaptainPlayerCount(c.id) < settings.playersPerTeam) {
      active.push(c)
    }
  }
  if (active.length === 0) return captains[0]

  if (settings.nominationOrder === 'lowest_avg') {
    let lowest = active[0]
    let lowestAvg = await getCaptainAvgMmr(lowest)
    for (let i = 1; i < active.length; i++) {
      const avg = await getCaptainAvgMmr(active[i])
      if (avg < lowestAvg) {
        lowest = active[i]
        lowestAvg = avg
      }
    }
    return lowest
  }

  if (settings.nominationOrder === 'fewest_then_lowest') {
    let best = active[0]
    let bestCount = await getCaptainPlayerCount(best.id)
    let bestAvg = await getCaptainAvgMmr(best)
    for (let i = 1; i < active.length; i++) {
      const c = active[i]
      const count = await getCaptainPlayerCount(c.id)
      const avg = await getCaptainAvgMmr(c)
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
    if (active.some(a => a.id === candidate.id)) {
      return candidate
    }
  }
  return captains[nominatorIndex]
}

// ─── REST API: Auth ───────────────────────────────────────

app.post('/api/auth/admin', async (req, res) => {
  const { password } = req.body
  const row = await queryOne("SELECT value FROM settings WHERE key = 'adminPassword'")
  const adminPassword = row?.value || 'admin'
  if (password === adminPassword) {
    return res.json({ ok: true })
  }
  res.status(401).json({ error: 'Invalid admin password' })
})

app.post('/api/auth/token', async (req, res) => {
  const { token } = req.body
  if (!token) return res.status(400).json({ error: 'Token required' })
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf-8')
    const sep = decoded.indexOf(':')
    if (sep === -1) return res.status(401).json({ error: 'Invalid token' })
    const id = Number(decoded.slice(0, sep))
    const password = decoded.slice(sep + 1)
    const captain = await queryOne(
      'SELECT id, name, team, budget, status, mmr, is_admin FROM captains WHERE id = $1 AND password = $2',
      [id, password]
    )
    if (!captain) return res.status(401).json({ error: 'Invalid token' })
    res.json(captain)
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
})

app.get('/api/captains/:id/login-token', async (req, res) => {
  const captain = await queryOne('SELECT id, password FROM captains WHERE id = $1', [req.params.id])
  if (!captain) return res.status(404).json({ error: 'Captain not found' })
  const token = Buffer.from(`${captain.id}:${captain.password}`).toString('base64')
  res.json({ token })
})

app.post('/api/auth/captain', async (req, res) => {
  const { name, password } = req.body
  if (!name || !password) return res.status(400).json({ error: 'Name and password required' })
  const captain = await queryOne(
    'SELECT id, name, team, budget, status, mmr, is_admin FROM captains WHERE name = $1 AND password = $2',
    [name, password]
  )
  if (!captain) return res.status(401).json({ error: 'Invalid captain name or password' })
  res.json(captain)
})

// ─── REST API: Steam Auth ────────────────────────────────

app.get('/api/auth/steam', (req, res) => {
  const serverOrigin = `${req.protocol}://${req.get('host')}`
  const returnUrl = `${serverOrigin}/api/auth/steam/callback`
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnUrl,
    'openid.realm': serverOrigin,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  })
  res.redirect(`https://steamcommunity.com/openid/login?${params}`)
})

app.get('/api/auth/steam/callback', async (req, res) => {
  try {
    // Verify the OpenID response with Steam
    const params = new URLSearchParams(req.query)
    params.set('openid.mode', 'check_authentication')
    const verifyRes = await fetch('https://steamcommunity.com/openid/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
    const verifyBody = await verifyRes.text()
    if (!verifyBody.includes('is_valid:true')) {
      return res.redirect(`${BASE_URL}/players?steam_error=validation_failed`)
    }

    // Extract Steam ID from claimed_id
    const claimedId = req.query['openid.claimed_id']
    const steamIdMatch = claimedId?.match(/\/openid\/id\/(\d+)$/)
    if (!steamIdMatch) {
      return res.redirect(`${BASE_URL}/players?steam_error=invalid_id`)
    }
    const steamId = steamIdMatch[1]

    // Check if already registered
    const existing = await queryOne('SELECT id FROM players WHERE steam_id = $1', [steamId])
    if (existing) {
      return res.redirect(`${BASE_URL}/players?steam_error=already_registered`)
    }

    // Fetch Steam profile
    let personaName = `Steam_${steamId.slice(-6)}`
    let avatarUrl = ''
    const steamApiKey = process.env.STEAM_API_KEY
    if (steamApiKey) {
      try {
        const profileRes = await fetch(
          `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${steamApiKey}&steamids=${steamId}`
        )
        const profileData = await profileRes.json()
        const player = profileData?.response?.players?.[0]
        if (player) {
          personaName = player.personaname || personaName
          avatarUrl = player.avatarfull || player.avatarmedium || player.avatar || ''
        }
      } catch (e) {
        console.error('Failed to fetch Steam profile:', e.message)
      }
    }

    // Generate temp token and store verified steam data
    const token = crypto.randomBytes(32).toString('hex')
    steamPendingRegistrations.set(token, {
      steamId,
      name: personaName,
      avatarUrl,
      createdAt: Date.now(),
    })
    // Clean up expired tokens
    for (const [k, v] of steamPendingRegistrations) {
      if (Date.now() - v.createdAt > STEAM_TOKEN_TTL) steamPendingRegistrations.delete(k)
    }

    res.redirect(`${BASE_URL}/players?steamToken=${token}`)
  } catch (e) {
    console.error('Steam callback error:', e)
    res.redirect(`${BASE_URL}/players?steam_error=server_error`)
  }
})

app.get('/api/auth/steam/profile', (req, res) => {
  const { token } = req.query
  const data = steamPendingRegistrations.get(token)
  if (!data || Date.now() - data.createdAt > STEAM_TOKEN_TTL) {
    return res.status(400).json({ error: 'Invalid or expired token' })
  }
  res.json({ steamId: data.steamId, name: data.name, avatarUrl: data.avatarUrl })
})

app.post('/api/players/register', async (req, res) => {
  const { token, roles, mmr, info } = req.body
  const data = steamPendingRegistrations.get(token)
  if (!data || Date.now() - data.createdAt > STEAM_TOKEN_TTL) {
    return res.status(400).json({ error: 'Invalid or expired registration token' })
  }

  // Check settings
  const settings = await getSettings()
  if (!settings.allowSteamRegistration) {
    return res.status(403).json({ error: 'Steam registration is disabled' })
  }

  // Check duplicate
  const existing = await queryOne('SELECT id FROM players WHERE steam_id = $1', [data.steamId])
  if (existing) {
    steamPendingRegistrations.delete(token)
    return res.status(409).json({ error: 'You are already registered' })
  }

  const result = await queryOne(
    'INSERT INTO players (name, roles, mmr, info, steam_id, avatar_url) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [data.name, JSON.stringify(roles || []), mmr || 0, info || '', data.steamId, data.avatarUrl]
  )
  steamPendingRegistrations.delete(token)

  io.emit('players:updated', await getPlayers())
  res.status(201).json({ id: result.id, name: data.name })
})

// ─── REST API: Settings ───────────────────────────────────

app.get('/api/settings', async (req, res) => {
  res.json(await getSettings())
})

app.put('/api/settings', async (req, res) => {
  for (const [key, value] of Object.entries(req.body)) {
    await execute(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [key, String(value)]
    )
  }
  const settings = await getSettings()
  io.emit('settings:updated', settings)
  res.json(settings)
})

// ─── REST API: Captains ───────────────────────────────────

app.get('/api/captains', async (req, res) => {
  res.json(await getCaptains())
})

app.post('/api/captains', async (req, res) => {
  const { name, team, budget, password, mmr, is_admin } = req.body
  if (!name || !team) return res.status(400).json({ error: 'Name and team required' })
  const settings = await getSettings()
  const result = await queryOne(
    'INSERT INTO captains (name, team, budget, status, password, mmr, is_admin) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [name, team, budget || settings.startingBudget, 'Waiting', password || '', mmr || 0, is_admin ? 1 : 0]
  )
  const captain = await queryOne(
    'SELECT id, name, team, budget, status, mmr, is_admin FROM captains WHERE id = $1',
    [result.id]
  )
  io.emit('captains:updated', await getCaptains())
  res.status(201).json(captain)
})

app.put('/api/captains/:id', async (req, res) => {
  const { name, team, budget, status, password, mmr, is_admin } = req.body
  const captain = await queryOne('SELECT * FROM captains WHERE id = $1', [req.params.id])
  if (!captain) return res.status(404).json({ error: 'Captain not found' })
  await execute(
    'UPDATE captains SET name = $1, team = $2, budget = $3, status = $4, password = $5, mmr = $6, is_admin = $7 WHERE id = $8',
    [
      name ?? captain.name, team ?? captain.team, budget ?? captain.budget,
      status ?? captain.status, password ?? captain.password, mmr ?? captain.mmr,
      is_admin !== undefined ? (is_admin ? 1 : 0) : captain.is_admin,
      req.params.id
    ]
  )
  io.emit('captains:updated', await getCaptains())
  res.json(await queryOne('SELECT id, name, team, budget, status, mmr, is_admin FROM captains WHERE id = $1', [req.params.id]))
})

app.delete('/api/captains/:id', async (req, res) => {
  await execute('DELETE FROM captains WHERE id = $1', [req.params.id])
  io.emit('captains:updated', await getCaptains())
  res.json({ ok: true })
})

// ─── REST API: Players ────────────────────────────────────

app.get('/api/players', async (req, res) => {
  res.json(await getPlayers())
})

app.post('/api/players', async (req, res) => {
  const { name, roles, mmr, info } = req.body
  if (!name) return res.status(400).json({ error: 'Name is required' })
  const result = await queryOne(
    'INSERT INTO players (name, roles, mmr, info) VALUES ($1, $2, $3, $4) RETURNING id',
    [name, JSON.stringify(roles), mmr || 0, info || '']
  )
  const player = await queryOne('SELECT * FROM players WHERE id = $1', [result.id])
  io.emit('players:updated', await getPlayers())
  res.status(201).json({ ...player, roles: JSON.parse(player.roles), drafted: false })
})

app.put('/api/players/:id', async (req, res) => {
  const player = await queryOne('SELECT * FROM players WHERE id = $1', [req.params.id])
  if (!player) return res.status(404).json({ error: 'Player not found' })
  const { name, roles, mmr, info } = req.body
  await execute(
    'UPDATE players SET name = $1, roles = $2, mmr = $3, info = $4 WHERE id = $5',
    [name ?? player.name, roles ? JSON.stringify(roles) : player.roles, mmr ?? player.mmr, info ?? player.info, req.params.id]
  )
  io.emit('players:updated', await getPlayers())
  const updated = await queryOne('SELECT * FROM players WHERE id = $1', [req.params.id])
  res.json({ ...updated, roles: JSON.parse(roles ? JSON.stringify(roles) : player.roles) })
})

app.delete('/api/players/:id', async (req, res) => {
  await execute('DELETE FROM players WHERE id = $1', [req.params.id])
  io.emit('players:updated', await getPlayers())
  res.json({ ok: true })
})

// ─── REST API: News ───────────────────────────────────────

app.get('/api/news', async (req, res) => {
  const news = await query('SELECT * FROM news ORDER BY created_at DESC')
  res.json(news)
})

app.post('/api/news', async (req, res) => {
  const { title, content } = req.body
  if (!title || !content) return res.status(400).json({ error: 'Title and content required' })
  const result = await queryOne(
    'INSERT INTO news (title, content) VALUES ($1, $2) RETURNING id',
    [title, content]
  )
  const post = await queryOne('SELECT * FROM news WHERE id = $1', [result.id])
  io.emit('news:updated')
  res.status(201).json(post)
})

app.put('/api/news/:id', async (req, res) => {
  const post = await queryOne('SELECT * FROM news WHERE id = $1', [req.params.id])
  if (!post) return res.status(404).json({ error: 'Post not found' })
  const { title, content } = req.body
  await execute(
    'UPDATE news SET title = $1, content = $2 WHERE id = $3',
    [title ?? post.title, content ?? post.content, req.params.id]
  )
  io.emit('news:updated')
  res.json(await queryOne('SELECT * FROM news WHERE id = $1', [req.params.id]))
})

app.delete('/api/news/:id', async (req, res) => {
  await execute('DELETE FROM news WHERE id = $1', [req.params.id])
  io.emit('news:updated')
  res.json({ ok: true })
})

// ─── REST API: Auction State ──────────────────────────────

app.get('/api/auction', async (req, res) => {
  const state = await getAuctionState()
  const settings = await getSettings()
  const nominatedPlayer = state.nominatedPlayerId
    ? await queryOne('SELECT * FROM players WHERE id = $1', [state.nominatedPlayerId])
    : null
  const nominator = state.nominatorId
    ? await queryOne('SELECT id, name, team FROM captains WHERE id = $1', [state.nominatorId])
    : null
  const currentBidder = state.currentBidderId
    ? await queryOne('SELECT id, name, team FROM captains WHERE id = $1', [state.currentBidderId])
    : null
  const history = state.currentRound !== '0' ? await getBidHistory(Number(state.currentRound)) : []

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
    captains: await getCaptains(),
    players: await getPlayers(),
  })
})

app.get('/api/auction/results', async (req, res) => {
  const captains = await getCaptains()
  const players = await getPlayers()
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

let bidTimer = null
let lastBidTime = 0
const BID_COOLDOWN_MS = 300

function clearBidTimer() {
  if (bidTimer) {
    clearTimeout(bidTimer)
    bidTimer = null
  }
}

async function startBidTimer() {
  clearBidTimer()
  const settings = await getSettings()
  const endTime = Date.now() + settings.bidTimer * 1000
  await setAuctionState('bidTimerEnd', endTime)
  io.emit('auction:timerUpdate', { bidTimerEnd: endTime })

  bidTimer = setTimeout(() => {
    finalizeBid()
  }, settings.bidTimer * 1000)
}

async function finalizeBid() {
  clearBidTimer()
  const state = await getAuctionState()
  const playerId = Number(state.nominatedPlayerId)
  const bidderId = Number(state.currentBidderId)
  const bidAmount = Number(state.currentBid)

  if (playerId && bidderId && bidAmount >= 0) {
    const draftRound = Number(state.currentRound)
    await execute(
      'UPDATE players SET drafted = 1, drafted_by = $1, draft_price = $2, draft_round = $3 WHERE id = $4',
      [bidderId, bidAmount, draftRound, playerId]
    )
    await execute('UPDATE captains SET budget = budget - $1 WHERE id = $2', [bidAmount, bidderId])

    const winner = await queryOne('SELECT name FROM captains WHERE id = $1', [bidderId])
    const player = await queryOne('SELECT name FROM players WHERE id = $1', [playerId])

    io.emit('auction:sold', {
      playerName: player.name,
      captainName: winner.name,
      amount: bidAmount,
    })
    await saveAuctionLog('sold', `${player.name} sold to ${winner.name} for ${bidAmount}g`)
    io.emit('auction:log', { type: 'sold', message: `${player.name} sold to ${winner.name} for ${bidAmount}g` })
  }

  const currentRound = Number(state.currentRound)
  const totalRounds = Number(state.totalRounds)
  const captains = await getCaptains()
  const settings = await getSettings()
  const totalPlayers = settings.playersPerTeam * captains.length

  const draftedRow = await queryOne('SELECT COUNT(*) as count FROM players WHERE drafted = 1')
  const draftedCount = parseInt(draftedRow.count)

  if (draftedCount >= totalPlayers || currentRound >= totalRounds) {
    await setAuctionState('status', 'finished')
    await setAuctionState('nominatedPlayerId', '')
    await setAuctionState('currentBid', '0')
    await setAuctionState('currentBidderId', '')
    await saveAuctionLog('end', 'Draft complete! All players drafted.')
    io.emit('auction:log', { type: 'end', message: 'Draft complete! All players drafted.' })
    io.emit('auction:finished', { results: 'Draft complete!' })
    io.emit('auction:stateChanged', await getFullAuctionState())
  } else {
    const nextRound = currentRound + 1
    const nextNominator = await getNextNominator(nextRound, captains, settings)

    await setAuctionState('status', 'nominating')
    await setAuctionState('currentRound', nextRound)
    await setAuctionState('nominatorId', nextNominator.id)
    await setAuctionState('nominatedPlayerId', '')
    await setAuctionState('currentBid', '0')
    await setAuctionState('currentBidderId', '')
    await setAuctionState('bidTimerEnd', '0')

    io.emit('auction:stateChanged', await getFullAuctionState())
  }
}

async function getFullAuctionState() {
  const state = await getAuctionState()
  const nominatedPlayer = state.nominatedPlayerId
    ? await queryOne('SELECT * FROM players WHERE id = $1', [state.nominatedPlayerId])
    : null
  const nominator = state.nominatorId
    ? await queryOne('SELECT id, name, team FROM captains WHERE id = $1', [state.nominatorId])
    : null
  const currentBidder = state.currentBidderId
    ? await queryOne('SELECT id, name, team FROM captains WHERE id = $1', [state.currentBidderId])
    : null
  const history = state.currentRound !== '0' ? await getBidHistory(Number(state.currentRound)) : []

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
    captains: await getCaptains(),
    players: await getPlayers(),
  }
}

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`)

  // Send current state on connect
  ;(async () => {
    socket.emit('server:time', Date.now())
    socket.emit('auction:stateChanged', await getFullAuctionState())
    socket.emit('captains:online', getOnlineCaptainIds())
    socket.emit('captains:ready', getReadyCaptainIds())
    socket.emit('auction:logHistory', await getAuctionLog())
  })()

  // Time sync
  socket.on('server:ping', () => {
    socket.emit('server:time', Date.now())
  })

  // Authenticate as admin via socket
  socket.on('auth:admin', async (password) => {
    const row = await queryOne("SELECT value FROM settings WHERE key = 'adminPassword'")
    const adminPassword = row?.value || 'admin'
    if (password === adminPassword) {
      adminSockets.add(socket.id)
      socket.emit('auth:ok', { role: 'admin' })
    } else {
      socket.emit('auction:error', { message: 'Invalid admin password' })
    }
  })

  // Captain identifies themselves (with password verification)
  socket.on('captain:login', async ({ captainId, password }) => {
    const id = Number(captainId)
    if (password) {
      const captain = await queryOne('SELECT id FROM captains WHERE id = $1 AND password = $2', [id, password])
      if (!captain) {
        socket.emit('auction:error', { message: 'Invalid captain credentials' })
        return
      }
    } else {
      const captain = await queryOne('SELECT id FROM captains WHERE id = $1', [id])
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
  socket.on('auction:start', async () => {
    if (!await isAdminSocket(socket.id)) {
      socket.emit('auction:error', { message: 'Admin access required' })
      return
    }
    const captains = await getCaptains()
    if (captains.length < 2) {
      socket.emit('auction:error', { message: 'Need at least 2 captains' })
      return
    }

    const settings = await getSettings()

    if (settings.requireAllOnline) {
      const allReady = captains.every(c => readyCaptains.has(c.id))
      if (!allReady) {
        socket.emit('auction:error', { message: 'All captains must be ready before starting' })
        return
      }
    }
    const totalRounds = settings.playersPerTeam * captains.length

    await execute('UPDATE captains SET status = $1', ['Ready'])
    await execute('UPDATE players SET drafted = 0, drafted_by = NULL, draft_price = NULL, draft_round = NULL')
    // Clear bid history and auction log
    await execute('DELETE FROM bid_history')
    await execute('DELETE FROM auction_log')

    await setAuctionState('status', 'nominating')
    await setAuctionState('currentRound', '1')
    await setAuctionState('totalRounds', String(totalRounds))
    const firstNominator = await getNextNominator(1, await getCaptains(), settings)
    await setAuctionState('nominatorId', String(firstNominator.id))
    await setAuctionState('nominatedPlayerId', '')
    await setAuctionState('currentBid', '0')
    await setAuctionState('currentBidderId', '')
    await setAuctionState('bidTimerEnd', '0')

    readyCaptains.clear()
    io.emit('captains:ready', getReadyCaptainIds())
    await saveAuctionLog('start', `Draft started with ${captains.length} captains`)
    io.emit('auction:log', { type: 'start', message: `Draft started with ${captains.length} captains` })
    io.emit('auction:started')
    io.emit('auction:stateChanged', await getFullAuctionState())
    io.emit('captains:updated', await getCaptains())
    io.emit('players:updated', await getPlayers())
  })

  // Nominate a player
  socket.on('auction:nominate', async ({ playerId, startingBid }) => {
    const socketCaptainId = onlineCaptains.get(socket.id)
    const isAdmin = await isAdminSocket(socket.id)
    const currentState = await getAuctionState()
    if (!isAdmin && socketCaptainId !== Number(currentState.nominatorId)) {
      socket.emit('auction:error', { message: 'Not your turn to nominate' })
      return
    }
    const state = await getAuctionState()
    if (state.status !== 'nominating') {
      socket.emit('auction:error', { message: 'Not in nomination phase' })
      return
    }

    const onlineIds = getOnlineCaptainIds()
    const allCaptains = await getCaptains()
    const settings = await getSettings()
    const activeCaptains = []
    for (const c of allCaptains) {
      if (await getCaptainPlayerCount(c.id) < settings.playersPerTeam) activeCaptains.push(c)
    }
    if (settings.requireAllOnline) {
      const allOnline = activeCaptains.every(c => onlineIds.includes(c.id))
      if (!allOnline) {
        const offlineNames = activeCaptains.filter(c => !onlineIds.includes(c.id)).map(c => c.name)
        socket.emit('auction:error', { message: `Waiting for: ${offlineNames.join(', ')}` })
        return
      }
    }

    const player = await queryOne('SELECT * FROM players WHERE id = $1 AND drafted = 0', [playerId])
    if (!player) {
      socket.emit('auction:error', { message: 'Player not available' })
      return
    }

    const nominator = await queryOne('SELECT * FROM captains WHERE id = $1', [state.nominatorId])
    const bid = nominator && nominator.budget === 0 ? 0 : Math.max(settings.minimumBid, Number(startingBid) || settings.minimumBid)

    if (nominator && bid > nominator.budget) {
      socket.emit('auction:error', { message: `Starting bid ${bid}g exceeds your budget of ${nominator.budget}g` })
      return
    }

    if (nominator && await getCaptainPlayerCount(nominator.id) >= settings.playersPerTeam) {
      socket.emit('auction:error', { message: 'Your team is already full' })
      return
    }

    await setAuctionState('status', 'bidding')
    await setAuctionState('nominatedPlayerId', String(playerId))
    await setAuctionState('currentBid', String(bid))
    await setAuctionState('currentBidderId', state.nominatorId)

    const nominatorName = (await queryOne('SELECT name FROM captains WHERE id = $1', [state.nominatorId]))?.name
    await execute(
      'INSERT INTO bid_history (round, player_id, captain_id, captain_name, amount) VALUES ($1, $2, $3, $4, $5)',
      [Number(state.currentRound), playerId, Number(state.nominatorId), nominatorName, bid]
    )

    await saveAuctionLog('nomination', `${nominatorName} nominated ${player.name} for ${bid}g`)
    io.emit('auction:log', { type: 'nomination', message: `${nominatorName} nominated ${player.name} for ${bid}g` })
    await startBidTimer()
    io.emit('auction:stateChanged', await getFullAuctionState())
  })

  // Place a bid
  socket.on('auction:bid', async ({ captainId, amount }) => {
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

    const state = await getAuctionState()
    if (state.status !== 'bidding') {
      socket.emit('auction:error', { message: 'Not in bidding phase' })
      return
    }

    const captain = await queryOne('SELECT * FROM captains WHERE id = $1', [captainId])
    if (!captain) {
      socket.emit('auction:error', { message: 'Captain not found' })
      return
    }

    const settings = await getSettings()
    if (await getCaptainPlayerCount(captainId) >= settings.playersPerTeam) {
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

    await setAuctionState('currentBid', String(amount))
    await setAuctionState('currentBidderId', String(captainId))
    lastBidTime = Date.now()

    await execute(
      'INSERT INTO bid_history (round, player_id, captain_id, captain_name, amount) VALUES ($1, $2, $3, $4, $5)',
      [Number(state.currentRound), Number(state.nominatedPlayerId), captainId, captain.name, amount]
    )

    const bidPlayer = await queryOne('SELECT name FROM players WHERE id = $1', [state.nominatedPlayerId])
    await saveAuctionLog('bid', `${captain.name} bid ${amount}g on ${bidPlayer?.name}`)
    io.emit('auction:log', { type: 'bid', message: `${captain.name} bid ${amount}g on ${bidPlayer?.name}` })

    await startBidTimer()
    io.emit('auction:stateChanged', await getFullAuctionState())
  })

  // Pause auction (admin only)
  socket.on('auction:pause', async () => {
    if (!await isAdminSocket(socket.id)) {
      socket.emit('auction:error', { message: 'Admin access required' })
      return
    }
    clearBidTimer()
    await setAuctionState('bidTimerEnd', '0')
    await setAuctionState('status', 'paused')
    await saveAuctionLog('pause', 'Auction paused by admin')
    io.emit('auction:log', { type: 'pause', message: 'Auction paused by admin' })
    io.emit('auction:stateChanged', await getFullAuctionState())
  })

  // Resume auction (admin only)
  socket.on('auction:resume', async () => {
    if (!await isAdminSocket(socket.id)) {
      socket.emit('auction:error', { message: 'Admin access required' })
      return
    }
    const state = await getAuctionState()
    if (state.nominatedPlayerId) {
      await setAuctionState('status', 'bidding')
      await startBidTimer()
    } else {
      await setAuctionState('status', 'nominating')
    }
    await saveAuctionLog('resume', 'Auction resumed by admin')
    io.emit('auction:log', { type: 'resume', message: 'Auction resumed by admin' })
    io.emit('auction:stateChanged', await getFullAuctionState())
  })

  // End draft early (admin only)
  socket.on('auction:end', async () => {
    if (!await isAdminSocket(socket.id)) {
      socket.emit('auction:error', { message: 'Admin access required' })
      return
    }
    clearBidTimer()
    await setAuctionState('status', 'finished')
    await setAuctionState('nominatedPlayerId', '')
    await setAuctionState('currentBid', '0')
    await setAuctionState('currentBidderId', '')
    await saveAuctionLog('end', 'Draft ended by admin')
    io.emit('auction:log', { type: 'end', message: 'Draft ended by admin' })
    io.emit('auction:finished', { results: 'Draft ended by admin' })
    io.emit('auction:stateChanged', await getFullAuctionState())
  })

  // Undo last action (admin only)
  socket.on('auction:undo', async () => {
    if (!await isAdminSocket(socket.id)) {
      socket.emit('auction:error', { message: 'Admin access required' })
      return
    }
    const state = await getAuctionState()

    // Case 1: Currently in bidding or paused with a nomination
    if (state.status === 'bidding' || (state.status === 'paused' && state.nominatedPlayerId)) {
      clearBidTimer()
      const nominatedPlayer = await queryOne('SELECT name FROM players WHERE id = $1', [state.nominatedPlayerId])
      await execute('DELETE FROM bid_history WHERE round = $1', [Number(state.currentRound)])
      await setAuctionState('status', 'nominating')
      await setAuctionState('nominatedPlayerId', '')
      await setAuctionState('currentBid', '0')
      await setAuctionState('currentBidderId', '')
      await setAuctionState('bidTimerEnd', '0')
      io.emit('auction:undone', { message: `Nomination of ${nominatedPlayer?.name || 'player'} was cancelled` })
      await saveAuctionLog('undo', `Undo: nomination of ${nominatedPlayer?.name || 'player'} cancelled`)
      io.emit('auction:log', { type: 'undo', message: `Undo: nomination of ${nominatedPlayer?.name || 'player'} cancelled` })
      io.emit('auction:stateChanged', await getFullAuctionState())
      return
    }

    // Case 2: In nominating phase, paused without nomination, or finished
    if (state.status === 'nominating' || state.status === 'finished' || state.status === 'paused') {
      const currentRound = Number(state.currentRound)
      const prevRound = state.status === 'finished' ? currentRound : currentRound - 1
      if (prevRound < 1) {
        socket.emit('auction:error', { message: 'Nothing to undo' })
        return
      }

      const lastBid = await queryOne('SELECT * FROM bid_history WHERE round = $1 ORDER BY id DESC LIMIT 1', [prevRound])
      if (!lastBid) {
        socket.emit('auction:error', { message: 'Nothing to undo' })
        return
      }

      const player = await queryOne('SELECT * FROM players WHERE id = $1', [lastBid.player_id])
      if (!player || !player.drafted) {
        socket.emit('auction:error', { message: 'Nothing to undo' })
        return
      }

      const buyer = await queryOne('SELECT name FROM captains WHERE id = $1', [player.drafted_by])
      const undoMsg = `${player.name} (${player.draft_price}g from ${buyer?.name || 'unknown'}) was reversed`
      await execute('UPDATE captains SET budget = budget + $1 WHERE id = $2', [player.draft_price, player.drafted_by])
      await execute('UPDATE players SET drafted = 0, drafted_by = NULL, draft_price = NULL, draft_round = NULL WHERE id = $1', [player.id])
      await execute('DELETE FROM bid_history WHERE round = $1', [prevRound])

      const captains = await getCaptains()
      const settings = await getSettings()
      const nextNominator = await getNextNominator(prevRound, captains, settings)

      await setAuctionState('status', 'nominating')
      await setAuctionState('currentRound', String(prevRound))
      await setAuctionState('nominatorId', String(nextNominator.id))
      await setAuctionState('nominatedPlayerId', '')
      await setAuctionState('currentBid', '0')
      await setAuctionState('currentBidderId', '')
      await setAuctionState('bidTimerEnd', '0')

      io.emit('auction:undone', { message: undoMsg })
      await saveAuctionLog('undo', `Undo: ${undoMsg}`)
      io.emit('auction:log', { type: 'undo', message: `Undo: ${undoMsg}` })
      io.emit('auction:stateChanged', await getFullAuctionState())
      io.emit('captains:updated', await getCaptains())
      io.emit('players:updated', await getPlayers())
      return
    }

    socket.emit('auction:error', { message: 'Nothing to undo' })
  })

  // Reset draft (admin only)
  socket.on('auction:reset', async () => {
    if (!await isAdminSocket(socket.id)) {
      socket.emit('auction:error', { message: 'Admin access required' })
      return
    }
    clearBidTimer()
    readyCaptains.clear()
    const settings = await getSettings()
    await execute('UPDATE captains SET budget = $1, status = $2', [settings.startingBudget, 'Waiting'])
    await execute('UPDATE players SET drafted = 0, drafted_by = NULL, draft_price = NULL, draft_round = NULL')
    await execute('DELETE FROM bid_history')
    await execute('DELETE FROM auction_log')
    await setAuctionState('status', 'idle')
    await setAuctionState('currentRound', '0')
    await setAuctionState('nominatorId', '')
    await setAuctionState('nominatedPlayerId', '')
    await setAuctionState('currentBid', '0')
    await setAuctionState('currentBidderId', '')
    await setAuctionState('bidTimerEnd', '0')
    io.emit('captains:ready', getReadyCaptainIds())
    io.emit('auction:stateChanged', await getFullAuctionState())
    io.emit('captains:updated', await getCaptains())
    io.emit('players:updated', await getPlayers())
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

// Initialize DB and start server
const PORT = process.env.PORT || 3001
initDb().then(() => {
  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`)
  })
}).catch(err => {
  console.error('Failed to initialize database:', err)
  process.exit(1)
})
