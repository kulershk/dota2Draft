import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import fs from 'fs'
import multer from 'multer'
import pool, { query, queryOne, execute, initDb } from './db.js'

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

// Uploads directory
const uploadsDir = join(__dirname, '..', 'uploads')
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })
app.use('/uploads', express.static(uploadsDir))

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const ext = file.originalname.split('.').pop()
      cb(null, `banner_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`)
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)) cb(null, true)
    else cb(new Error('Only image files are allowed'))
  },
})

// Base URL for redirects (frontend origin)
const BASE_URL = process.env.BASE_URL || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5173')

// ─── Session Management ──────────────────────────────────

const sessions = new Map() // token -> { playerId, createdAt }
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000 // 30 days

function createSession(playerId) {
  const token = crypto.randomBytes(32).toString('hex')
  sessions.set(token, { playerId, createdAt: Date.now() })
  return token
}

function getSessionPlayerId(token) {
  if (!token) return null
  const session = sessions.get(token)
  if (!session) return null
  if (Date.now() - session.createdAt > SESSION_TTL) {
    sessions.delete(token)
    return null
  }
  return session.playerId
}

function getTokenFromReq(req) {
  return req.headers.authorization?.replace('Bearer ', '') || null
}

async function getAuthPlayer(req) {
  const playerId = getSessionPlayerId(getTokenFromReq(req))
  if (!playerId) return null
  return await queryOne('SELECT * FROM players WHERE id = $1', [playerId])
}

// ─── Competition Helpers ─────────────────────────────────

function parseCompSettings(comp) {
  const s = comp.settings || {}
  return {
    playersPerTeam: Number(s.playersPerTeam) || 5,
    bidTimer: Number(s.bidTimer) || 30,
    startingBudget: Number(s.startingBudget) || 1000,
    minimumBid: Number(s.minimumBid) || 10,
    bidIncrement: Number(s.bidIncrement) || 5,
    maxBid: Number(s.maxBid) || 0,
    nominationOrder: s.nominationOrder || 'normal',
    requireAllOnline: s.requireAllOnline !== false,
    allowSteamRegistration: s.allowSteamRegistration !== false,
  }
}

function parseAuctionState(comp) {
  return comp.auction_state || {}
}

async function getCompetition(compId) {
  return await queryOne('SELECT * FROM competitions WHERE id = $1', [compId])
}

async function setAuctionState(compId, updates) {
  const comp = await queryOne('SELECT auction_state FROM competitions WHERE id = $1', [compId])
  const state = comp?.auction_state || {}
  Object.assign(state, updates)
  await execute('UPDATE competitions SET auction_state = $1 WHERE id = $2', [JSON.stringify(state), compId])
}

async function getCaptains(compId) {
  return await query(`
    SELECT c.id, c.name, c.team, c.budget, c.status, c.mmr, c.player_id, c.competition_id,
           c.banner_url, COALESCE(p.avatar_url, '') as avatar_url
    FROM captains c
    LEFT JOIN players p ON c.player_id = p.id
    WHERE c.competition_id = $1
    ORDER BY c.id
  `, [compId])
}

async function getCompPlayers(compId) {
  const captainPlayerIds = (await query(
    'SELECT player_id FROM captains WHERE competition_id = $1 AND player_id IS NOT NULL', [compId]
  )).map(r => r.player_id)

  const rows = await query(`
    SELECT cp.*, p.name, p.steam_id, p.avatar_url, p.is_admin
    FROM competition_players cp
    JOIN players p ON cp.player_id = p.id
    WHERE cp.competition_id = $1
    ORDER BY cp.id
  `, [compId])

  return rows.filter(p => p.in_pool || captainPlayerIds.includes(p.player_id)).map(p => ({
    id: p.player_id,
    name: p.name,
    roles: JSON.parse(p.roles || '[]'),
    mmr: p.mmr,
    info: p.info || '',
    drafted: !!p.drafted,
    drafted_by: p.drafted_by,
    draft_price: p.draft_price,
    draft_round: p.draft_round,
    steam_id: p.steam_id || null,
    avatar_url: p.avatar_url || null,
    is_admin: !!p.is_admin,
    is_captain: captainPlayerIds.includes(p.player_id),
    in_pool: !!p.in_pool,
  }))
}

async function getBidHistory(compId, round) {
  if (round !== undefined) {
    return await query('SELECT * FROM bid_history WHERE competition_id = $1 AND round = $2 ORDER BY id DESC', [compId, round])
  }
  return await query('SELECT * FROM bid_history WHERE competition_id = $1 ORDER BY id DESC LIMIT 50', [compId])
}

async function saveAuctionLog(compId, type, message) {
  await execute('INSERT INTO auction_log (competition_id, type, message) VALUES ($1, $2, $3)', [compId, type, message])
}

async function getAuctionLog(compId) {
  const rows = await query(
    'SELECT type, message, created_at as time FROM auction_log WHERE competition_id = $1 ORDER BY id DESC LIMIT 200', [compId]
  )
  return rows.map(r => ({ type: r.type, message: r.message, time: new Date(r.time).getTime() }))
}

async function getCaptainPlayerCount(compId, captainId) {
  const row = await queryOne(
    'SELECT COUNT(*) as count FROM competition_players WHERE competition_id = $1 AND drafted = 1 AND drafted_by = $2',
    [compId, captainId]
  )
  return parseInt(row.count)
}

async function getCaptainAvgMmr(compId, captain) {
  const players = await query(
    'SELECT mmr FROM competition_players WHERE competition_id = $1 AND drafted = 1 AND drafted_by = $2',
    [compId, captain.id]
  )
  const totalMmr = captain.mmr + players.reduce((s, p) => s + p.mmr, 0)
  return totalMmr / (1 + players.length)
}

async function getNextNominator(compId, round, captains, settings) {
  const active = []
  for (const c of captains) {
    if (await getCaptainPlayerCount(compId, c.id) < settings.playersPerTeam) {
      active.push(c)
    }
  }
  if (active.length === 0) return captains[0]

  if (settings.nominationOrder === 'lowest_avg') {
    let lowest = active[0]
    let lowestAvg = await getCaptainAvgMmr(compId, lowest)
    for (let i = 1; i < active.length; i++) {
      const avg = await getCaptainAvgMmr(compId, active[i])
      if (avg < lowestAvg) {
        lowest = active[i]
        lowestAvg = avg
      }
    }
    return lowest
  }

  if (settings.nominationOrder === 'fewest_then_lowest') {
    let best = active[0]
    let bestCount = await getCaptainPlayerCount(compId, best.id)
    let bestAvg = await getCaptainAvgMmr(compId, best)
    for (let i = 1; i < active.length; i++) {
      const c = active[i]
      const count = await getCaptainPlayerCount(compId, c.id)
      const avg = await getCaptainAvgMmr(compId, c)
      if (count < bestCount || (count === bestCount && avg < bestAvg)) {
        best = c
        bestCount = count
        bestAvg = avg
      }
    }
    return best
  }

  // Normal: round-robin
  const nominatorIndex = (round - 1) % captains.length
  for (let i = 0; i < captains.length; i++) {
    const candidate = captains[(nominatorIndex + i) % captains.length]
    if (active.some(a => a.id === candidate.id)) return candidate
  }
  return captains[nominatorIndex]
}

// ─── Socket & Timer Tracking (Per-Competition) ──────────

const socketPlayers = new Map()       // socketId -> playerId
const socketCompetitions = new Map()  // socketId -> compId
const compOnlineCaptains = new Map()  // compId -> Map<socketId, captainId>
const compReadyCaptains = new Map()   // compId -> Set<captainId>
const compBidTimers = new Map()       // compId -> timeout
const compLastBidTime = new Map()     // compId -> timestamp
const BID_COOLDOWN_MS = 300

function getOnlineCaptainIds(compId) {
  const map = compOnlineCaptains.get(compId)
  if (!map) return []
  return [...new Set(map.values())]
}

