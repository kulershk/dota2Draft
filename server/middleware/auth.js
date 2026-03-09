import jwt from 'jsonwebtoken'
import { queryOne } from '../db.js'
import { JWT_SECRET, JWT_EXPIRY } from '../config.js'

export function createSession(playerId) {
  return jwt.sign({ playerId }, JWT_SECRET, { expiresIn: JWT_EXPIRY })
}

export function getSessionPlayerId(token) {
  if (!token) return null
  try {
    const payload = jwt.verify(token, JWT_SECRET)
    return payload.playerId
  } catch {
    return null
  }
}

export function getTokenFromReq(req) {
  return req.headers.authorization?.replace('Bearer ', '') || null
}

export async function getAuthPlayer(req) {
  const playerId = getSessionPlayerId(getTokenFromReq(req))
  if (!playerId) return null
  return await queryOne('SELECT * FROM players WHERE id = $1', [playerId])
}
