import { query } from '../db.js'
import { getAuthPlayer } from './auth.js'
import { getCompetition } from '../helpers/competition.js'

export const ALL_PERMISSIONS = [
  'manage_competitions',
  'manage_own_competitions',
  'manage_users',
  'manage_news',
  'manage_site_settings',
  // manage_captains + manage_auction were removed — captain + auction
  // control is comp-scoped (owner / helper / manage_competitions), so the
  // standalone cross-comp grants were redundant.
  'manage_players',
  'manage_permissions',
  'manage_bots',
  'manage_jobs',
  'manage_games',
  'manage_queue_pools',
  'manage_own_queue_pools',
  'delete_queue_matches',
  'manage_seasons',
  'manage_own_seasons',
  'manage_mmr_verifications',
  'view_request_stats',
  'manage_menu',
  'ban_users',
  'impersonate_users',
  'manage_fantasy',
  'manage_xp_log',
  'manage_leagues',
  'manage_own_leagues',
  'manage_subscription_plans',
  'manage_discord_settings',
  'review_grief_reports',
  'manage_dotacoins',
  'manage_gcoins',
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

// Permissions of a single group — used by the preview resolver.
export async function getGroupPermissions(groupId) {
  const row = await query('SELECT permissions FROM permission_groups WHERE id = $1', [groupId]).then(r => r[0])
  return new Set(row?.permissions || [])
}

// Effective permission set for a player, honouring preview mode. In a
// preview session the set is exactly the previewed group's permissions
// (the real groups are ignored), which is what /api/auth/me reports so
// the client UI matches the server's enforcement.
export async function getEffectivePermissions(player) {
  if (!player) return new Set()
  if (player.preview_group_id) return await getGroupPermissions(player.preview_group_id)
  return await getPlayerPermissions(player.id)
}

export async function hasPermission(player, permission) {
  if (!player) return false
  // In preview mode, getAuthPlayer has already forced is_admin=false, so the
  // bypass below is skipped and we check the group's permission set.
  if (player.preview_group_id) {
    const perms = await getGroupPermissions(player.preview_group_id)
    return perms.has(permission)
  }
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

export async function isCompetitionHelper(playerId, compId) {
  if (!playerId || !compId) return false
  const row = await query(
    'SELECT 1 FROM competition_helpers WHERE competition_id = $1 AND player_id = $2 LIMIT 1',
    [compId, playerId],
  )
  return row.length > 0
}

// Boolean form of the comp-permission check — no req/res. Shared by
// requireCompPermission (REST) and socket handlers (e.g. auction control)
// so the rules stay identical: a global manage_competitions admin, a
// holder of the sub-permission, a comp helper, or the comp's own creator
// (with manage_own_competitions) all pass.
export async function playerCanManageComp(player, compId, subPermission) {
  if (!player) return false
  if (await hasPermission(player, 'manage_competitions')) return true
  if (subPermission && await hasPermission(player, subPermission)) return true
  if (compId && await isCompetitionHelper(player.id, compId)) return true
  if (await hasPermission(player, 'manage_own_competitions')) {
    if (!compId) return true
    const comp = await getCompetition(compId)
    if (comp && comp.created_by === player.id) return true
  }
  return false
}

export async function requireCompPermission(req, res, compId, subPermission) {
  const player = await getAuthPlayer(req)
  if (!player) { res.status(401).json({ error: 'Not authenticated' }); return null }
  if (await playerCanManageComp(player, compId, subPermission)) return player
  res.status(403).json({ error: 'Permission denied' })
  return null
}

export async function requireQueuePoolPermission(req, res, poolId) {
  const player = await getAuthPlayer(req)
  if (!player) { res.status(401).json({ error: 'Not authenticated' }); return null }
  if (await hasPermission(player, 'manage_queue_pools')) return player
  if (await hasPermission(player, 'manage_own_queue_pools')) {
    if (!poolId) return player
    const pool = await query('SELECT created_by FROM queue_pools WHERE id = $1', [poolId]).then(r => r[0])
    if (pool && pool.created_by === player.id) return player
  }
  res.status(403).json({ error: 'Permission denied' })
  return null
}

export async function requireLeaguePermission(req, res, leagueId) {
  const player = await getAuthPlayer(req)
  if (!player) { res.status(401).json({ error: 'Not authenticated' }); return null }
  if (await hasPermission(player, 'manage_leagues')) return player
  if (await hasPermission(player, 'manage_own_leagues')) {
    if (!leagueId) return player
    const league = await query('SELECT created_by FROM leagues WHERE id = $1', [leagueId]).then(r => r[0])
    if (league && league.created_by === player.id) return player
  }
  res.status(403).json({ error: 'Permission denied' })
  return null
}

// Mirrors the league check for seasons. Full perm = manage_seasons (every
// season); manage_own_seasons = only seasons you created. seasonId omitted
// (e.g. create / list) passes for either perm — the caller scopes the data.
export async function requireSeasonPermission(req, res, seasonId) {
  const player = await getAuthPlayer(req)
  if (!player) { res.status(401).json({ error: 'Not authenticated' }); return null }
  if (await hasPermission(player, 'manage_seasons')) return player
  if (await hasPermission(player, 'manage_own_seasons')) {
    if (!seasonId) return player
    const season = await query('SELECT created_by FROM seasons WHERE id = $1', [seasonId]).then(r => r[0])
    if (season && season.created_by === player.id) return player
  }
  res.status(403).json({ error: 'Permission denied' })
  return null
}