function getReadyCaptainIds(compId) {
  const set = compReadyCaptains.get(compId)
  if (!set) return []
  return [...set]
}

async function isAdminSocket(socketId) {
  const playerId = socketPlayers.get(socketId)
  if (!playerId) return false
  const player = await queryOne('SELECT is_admin FROM players WHERE id = $1', [playerId])
  return !!player?.is_admin
}

async function getSocketCaptainId(socketId, compId) {
  const playerId = socketPlayers.get(socketId)
  if (!playerId) return null
  const captain = await queryOne(
    'SELECT id FROM captains WHERE player_id = $1 AND competition_id = $2', [playerId, compId]
  )
  return captain?.id || null
}

function clearCompBidTimer(compId) {
  const timer = compBidTimers.get(compId)
  if (timer) {
    clearTimeout(timer)
    compBidTimers.delete(compId)
  }
}

async function startCompBidTimer(compId) {
  clearCompBidTimer(compId)
  const comp = await getCompetition(compId)
  const settings = parseCompSettings(comp)
  const endTime = Date.now() + settings.bidTimer * 1000
  await setAuctionState(compId, { bidTimerEnd: endTime })
  io.to(`comp:${compId}`).emit('auction:timerUpdate', { bidTimerEnd: endTime })

  const timer = setTimeout(() => {
    finalizeCompBid(compId)
  }, settings.bidTimer * 1000)
  compBidTimers.set(compId, timer)
}

async function finalizeCompBid(compId) {
  clearCompBidTimer(compId)
  const comp = await getCompetition(compId)
  const state = parseAuctionState(comp)
  const settings = parseCompSettings(comp)

  const playerId = Number(state.nominatedPlayerId)
  const bidderId = Number(state.currentBidderId)
  const bidAmount = Number(state.currentBid)

  if (playerId && bidderId && bidAmount >= 0) {
    const draftRound = Number(state.currentRound)
    await execute(
      'UPDATE competition_players SET drafted = 1, drafted_by = $1, draft_price = $2, draft_round = $3 WHERE competition_id = $4 AND player_id = $5',
      [bidderId, bidAmount, draftRound, compId, playerId]
    )
    await execute('UPDATE captains SET budget = budget - $1 WHERE id = $2', [bidAmount, bidderId])

    const winner = await queryOne('SELECT name FROM captains WHERE id = $1', [bidderId])
    const player = await queryOne('SELECT name FROM players WHERE id = $1', [playerId])

    io.to(`comp:${compId}`).emit('auction:sold', {
      playerName: player.name,
      captainName: winner.name,
      amount: bidAmount,
    })
    await saveAuctionLog(compId, 'sold', `${player.name} sold to ${winner.name} for ${bidAmount}g`)
    io.to(`comp:${compId}`).emit('auction:log', { type: 'sold', message: `${player.name} sold to ${winner.name} for ${bidAmount}g` })
  }

  const currentRound = Number(state.currentRound)
  const totalRounds = Number(state.totalRounds)
  const captains = await getCaptains(compId)
  const totalPlayers = settings.playersPerTeam * captains.length

  const draftedRow = await queryOne(
    'SELECT COUNT(*) as count FROM competition_players WHERE competition_id = $1 AND drafted = 1', [compId]
  )
  const draftedCount = parseInt(draftedRow.count)

  if (draftedCount >= totalPlayers || currentRound >= totalRounds) {
    await setAuctionState(compId, {
      status: 'finished', nominatedPlayerId: '', currentBid: 0, currentBidderId: '',
    })
    await saveAuctionLog(compId, 'end', 'Draft complete! All players drafted.')
    io.to(`comp:${compId}`).emit('auction:log', { type: 'end', message: 'Draft complete! All players drafted.' })
    io.to(`comp:${compId}`).emit('auction:finished', { results: 'Draft complete!' })
    io.to(`comp:${compId}`).emit('auction:stateChanged', await getFullAuctionState(compId))
  } else {
    const nextRound = currentRound + 1
    const nextNominator = await getNextNominator(compId, nextRound, captains, settings)

    await setAuctionState(compId, {
      status: 'nominating',
      currentRound: nextRound,
      nominatorId: nextNominator.id,
      nominatedPlayerId: '',
      currentBid: 0,
      currentBidderId: '',
      bidTimerEnd: 0,
    })
    io.to(`comp:${compId}`).emit('auction:stateChanged', await getFullAuctionState(compId))
  }
}

async function getFullAuctionState(compId) {
  const comp = await getCompetition(compId)
  const state = parseAuctionState(comp)
  const settings = parseCompSettings(comp)

  const nominatedPlayer = state.nominatedPlayerId
    ? await queryOne(`
        SELECT cp.*, p.name, p.steam_id, p.avatar_url
        FROM competition_players cp JOIN players p ON cp.player_id = p.id
        WHERE cp.competition_id = $1 AND cp.player_id = $2
      `, [compId, state.nominatedPlayerId])
    : null
  const nominator = state.nominatorId
    ? await queryOne('SELECT id, name, team FROM captains WHERE id = $1', [state.nominatorId])
    : null
  const currentBidder = state.currentBidderId
    ? await queryOne('SELECT id, name, team FROM captains WHERE id = $1', [state.currentBidderId])
    : null
  const history = state.currentRound ? await getBidHistory(compId, Number(state.currentRound)) : []

  return {
    status: state.status || 'idle',
    currentRound: Number(state.currentRound) || 0,
    totalRounds: Number(state.totalRounds) || 0,
    nominator,
    nominatedPlayer: nominatedPlayer ? {
      id: nominatedPlayer.player_id,
      name: nominatedPlayer.name,
      roles: JSON.parse(nominatedPlayer.roles || '[]'),
      mmr: nominatedPlayer.mmr,
      info: nominatedPlayer.info,
      drafted: !!nominatedPlayer.drafted,
      steam_id: nominatedPlayer.steam_id,
      avatar_url: nominatedPlayer.avatar_url,
    } : null,
    currentBid: Number(state.currentBid) || 0,
    currentBidder,
    bidTimerEnd: Number(state.bidTimerEnd) || 0,
    bidHistory: history,
    captains: await getCaptains(compId),
    players: await getCompPlayers(compId),
    settings,
  }
}

// ─── REST API: Steam Auth ────────────────────────────────

async function fetchSteamProfile(steamId) {
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
  return { personaName, avatarUrl }
}

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
    const params = new URLSearchParams(req.query)
    params.set('openid.mode', 'check_authentication')
    const verifyRes = await fetch('https://steamcommunity.com/openid/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
    const verifyBody = await verifyRes.text()
    if (!verifyBody.includes('is_valid:true')) {
      return res.redirect(`${BASE_URL}/?steam_error=validation_failed`)
    }

    const claimedId = req.query['openid.claimed_id']
    const steamIdMatch = claimedId?.match(/\/openid\/id\/(\d+)$/)
    if (!steamIdMatch) {
      return res.redirect(`${BASE_URL}/?steam_error=invalid_id`)
    }
    const steamId = steamIdMatch[1]
    const { personaName, avatarUrl } = await fetchSteamProfile(steamId)

    const existing = await queryOne('SELECT * FROM players WHERE steam_id = $1', [steamId])
    if (existing) {
      await execute('UPDATE players SET name = $1, avatar_url = $2 WHERE id = $3', [personaName, avatarUrl, existing.id])
      const token = createSession(existing.id)
      return res.redirect(`${BASE_URL}/?authToken=${token}`)
    }

    const newPlayer = await queryOne(
      'INSERT INTO players (name, roles, mmr, info, steam_id, avatar_url) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [personaName, '[]', 0, '', steamId, avatarUrl]
    )
    const token = createSession(newPlayer.id)
    res.redirect(`${BASE_URL}/?authToken=${token}`)
  } catch (e) {
    console.error('Steam callback error:', e)
    res.redirect(`${BASE_URL}/?steam_error=server_error`)
  }
})

