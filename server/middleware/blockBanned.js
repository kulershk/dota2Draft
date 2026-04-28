import { getAuthPlayer } from './auth.js'

const PASSTHROUGH_PATHS = new Set([
  '/api/auth/logout',
])

export async function blockBanned(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next()
  }
  if (PASSTHROUGH_PATHS.has(req.path)) {
    return next()
  }
  const player = await getAuthPlayer(req)
  if (player && player.is_banned) {
    return res.status(403).json({
      error: 'banned',
      reason: player.banned_reason || null,
    })
  }
  next()
}
