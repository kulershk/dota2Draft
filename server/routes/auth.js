import { Router } from 'express'
import { queryOne, execute } from '../db.js'
import { createSession, getSessionPlayerId, getTokenFromReq, getAuthPlayer } from '../middleware/auth.js'
import { requirePermission } from '../middleware/permissions.js'
import { getTwitchAppToken } from '../helpers/twitch.js'
import { BASE_URL, TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET } from '../config.js'
import { getCompetition } from '../helpers/competition.js'

const router = Router()

// Steam profile fetch helper
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

router.get('/api/auth/steam', (req, res) => {
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

router.get('/api/auth/steam/callback', async (req, res) => {
  try {
    const params = new URLSearchParams(req.query)
    params.set('openid.mode', 'check_authentication')
    const verifyRes = await fetch('https://steamcommunity.com/openid/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    })
    const verifyText = await verifyRes.text()
    if (!verifyText.includes('is_valid:true')) {
      return res.redirect(`${BASE_URL}/login?error=steam_auth_failed`)
    }

    const claimedId = req.query['openid.claimed_id'] || ''
    const steamId = claimedId.split('/').pop()
    if (!steamId) return res.redirect(`${BASE_URL}/login?error=no_steam_id`)

    const { personaName, avatarUrl } = await fetchSteamProfile(steamId)
    let player = await queryOne('SELECT * FROM players WHERE steam_id = $1', [steamId])

    if (!player) {
      player = await queryOne(
        'INSERT INTO players (name, steam_id, avatar_url) VALUES ($1, $2, $3) RETURNING *',
        [personaName, steamId, avatarUrl]
      )
    } else {
      await execute(
        'UPDATE players SET name = $1, avatar_url = $2 WHERE id = $3',
        [personaName, avatarUrl, player.id]
      )
    }

    if (player.is_banned) return res.redirect(`${BASE_URL}/login?error=banned`)
    const token = createSession(player.id)
    res.redirect(`${BASE_URL}/?authToken=${token}`)
  } catch (e) {
    console.error('Steam auth error:', e)
    res.redirect(`${BASE_URL}/login?error=server_error`)
  }
})

router.get('/api/auth/me', async (req, res) => {
  const player = await getAuthPlayer(req)
  if (!player) return res.status(401).json({ error: 'Not authenticated' })
  execute('UPDATE players SET last_online = NOW() WHERE id = $1', [player.id]).catch(() => {})
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
    discord_username: player.discord_username || null,
  })
})

router.put('/api/auth/me', async (req, res) => {
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
    discord_username: updated.discord_username || null,
  })
})

router.get('/api/competitions/:compId/me', async (req, res) => {
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

router.post('/api/auth/claim-admin', async (req, res) => {
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

// Twitch OAuth
router.get('/api/auth/twitch/link', async (req, res) => {
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

router.get('/api/auth/twitch/callback', async (req, res) => {
  try {
    const { code, state } = req.query
    if (!code || !state) return res.redirect(`${BASE_URL}/settings?twitch_error=missing_params`)

    const playerId = getSessionPlayerId(state)
    if (!playerId) return res.redirect(`${BASE_URL}/settings?twitch_error=not_authenticated`)

    const serverOrigin = `${req.protocol}://${req.get('host')}`
    const redirectUri = `${serverOrigin}/api/auth/twitch/callback`

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

router.post('/api/auth/twitch/unlink', async (req, res) => {
  const player = await getAuthPlayer(req)
  if (!player) return res.status(401).json({ error: 'Not authenticated' })
  await execute('UPDATE players SET twitch_id = NULL, twitch_username = NULL WHERE id = $1', [player.id])
  res.json({ ok: true })
})

// Discord OAuth
router.get('/api/auth/discord/link', async (req, res) => {
  const player = await getAuthPlayer(req)
  if (!player) return res.status(401).json({ error: 'Not authenticated' })
  if (!DISCORD_CLIENT_ID) return res.status(500).json({ error: 'Discord not configured' })

  const token = getTokenFromReq(req)
  const serverOrigin = `${req.protocol}://${req.get('host')}`
  const redirectUri = `${serverOrigin}/api/auth/discord/callback`
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify',
    state: token,
  })
  res.json({ url: `https://discord.com/oauth2/authorize?${params}` })
})

router.get('/api/auth/discord/callback', async (req, res) => {
  try {
    const { code, state } = req.query
    if (!code || !state) return res.redirect(`${BASE_URL}/settings?discord_error=missing_params`)

    const playerId = getSessionPlayerId(state)
    if (!playerId) return res.redirect(`${BASE_URL}/settings?discord_error=not_authenticated`)

    const serverOrigin = `${req.protocol}://${req.get('host')}`
    const redirectUri = `${serverOrigin}/api/auth/discord/callback`

    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    })
    const tokenData = await tokenRes.json()
    if (!tokenData.access_token) return res.redirect(`${BASE_URL}/settings?discord_error=token_failed`)

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    })
    const discordUser = await userRes.json()
    if (!discordUser?.id) return res.redirect(`${BASE_URL}/settings?discord_error=user_fetch_failed`)

    const username = discordUser.username
    await execute(
      'UPDATE players SET discord_id = $1, discord_username = $2 WHERE id = $3',
      [discordUser.id, username, playerId]
    )

    res.redirect(`${BASE_URL}/settings?discord_linked=1`)
  } catch (e) {
    console.error('Discord callback error:', e)
    res.redirect(`${BASE_URL}/settings?discord_error=server_error`)
  }
})

router.post('/api/auth/discord/unlink', async (req, res) => {
  const player = await getAuthPlayer(req)
  if (!player) return res.status(401).json({ error: 'Not authenticated' })
  await execute('UPDATE players SET discord_id = NULL, discord_username = NULL WHERE id = $1', [player.id])
  res.json({ ok: true })
})

router.post('/api/auth/logout', (req, res) => {
  res.json({ ok: true })
})

export default router
