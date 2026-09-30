// Minimal row factories for bot/lobby tests. Every factory tags rows with a
// unique suffix so tests can clean up exactly what they created.
import { queryOne, execute } from '../../server/db.js'

const uniq = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

export async function seedCompMatch({ bestOf = 1, withNext = false, settings = {} } = {}) {
  const tag = uniq()
  const comp = await queryOne(
    'INSERT INTO competitions (name, settings) VALUES ($1, $2) RETURNING *',
    [`bot-test-${tag}`, JSON.stringify(settings)],
  )
  const mkPlayer = (n) => queryOne(
    'INSERT INTO players (name, steam_id, mmr, roles) VALUES ($1, $2, 3000, $3) RETURNING *',
    [`P${n}-${tag}`, `7656119${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`, '["Mid"]'],
  )
  const p1 = await mkPlayer(1)
  const p2 = await mkPlayer(2)
  const cap1 = await queryOne(
    "INSERT INTO captains (competition_id, name, team, player_id) VALUES ($1, 'C1', 'Team A', $2) RETURNING *",
    [comp.id, p1.id],
  )
  const cap2 = await queryOne(
    "INSERT INTO captains (competition_id, name, team, player_id) VALUES ($1, 'C2', 'Team B', $2) RETURNING *",
    [comp.id, p2.id],
  )
  const next = withNext
    ? await queryOne('INSERT INTO matches (competition_id, best_of) VALUES ($1, 1) RETURNING *', [comp.id])
    : null
  const match = await queryOne(
    `INSERT INTO matches (competition_id, team1_captain_id, team2_captain_id, best_of, status, next_match_id, next_match_slot)
     VALUES ($1, $2, $3, $4, 'live', $5, $6) RETURNING *`,
    [comp.id, cap1.id, cap2.id, bestOf, next?.id ?? null, next ? 1 : null],
  )
  return { tag, comp, players: [p1, p2], cap1, cap2, match, next }
}

export async function seedBot({ status = 'available', tag = uniq() } = {}) {
  return queryOne(
    "INSERT INTO lobby_bots (username, password, status) VALUES ($1, 'x', $2) RETURNING *",
    [`bot-${tag}`, status],
  )
}

export async function seedLobby({ match, botId, status = 'waiting', gameNumber = 1, competitionId = match.competition_id }) {
  return queryOne(
    `INSERT INTO match_lobbies (match_id, game_number, competition_id, bot_id, status, game_name, password, players_expected)
     VALUES ($1, $2, $3, $4, $5, 'test lobby', 'pw', '[]') RETURNING *`,
    [match.id, gameNumber, competitionId, botId, status],
  )
}

export async function cleanupSeed({ comp, players = [], bots = [] }) {
  if (comp) {
    await execute("DELETE FROM jobs WHERE payload->>'matchId' IN (SELECT id::text FROM matches WHERE competition_id = $1)", [comp.id])
    await execute('DELETE FROM xp_log WHERE player_id = ANY($1::int[])', [players.map(p => p.id)])
    // match_standins.captain_id has no ON DELETE CASCADE, so it must be
    // cleared before the competition delete cascades into captains — leaving
    // it to the cascade risks captains being removed first and tripping the
    // FK (cascade ordering across sibling FKs on the same parent row isn't
    // guaranteed to run matches-then-match_standins before captains).
    await execute('DELETE FROM match_standins WHERE match_id IN (SELECT id FROM matches WHERE competition_id = $1)', [comp.id])
    await execute('DELETE FROM competitions WHERE id = $1', [comp.id]) // cascades matches, captains, lobbies
  }
  if (players.length) await execute('DELETE FROM players WHERE id = ANY($1::int[])', [players.map(p => p.id)])
  if (bots.length) await execute('DELETE FROM lobby_bots WHERE id = ANY($1::int[])', [bots.map(b => b.id)])
}

// Queue match: pool + competition-less match + queue_matches row + one player
// per side. Pair with cleanupQueueSeed (deletes exactly these rows).
export async function seedQueueMatch() {
  const tag = uniq()
  const mkPlayer = (n) => queryOne(
    'INSERT INTO players (name, steam_id, mmr, roles) VALUES ($1, $2, 3000, $3) RETURNING *',
    [`Q${n}-${tag}`, `7656119${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`, '["Mid"]'],
  )
  const p1 = await mkPlayer(1)
  const p2 = await mkPlayer(2)
  const pool = await queryOne('INSERT INTO queue_pools (name) VALUES ($1) RETURNING *', [`bot-test-pool-${tag}`])
  const match = await queryOne(
    "INSERT INTO matches (competition_id, best_of, status) VALUES (NULL, 1, 'live') RETURNING *",
  )
  const side = (p) => JSON.stringify([{ playerId: p.id, steamId: p.steam_id, name: p.name }])
  const queueMatch = await queryOne(
    `INSERT INTO queue_matches (pool_id, match_id, captain1_player_id, captain2_player_id, team1_players, team2_players, all_player_ids, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'live') RETURNING *`,
    [pool.id, match.id, p1.id, p2.id, side(p1), side(p2), JSON.stringify([p1.id, p2.id])],
  )
  const playersExpected = [
    { steam_id: p1.steam_id, name: p1.name, team: 'radiant' },
    { steam_id: p2.steam_id, name: p2.name, team: 'dire' },
  ]
  return { tag, pool, match, queueMatch, players: [p1, p2], playersExpected }
}

export async function seedQueueLobby({ match, botId, playersExpected, status = 'waiting', gameNumber = 1 }) {
  return queryOne(
    `INSERT INTO match_lobbies (match_id, game_number, competition_id, bot_id, status, game_name, password, players_expected)
     VALUES ($1, $2, NULL, $3, $4, 'test queue lobby', 'pw', $5) RETURNING *`,
    [match.id, gameNumber, botId, status, JSON.stringify(playersExpected)],
  )
}

export async function cleanupQueueSeed({ pool, match, players = [], bots = [] }) {
  if (match) {
    await execute("DELETE FROM jobs WHERE payload->>'matchId' = $1", [String(match.id)])
    await execute('DELETE FROM match_lobbies WHERE match_id = $1', [match.id])
    await execute('DELETE FROM matches WHERE id = $1', [match.id]) // cascades match_games
  }
  if (pool) await execute('DELETE FROM queue_pools WHERE id = $1', [pool.id]) // cascades queue_matches
  if (players.length) {
    await execute('DELETE FROM xp_log WHERE player_id = ANY($1::int[])', [players.map(p => p.id)])
    await execute('DELETE FROM players WHERE id = ANY($1::int[])', [players.map(p => p.id)])
  }
  if (bots.length) await execute('DELETE FROM lobby_bots WHERE id = ANY($1::int[])', [bots.map(b => b.id)])
}
