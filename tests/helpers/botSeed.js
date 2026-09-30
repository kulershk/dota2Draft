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
