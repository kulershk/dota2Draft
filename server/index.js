import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import fs from 'fs'
import multer from 'multer'
import jwt from 'jsonwebtoken'
import pool, { query, queryOne, execute, initDb } from './db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const app = express()
app.set('trust proxy', true)
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

// ─── Session Management (JWT) ────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex')
const JWT_EXPIRY = '30d'

function createSession(playerId) {
  return jwt.sign({ playerId }, JWT_SECRET, { expiresIn: JWT_EXPIRY })
}

function getSessionPlayerId(token) {
  if (!token) return null
  try {
    const payload = jwt.verify(token, JWT_SECRET)
    return payload.playerId
  } catch {
    return null
  }
}

function getTokenFromReq(req) {
  return req.headers.authorization?.replace('Bearer ', '') || null
}

async function getAuthPlayer(req) {
  const playerId = getSessionPlayerId(getTokenFromReq(req))
  if (!playerId) return null
  return await queryOne('SELECT * FROM players WHERE id = $1', [playerId])
}

// ─── Permission Helpers ──────────────────────────────────

const ALL_PERMISSIONS = [
  'manage_competitions',
  'manage_own_competitions',
  'manage_users',
  'manage_news',
  'manage_site_settings',
  'manage_captains',
  'manage_players',
  'manage_auction',
  'manage_permissions',
]

async function getPlayerPermissions(playerId) {
  const rows = await query(`
    SELECT DISTINCT pg.permissions FROM permission_groups pg
    JOIN player_permission_groups ppg ON ppg.group_id = pg.id
    WHERE ppg.player_id = $1
  `, [playerId])
  const perms = new Set()
  for (const r of rows) {
    const list = r.permissions || []
    for (const p of list) perms.add(p)
  }
  return perms
}

async function hasPermission(player, permission) {
  if (!player) return false
  if (player.is_admin) return true
  const perms = await getPlayerPermissions(player.id)
  return perms.has(permission)
}

async function requirePermission(req, res, permission) {
  const player = await getAuthPlayer(req)
  if (!player) { res.status(401).json({ error: 'Not authenticated' }); return null }
  const allowed = await hasPermission(player, permission)
  if (!allowed) { res.status(403).json({ error: 'Permission denied' }); return null }
  return player
}

