import jwt from 'jsonwebtoken'
import { queryOne } from '../db.js'
import { JWT_SECRET, JWT_EXPIRY } from '../config.js'

// previewGroupId (optional) puts the session into permission-preview mode:
// the player is authenticated as themselves but their effective permissions
// resolve to ONLY that group's set, with is_admin forced false. Used by the
// admin "test a permission group" tool so backend enforcement matches.
export function createSession(playerId, previewGroupId = null) {
  const claims = { playerId }
  if (previewGroupId) claims.previewGroupId = Number(previewGroupId)
  return jwt.sign(claims, JWT_SECRET, { expiresIn: JWT_EXPIRY })
}

export function getSessionPlayerId(token) {
  return getTokenPayload(token)?.playerId ?? null
}

export function getTokenPayload(token) {
  if (!token) return null
  try {
    return jwt.verify(token, JWT_SECRET)
  } catch {
    return null
  }
}

export function getTokenFromReq(req) {
  return req.headers.authorization?.replace('Bearer ', '') || null
}

export async function getAuthPlayer(req) {
  const payload = getTokenPayload(getTokenFromReq(req))
  if (!payload?.playerId) return null
  const player = await queryOne('SELECT * FROM players WHERE id = $1', [payload.playerId])
  if (!player) return null
  // Permission-preview mode: surface the previewed group and neutralise the
  // is_admin bypass so every downstream check (requirePermission and any raw
  // admin.is_admin shortcut) evaluates against the group's permissions only.
  // The real is_admin is preserved separately in case a caller needs it.
  if (payload.previewGroupId) {
    player.preview_group_id = Number(payload.previewGroupId)
    player.real_is_admin = player.is_admin
    player.is_admin = false
  }
  return player
}
