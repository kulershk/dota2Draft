import { query, execute } from '../db.js'

/**
 * Recalculate favorite position for a player based on their last 10 games.
 * Uses NW ranking within team + lane_role to estimate position 1-5.
 * Stores result in players.favorite_position JSONB column.
 */
export async function recalcFavoritePosition(accountId) {
  // Get last 10 match_game_ids this player participated in
  const recentGames = await query(`
    SELECT match_game_id FROM match_game_player_stats
    WHERE account_id = $1
    ORDER BY match_game_id DESC
    LIMIT 10
  `, [String(accountId)])

  if (recentGames.length === 0) return

  const gameIds = recentGames.map(g => g.match_game_id)

  // Get all players in those games
  const allStats = await query(`
    SELECT match_game_id, account_id, net_worth, lane_role, is_radiant
    FROM match_game_player_stats
    WHERE match_game_id = ANY($1)
  `, [gameIds])

  // Group by game
  const gameMap = {}
  for (const row of allStats) {
    if (!gameMap[row.match_game_id]) gameMap[row.match_game_id] = []
    gameMap[row.match_game_id].push(row)
  }

  const positionCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  const aid = String(accountId)

  for (const players of Object.values(gameMap)) {
    const me = players.find(p => String(p.account_id) === aid)
    if (!me) continue
    const team = players.filter(p => p.is_radiant === me.is_radiant).sort((a, b) => b.net_worth - a.net_worth)
    if (team.length < 5) continue

    const cores = team.slice(0, 3)
    const supports = team.slice(3)
    const isCore = cores.some(p => String(p.account_id) === aid)

    if (isCore) {
      if (me.lane_role === 2) positionCounts[2]++
      else if (me.lane_role === 1) positionCounts[1]++
      else if (me.lane_role === 3) positionCounts[3]++
      else positionCounts[1]++
    } else {
      const myIdx = supports.findIndex(p => String(p.account_id) === aid)
      positionCounts[myIdx === 0 ? 4 : 5]++
    }
  }

  const totalGames = Object.values(positionCounts).reduce((a, b) => a + b, 0)
  if (totalGames === 0) return

  const sorted = Object.entries(positionCounts).sort((a, b) => b[1] - a[1])
  const result = {
    position: Number(sorted[0][0]),
    games: sorted[0][1],
    total: totalGames,
    distribution: positionCounts,
  }

  // Update player by steam_id (account_id + offset = steam64)
  const steam64 = String(BigInt(accountId) + 76561197960265728n)
  await execute(
    'UPDATE players SET favorite_position = $1 WHERE steam_id = $2',
    [JSON.stringify(result), steam64]
  )
}