// Check competition permission: manage_competitions (all) or manage_own_competitions (own only)
// Also accepts a specific sub-permission (e.g. manage_players, manage_captains) for non-owners
async function requireCompPermission(req, res, compId, subPermission) {
  const player = await getAuthPlayer(req)
  if (!player) { res.status(401).json({ error: 'Not authenticated' }); return null }
  // Root admin or manage_competitions = full access
  if (await hasPermission(player, 'manage_competitions')) return player
  // Check sub-permission (e.g. manage_players, manage_captains)
  if (subPermission && await hasPermission(player, subPermission)) return player
  // manage_own_competitions = access only to own competitions
  if (await hasPermission(player, 'manage_own_competitions')) {
    if (!compId) return player // creating new competition
    const comp = await getCompetition(compId)
    if (comp && comp.created_by === player.id) return player
  }
  res.status(403).json({ error: 'Permission denied' })
  return null
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
  const player = await queryOne('SELECT * FROM players WHERE id = $1', [playerId])
  return await hasPermission(player, 'manage_auction')
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

  const permissions = player.is_admin
    ? ALL_PERMISSIONS
    : [...await getPlayerPermissions(player.id)]

  res.json({
    id: player.id,
    name: player.name,
    steam_id: player.steam_id,
    avatar_url: player.avatar_url,
    is_admin: !!player.is_admin,
    permissions,
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
  // JWT is stateless; client removes the token
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
  const admin = await requireCompPermission(req, res, null)
  if (!admin) return

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
  const admin = await requireCompPermission(req, res, Number(req.params.id))
  if (!admin) return

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
  const admin = await requireCompPermission(req, res, Number(req.params.id))
  if (!admin) return

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
  const compId = Number(req.params.compId)
  const admin = await requireCompPermission(req, res, compId, 'manage_players')
  if (!admin) return
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
  const compId = Number(req.params.compId)
  const admin = await requireCompPermission(req, res, compId, 'manage_players')
  if (!admin) return
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
  const compId = Number(req.params.compId)
  const admin = await requireCompPermission(req, res, compId, 'manage_captains')
  if (!admin) return

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

// ─── REST API: Tournament ────────────────────────────────

// Helper: advance winner to next match in bracket (and loser to lower bracket if double elim)
async function advanceWinner(matchId, winnerId) {
  const match = await queryOne('SELECT * FROM matches WHERE id = $1', [matchId])
  if (!match) return

  // Advance winner
  if (match.next_match_id) {
    const col = match.next_match_slot === 1 ? 'team1_captain_id' : 'team2_captain_id'
    await execute(`UPDATE matches SET ${col} = $1 WHERE id = $2`, [winnerId, match.next_match_id])
  }

  // Advance loser to lower bracket (double elimination)
  if (match.loser_next_match_id) {
    const loserId = match.team1_captain_id === winnerId ? match.team2_captain_id : match.team1_captain_id
    if (loserId) {
      const col = match.loser_next_match_slot === 1 ? 'team1_captain_id' : 'team2_captain_id'
      await execute(`UPDATE matches SET ${col} = $1 WHERE id = $2`, [loserId, match.loser_next_match_id])
      // Auto-complete if the other slot already has a BYE situation (only one team)
    }
  }
}

// Helper: generate elimination bracket matches for a stage
async function generateEliminationBracket(compId, stageId, teamIds, bestOf) {
  const n = teamIds.length
  let bracketSize = 1
  while (bracketSize < n) bracketSize *= 2
  const totalRounds = Math.log2(bracketSize)

  const matchesByRound = {}
  for (let round = totalRounds; round >= 1; round--) {
    const matchCount = bracketSize / Math.pow(2, round)
    matchesByRound[round] = []
    for (let i = 0; i < matchCount; i++) {
      const m = await queryOne(
        `INSERT INTO matches (competition_id, stage, round, match_order, best_of, status)
         VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id`,
        [compId, stageId, round, i, bestOf]
      )
      matchesByRound[round].push(m.id)
    }
  }

  // Link matches
  for (let round = 1; round < totalRounds; round++) {
    const ids = matchesByRound[round]
    for (let i = 0; i < ids.length; i++) {
      const nextMatchId = matchesByRound[round + 1][Math.floor(i / 2)]
      const nextSlot = (i % 2) + 1
      await execute('UPDATE matches SET next_match_id = $1, next_match_slot = $2 WHERE id = $3',
        [nextMatchId, nextSlot, ids[i]])
    }
  }

  // Seed teams into round 1
  const round1 = matchesByRound[1]
  for (let i = 0; i < bracketSize; i++) {
    const captainId = i < n ? teamIds[i] : null
    const matchIdx = Math.floor(i / 2)
    const slot = (i % 2) + 1
    if (captainId) {
      const col = slot === 1 ? 'team1_captain_id' : 'team2_captain_id'
      await execute(`UPDATE matches SET ${col} = $1 WHERE id = $2`, [captainId, round1[matchIdx]])
    }
  }

  // Handle byes
  for (const matchId of round1) {
    const m = await queryOne('SELECT * FROM matches WHERE id = $1', [matchId])
    if (m.team1_captain_id && !m.team2_captain_id) {
      await execute("UPDATE matches SET winner_captain_id = $1, status = 'completed', score1 = 1, score2 = 0 WHERE id = $2",
        [m.team1_captain_id, matchId])
      await advanceWinner(matchId, m.team1_captain_id)
    } else if (!m.team1_captain_id && m.team2_captain_id) {
      await execute("UPDATE matches SET winner_captain_id = $1, status = 'completed', score1 = 0, score2 = 1 WHERE id = $2",
        [m.team2_captain_id, matchId])
      await advanceWinner(matchId, m.team2_captain_id)
    }
  }

  return { bracketSize, totalRounds }
}

// Helper: generate group stage matches for a stage
async function generateGroupMatches(compId, stageId, groups, bestOf) {
  for (const group of groups) {
    const teamIds = group.teamIds
    let order = 0
    for (let i = 0; i < teamIds.length; i++) {
      for (let j = i + 1; j < teamIds.length; j++) {
        await execute(
          `INSERT INTO matches (competition_id, stage, round, match_order, group_name, team1_captain_id, team2_captain_id, best_of, status)
           VALUES ($1, $2, 1, $3, $4, $5, $6, $7, 'pending')`,
          [compId, stageId, order++, group.name, teamIds[i], teamIds[j], bestOf]
        )
      }
    }
  }
}

// Helper: generate double elimination bracket (upper + lower + grand finals)
async function generateDoubleEliminationBracket(compId, stageId, teamIds, bestOf) {
  const n = teamIds.length
  let bracketSize = 1
  while (bracketSize < n) bracketSize *= 2
  const ubRounds = Math.log2(bracketSize) // upper bracket rounds

  // --- Upper Bracket ---
  const ubByRound = {}
  for (let round = ubRounds; round >= 1; round--) {
    const matchCount = bracketSize / Math.pow(2, round)
    ubByRound[round] = []
    for (let i = 0; i < matchCount; i++) {
      const m = await queryOne(
        `INSERT INTO matches (competition_id, stage, round, match_order, best_of, status, bracket)
         VALUES ($1, $2, $3, $4, $5, 'pending', 'upper') RETURNING id`,
        [compId, stageId, round, i, bestOf]
      )
      ubByRound[round].push(m.id)
    }
  }

  // Link upper bracket matches (winner advances up)
  for (let round = 1; round < ubRounds; round++) {
    const ids = ubByRound[round]
    for (let i = 0; i < ids.length; i++) {
      const nextMatchId = ubByRound[round + 1][Math.floor(i / 2)]
      const nextSlot = (i % 2) + 1
      await execute('UPDATE matches SET next_match_id = $1, next_match_slot = $2 WHERE id = $3',
        [nextMatchId, nextSlot, ids[i]])
    }
  }

  // --- Lower Bracket ---
  // Lower bracket has (ubRounds - 1) * 2 rounds for a standard double elim
  // Round structure: for each UB round (except finals), losers drop down
  // LB round 1: losers from UB round 1 (bracketSize/2 teams → bracketSize/4 matches)
  // Then alternating: "minor" rounds (only LB teams) and "major" rounds (LB teams + new UB dropdowns)
  // Total LB rounds = (ubRounds - 1) * 2
  const lbTotalRounds = Math.max((ubRounds - 1) * 2, 1)
  const lbByRound = {}

  // Calculate LB match counts per round
  // LB round 1: bracketSize/4 matches (losers from UB R1 paired up)
  // LB round 2: bracketSize/4 matches (LB R1 winners vs UB R2 losers)
  // LB round 3: bracketSize/8 matches
  // LB round 4: bracketSize/8 matches (LB R3 winners vs UB R3 losers)
  // Pattern: odd rounds halve, even rounds stay same as previous odd
  let lbMatchCount = bracketSize / 4
  const lbMatchCounts = {}
  for (let lr = 1; lr <= lbTotalRounds; lr++) {
    lbMatchCounts[lr] = Math.max(lbMatchCount, 1)
    if (lr % 2 === 0) {
      lbMatchCount = Math.max(Math.floor(lbMatchCount / 2), 1)
    }
  }

  // Create LB matches
  for (let lr = 1; lr <= lbTotalRounds; lr++) {
    lbByRound[lr] = []
    for (let i = 0; i < lbMatchCounts[lr]; i++) {
      const m = await queryOne(
        `INSERT INTO matches (competition_id, stage, round, match_order, best_of, status, bracket)
         VALUES ($1, $2, $3, $4, $5, 'pending', 'lower') RETURNING id`,
        [compId, stageId, 100 + lr, i, bestOf]
      )
      lbByRound[lr].push(m.id)
    }
  }

  // Link LB matches (winner advances within LB)
  for (let lr = 1; lr < lbTotalRounds; lr++) {
    const ids = lbByRound[lr]
    const nextIds = lbByRound[lr + 1]
    for (let i = 0; i < ids.length; i++) {
      let nextIdx, nextSlot
      if (lr % 2 === 1) {
        // Odd LB round → next round has same count, 1-to-1
        nextIdx = i
        nextSlot = 1 // LB survivor goes to slot 1, UB dropout goes to slot 2
      } else {
        // Even LB round → next round has half count
        nextIdx = Math.floor(i / 2)
        nextSlot = (i % 2) + 1
      }
      if (nextIdx < nextIds.length) {
        await execute('UPDATE matches SET next_match_id = $1, next_match_slot = $2 WHERE id = $3',
          [nextIds[nextIdx], nextSlot, ids[i]])
      }
    }
  }

  // Link UB losers to LB
  // UB R1 losers → LB R1 (paired up)
  if (ubByRound[1]) {
    const ubR1 = ubByRound[1]
    for (let i = 0; i < ubR1.length; i++) {
      const lbIdx = Math.floor(i / 2)
      const lbSlot = (i % 2) + 1
      if (lbByRound[1] && lbIdx < lbByRound[1].length) {
        await execute('UPDATE matches SET loser_next_match_id = $1, loser_next_match_slot = $2 WHERE id = $3',
          [lbByRound[1][lbIdx], lbSlot, ubR1[i]])
      }
    }
  }

  // UB R2+ losers → LB even rounds (slot 2)
  for (let ubr = 2; ubr <= ubRounds; ubr++) {
    const lbTargetRound = (ubr - 1) * 2 // UB R2→LB R2, UB R3→LB R4, etc.
    if (ubByRound[ubr] && lbByRound[lbTargetRound]) {
      const ubIds = ubByRound[ubr]
      const lbIds = lbByRound[lbTargetRound]
      for (let i = 0; i < ubIds.length && i < lbIds.length; i++) {
        await execute('UPDATE matches SET loser_next_match_id = $1, loser_next_match_slot = $2 WHERE id = $3',
          [lbIds[i], 2, ubIds[i]])
      }
    }
  }

  // --- Grand Finals ---
  const gf = await queryOne(
    `INSERT INTO matches (competition_id, stage, round, match_order, best_of, status, bracket)
     VALUES ($1, $2, $3, 0, $4, 'pending', 'grand_finals') RETURNING id`,
    [compId, stageId, 200, bestOf]
  )

  // UB finals winner → GF slot 1
  const ubFinalId = ubByRound[ubRounds][0]
  await execute('UPDATE matches SET next_match_id = $1, next_match_slot = 1 WHERE id = $2', [gf.id, ubFinalId])

  // LB finals winner → GF slot 2
  const lbFinalId = lbByRound[lbTotalRounds][0]
  await execute('UPDATE matches SET next_match_id = $1, next_match_slot = 2 WHERE id = $2', [gf.id, lbFinalId])

  // UB finals loser → LB finals (last LB round, slot 2)
  await execute('UPDATE matches SET loser_next_match_id = $1, loser_next_match_slot = 2 WHERE id = $2',
    [lbFinalId, ubFinalId])

  // Seed teams into UB round 1
  const round1 = ubByRound[1]
  for (let i = 0; i < bracketSize; i++) {
    const captainId = i < n ? teamIds[i] : null
    const matchIdx = Math.floor(i / 2)
    const slot = (i % 2) + 1
    if (captainId) {
      const col = slot === 1 ? 'team1_captain_id' : 'team2_captain_id'
      await execute(`UPDATE matches SET ${col} = $1 WHERE id = $2`, [captainId, round1[matchIdx]])
    }
  }

  // Handle byes in UB round 1
  for (const matchId of round1) {
    const m = await queryOne('SELECT * FROM matches WHERE id = $1', [matchId])
    if (m.team1_captain_id && !m.team2_captain_id) {
      await execute("UPDATE matches SET winner_captain_id = $1, status = 'completed', score1 = 1, score2 = 0 WHERE id = $2",
        [m.team1_captain_id, matchId])
      await advanceWinner(matchId, m.team1_captain_id)
    } else if (!m.team1_captain_id && m.team2_captain_id) {
      await execute("UPDATE matches SET winner_captain_id = $1, status = 'completed', score1 = 0, score2 = 1 WHERE id = $2",
        [m.team2_captain_id, matchId])
      await advanceWinner(matchId, m.team2_captain_id)
    }
  }

  return { bracketSize, ubRounds, lbTotalRounds }
}

// Get tournament data (public)
app.get('/api/competitions/:compId/tournament', async (req, res) => {
  const compId = Number(req.params.compId)
  const comp = await getCompetition(compId)
  if (!comp) return res.status(404).json({ error: 'Competition not found' })

  const matches = await query(`
    SELECT m.*,
      t1.team AS team1_name, t1.name AS team1_captain, COALESCE(p1.avatar_url, '') AS team1_avatar, t1.banner_url AS team1_banner,
      t2.team AS team2_name, t2.name AS team2_captain, COALESCE(p2.avatar_url, '') AS team2_avatar, t2.banner_url AS team2_banner,
      w.team AS winner_name
    FROM matches m
    LEFT JOIN captains t1 ON t1.id = m.team1_captain_id
    LEFT JOIN players p1 ON p1.id = t1.player_id
    LEFT JOIN captains t2 ON t2.id = m.team2_captain_id
    LEFT JOIN players p2 ON p2.id = t2.player_id
    LEFT JOIN captains w ON w.id = m.winner_captain_id
    WHERE m.competition_id = $1
    ORDER BY m.stage, m.round, m.match_order
  `, [compId])

  const games = await query(`
    SELECT mg.*, w.team AS winner_name
    FROM match_games mg
    JOIN matches m ON m.id = mg.match_id
    LEFT JOIN captains w ON w.id = mg.winner_captain_id
    WHERE m.competition_id = $1
    ORDER BY mg.match_id, mg.game_number
  `, [compId])

  const gamesByMatch = {}
  for (const g of games) {
    if (!gamesByMatch[g.match_id]) gamesByMatch[g.match_id] = []
    gamesByMatch[g.match_id].push(g)
  }

  res.json({
    tournament_state: comp.tournament_state || {},
    matches: matches.map(m => ({ ...m, games: gamesByMatch[m.id] || [] })),
  })
})

// Add a stage to the tournament (admin)
app.post('/api/competitions/:compId/tournament/stages', async (req, res) => {
  const compId = Number(req.params.compId)
  const admin = await requireCompPermission(req, res, compId)
  if (!admin) return

  const comp = await getCompetition(compId)
  if (!comp) return res.status(404).json({ error: 'Competition not found' })

  const { name, format, groups, bestOf = 3, seeds } = req.body
  if (!format || !['single_elimination', 'double_elimination', 'group_stage'].includes(format)) {
    return res.status(400).json({ error: 'Invalid format' })
  }

  const ts = comp.tournament_state || {}
  if (!ts.stages) ts.stages = []

  const stageId = (ts.stages.length > 0 ? Math.max(...ts.stages.map(s => s.id)) : 0) + 1
  const stage = { id: stageId, name: name || `Stage ${stageId}`, format, status: 'pending', bestOf }

  const captainsList = await getCaptains(compId)

  if (format === 'single_elimination') {
    // Use provided seeds or default order
    const teamIds = seeds || captainsList.map(c => c.id)
    if (teamIds.length < 2) return res.status(400).json({ error: 'Need at least 2 teams' })
    const { bracketSize, totalRounds } = await generateEliminationBracket(compId, stageId, teamIds, bestOf)
    stage.bracketSize = bracketSize
    stage.totalRounds = totalRounds
    stage.status = 'active'
  } else if (format === 'double_elimination') {
    const teamIds = seeds || captainsList.map(c => c.id)
    if (teamIds.length < 3) return res.status(400).json({ error: 'Need at least 3 teams for double elimination' })
    const { bracketSize, ubRounds, lbTotalRounds } = await generateDoubleEliminationBracket(compId, stageId, teamIds, bestOf)
    stage.bracketSize = bracketSize
    stage.ubRounds = ubRounds
    stage.lbTotalRounds = lbTotalRounds
    stage.status = 'active'
  } else {
    if (!groups || !Array.isArray(groups) || groups.length === 0) {
      return res.status(400).json({ error: 'Groups required for group stage' })
    }
    stage.groups = groups
    await generateGroupMatches(compId, stageId, groups, bestOf)
    stage.status = 'active'
  }

  ts.stages.push(stage)
  await execute('UPDATE competitions SET tournament_state = $1 WHERE id = $2', [JSON.stringify(ts), compId])

  io.to(`comp:${compId}`).emit('tournament:updated')
  res.json({ ok: true, stageId })
})

// Delete a specific stage (admin)
app.delete('/api/competitions/:compId/tournament/stages/:stageId', async (req, res) => {
  const compId = Number(req.params.compId)
  const stageId = Number(req.params.stageId)
  const admin = await requireCompPermission(req, res, compId)
  if (!admin) return

  const comp = await getCompetition(compId)
  if (!comp) return res.status(404).json({ error: 'Competition not found' })

  const ts = comp.tournament_state || {}
  if (!ts.stages) return res.status(404).json({ error: 'No stages' })

  ts.stages = ts.stages.filter(s => s.id !== stageId)
  await execute('DELETE FROM matches WHERE competition_id = $1 AND stage = $2', [compId, stageId])
  await execute('UPDATE competitions SET tournament_state = $1 WHERE id = $2', [JSON.stringify(ts), compId])

  io.to(`comp:${compId}`).emit('tournament:updated')
  res.json({ ok: true })
})

// Update match score (admin)
app.put('/api/competitions/:compId/tournament/matches/:matchId/score', async (req, res) => {
  const compId = Number(req.params.compId)
  const matchId = Number(req.params.matchId)
  const admin = await requireCompPermission(req, res, compId)
  if (!admin) return

  const match = await queryOne('SELECT * FROM matches WHERE id = $1 AND competition_id = $2', [matchId, compId])
  if (!match) return res.status(404).json({ error: 'Match not found' })

  const { score1, score2, games, status } = req.body

  let winnerId = null
  if (score1 != null && score2 != null) {
    if (score1 > score2) winnerId = match.team1_captain_id
    else if (score2 > score1) winnerId = match.team2_captain_id
  }

  const newStatus = status || (winnerId ? 'completed' : match.status)

  await execute(
    `UPDATE matches SET score1 = $1, score2 = $2, winner_captain_id = $3, status = $4 WHERE id = $5`,
    [score1 ?? match.score1, score2 ?? match.score2, winnerId, newStatus, matchId]
  )

  if (games && Array.isArray(games)) {
    for (const game of games) {
      await execute(`
        INSERT INTO match_games (match_id, game_number, winner_captain_id, dotabuff_id, duration_minutes)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (match_id, game_number) DO UPDATE SET
          winner_captain_id = $3, dotabuff_id = $4, duration_minutes = $5
      `, [matchId, game.game_number, game.winner_captain_id || null, game.dotabuff_id || null, game.duration_minutes || null])
    }
  }

  // Auto-advance winner (and loser in double elimination) in bracket
  if (winnerId && (match.next_match_id || match.loser_next_match_id)) {
    await advanceWinner(matchId, winnerId)
  }

  // Check if stage is completed (all matches in that stage done)
  const comp = await getCompetition(compId)
  const ts = comp.tournament_state || {}
  if (ts.stages) {
    const stage = ts.stages.find(s => s.id === match.stage)
    if (stage) {
      const stageMatches = await query(
        "SELECT id FROM matches WHERE competition_id = $1 AND stage = $2 AND status != 'completed'",
        [compId, match.stage]
      )
      if (stageMatches.length === 0) {
        stage.status = 'completed'
        await execute('UPDATE competitions SET tournament_state = $1 WHERE id = $2', [JSON.stringify(ts), compId])
      }
    }
  }

  io.to(`comp:${compId}`).emit('tournament:updated')
  res.json({ ok: true })
})

// Reset entire tournament (admin)
app.delete('/api/competitions/:compId/tournament', async (req, res) => {
  const compId = Number(req.params.compId)
  const admin = await requireCompPermission(req, res, compId)
  if (!admin) return

  await execute('DELETE FROM matches WHERE competition_id = $1', [compId])
  await execute("UPDATE competitions SET tournament_state = '{}' WHERE id = $1", [compId])

  io.to(`comp:${compId}`).emit('tournament:updated')
  res.json({ ok: true })
})

// Admin: add user to competition pool
app.post('/api/competitions/:compId/users/:userId/add-to-pool', async (req, res) => {
  const compId = Number(req.params.compId)
  const admin = await requireCompPermission(req, res, compId, 'manage_players')
  if (!admin) return
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
  const compId = Number(req.params.compId)
  const admin = await requireCompPermission(req, res, compId, 'manage_players')
  if (!admin) return
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

// ─── Permission Groups ────────────────────────────────────

app.get('/api/permissions/all', (req, res) => {
  res.json(ALL_PERMISSIONS)
})

app.get('/api/permission-groups', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_permissions')
  if (!admin) return
  const groups = await query('SELECT * FROM permission_groups ORDER BY name')
  res.json(groups.map(g => ({ ...g, permissions: g.permissions || [] })))
})

app.post('/api/permission-groups', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_permissions')
  if (!admin) return
  const { name, permissions } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })
  const group = await queryOne(
    'INSERT INTO permission_groups (name, permissions) VALUES ($1, $2) RETURNING *',
    [name.trim(), JSON.stringify(permissions || [])]
  )
  res.json({ ...group, permissions: group.permissions || [] })
})

app.put('/api/permission-groups/:id', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_permissions')
  if (!admin) return
  const { name, permissions } = req.body
  await execute(
    'UPDATE permission_groups SET name = COALESCE($1, name), permissions = COALESCE($2, permissions) WHERE id = $3',
    [name?.trim() || null, permissions ? JSON.stringify(permissions) : null, req.params.id]
  )
  const group = await queryOne('SELECT * FROM permission_groups WHERE id = $1', [req.params.id])
  res.json({ ...group, permissions: group.permissions || [] })
})