app.get('/api/auth/me', async (req, res) => {
  const player = await getAuthPlayer(req)
  if (!player) return res.status(401).json({ error: 'Not authenticated' })

  res.json({
    id: player.id,
    name: player.name,
    steam_id: player.steam_id,
    avatar_url: player.avatar_url,
    is_admin: !!player.is_admin,
    roles: JSON.parse(player.roles || '[]'),
    mmr: player.mmr,
    info: player.info || '',
    twitch_username: player.twitch_username || null,
  })
})

app.put('/api/auth/me', async (req, res) => {
  const player = await getAuthPlayer(req)
  if (!player) return res.status(401).json({ error: 'Not authenticated' })
  const { mmr, info, roles } = req.body
  await execute(
    'UPDATE players SET mmr = $1, info = $2, roles = $3 WHERE id = $4',
    [
      mmr ?? player.mmr,
      info ?? player.info,
      roles ? JSON.stringify(roles) : player.roles,
      player.id,
    ]
  )
  const updated = await queryOne('SELECT * FROM players WHERE id = $1', [player.id])
  res.json({
    id: updated.id,
    name: updated.name,
    steam_id: updated.steam_id,
    avatar_url: updated.avatar_url,
    is_admin: !!updated.is_admin,
    roles: JSON.parse(updated.roles || '[]'),
    mmr: updated.mmr,
    info: updated.info || '',
    twitch_username: updated.twitch_username || null,
  })
})

// Competition-specific user info
app.get('/api/competitions/:compId/me', async (req, res) => {
  const player = await getAuthPlayer(req)
  if (!player) return res.status(401).json({ error: 'Not authenticated' })
  const compId = Number(req.params.compId)

  const cp = await queryOne(
    'SELECT * FROM competition_players WHERE competition_id = $1 AND player_id = $2',
    [compId, player.id]
  )
  const captain = await queryOne(
    'SELECT id, team, budget, status FROM captains WHERE player_id = $1 AND competition_id = $2',
    [player.id, compId]
  )

  res.json({
    in_pool: cp ? !!cp.in_pool : false,
    roles: cp ? JSON.parse(cp.roles || '[]') : JSON.parse(player.roles || '[]'),
    mmr: cp ? cp.mmr : player.mmr,
    info: cp ? (cp.info || '') : (player.info || ''),
    captain: captain ? { id: captain.id, team: captain.team, budget: captain.budget, status: captain.status } : null,
  })
})

app.post('/api/auth/claim-admin', async (req, res) => {
  const player = await getAuthPlayer(req)
  if (!player) return res.status(401).json({ error: 'Not authenticated' })

  const { password } = req.body
  const row = await queryOne("SELECT value FROM settings WHERE key = 'adminPassword'")
  const adminPassword = row?.value || 'admin'

  if (password !== adminPassword) {
    return res.status(401).json({ error: 'Invalid admin password' })
  }

  await execute('UPDATE players SET is_admin = true WHERE id = $1', [player.id])
  res.json({ ok: true })
})

// ─── Twitch OAuth ─────────────────────────────────────────
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || ''
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || ''
const DOTA2_GAME_ID = '29595'

let twitchAppToken = null
let twitchAppTokenExpiresAt = 0

async function getTwitchAppToken() {
  if (twitchAppToken && Date.now() < twitchAppTokenExpiresAt - 60000) return twitchAppToken
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) return null
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: TWITCH_CLIENT_ID,
        client_secret: TWITCH_CLIENT_SECRET,
        grant_type: 'client_credentials',
      }),
    })
    const data = await res.json()
    if (data.access_token) {
      twitchAppToken = data.access_token
      twitchAppTokenExpiresAt = Date.now() + data.expires_in * 1000
      return twitchAppToken
    }
  } catch (e) {
    console.error('Failed to get Twitch app token:', e.message)
  }
  return null
}

app.get('/api/auth/twitch/link', async (req, res) => {
  const player = await getAuthPlayer(req)
  if (!player) return res.status(401).json({ error: 'Not authenticated' })
  if (!TWITCH_CLIENT_ID) return res.status(500).json({ error: 'Twitch not configured' })

  const token = getTokenFromReq(req)
  const serverOrigin = `${req.protocol}://${req.get('host')}`
  const redirectUri = `${serverOrigin}/api/auth/twitch/callback`
  const params = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: '',
    state: token,
  })
  res.json({ url: `https://id.twitch.tv/oauth2/authorize?${params}` })
})

app.get('/api/auth/twitch/callback', async (req, res) => {
  try {
    const { code, state } = req.query
    if (!code || !state) return res.redirect(`${BASE_URL}/settings?twitch_error=missing_params`)

    const playerId = getSessionPlayerId(state)
    if (!playerId) return res.redirect(`${BASE_URL}/settings?twitch_error=not_authenticated`)

    const serverOrigin = `${req.protocol}://${req.get('host')}`
    const redirectUri = `${serverOrigin}/api/auth/twitch/callback`

    // Exchange code for access token
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: TWITCH_CLIENT_ID,
        client_secret: TWITCH_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    })
    const tokenData = await tokenRes.json()
    if (!tokenData.access_token) return res.redirect(`${BASE_URL}/settings?twitch_error=token_failed`)

    // Get Twitch user info
    const userRes = await fetch('https://api.twitch.tv/helix/users', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'Client-Id': TWITCH_CLIENT_ID,
      },
    })
    const userData = await userRes.json()
    const twitchUser = userData.data?.[0]
    if (!twitchUser) return res.redirect(`${BASE_URL}/settings?twitch_error=user_fetch_failed`)

    await execute(
      'UPDATE players SET twitch_id = $1, twitch_username = $2 WHERE id = $3',
      [twitchUser.id, twitchUser.login, playerId]
    )

    res.redirect(`${BASE_URL}/settings?twitch_linked=1`)
  } catch (e) {
    console.error('Twitch callback error:', e)
    res.redirect(`${BASE_URL}/settings?twitch_error=server_error`)
  }
})

app.post('/api/auth/twitch/unlink', async (req, res) => {
  const player = await getAuthPlayer(req)
  if (!player) return res.status(401).json({ error: 'Not authenticated' })
  await execute('UPDATE players SET twitch_id = NULL, twitch_username = NULL WHERE id = $1', [player.id])
  res.json({ ok: true })
})

app.post('/api/auth/logout', (req, res) => {
  const token = getTokenFromReq(req)
  if (token) sessions.delete(token)
  res.json({ ok: true })
})

// ─── REST API: Competitions CRUD ─────────────────────────

app.get('/api/competitions', async (req, res) => {
  const comps = await query(`
    SELECT c.*, p.name AS created_by_name, p.avatar_url AS created_by_avatar
    FROM competitions c
    LEFT JOIN players p ON p.id = c.created_by
    ORDER BY c.created_at DESC
  `)
  res.json(comps.map(c => ({
    ...c,
    settings: parseCompSettings(c),
    auction_state: parseAuctionState(c),
  })))
})

app.get('/api/competitions/:id', async (req, res) => {
  const comp = await queryOne(`
    SELECT c.*, p.name AS created_by_name, p.avatar_url AS created_by_avatar
    FROM competitions c
    LEFT JOIN players p ON p.id = c.created_by
    WHERE c.id = $1
  `, [req.params.id])
  if (!comp) return res.status(404).json({ error: 'Competition not found' })
  res.json({
    ...comp,
    settings: parseCompSettings(comp),
    auction_state: parseAuctionState(comp),
  })
})

