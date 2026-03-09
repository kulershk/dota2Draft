import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { requireCompPermission } from '../middleware/permissions.js'
import { getTwitchAppToken, fetchTwitchProfileImage } from '../helpers/twitch.js'
import { TWITCH_CLIENT_ID, DOTA2_GAME_ID } from '../config.js'

const router = Router()

let streamersCache = null
let streamersCacheTime = 0
const STREAMERS_CACHE_TTL = 60 * 1000

router.get('/api/competitions/:compId/streams', async (req, res) => {
  const compId = Number(req.params.compId)
  const streams = await query(
    'SELECT * FROM competition_streams WHERE competition_id = $1 ORDER BY id',
    [compId]
  )
  res.json(streams)
})

router.get('/api/competitions/:compId/streams/live', async (req, res) => {
  const compId = Number(req.params.compId)
  const streams = await query(
    'SELECT * FROM competition_streams WHERE competition_id = $1 ORDER BY id',
    [compId]
  )
  if (streams.length === 0) return res.json([])

  const token = await getTwitchAppToken()
  if (!token) return res.json(streams.map(s => ({ ...s, live: false })))

  try {
    const logins = streams.map(s => s.twitch_username)
    const params = new URLSearchParams()
    logins.slice(0, 100).forEach(l => params.append('user_login', l))
    params.set('first', '100')

    const [streamRes, usersRes] = await Promise.all([
      fetch(`https://api.twitch.tv/helix/streams?${params}`, {
        headers: { Authorization: `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID },
      }),
      fetch(`https://api.twitch.tv/helix/users?${params}`, {
        headers: { Authorization: `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID },
      }),
    ])
    const streamData = await streamRes.json()
    const usersData = await usersRes.json()
    const liveStreams = streamData.data || []
    const twitchUsers = usersData.data || []

    const liveMap = new Map()
    for (const s of liveStreams) {
      liveMap.set(s.user_login.toLowerCase(), {
        title: s.title,
        viewer_count: s.viewer_count,
        thumbnail_url: s.thumbnail_url?.replace('{width}', '440').replace('{height}', '248'),
        started_at: s.started_at,
        game_name: s.game_name,
      })
    }

    const profileMap = new Map()
    for (const u of twitchUsers) {
      profileMap.set(u.login.toLowerCase(), u.profile_image_url)
    }

    for (const s of streams) {
      const img = profileMap.get(s.twitch_username.toLowerCase())
      if (img && !s.profile_image_url) {
        execute('UPDATE competition_streams SET profile_image_url = $1 WHERE id = $2', [img, s.id]).catch(() => {})
        s.profile_image_url = img
      }
    }

    const result = streams.map(s => ({
      ...s,
      profile_image_url: s.profile_image_url || profileMap.get(s.twitch_username.toLowerCase()) || null,
      is_live: liveMap.has(s.twitch_username.toLowerCase()),
      viewer_count: liveMap.get(s.twitch_username.toLowerCase())?.viewer_count || null,
      stream: liveMap.get(s.twitch_username.toLowerCase()) || null,
    }))

    res.json(result)
  } catch (e) {
    console.error('Failed to fetch comp streams:', e.message)
    res.json(streams.map(s => ({ ...s, is_live: false })))
  }
})

router.post('/api/competitions/:compId/streams', async (req, res) => {
  const compId = Number(req.params.compId)
  const admin = await requireCompPermission(req, res, compId)
  if (!admin) return

  const { title, twitch_username } = req.body
  if (!twitch_username) return res.status(400).json({ error: 'Twitch username is required' })

  const login = twitch_username.trim().toLowerCase()
  const profileImage = await fetchTwitchProfileImage(login)

  const stream = await queryOne(
    'INSERT INTO competition_streams (competition_id, title, twitch_username, profile_image_url) VALUES ($1, $2, $3, $4) RETURNING *',
    [compId, title || '', login, profileImage]
  )
  res.json(stream)
})

router.put('/api/competitions/:compId/streams/:streamId', async (req, res) => {
  const compId = Number(req.params.compId)
  const streamId = Number(req.params.streamId)
  const admin = await requireCompPermission(req, res, compId)
  if (!admin) return

  const { title, twitch_username } = req.body
  const login = twitch_username?.trim().toLowerCase()

  let profileImage = undefined
  if (login) {
    profileImage = await fetchTwitchProfileImage(login)
  }

  const stream = await queryOne(
    profileImage !== undefined
      ? 'UPDATE competition_streams SET title = COALESCE($1, title), twitch_username = COALESCE($2, twitch_username), profile_image_url = $5 WHERE id = $3 AND competition_id = $4 RETURNING *'
      : 'UPDATE competition_streams SET title = COALESCE($1, title), twitch_username = COALESCE($2, twitch_username) WHERE id = $3 AND competition_id = $4 RETURNING *',
    profileImage !== undefined
      ? [title, login, streamId, compId, profileImage]
      : [title, login, streamId, compId]
  )
  if (!stream) return res.status(404).json({ error: 'Stream not found' })
  res.json(stream)
})

router.delete('/api/competitions/:compId/streams/:streamId', async (req, res) => {
  const compId = Number(req.params.compId)
  const streamId = Number(req.params.streamId)
  const admin = await requireCompPermission(req, res, compId)
  if (!admin) return

  await execute('DELETE FROM competition_streams WHERE id = $1 AND competition_id = $2', [streamId, compId])
  res.json({ ok: true })
})

// Global streamers (live Dota 2 streamers from player accounts)
router.get('/api/streamers', async (req, res) => {
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

export default router
