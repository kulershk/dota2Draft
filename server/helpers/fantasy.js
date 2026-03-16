import { query } from '../db.js'

// Steam64 to Steam32 (OpenDota account_id)
export function steamIdToAccountId(steamId) {
  if (!steamId) return null
  return Number(BigInt(steamId) - BigInt('76561197960265728'))
}

// Map DB stat fields to fantasy scoring keys
const STAT_MAP = {
  kills: 'kill',
  deaths: 'death',
  assists: 'assist',
  last_hits: 'lastHit',
  denies: 'deny',
  gpm: 'gpm',
  xpm: 'xpm',
  obs_placed: 'obsPlaced',
  sen_placed: 'senPlaced',
  observer_kills: 'obsKilled',
  sentry_kills: 'senKilled',
  camps_stacked: 'campsStacked',
  stuns: 'stuns',
  teamfight_participation: 'teamfight',
  towers_killed: 'towerKill',
  roshans_killed: 'roshanKill',
  firstblood_claimed: 'firstBlood',
  rune_pickups: 'runePickup',
  courier_kills: 'courierKill',
}

// Per-1000 stats (divide by 1000 before applying multiplier)
const PER_THOUSAND = { hero_damage: 'heroDamage', tower_damage: 'towerDamage', hero_healing: 'heroHealing' }

export function calculatePlayerPoints(playerStats, roleMultipliers) {
  let points = 0

  // Direct stats
  for (const [dbField, scoringKey] of Object.entries(STAT_MAP)) {
    const value = playerStats[dbField] || 0
    const multiplier = roleMultipliers[scoringKey] || 0
    points += value * multiplier
  }

  // Per-1000 stats
  for (const [dbField, scoringKey] of Object.entries(PER_THOUSAND)) {
    const value = (playerStats[dbField] || 0) / 1000
    const multiplier = roleMultipliers[scoringKey] || 0
    points += value * multiplier
  }

  // Multi-kills
  const multiKills = playerStats.multi_kills || {}
  points += (multiKills['3'] || 0) * (roleMultipliers.tripleKill || 0)
  points += (multiKills['4'] || 0) * (roleMultipliers.ultraKill || 0)
  points += (multiKills['5'] || 0) * (roleMultipliers.rampage || 0)

  return Math.round(points * 100) / 100
}

export async function getStagePoints(stageId, fantasyScoring) {
  // Get all match_game_ids for this stage
  const gameRows = await query(`
    SELECT mg.id AS match_game_id
    FROM fantasy_stage_matches fsm
    JOIN match_games mg ON mg.match_id = fsm.match_id
    WHERE fsm.fantasy_stage_id = $1
  `, [stageId])

  if (gameRows.length === 0) return {}

  const gameIds = gameRows.map(r => r.match_game_id)

  // Get all player stats for these games
  const allStats = await query(
    `SELECT * FROM match_game_player_stats WHERE match_game_id = ANY($1)`,
    [gameIds]
  )

  // Index stats by account_id -> array of stat rows
  const statsByAccount = {}
  for (const s of allStats) {
    if (!statsByAccount[s.account_id]) statsByAccount[s.account_id] = []
    statsByAccount[s.account_id].push(s)
  }

  // Get all picks for this stage with player steam_ids
  const picks = await query(`
    SELECT fp.player_id, fp.role, fp.pick_player_id, p.steam_id,
           COALESCE(p.display_name, p.name) AS pick_name, p.avatar_url AS pick_avatar
    FROM fantasy_picks fp
    JOIN players p ON p.id = fp.pick_player_id
    WHERE fp.fantasy_stage_id = $1
  `, [stageId])

  // Calculate points per user
  const userPoints = {} // { playerId: { total, picks: { role: { pickPlayerId, name, avatar, points } } } }

  for (const pick of picks) {
    const accountId = steamIdToAccountId(pick.steam_id)
    const roleMultipliers = fantasyScoring[pick.role]
    if (!roleMultipliers) continue

    const playerGameStats = accountId ? (statsByAccount[accountId] || []) : []
    let pickPoints = 0
    for (const stat of playerGameStats) {
      pickPoints += calculatePlayerPoints(stat, roleMultipliers)
    }
    pickPoints = Math.round(pickPoints * 100) / 100

    if (!userPoints[pick.player_id]) {
      userPoints[pick.player_id] = { total: 0, picks: {} }
    }
    userPoints[pick.player_id].picks[pick.role] = {
      pickPlayerId: pick.pick_player_id,
      name: pick.pick_name,
      avatar: pick.pick_avatar,
      points: pickPoints,
    }
    userPoints[pick.player_id].total += pickPoints
  }

  // Round totals
  for (const uid in userPoints) {
    userPoints[uid].total = Math.round(userPoints[uid].total * 100) / 100
  }

  return userPoints
}

export async function getStageTopPicks(stageId, compId, fantasyScoring) {
  // Get all match_game_ids for this stage
  const gameRows = await query(`
    SELECT mg.id AS match_game_id
    FROM fantasy_stage_matches fsm
    JOIN match_games mg ON mg.match_id = fsm.match_id
    WHERE fsm.fantasy_stage_id = $1
  `, [stageId])

  if (gameRows.length === 0) return {}

  const gameIds = gameRows.map(r => r.match_game_id)

  // Get all player stats for these games
  const allStats = await query(
    'SELECT * FROM match_game_player_stats WHERE match_game_id = ANY($1)',
    [gameIds]
  )

  // Index stats by account_id
  const statsByAccount = {}
  for (const s of allStats) {
    if (!statsByAccount[s.account_id]) statsByAccount[s.account_id] = []
    statsByAccount[s.account_id].push(s)
  }

  // Get all competition players with steam_ids
  const compPlayers = await query(`
    SELECT cp.player_id, COALESCE(p.display_name, p.name) AS name, p.avatar_url, p.steam_id
    FROM competition_players cp
    JOIN players p ON p.id = cp.player_id
    WHERE cp.competition_id = $1
  `, [compId])

  const roles = ['carry', 'mid', 'offlane', 'pos4', 'pos5']
  const result = {}

  for (const role of roles) {
    const multipliers = fantasyScoring[role]
    if (!multipliers) { result[role] = []; continue }

    const ranked = []
    for (const player of compPlayers) {
      const accountId = steamIdToAccountId(player.steam_id)
      const playerGameStats = accountId ? (statsByAccount[accountId] || []) : []
      if (playerGameStats.length === 0) continue

      let points = 0
      for (const stat of playerGameStats) {
        points += calculatePlayerPoints(stat, multipliers)
      }
      points = Math.round(points * 100) / 100

      ranked.push({
        playerId: player.player_id,
        name: player.name,
        avatar: player.avatar_url || '',
        points,
      })
    }

    ranked.sort((a, b) => b.points - a.points)
    result[role] = ranked.slice(0, 10)
  }

  return result
}