app.post('/api/competitions', async (req, res) => {
  const admin = await getAuthPlayer(req)
  if (!admin?.is_admin) return res.status(403).json({ error: 'Admin access required' })

  const { name, description, starts_at, registration_start, registration_end, settings } = req.body
  if (!name) return res.status(400).json({ error: 'Name is required' })

  const defaultSettings = {
    playersPerTeam: 5, bidTimer: 30, startingBudget: 1000,
    minimumBid: 10, bidIncrement: 5, maxBid: 0,
    nominationOrder: 'normal', requireAllOnline: true, allowSteamRegistration: true,
  }

  const comp = await queryOne(
    `INSERT INTO competitions (name, description, starts_at, registration_start, registration_end, settings, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [name, description || '', starts_at || null, registration_start || null, registration_end || null, JSON.stringify({ ...defaultSettings, ...settings }), admin.id]
  )
  // Fetch with creator info
  const full = await queryOne(`
    SELECT c.*, p.name AS created_by_name, p.avatar_url AS created_by_avatar
    FROM competitions c LEFT JOIN players p ON p.id = c.created_by WHERE c.id = $1
  `, [comp.id])
  res.status(201).json({ ...full, settings: parseCompSettings(full) })
})

app.put('/api/competitions/:id', async (req, res) => {
  const admin = await getAuthPlayer(req)
  if (!admin?.is_admin) return res.status(403).json({ error: 'Admin access required' })

  const comp = await getCompetition(req.params.id)
  if (!comp) return res.status(404).json({ error: 'Competition not found' })

  const { name, description, starts_at, registration_start, registration_end, settings } = req.body

  const newSettings = settings ? { ...comp.settings, ...settings } : comp.settings
  await execute(
    `UPDATE competitions SET name = $1, description = $2, starts_at = $3, registration_start = $4, registration_end = $5, settings = $6 WHERE id = $7`,
    [
      name ?? comp.name,
      description ?? comp.description,
      starts_at !== undefined ? starts_at : comp.starts_at,
      registration_start !== undefined ? registration_start : comp.registration_start,
      registration_end !== undefined ? registration_end : comp.registration_end,
      JSON.stringify(newSettings),
      comp.id,
    ]
  )

  const updated = await queryOne(`
    SELECT c.*, p.name AS created_by_name, p.avatar_url AS created_by_avatar
    FROM competitions c LEFT JOIN players p ON p.id = c.created_by WHERE c.id = $1
  `, [comp.id])
  io.to(`comp:${comp.id}`).emit('settings:updated', parseCompSettings(updated))
  res.json({ ...updated, settings: parseCompSettings(updated) })
})

app.delete('/api/competitions/:id', async (req, res) => {
  const admin = await getAuthPlayer(req)
  if (!admin?.is_admin) return res.status(403).json({ error: 'Admin access required' })

  await execute('DELETE FROM competitions WHERE id = $1', [req.params.id])
  res.json({ ok: true })
})

// ─── REST API: Competition Players ───────────────────────

app.get('/api/competitions/:compId/players', async (req, res) => {
  res.json(await getCompPlayers(Number(req.params.compId)))
})

// Self-register for a competition's participant list
app.post('/api/competitions/:compId/players/register', async (req, res) => {
  const player = await getAuthPlayer(req)
  if (!player) return res.status(401).json({ error: 'Not authenticated' })
  if (player.is_banned) return res.status(403).json({ error: 'Your account has been banned' })
  const compId = Number(req.params.compId)

  // Check registration window (admins bypass)
  if (!player.is_admin) {
    const comp = await getCompetition(compId)
    if (!comp) return res.status(404).json({ error: 'Competition not found' })
    const now = new Date()
    if (comp.registration_start && new Date(comp.registration_start) > now) {
      return res.status(403).json({ error: 'Registration has not opened yet' })
    }
    if (comp.registration_end && new Date(comp.registration_end) < now) {
      return res.status(403).json({ error: 'Registration has closed' })
    }
  }

  const existing = await queryOne(
    'SELECT * FROM competition_players WHERE competition_id = $1 AND player_id = $2',
    [compId, player.id]
  )
  if (existing?.in_pool) return res.status(409).json({ error: 'Already registered as a participant' })

  const { roles, mmr, info } = req.body

  // Also update player's global defaults
  await execute(
    'UPDATE players SET roles = $1, mmr = $2, info = $3 WHERE id = $4',
    [JSON.stringify(roles || []), mmr || 0, info || '', player.id]
  )

  if (existing) {
    await execute(
      'UPDATE competition_players SET roles = $1, mmr = $2, info = $3, in_pool = true WHERE id = $4',
      [JSON.stringify(roles || []), mmr || 0, info || '', existing.id]
    )
  } else {
    await execute(
      `INSERT INTO competition_players (competition_id, player_id, roles, mmr, info, in_pool)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [compId, player.id, JSON.stringify(roles || []), mmr || 0, info || '']
    )
  }

  io.to(`comp:${compId}`).emit('players:updated', await getCompPlayers(compId))
  res.json({ ok: true })
})

app.put('/api/competitions/:compId/players/:playerId', async (req, res) => {
  const admin = await getAuthPlayer(req)
  if (!admin?.is_admin) return res.status(403).json({ error: 'Admin access required' })
  const compId = Number(req.params.compId)
  const playerId = Number(req.params.playerId)

  const cp = await queryOne(
    'SELECT * FROM competition_players WHERE competition_id = $1 AND player_id = $2',
    [compId, playerId]
  )
  if (!cp) return res.status(404).json({ error: 'Player not in this competition' })

  const { name, roles, mmr, info, is_admin } = req.body

  // Update competition-specific data
  await execute(
    'UPDATE competition_players SET roles = $1, mmr = $2, info = $3 WHERE id = $4',
    [
      roles ? JSON.stringify(roles) : cp.roles,
      mmr ?? cp.mmr,
      info ?? cp.info,
      cp.id,
    ]
  )

  // Update global player data if name or is_admin changed
  if (name !== undefined || is_admin !== undefined) {
    const player = await queryOne('SELECT * FROM players WHERE id = $1', [playerId])
    await execute(
      'UPDATE players SET name = $1, is_admin = $2 WHERE id = $3',
      [name ?? player.name, is_admin !== undefined ? is_admin : player.is_admin, playerId]
    )
  }

  io.to(`comp:${compId}`).emit('players:updated', await getCompPlayers(compId))
  res.json({ ok: true })
})

app.delete('/api/competitions/:compId/players/:playerId', async (req, res) => {
  const admin = await getAuthPlayer(req)
  if (!admin?.is_admin) return res.status(403).json({ error: 'Admin access required' })
  const compId = Number(req.params.compId)
  const playerId = Number(req.params.playerId)

  // Remove from competition pool (set in_pool=false, clear draft state)
  await execute(
    'UPDATE competition_players SET in_pool = false, drafted = 0, drafted_by = NULL, draft_price = NULL, draft_round = NULL WHERE competition_id = $1 AND player_id = $2',
    [compId, playerId]
  )

  io.to(`comp:${compId}`).emit('players:updated', await getCompPlayers(compId))
  res.json({ ok: true })
})

// ─── REST API: Competition Captains ──────────────────────

app.get('/api/competitions/:compId/captains', async (req, res) => {
  res.json(await getCaptains(Number(req.params.compId)))
})

