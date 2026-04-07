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

export function calculatePlayerPointsDetailed(playerStats, roleMultipliers) {
  const breakdown = {}
  let total = 0

  // Direct stats
  for (const [dbField, scoringKey] of Object.entries(STAT_MAP)) {
    const value = playerStats[dbField] || 0
    const multiplier = roleMultipliers[scoringKey] || 0
    const points = Math.round(value * multiplier * 100) / 100
    breakdown[scoringKey] = { value, multiplier, points }
    total += points
  }

  // Per-1000 stats
  for (const [dbField, scoringKey] of Object.entries(PER_THOUSAND)) {
    const rawValue = playerStats[dbField] || 0
    const value = rawValue / 1000
    const multiplier = roleMultipliers[scoringKey] || 0
    const points = Math.round(value * multiplier * 100) / 100
    breakdown[scoringKey] = { value: rawValue, multiplier, points }
    total += points
  }

  // Multi-kills
  const multiKills = playerStats.multi_kills || {}
  const tripleVal = multiKills['3'] || 0
  const ultraVal = multiKills['4'] || 0
  const rampageVal = multiKills['5'] || 0
  breakdown.tripleKill = { value: tripleVal, multiplier: roleMultipliers.tripleKill || 0, points: Math.round(tripleVal * (roleMultipliers.tripleKill || 0) * 100) / 100 }
  breakdown.ultraKill = { value: ultraVal, multiplier: roleMultipliers.ultraKill || 0, points: Math.round(ultraVal * (roleMultipliers.ultraKill || 0) * 100) / 100 }
  breakdown.rampage = { value: rampageVal, multiplier: roleMultipliers.rampage || 0, points: Math.round(rampageVal * (roleMultipliers.rampage || 0) * 100) / 100 }
  total += breakdown.tripleKill.points + breakdown.ultraKill.points + breakdown.rampage.points

  return { breakdown, total: Math.round(total * 100) / 100 }
}

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

// Build a map of standin replacements for a stage's matches
// Returns { originalPlayerId -> { matchGameId -> standinSteamId } }
// Game-level standins (match_game_id set) take priority over match-level (match_game_id NULL)
async function getStageStandinMap(stageId) {
  const rows = await query(`
    SELECT ms.match_id, ms.match_game_id, ms.original_player_id, p.steam_id AS standin_steam_id
    FROM match_standins ms
    JOIN fantasy_stage_matches fsm ON fsm.match_id = ms.match_id
    JOIN players p ON p.id = ms.standin_player_id
    WHERE fsm.fantasy_stage_id = $1
  `, [stageId])

  // Get match_game_id -> match_id mapping for all games in this stage
  const gameRows = await query(`
    SELECT mg.id AS match_game_id, mg.match_id
    FROM fantasy_stage_matches fsm
    JOIN match_games mg ON mg.match_id = fsm.match_id
    WHERE fsm.fantasy_stage_id = $1
  `, [stageId])

  // Separate match-level and game-level standins
  const matchLevel = {} // { originalPlayerId -> { matchId -> standinSteamId } }
  const gameLevel = {}  // { originalPlayerId -> { matchGameId -> standinSteamId } }

  for (const r of rows) {
    if (r.match_game_id) {
      // Game-specific standin
      if (!gameLevel[r.original_player_id]) gameLevel[r.original_player_id] = {}
      gameLevel[r.original_player_id][r.match_game_id] = r.standin_steam_id
    } else {
      // Match-level standin (applies to all games in match)
      if (!matchLevel[r.original_player_id]) matchLevel[r.original_player_id] = {}
      matchLevel[r.original_player_id][r.match_id] = r.standin_steam_id
    }
  }

  // Build final map: { originalPlayerId -> { matchGameId -> standinSteamId } }
  // Game-level overrides match-level
  const map = {}
  for (const g of gameRows) {
    for (const playerId of new Set([...Object.keys(matchLevel), ...Object.keys(gameLevel)])) {
      const gameSteamId = gameLevel[playerId]?.[g.match_game_id]
      const matchSteamId = matchLevel[playerId]?.[g.match_id]
      const standinSteamId = gameSteamId || matchSteamId
      if (standinSteamId) {
        if (!map[playerId]) map[playerId] = {}
        map[playerId][g.match_game_id] = standinSteamId
      }
    }
  }
  return map
}

// Build reverse map: { accountId -> Set<matchGameId> } for games where a player was a standin
// These games should be excluded from the standin's own point calculation
function buildStandinExclusions(standinMap) {
  const exclusions = {} // { accountId -> Set<matchGameId> }
  for (const playerId in standinMap) {
    for (const [matchGameId, standinSteamId] of Object.entries(standinMap[playerId])) {
      const standinAccountId = steamIdToAccountId(standinSteamId)
      if (!standinAccountId) continue
      if (!exclusions[standinAccountId]) exclusions[standinAccountId] = new Set()
      exclusions[standinAccountId].add(Number(matchGameId))
    }
  }
  return exclusions
}

