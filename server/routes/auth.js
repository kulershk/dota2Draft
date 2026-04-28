import { Router } from 'express'
import { queryOne, execute } from '../db.js'
import { createSession, getSessionPlayerId, getTokenFromReq, getAuthPlayer } from '../middleware/auth.js'
import { requirePermission, getPlayerPermissions } from '../middleware/permissions.js'
import { getTwitchAppToken } from '../helpers/twitch.js'
import { BASE_URL, TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET } from '../config.js'
import { getCompetition } from '../helpers/competition.js'
import { fetchSteamProfile } from '../helpers/steam.js'
import { awardXp } from '../helpers/xp.js'

const router = Router()

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

    // Banned users are still allowed to log in. The banner + write-action
    // blocks (server middleware + UI) take care of restricting them.
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
  const perms = await getPlayerPermissions(player.id)

  let bannedByName = null
  if (player.is_banned && player.banned_by) {
    const banner = await queryOne(
      'SELECT name, display_name FROM players WHERE id = $1',
      [player.banned_by]
    )
    bannedByName = banner ? (banner.display_name || banner.name) : null
  }

  res.json({
    id: player.id,
    name: player.display_name || player.name,
    display_name: player.display_name || null,
    steam_name: player.name,
    steam_id: player.steam_id,
    avatar_url: player.avatar_url,
    is_admin: !!player.is_admin,
    permissions: [...perms],
    roles: JSON.parse(player.roles || '[]'),
    mmr: player.mmr,
    mmr_verified_at: player.mmr_verified_at || null,
    info: player.info || '',
    total_xp: player.total_xp || 0,
    twitch_username: player.twitch_username || null,
    discord_username: player.discord_username || null,
    is_banned: !!player.is_banned,
    banned_at: player.banned_at || null,
    banned_by_name: bannedByName,
    banned_reason: player.banned_reason || null,
  })
})

router.put('/api/auth/me', async (req, res) => {
  const player = await getAuthPlayer(req)
  if (!player) return res.status(401).json({ error: 'Not authenticated' })
  // MMR is no longer self-editable — it changes only when an admin approves
  // an MMR verification submission. Body's mmr field is ignored here.
  const { info, roles } = req.body
  await execute(
    'UPDATE players SET info = $1, roles = $2 WHERE id = $3',
    [
      info ?? player.info,
      roles ? JSON.stringify(roles) : player.roles,
      player.id,
    ]
  )
  // XP: first time setting bio
  if (info && !player.info) {
    awardXp(player.id, 25, 'set_bio', 'profile', String(player.id))
  }

  const updated = await queryOne('SELECT * FROM players WHERE id = $1', [player.id])
  const updatedPerms = await getPlayerPermissions(updated.id)
  res.json({
    id: updated.id,
    name: updated.display_name || updated.name,
    display_name: updated.display_name || null,
    steam_name: updated.name,
    steam_id: updated.steam_id,
    avatar_url: updated.avatar_url,
    is_admin: !!updated.is_admin,
    permissions: [...updatedPerms],
    roles: JSON.parse(updated.roles || '[]'),
    mmr: updated.mmr,
    mmr_verified_at: updated.mmr_verified_at || null,
    info: updated.info || '',
    total_xp: updated.total_xp || 0,
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
    awardXp(playerId, 50, 'link_twitch', 'profile', String(playerId))

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
    awardXp(playerId, 50, 'link_discord', 'profile', String(playerId))

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

// Daily login bonus
router.get('/api/auth/daily-status', async (req, res) => {
  const player = await getAuthPlayer(req)
  if (!player) return res.status(401).json({ error: 'Not authenticated' })

  const today = new Date().toISOString().slice(0, 10)
  const lastClaimed = player.daily_last_claimed ? new Date(player.daily_last_claimed).toISOString().slice(0, 10) : null
  const claimedToday = lastClaimed === today

  // Check if streak is still valid (last claim was yesterday or today)
  let streak = player.daily_streak || 0
  if (lastClaimed && !claimedToday) {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayStr = yesterday.toISOString().slice(0, 10)
    if (lastClaimed !== yesterdayStr) streak = 0
  }

  res.json({
    claimed_today: claimedToday,
    streak,
    next_xp: (streak + 1) >= 7 ? 20 : 10,
  })
})

router.post('/api/auth/daily-claim', async (req, res) => {
  const player = await getAuthPlayer(req)
  if (!player) return res.status(401).json({ error: 'Not authenticated' })

  const today = new Date().toISOString().slice(0, 10)
  const lastClaimed = player.daily_last_claimed ? new Date(player.daily_last_claimed).toISOString().slice(0, 10) : null

  if (lastClaimed === today) {
    return res.status(400).json({ error: 'Already claimed today' })
  }

  // Compute new streak
  let streak = player.daily_streak || 0
  if (lastClaimed) {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayStr = yesterday.toISOString().slice(0, 10)
    streak = lastClaimed === yesterdayStr ? streak + 1 : 1
  } else {
    streak = 1
  }

  const xpAmount = streak >= 7 ? 20 : 10

  await execute(
    'UPDATE players SET daily_last_claimed = $1, daily_streak = $2 WHERE id = $3',
    [today, streak, player.id]
  )

  const result = await awardXp(player.id, xpAmount, 'daily_login', 'daily', today, {
    detail: `Day ${streak} streak`,
  })

  res.json({
    awarded: result.awarded,
    xp: xpAmount,
    streak,
    total_xp: result.total_xp,
    level: result.level,
  })
})

router.post('/api/auth/logout', (req, res) => {
  res.json({ ok: true })
})

export default router