app.post('/api/competitions/:compId/captains/promote', async (req, res) => {
  const admin = await getAuthPlayer(req)
  if (!admin?.is_admin) return res.status(403).json({ error: 'Admin access required' })
  const compId = Number(req.params.compId)

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
    [compId, player.name, team, settings.startingBudget, 'Waiting', player.mmr, playerId]
  )

  // Ensure player has a competition_players entry (remove from pool since they're a captain)
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

app.put('/api/competitions/:compId/captains/:id', async (req, res) => {
  const admin = await getAuthPlayer(req)
  if (!admin?.is_admin) return res.status(403).json({ error: 'Admin access required' })
  const compId = Number(req.params.compId)

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

app.post('/api/competitions/:compId/captains/:id/banner', upload.single('banner'), async (req, res) => {
  const player = await getAuthPlayer(req)
  if (!player) return res.status(401).json({ error: 'Not authenticated' })
  const compId = Number(req.params.compId)
  const captainId = Number(req.params.id)

  const captain = await queryOne('SELECT * FROM captains WHERE id = $1 AND competition_id = $2', [captainId, compId])
  if (!captain) return res.status(404).json({ error: 'Captain not found' })

  // Only the captain themselves or an admin can upload
  if (captain.player_id !== player.id && !player.is_admin) {
    return res.status(403).json({ error: 'Only the team captain or an admin can upload a banner' })
  }

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })

  // Delete old banner file if exists
  if (captain.banner_url) {
    const oldPath = join(uploadsDir, captain.banner_url.replace('/uploads/', ''))
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath)
  }

  const bannerUrl = `/uploads/${req.file.filename}`
  await execute('UPDATE captains SET banner_url = $1 WHERE id = $2', [bannerUrl, captainId])
  io.to(`comp:${compId}`).emit('captains:updated', await getCaptains(compId))
  res.json({ banner_url: bannerUrl })
})