app.delete('/api/permission-groups/:id', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_permissions')
  if (!admin) return
  await execute('DELETE FROM permission_groups WHERE id = $1', [req.params.id])
  res.json({ ok: true })
})

app.get('/api/players/:id/groups', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_permissions')
  if (!admin) return
  const groups = await query(`
    SELECT pg.* FROM permission_groups pg
    JOIN player_permission_groups ppg ON ppg.group_id = pg.id
    WHERE ppg.player_id = $1
  `, [req.params.id])
  res.json(groups.map(g => ({ ...g, permissions: g.permissions || [] })))
})

app.put('/api/players/:id/groups', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_permissions')
  if (!admin) return
  const { groupIds } = req.body
  const playerId = req.params.id
  await execute('DELETE FROM player_permission_groups WHERE player_id = $1', [playerId])
  for (const gid of (groupIds || [])) {
    await execute(
      'INSERT INTO player_permission_groups (player_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [playerId, gid]
    )
  }
  res.json({ ok: true })
})

// ─── Site Settings ────────────────────────────────────────
app.get('/api/site-settings', async (req, res) => {
  const rows = await query("SELECT key, value FROM settings WHERE key LIKE 'site_%'")
  const obj = {}
  for (const r of rows) obj[r.key] = r.value
  res.json({
    site_title: obj.site_title || '',
    site_subtitle: obj.site_subtitle || '',
    site_discord_url: obj.site_discord_url || '',
    site_name: obj.site_name || '',
    site_logo_url: obj.site_logo_url || '',
  })
})

