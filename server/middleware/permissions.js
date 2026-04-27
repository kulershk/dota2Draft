import { query } from '../db.js'
import { getAuthPlayer } from './auth.js'
import { getCompetition } from '../helpers/competition.js'

export const ALL_PERMISSIONS = [
  'manage_competitions',
  'manage_own_competitions',
  'manage_users',
  'manage_news',
  'manage_site_settings',
  'manage_captains',
  'manage_players',
  'manage_auction',
  'manage_permissions',
  'manage_bots',
  'manage_jobs',
  'manage_games',
  'manage_queue_pools',
  'manage_seasons',
  'manage_mmr_verifications',
  'view_request_stats',
]

export async function getPlayerPermissions(playerId) {
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

export async function hasPermission(player, permission) {
  if (!player) return false
  if (player.is_admin) return true
  const perms = await getPlayerPermissions(player.id)
  return perms.has(permission)
}

export async function requirePermission(req, res, permission) {
  const player = await getAuthPlayer(req)
  if (!player) { res.status(401).json({ error: 'Not authenticated' }); return null }
  const allowed = await hasPermission(player, permission)
  if (!allowed) { res.status(403).json({ error: 'Permission denied' }); return null }
  return player
}

export async function requireCompPermission(req, res, compId, subPermission) {
  const player = await getAuthPlayer(req)
  if (!player) { res.status(401).json({ error: 'Not authenticated' }); return null }
  if (await hasPermission(player, 'manage_competitions')) return player
  if (subPermission && await hasPermission(player, subPermission)) return player
  if (await hasPermission(player, 'manage_own_competitions')) {
    if (!compId) return player
    const comp = await getCompetition(compId)
    if (comp && comp.created_by === player.id) return player
  }
  res.status(403).json({ error: 'Permission denied' })
  return null
}