app.delete('/api/competitions/:compId/captains/:id/banner', async (req, res) => {
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

app.post('/api/competitions/:compId/captains/:id/demote', async (req, res) => {
  const admin = await getAuthPlayer(req)
  if (!admin?.is_admin) return res.status(403).json({ error: 'Admin access required' })
  const compId = Number(req.params.compId)

  const captain = await queryOne('SELECT player_id FROM captains WHERE id = $1 AND competition_id = $2', [req.params.id, compId])
  await execute('DELETE FROM captains WHERE id = $1', [req.params.id])

  if (captain?.player_id) {
    // Return to pool
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

// ─── REST API: Competition Auction ───────────────────────

app.get('/api/competitions/:compId/auction', async (req, res) => {
  const compId = Number(req.params.compId)
  res.json(await getFullAuctionState(compId))
})

app.get('/api/competitions/:compId/auction/results', async (req, res) => {
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

// Admin: add user to competition pool
app.post('/api/competitions/:compId/users/:userId/add-to-pool', async (req, res) => {
  const admin = await getAuthPlayer(req)
  if (!admin?.is_admin) return res.status(403).json({ error: 'Admin access required' })
  const compId = Number(req.params.compId)
  const userId = Number(req.params.userId)

  const player = await queryOne('SELECT * FROM players WHERE id = $1', [userId])
  if (!player) return res.status(404).json({ error: 'User not found' })

  const existing = await queryOne(
    'SELECT * FROM competition_players WHERE competition_id = $1 AND player_id = $2',
    [compId, userId]
  )

  if (existing) {
    if (existing.in_pool) return res.status(409).json({ error: 'Already in pool' })
    await execute('UPDATE competition_players SET in_pool = true WHERE id = $1', [existing.id])
  } else {
    await execute(
      `INSERT INTO competition_players (competition_id, player_id, roles, mmr, info, in_pool)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [compId, userId, player.roles || '[]', player.mmr, player.info || '']
    )
  }

  io.to(`comp:${compId}`).emit('players:updated', await getCompPlayers(compId))
  res.json({ ok: true })
})

app.post('/api/competitions/:compId/users/:userId/remove-from-pool', async (req, res) => {
  const admin = await getAuthPlayer(req)
  if (!admin?.is_admin) return res.status(403).json({ error: 'Admin access required' })
  const compId = Number(req.params.compId)
  const userId = Number(req.params.userId)

  await execute(
    'UPDATE competition_players SET in_pool = false WHERE competition_id = $1 AND player_id = $2',
    [compId, userId]
  )

  io.to(`comp:${compId}`).emit('players:updated', await getCompPlayers(compId))
  res.json({ ok: true })
})

// ─── REST API: Users (global, all Steam accounts) ───────

let streamersCache = null
let streamersCacheTime = 0
const STREAMERS_CACHE_TTL = 60 * 1000 // 1 minute

app.get('/api/streamers', async (req, res) => {
  if (streamersCache && Date.now() - streamersCacheTime < STREAMERS_CACHE_TTL) {
    return res.json(streamersCache)
  }

  const rows = await query(
    "SELECT id, name, avatar_url, twitch_username FROM players WHERE twitch_username IS NOT NULL AND twitch_username != '' ORDER BY name"
  )
  if (rows.length === 0) { streamersCache = []; streamersCacheTime = Date.now(); return res.json([]) }

  const token = await getTwitchAppToken()
  if (!token) { streamersCache = []; streamersCacheTime = Date.now(); return res.json([]) }

  try {
    const logins = rows.map(r => r.twitch_username)
    const params = new URLSearchParams()
    params.set('game_id', DOTA2_GAME_ID)
    logins.slice(0, 100).forEach(l => params.append('user_login', l))
    params.set('first', '100')

    const streamRes = await fetch(`https://api.twitch.tv/helix/streams?${params}`, {
      headers: { Authorization: `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID },
    })
    const streamData = await streamRes.json()
    const liveStreams = streamData.data || []

    const liveMap = new Map()
    for (const s of liveStreams) {
      liveMap.set(s.user_login.toLowerCase(), {
        title: s.title,
        viewer_count: s.viewer_count,
        thumbnail_url: s.thumbnail_url?.replace('{width}', '440').replace('{height}', '248'),
        started_at: s.started_at,
      })
    }

    const result = rows
      .filter(r => liveMap.has(r.twitch_username.toLowerCase()))
      .map(r => ({
        ...r,
        stream: liveMap.get(r.twitch_username.toLowerCase()),
      }))
      .sort((a, b) => b.stream.viewer_count - a.stream.viewer_count)

    streamersCache = result
    streamersCacheTime = Date.now()
    res.json(result)
  } catch (e) {
    console.error('Failed to fetch Twitch streams:', e.message)
    res.json(streamersCache || [])
  }
})

app.get('/api/users', async (req, res) => {
  const admin = await getAuthPlayer(req)
  if (!admin?.is_admin) return res.status(403).json({ error: 'Admin access required' })

  const rows = await query('SELECT * FROM players ORDER BY id')
  res.json(rows.map(p => ({
    id: p.id,
    name: p.name,
    steam_id: p.steam_id || null,
    avatar_url: p.avatar_url || null,
    roles: JSON.parse(p.roles || '[]'),
    mmr: p.mmr,
    info: p.info || '',
    is_admin: !!p.is_admin,
    is_banned: !!p.is_banned,
    twitch_username: p.twitch_username || null,
    created_at: p.created_at,
  })))
})

app.put('/api/players/:id', async (req, res) => {
  const admin = await getAuthPlayer(req)
  if (!admin?.is_admin) return res.status(403).json({ error: 'Admin access required' })

  const player = await queryOne('SELECT * FROM players WHERE id = $1', [req.params.id])
  if (!player) return res.status(404).json({ error: 'Player not found' })
  const { name, roles, mmr, info, is_admin, is_banned } = req.body
  await execute(
    'UPDATE players SET name = $1, roles = $2, mmr = $3, info = $4, is_admin = $5, is_banned = $6 WHERE id = $7',
    [
      name ?? player.name,
      roles ? JSON.stringify(roles) : player.roles,
      mmr ?? player.mmr,
      info ?? player.info,
      is_admin !== undefined ? is_admin : player.is_admin,
      is_banned !== undefined ? is_banned : !!player.is_banned,
      req.params.id,
    ]
  )
  res.json({ ok: true })
})

// ─── REST API: News ──────────────────────────────────────

app.get('/api/news', async (req, res) => {
  const news = await query(`
    SELECT n.*, p.name AS created_by_name, p.avatar_url AS created_by_avatar
    FROM news n
    LEFT JOIN players p ON p.id = n.created_by
    ORDER BY n.created_at DESC
  `)
  res.json(news)
})

app.post('/api/news', async (req, res) => {
  const admin = await getAuthPlayer(req)
  if (!admin?.is_admin) return res.status(403).json({ error: 'Admin access required' })
  const { title, content } = req.body
  if (!title || !content) return res.status(400).json({ error: 'Title and content required' })
  const result = await queryOne(
    'INSERT INTO news (title, content, created_by) VALUES ($1, $2, $3) RETURNING id',
    [title, content, admin.id]
  )
  const post = await queryOne(`
    SELECT n.*, p.name AS created_by_name, p.avatar_url AS created_by_avatar
    FROM news n LEFT JOIN players p ON p.id = n.created_by WHERE n.id = $1
  `, [result.id])
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
  const updated = await queryOne(`
    SELECT n.*, p.name AS created_by_name, p.avatar_url AS created_by_avatar
    FROM news n LEFT JOIN players p ON p.id = n.created_by WHERE n.id = $1
  `, [req.params.id])
  res.json(updated)
})

app.delete('/api/news/:id', async (req, res) => {
  await execute('DELETE FROM news WHERE id = $1', [req.params.id])
  io.emit('news:updated')
  res.json({ ok: true })
})

// ─── REST API: News Comments ────────────────────────────

app.get('/api/news/:newsId/comments', async (req, res) => {
  const comments = await query(`
    SELECT c.*, p.name AS player_name, p.avatar_url AS player_avatar
    FROM news_comments c
    JOIN players p ON p.id = c.player_id
    WHERE c.news_id = $1
    ORDER BY c.created_at ASC
  `, [req.params.newsId])
  res.json(comments)
})

app.post('/api/news/:newsId/comments', async (req, res) => {
  const player = await getAuthPlayer(req)
  if (!player) return res.status(401).json({ error: 'Login required' })
  if (player.is_banned) return res.status(403).json({ error: 'Your account has been banned' })
  const { content } = req.body
  if (!content || !content.trim()) return res.status(400).json({ error: 'Comment cannot be empty' })
  const newsPost = await queryOne('SELECT id FROM news WHERE id = $1', [req.params.newsId])
  if (!newsPost) return res.status(404).json({ error: 'News post not found' })
  const result = await queryOne(
    'INSERT INTO news_comments (news_id, player_id, content) VALUES ($1, $2, $3) RETURNING id',
    [req.params.newsId, player.id, content.trim()]
  )
  const comment = await queryOne(`
    SELECT c.*, p.name AS player_name, p.avatar_url AS player_avatar
    FROM news_comments c JOIN players p ON p.id = c.player_id WHERE c.id = $1
  `, [result.id])
  io.emit('news:commented', { newsId: Number(req.params.newsId) })
  res.status(201).json(comment)
})

app.delete('/api/news/:newsId/comments/:commentId', async (req, res) => {
  const player = await getAuthPlayer(req)
  if (!player) return res.status(401).json({ error: 'Login required' })
  const comment = await queryOne('SELECT * FROM news_comments WHERE id = $1 AND news_id = $2', [req.params.commentId, req.params.newsId])
  if (!comment) return res.status(404).json({ error: 'Comment not found' })
  // Only the author or an admin can delete
  if (comment.player_id !== player.id && !player.is_admin) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  await execute('DELETE FROM news_comments WHERE id = $1', [req.params.commentId])
  io.emit('news:commented', { newsId: Number(req.params.newsId) })
  res.json({ ok: true })
})

// ─── Socket.io: Per-Competition Auction Logic ────────────

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`)

  // Authenticate via handshake token
  const token = socket.handshake.auth?.token
  if (token) {
    const playerId = getSessionPlayerId(token)
    if (playerId) {
      socketPlayers.set(socket.id, playerId)
    }
  }

  // Time sync
  socket.emit('server:time', Date.now())
  socket.on('server:ping', () => {
    socket.emit('server:time', Date.now())
  })

  // ─── Competition Room Management ───────────────────────

  socket.on('competition:join', async ({ competitionId }) => {
    const compId = Number(competitionId)
    const comp = await getCompetition(compId)
    if (!comp) return socket.emit('auction:error', { message: 'Competition not found' })

    // Leave previous competition room
    const prevCompId = socketCompetitions.get(socket.id)
    if (prevCompId) {
      socket.leave(`comp:${prevCompId}`)
      // Remove from online captains of previous comp
      const prevMap = compOnlineCaptains.get(prevCompId)
      if (prevMap) {
        prevMap.delete(socket.id)
        io.to(`comp:${prevCompId}`).emit('captains:online', getOnlineCaptainIds(prevCompId))
      }
    }

    // Join new competition room
    socket.join(`comp:${compId}`)
    socketCompetitions.set(socket.id, compId)

    // Check if player is a captain in this competition
    const playerId = socketPlayers.get(socket.id)
    if (playerId) {
      const captain = await queryOne(
        'SELECT id FROM captains WHERE player_id = $1 AND competition_id = $2', [playerId, compId]
      )
      if (captain) {
        if (!compOnlineCaptains.has(compId)) compOnlineCaptains.set(compId, new Map())
        compOnlineCaptains.get(compId).set(socket.id, captain.id)
        io.to(`comp:${compId}`).emit('captains:online', getOnlineCaptainIds(compId))
      }
    }

    // Send current state
    socket.emit('auction:stateChanged', await getFullAuctionState(compId))
    socket.emit('captains:online', getOnlineCaptainIds(compId))
    socket.emit('captains:ready', getReadyCaptainIds(compId))
    socket.emit('auction:logHistory', await getAuctionLog(compId))
  })

  // ─── Captain Ready ────────────────────────────────────

  socket.on('captain:ready', async () => {
    const compId = socketCompetitions.get(socket.id)
    if (!compId) return socket.emit('auction:error', { message: 'Not in a competition room' })
    const captainId = await getSocketCaptainId(socket.id, compId)
    if (!captainId) return socket.emit('auction:error', { message: 'Not a captain' })
    if (!compReadyCaptains.has(compId)) compReadyCaptains.set(compId, new Set())
    compReadyCaptains.get(compId).add(captainId)
    io.to(`comp:${compId}`).emit('captains:ready', getReadyCaptainIds(compId))
  })

  socket.on('captain:unready', async () => {
    const compId = socketCompetitions.get(socket.id)
    if (!compId) return socket.emit('auction:error', { message: 'Not in a competition room' })
    const captainId = await getSocketCaptainId(socket.id, compId)
    if (!captainId) return socket.emit('auction:error', { message: 'Not a captain' })
    compReadyCaptains.get(compId)?.delete(captainId)
    io.to(`comp:${compId}`).emit('captains:ready', getReadyCaptainIds(compId))
  })

  // ─── Auction: Start ───────────────────────────────────

  socket.on('auction:start', async () => {
    const compId = socketCompetitions.get(socket.id)
    if (!compId) return
    if (!await isAdminSocket(socket.id)) {
      return socket.emit('auction:error', { message: 'Admin access required' })
    }
    const captains = await getCaptains(compId)
    if (captains.length < 2) {
      return socket.emit('auction:error', { message: 'Need at least 2 captains' })
    }

    const comp = await getCompetition(compId)
    const settings = parseCompSettings(comp)

    if (settings.requireAllOnline) {
      const readySet = compReadyCaptains.get(compId) || new Set()
      const allReady = captains.every(c => readySet.has(c.id))
      if (!allReady) {
        return socket.emit('auction:error', { message: 'All captains must be ready before starting' })
      }
    }

    const totalRounds = settings.playersPerTeam * captains.length

    await execute('UPDATE captains SET status = $1 WHERE competition_id = $2', ['Ready', compId])
    await execute(
      'UPDATE competition_players SET drafted = 0, drafted_by = NULL, draft_price = NULL, draft_round = NULL WHERE competition_id = $1',
      [compId]
    )
    await execute('DELETE FROM bid_history WHERE competition_id = $1', [compId])
    await execute('DELETE FROM auction_log WHERE competition_id = $1', [compId])

    const firstNominator = await getNextNominator(compId, 1, await getCaptains(compId), settings)
    await setAuctionState(compId, {
      status: 'nominating',
      currentRound: 1,
      totalRounds,
      nominatorId: firstNominator.id,
      nominatedPlayerId: '',
      currentBid: 0,
      currentBidderId: '',
      bidTimerEnd: 0,
    })

    compReadyCaptains.get(compId)?.clear()
    io.to(`comp:${compId}`).emit('captains:ready', getReadyCaptainIds(compId))
    await saveAuctionLog(compId, 'start', `Draft started with ${captains.length} captains`)
    io.to(`comp:${compId}`).emit('auction:log', { type: 'start', message: `Draft started with ${captains.length} captains` })
    io.to(`comp:${compId}`).emit('auction:started')
    io.to(`comp:${compId}`).emit('auction:stateChanged', await getFullAuctionState(compId))
    io.to(`comp:${compId}`).emit('captains:updated', await getCaptains(compId))
    io.to(`comp:${compId}`).emit('players:updated', await getCompPlayers(compId))
  })

  // ─── Auction: Nominate ─────────────────────────────────

  socket.on('auction:nominate', async ({ playerId, startingBid }) => {
    const compId = socketCompetitions.get(socket.id)
    if (!compId) return
    const captainId = await getSocketCaptainId(socket.id, compId)
    const isAdmin = await isAdminSocket(socket.id)
    const comp = await getCompetition(compId)
    const state = parseAuctionState(comp)

    if (!isAdmin && captainId !== Number(state.nominatorId)) {
      return socket.emit('auction:error', { message: 'Not your turn to nominate' })
    }
    if (state.status !== 'nominating') {
      return socket.emit('auction:error', { message: 'Not in nomination phase' })
    }

    const settings = parseCompSettings(comp)
    const onlineIds = getOnlineCaptainIds(compId)
    const allCaptains = await getCaptains(compId)
    const activeCaptains = []
    for (const c of allCaptains) {
      if (await getCaptainPlayerCount(compId, c.id) < settings.playersPerTeam) activeCaptains.push(c)
    }
    if (settings.requireAllOnline) {
      const allOnline = activeCaptains.every(c => onlineIds.includes(c.id))
      if (!allOnline) {
        const offlineNames = activeCaptains.filter(c => !onlineIds.includes(c.id)).map(c => c.name)
        return socket.emit('auction:error', { message: `Waiting for: ${offlineNames.join(', ')}` })
      }
    }

    const cp = await queryOne(
      'SELECT * FROM competition_players WHERE competition_id = $1 AND player_id = $2 AND drafted = 0',
      [compId, playerId]
    )
    if (!cp) return socket.emit('auction:error', { message: 'Player not available' })

    const nominator = await queryOne('SELECT * FROM captains WHERE id = $1', [state.nominatorId])
    const bid = nominator && nominator.budget === 0 ? 0 : Math.max(settings.minimumBid, Number(startingBid) || settings.minimumBid)

    if (nominator && bid > nominator.budget) {
      return socket.emit('auction:error', { message: `Starting bid ${bid}g exceeds your budget of ${nominator.budget}g` })
    }

    if (nominator && await getCaptainPlayerCount(compId, nominator.id) >= settings.playersPerTeam) {
      return socket.emit('auction:error', { message: 'Your team is already full' })
    }

    await setAuctionState(compId, {
      status: 'bidding',
      nominatedPlayerId: playerId,
      currentBid: bid,
      currentBidderId: state.nominatorId,
    })

    const nominatorName = nominator?.name
    await execute(
      'INSERT INTO bid_history (competition_id, round, player_id, captain_id, captain_name, amount) VALUES ($1, $2, $3, $4, $5, $6)',
      [compId, Number(state.currentRound), playerId, Number(state.nominatorId), nominatorName, bid]
    )

    const player = await queryOne('SELECT name FROM players WHERE id = $1', [playerId])
    await saveAuctionLog(compId, 'nomination', `${nominatorName} nominated ${player.name} for ${bid}g`)
    io.to(`comp:${compId}`).emit('auction:log', { type: 'nomination', message: `${nominatorName} nominated ${player.name} for ${bid}g` })
    await startCompBidTimer(compId)
    io.to(`comp:${compId}`).emit('auction:stateChanged', await getFullAuctionState(compId))
  })

  // ─── Auction: Bid ──────────────────────────────────────

  socket.on('auction:bid', async ({ amount }) => {
    const compId = socketCompetitions.get(socket.id)
    if (!compId) return
    const captainId = await getSocketCaptainId(socket.id, compId)
    if (!captainId) return socket.emit('auction:error', { message: 'Not authorized to bid' })

    const now = Date.now()
    const lastBid = compLastBidTime.get(compId) || 0
    if (now - lastBid < BID_COOLDOWN_MS) {
      return socket.emit('auction:error', { message: 'Too fast! Wait a moment.' })
    }

    const comp = await getCompetition(compId)
    const state = parseAuctionState(comp)
    if (state.status !== 'bidding') {
      return socket.emit('auction:error', { message: 'Not in bidding phase' })
    }

    const captain = await queryOne('SELECT * FROM captains WHERE id = $1', [captainId])
    if (!captain) return socket.emit('auction:error', { message: 'Captain not found' })

    const settings = parseCompSettings(comp)
    if (await getCaptainPlayerCount(compId, captainId) >= settings.playersPerTeam) {
      return socket.emit('auction:error', { message: 'Your team is already full' })
    }

    const currentBid = Number(state.currentBid)
    if (amount <= currentBid) return socket.emit('auction:error', { message: `Bid must be higher than ${currentBid}g` })
    if (amount - currentBid < settings.bidIncrement) return socket.emit('auction:error', { message: `Minimum increment is ${settings.bidIncrement}g` })
    if (amount > captain.budget) return socket.emit('auction:error', { message: 'Insufficient budget' })
    if (settings.maxBid > 0 && amount > settings.maxBid) return socket.emit('auction:error', { message: `Max bid is ${settings.maxBid}g` })

    await setAuctionState(compId, { currentBid: amount, currentBidderId: captainId })
    compLastBidTime.set(compId, Date.now())

    await execute(
      'INSERT INTO bid_history (competition_id, round, player_id, captain_id, captain_name, amount) VALUES ($1, $2, $3, $4, $5, $6)',
      [compId, Number(state.currentRound), Number(state.nominatedPlayerId), captainId, captain.name, amount]
    )

    const bidPlayer = await queryOne('SELECT name FROM players WHERE id = $1', [state.nominatedPlayerId])
    await saveAuctionLog(compId, 'bid', `${captain.name} bid ${amount}g on ${bidPlayer?.name}`)
    io.to(`comp:${compId}`).emit('auction:log', { type: 'bid', message: `${captain.name} bid ${amount}g on ${bidPlayer?.name}` })
    await startCompBidTimer(compId)
    io.to(`comp:${compId}`).emit('auction:stateChanged', await getFullAuctionState(compId))
  })

  // ─── Auction: Pause / Resume / End / Undo / Reset ─────

  socket.on('auction:pause', async () => {
    const compId = socketCompetitions.get(socket.id)
    if (!compId) return
    if (!await isAdminSocket(socket.id)) return socket.emit('auction:error', { message: 'Admin access required' })
    clearCompBidTimer(compId)
    await setAuctionState(compId, { bidTimerEnd: 0, status: 'paused' })
    await saveAuctionLog(compId, 'pause', 'Auction paused by admin')
    io.to(`comp:${compId}`).emit('auction:log', { type: 'pause', message: 'Auction paused by admin' })
    io.to(`comp:${compId}`).emit('auction:stateChanged', await getFullAuctionState(compId))
  })

  socket.on('auction:resume', async () => {
    const compId = socketCompetitions.get(socket.id)
    if (!compId) return
    if (!await isAdminSocket(socket.id)) return socket.emit('auction:error', { message: 'Admin access required' })
    const comp = await getCompetition(compId)
    const state = parseAuctionState(comp)
    if (state.nominatedPlayerId) {
      await setAuctionState(compId, { status: 'bidding' })
      await startCompBidTimer(compId)
    } else {
      await setAuctionState(compId, { status: 'nominating' })
    }
    await saveAuctionLog(compId, 'resume', 'Auction resumed by admin')
    io.to(`comp:${compId}`).emit('auction:log', { type: 'resume', message: 'Auction resumed by admin' })
    io.to(`comp:${compId}`).emit('auction:stateChanged', await getFullAuctionState(compId))
  })

  socket.on('auction:end', async () => {
    const compId = socketCompetitions.get(socket.id)
    if (!compId) return
    if (!await isAdminSocket(socket.id)) return socket.emit('auction:error', { message: 'Admin access required' })
    clearCompBidTimer(compId)
    await setAuctionState(compId, {
      status: 'finished', nominatedPlayerId: '', currentBid: 0, currentBidderId: '',
    })
    await saveAuctionLog(compId, 'end', 'Draft ended by admin')
    io.to(`comp:${compId}`).emit('auction:log', { type: 'end', message: 'Draft ended by admin' })
    io.to(`comp:${compId}`).emit('auction:finished', { results: 'Draft ended by admin' })
    io.to(`comp:${compId}`).emit('auction:stateChanged', await getFullAuctionState(compId))
  })

  socket.on('auction:undo', async () => {
    const compId = socketCompetitions.get(socket.id)
    if (!compId) return
    if (!await isAdminSocket(socket.id)) return socket.emit('auction:error', { message: 'Admin access required' })

    const comp = await getCompetition(compId)
    const state = parseAuctionState(comp)
    const settings = parseCompSettings(comp)

    // Case 1: Currently in bidding or paused with a nomination
    if (state.status === 'bidding' || (state.status === 'paused' && state.nominatedPlayerId)) {
      clearCompBidTimer(compId)
      const nominatedPlayer = await queryOne('SELECT name FROM players WHERE id = $1', [state.nominatedPlayerId])
      await execute('DELETE FROM bid_history WHERE competition_id = $1 AND round = $2', [compId, Number(state.currentRound)])
      await setAuctionState(compId, {
        status: 'nominating', nominatedPlayerId: '', currentBid: 0, currentBidderId: '', bidTimerEnd: 0,
      })
      io.to(`comp:${compId}`).emit('auction:undone', { message: `Nomination of ${nominatedPlayer?.name || 'player'} was cancelled` })
      await saveAuctionLog(compId, 'undo', `Undo: nomination of ${nominatedPlayer?.name || 'player'} cancelled`)
      io.to(`comp:${compId}`).emit('auction:log', { type: 'undo', message: `Undo: nomination of ${nominatedPlayer?.name || 'player'} cancelled` })
      io.to(`comp:${compId}`).emit('auction:stateChanged', await getFullAuctionState(compId))
      return
    }

    // Case 2: In nominating, paused without nomination, or finished
    if (state.status === 'nominating' || state.status === 'finished' || state.status === 'paused') {
      const currentRound = Number(state.currentRound)
      const prevRound = state.status === 'finished' ? currentRound : currentRound - 1
      if (prevRound < 1) return socket.emit('auction:error', { message: 'Nothing to undo' })

      const lastBid = await queryOne(
        'SELECT * FROM bid_history WHERE competition_id = $1 AND round = $2 ORDER BY id DESC LIMIT 1',
        [compId, prevRound]
      )
      if (!lastBid) return socket.emit('auction:error', { message: 'Nothing to undo' })

      const cp = await queryOne(
        'SELECT * FROM competition_players WHERE competition_id = $1 AND player_id = $2',
        [compId, lastBid.player_id]
      )
      if (!cp || !cp.drafted) return socket.emit('auction:error', { message: 'Nothing to undo' })

      const buyer = await queryOne('SELECT name FROM captains WHERE id = $1', [cp.drafted_by])
      const playerName = (await queryOne('SELECT name FROM players WHERE id = $1', [lastBid.player_id]))?.name
      const undoMsg = `${playerName} (${cp.draft_price}g from ${buyer?.name || 'unknown'}) was reversed`

      await execute('UPDATE captains SET budget = budget + $1 WHERE id = $2', [cp.draft_price, cp.drafted_by])
      await execute(
        'UPDATE competition_players SET drafted = 0, drafted_by = NULL, draft_price = NULL, draft_round = NULL WHERE id = $1',
        [cp.id]
      )
      await execute('DELETE FROM bid_history WHERE competition_id = $1 AND round = $2', [compId, prevRound])

      const captains = await getCaptains(compId)
      const nextNominator = await getNextNominator(compId, prevRound, captains, settings)
      await setAuctionState(compId, {
        status: 'nominating',
        currentRound: prevRound,
        nominatorId: nextNominator.id,
        nominatedPlayerId: '',
        currentBid: 0,
        currentBidderId: '',
        bidTimerEnd: 0,
      })

      io.to(`comp:${compId}`).emit('auction:undone', { message: undoMsg })
      await saveAuctionLog(compId, 'undo', `Undo: ${undoMsg}`)
      io.to(`comp:${compId}`).emit('auction:log', { type: 'undo', message: `Undo: ${undoMsg}` })
      io.to(`comp:${compId}`).emit('auction:stateChanged', await getFullAuctionState(compId))
      io.to(`comp:${compId}`).emit('captains:updated', await getCaptains(compId))
      io.to(`comp:${compId}`).emit('players:updated', await getCompPlayers(compId))
      return
    }

    socket.emit('auction:error', { message: 'Nothing to undo' })
  })

  socket.on('auction:reset', async () => {
    const compId = socketCompetitions.get(socket.id)
    if (!compId) return
    if (!await isAdminSocket(socket.id)) return socket.emit('auction:error', { message: 'Admin access required' })

    clearCompBidTimer(compId)
    compReadyCaptains.get(compId)?.clear()

    const comp = await getCompetition(compId)
    const settings = parseCompSettings(comp)
    await execute('UPDATE captains SET budget = $1, status = $2 WHERE competition_id = $3', [settings.startingBudget, 'Waiting', compId])
    await execute(
      'UPDATE competition_players SET drafted = 0, drafted_by = NULL, draft_price = NULL, draft_round = NULL WHERE competition_id = $1',
      [compId]
    )
    await execute('DELETE FROM bid_history WHERE competition_id = $1', [compId])
    await execute('DELETE FROM auction_log WHERE competition_id = $1', [compId])
    await setAuctionState(compId, {
      status: 'idle', currentRound: 0, nominatorId: '', nominatedPlayerId: '',
      currentBid: 0, currentBidderId: '', bidTimerEnd: 0, totalRounds: 0,
    })

    io.to(`comp:${compId}`).emit('captains:ready', getReadyCaptainIds(compId))
    io.to(`comp:${compId}`).emit('auction:stateChanged', await getFullAuctionState(compId))
    io.to(`comp:${compId}`).emit('captains:updated', await getCaptains(compId))
    io.to(`comp:${compId}`).emit('players:updated', await getCompPlayers(compId))
  })

  // ─── Disconnect ────────────────────────────────────────

  socket.on('disconnect', () => {
    const compId = socketCompetitions.get(socket.id)
    socketPlayers.delete(socket.id)
    socketCompetitions.delete(socket.id)

    if (compId) {
      const onlineMap = compOnlineCaptains.get(compId)
      if (onlineMap) {
        const captainId = onlineMap.get(socket.id)
        onlineMap.delete(socket.id)
        if (captainId) {
          compReadyCaptains.get(compId)?.delete(captainId)
          io.to(`comp:${compId}`).emit('captains:ready', getReadyCaptainIds(compId))
        }
        io.to(`comp:${compId}`).emit('captains:online', getOnlineCaptainIds(compId))
      }
    }

    console.log(`Client disconnected: ${socket.id}`)
  })
})

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