app.put('/api/site-settings', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_site_settings')
  if (!admin) return
  const { site_title, site_subtitle, site_discord_url, site_name } = req.body
  for (const [key, value] of [['site_title', site_title], ['site_subtitle', site_subtitle], ['site_discord_url', site_discord_url], ['site_name', site_name]]) {
    if (value !== undefined) {
      await execute(
        "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
        [key, value || '']
      )
    }
  }
  res.json({ ok: true })
})

app.post('/api/site-settings/logo', upload.single('logo'), async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_site_settings')
  if (!admin) return
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  const logoUrl = `/uploads/${req.file.filename}`
  await execute(
    "INSERT INTO settings (key, value) VALUES ('site_logo_url', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
    [logoUrl]
  )
  res.json({ site_logo_url: logoUrl })
})

app.delete('/api/site-settings/logo', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_site_settings')
  if (!admin) return
  const current = await queryOne("SELECT value FROM settings WHERE key = 'site_logo_url'")
  if (current?.value) {
    const filePath = join(__dirname, '..', current.value)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  }
  await execute("DELETE FROM settings WHERE key = 'site_logo_url'")
  res.json({ ok: true })
})

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
  const admin = await requirePermission(req, res, 'manage_users')
  if (!admin) return

  const rows = await query('SELECT * FROM players ORDER BY id')
  const groupMemberships = await query(`
    SELECT ppg.player_id, pg.id AS group_id, pg.name AS group_name
    FROM player_permission_groups ppg
    JOIN permission_groups pg ON pg.id = ppg.group_id
    ORDER BY pg.name
  `)
  const groupsByPlayer = {}
  for (const m of groupMemberships) {
    if (!groupsByPlayer[m.player_id]) groupsByPlayer[m.player_id] = []
    groupsByPlayer[m.player_id].push({ id: m.group_id, name: m.group_name })
  }
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
    permission_groups: groupsByPlayer[p.id] || [],
  })))
})

app.put('/api/players/:id', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_users')
  if (!admin) return

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

app.post('/api/admin/impersonate/:id', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_users')
  if (!admin) return
  if (!admin.is_admin) return res.status(403).json({ error: 'Only root admins can impersonate' })
  const target = await queryOne('SELECT * FROM players WHERE id = $1', [req.params.id])
  if (!target) return res.status(404).json({ error: 'User not found' })
  const token = createSession(target.id)
  res.json({ token })
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
  const admin = await requirePermission(req, res, 'manage_news')
  if (!admin) return
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
  const admin = await requirePermission(req, res, 'manage_news')
  if (!admin) return
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
  const admin = await requirePermission(req, res, 'manage_news')
  if (!admin) return
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