// Resolve account_id per game for a player, considering standins
// Returns array of stat rows from the correct account per game
function resolvePlayerStats(playerId, steamId, standinMap, standinExclusions, statsByGameAndAccount, gameInfos) {
  const accountId = steamIdToAccountId(steamId)
  const playerStandins = standinMap[playerId] // { matchGameId -> standinSteamId }
  const excluded = accountId ? standinExclusions[accountId] : null // games where this player was a standin
  const result = []

  for (const g of gameInfos) {
    const standinSteamId = playerStandins?.[g.matchGameId]
    const lookupAccountId = standinSteamId
      ? steamIdToAccountId(standinSteamId)
      : accountId
    if (!lookupAccountId) continue

    // Skip games where this player was acting as a standin for someone else
    if (!standinSteamId && excluded?.has(g.matchGameId)) continue

    const stat = statsByGameAndAccount[g.matchGameId]?.[lookupAccountId]
    if (stat) result.push(stat)
  }
  return result
}

export async function getStagePoints(stageId, fantasyScoring, repeatPenalty = 0) {
  // Get all match_game_ids for this stage (with match_id for standin resolution)
  const gameRows = await query(`
    SELECT mg.id AS match_game_id, mg.match_id
    FROM fantasy_stage_matches fsm
    JOIN match_games mg ON mg.match_id = fsm.match_id
    WHERE fsm.fantasy_stage_id = $1
  `, [stageId])

  if (gameRows.length === 0) return {}

  const gameIds = gameRows.map(r => r.match_game_id)
  const gameInfos = gameRows.map(r => ({ matchGameId: r.match_game_id, matchId: r.match_id }))

  // Get all player stats for these games
  const allStats = await query(
    `SELECT * FROM match_game_player_stats WHERE match_game_id = ANY($1)`,
    [gameIds]
  )

  // Index stats by match_game_id -> account_id -> stat row
  const statsByGameAndAccount = {}
  for (const s of allStats) {
    if (!statsByGameAndAccount[s.match_game_id]) statsByGameAndAccount[s.match_game_id] = {}
    statsByGameAndAccount[s.match_game_id][s.account_id] = s
  }

  // Get standin map and exclusions for this stage
  const standinMap = await getStageStandinMap(stageId)
  const standinExclusions = buildStandinExclusions(standinMap)

  // Get previous stage picks for repeat penalty
  let prevPicksByUser = {} // { playerId: Set<pickPlayerId> }
  if (repeatPenalty > 0) {
    const prevStage = await query(`
      SELECT id FROM fantasy_stages
      WHERE id != $1
        AND competition_id = (SELECT competition_id FROM fantasy_stages WHERE id = $1)
        AND stage_order < (SELECT stage_order FROM fantasy_stages WHERE id = $1)
      ORDER BY stage_order DESC LIMIT 1
    `, [stageId])
    if (prevStage.length > 0) {
      const prevPicks = await query(
        'SELECT player_id, pick_player_id FROM fantasy_picks WHERE fantasy_stage_id = $1',
        [prevStage[0].id]
      )
      for (const pp of prevPicks) {
        if (!prevPicksByUser[pp.player_id]) prevPicksByUser[pp.player_id] = new Set()
        prevPicksByUser[pp.player_id].add(pp.pick_player_id)
      }
    }
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
  const userPoints = {} // { playerId: { total, picks: { role: { pickPlayerId, name, avatar, points, repeated } } } }

  for (const pick of picks) {
    const roleMultipliers = fantasyScoring[pick.role]
    if (!roleMultipliers) continue

    const playerGameStats = resolvePlayerStats(
      pick.pick_player_id, pick.steam_id, standinMap, standinExclusions, statsByGameAndAccount, gameInfos
    )
    let pickPoints = 0
    for (const stat of playerGameStats) {
      pickPoints += calculatePlayerPoints(stat, roleMultipliers)
    }

    // Apply repeat penalty
    const repeated = repeatPenalty > 0 && prevPicksByUser[pick.player_id]?.has(pick.pick_player_id)
    if (repeated) {
      pickPoints = pickPoints * (1 - repeatPenalty)
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
      repeated,
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
  // Get all match_game_ids for this stage (with match_id for standin resolution)
  const gameRows = await query(`
    SELECT mg.id AS match_game_id, mg.match_id
    FROM fantasy_stage_matches fsm
    JOIN match_games mg ON mg.match_id = fsm.match_id
    WHERE fsm.fantasy_stage_id = $1
  `, [stageId])

  if (gameRows.length === 0) return {}

  const gameIds = gameRows.map(r => r.match_game_id)
  const gameInfos = gameRows.map(r => ({ matchGameId: r.match_game_id, matchId: r.match_id }))

  // Get all player stats for these games
  const allStats = await query(
    'SELECT * FROM match_game_player_stats WHERE match_game_id = ANY($1)',
    [gameIds]
  )

  // Index stats by match_game_id -> account_id -> stat row
  const statsByGameAndAccount = {}
  for (const s of allStats) {
    if (!statsByGameAndAccount[s.match_game_id]) statsByGameAndAccount[s.match_game_id] = {}
    statsByGameAndAccount[s.match_game_id][s.account_id] = s
  }

  // Get standin map and exclusions for this stage
  const standinMap = await getStageStandinMap(stageId)
  const standinExclusions = buildStandinExclusions(standinMap)

  // Get all competition players with steam_ids
  const compPlayers = await query(`
    SELECT cp.player_id, COALESCE(p.display_name, p.name) AS name, p.avatar_url, p.steam_id
    FROM competition_players cp
    JOIN players p ON p.id = cp.player_id
    WHERE cp.competition_id = $1
  `, [compId])

  // Count how many participants picked each player per role
  const pickCounts = await query(`
    SELECT role, pick_player_id, COUNT(*)::int AS picks
    FROM fantasy_picks
    WHERE fantasy_stage_id = $1
    GROUP BY role, pick_player_id
  `, [stageId])

  const pickCountMap = {}
  for (const row of pickCounts) {
    if (!pickCountMap[row.role]) pickCountMap[row.role] = {}
    pickCountMap[row.role][row.pick_player_id] = row.picks
  }

  const roles = ['carry', 'mid', 'offlane', 'pos4', 'pos5']
  const result = {}

  for (const role of roles) {
    const multipliers = fantasyScoring[role]
    if (!multipliers) { result[role] = []; continue }

    const ranked = []
    for (const player of compPlayers) {
      const playerGameStats = resolvePlayerStats(
        player.player_id, player.steam_id, standinMap, standinExclusions, statsByGameAndAccount, gameInfos
      )
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
        picks: pickCountMap[role]?.[player.player_id] || 0,
      })
    }

    ranked.sort((a, b) => b.points - a.points)
    result[role] = ranked.slice(0, 10)
  }

  return result
}

export async function getPlayerCheckData(stageId, playerId, role, fantasyScoring) {
  const roleMultipliers = fantasyScoring[role]
  if (!roleMultipliers) return { games: [], total: 0 }

  // Get the player's steam_id
  const player = await query('SELECT steam_id FROM players WHERE id = $1', [playerId])
  if (!player.length || !player[0].steam_id) return { games: [], total: 0 }

  const accountId = steamIdToAccountId(player[0].steam_id)
  if (!accountId) return { games: [], total: 0 }

  // Get standin map and exclusions for this stage
  const standinMap = await getStageStandinMap(stageId)
  const standinExclusions = buildStandinExclusions(standinMap)
  const playerStandins = standinMap[playerId] // { matchGameId -> standinSteamId }
  const excluded = accountId ? standinExclusions[accountId] : null

  // Get all match_games for this stage with match info
  const gameRows = await query(`
    SELECT mg.id AS match_game_id, mg.game_number, mg.match_id, mg.dotabuff_id,
           m.round, m.stage,
           t1.team AS team1_name, t2.team AS team2_name
    FROM fantasy_stage_matches fsm
    JOIN match_games mg ON mg.match_id = fsm.match_id
    JOIN matches m ON m.id = mg.match_id
    LEFT JOIN captains t1 ON t1.id = m.team1_captain_id
    LEFT JOIN captains t2 ON t2.id = m.team2_captain_id
    WHERE fsm.fantasy_stage_id = $1
    ORDER BY mg.match_id, mg.game_number
  `, [stageId])

  if (gameRows.length === 0) return { games: [], total: 0 }

  const gameIds = gameRows.map(r => r.match_game_id)

  // Get all stats for these games (need all accounts since standins may vary per match)
  const allStats = await query(
    'SELECT * FROM match_game_player_stats WHERE match_game_id = ANY($1)',
    [gameIds]
  )

  // Index by match_game_id -> account_id -> stat
  const statsByGameAndAccount = {}
  for (const s of allStats) {
    if (!statsByGameAndAccount[s.match_game_id]) statsByGameAndAccount[s.match_game_id] = {}
    statsByGameAndAccount[s.match_game_id][s.account_id] = s
  }

  let grandTotal = 0
  const games = []

  for (const g of gameRows) {
    // Check if there's a standin for this game
    const standinSteamId = playerStandins?.[g.match_game_id]

    // Skip games where this player was acting as a standin for someone else
    if (!standinSteamId && excluded?.has(g.match_game_id)) continue

    const lookupAccountId = standinSteamId
      ? steamIdToAccountId(standinSteamId)
      : accountId

    const playerStats = lookupAccountId
      ? statsByGameAndAccount[g.match_game_id]?.[lookupAccountId]
      : null
    if (!playerStats) continue

    const { breakdown, total } = calculatePlayerPointsDetailed(playerStats, roleMultipliers)
    grandTotal += total

    games.push({
      matchGameId: g.match_game_id,
      gameNumber: g.game_number,
      matchLabel: `${g.team1_name || 'TBD'} vs ${g.team2_name || 'TBD'}`,
      dotabuffId: g.dotabuff_id,
      heroId: playerStats.hero_id,
      win: playerStats.win,
      breakdown,
      total,
    })
  }

  return { games, total: Math.round(grandTotal * 100) / 100 }
}
