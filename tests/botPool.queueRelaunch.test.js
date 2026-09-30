import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'

// Pass-through spy on awardXp so the settlement idempotency test can count
// payouts (the real function still runs).
vi.mock('../server/helpers/xp.js', async (importOriginal) => {
  const mod = await importOriginal()
  return { ...mod, awardXp: vi.fn(mod.awardXp) }
})

import { initDb, query, queryOne, execute } from '../server/db.js'
import { botPool } from '../server/services/botPool.js'
import { awardXp } from '../server/helpers/xp.js'
import {
  seedCompMatch, seedBot, seedLobby, cleanupSeed,
  seedQueueMatch, seedQueueLobby, cleanupQueueSeed,
} from './helpers/botSeed.js'

let q, bot
const compSeeds = []
const sent = []
const fakeGo = () => { botPool.goWs = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) } }
const launches = (lobbyId) => sent.filter(m => m.type === 'force_launch' && m.data.lobbyId === String(lobbyId))

beforeAll(async () => {
  delete process.env.STEAM_API_KEY // keep startLivePolling from polling Steam during the test
  await initDb()
  q = await seedQueueMatch()
  bot = await seedBot({ status: 'busy' })
})
afterEach(() => { botPool.goWs = null; sent.length = 0 })
afterAll(async () => {
  await cleanupQueueSeed({ ...q, bots: [bot] })
  for (const s of compSeeds) await cleanupSeed(s)
})

// Both expected players seated on their correct side.
const slotted = () => q.playersExpected.map(p => ({ steamId: p.steam_id, team: p.team }))
const status = (id) => botPool._onLobbyStatus({ lobbyId: String(id), status: 'waiting', playersJoined: slotted() })
const rowStatus = async (id) => (await queryOne('SELECT status FROM match_lobbies WHERE id = $1', [id])).status

describe('queue lobby auto-relaunch', () => {
  it('relaunches after a failed load using the persisted (JSONB) team ids', async () => {
    fakeGo()
    const lobby = await seedQueueLobby({ match: q.match, botId: bot.id, playersExpected: q.playersExpected })
    await botPool._onLobbyTeamIds({ lobbyId: String(lobby.id), radiantTeamId: 11, direTeamId: 22 })
    await status(lobby.id)
    expect(launches(lobby.id)).toHaveLength(1)

    await botPool._onGameStarted({ lobbyId: String(lobby.id), matchId: '555' }) // drops the in-memory team ids
    await botPool._onGameAborted({ lobbyId: String(lobby.id), matchId: '555' })
    botPool._autoLaunchAt.set(lobby.id, 0) // >30s since the abort
    await status(lobby.id)
    expect(launches(lobby.id)).toHaveLength(2)
    expect(await rowStatus(lobby.id)).toBe('launching')
    await execute("UPDATE match_lobbies SET status = 'cancelled' WHERE id = $1", [lobby.id])
  })

  it('gives players 30s after an abort before auto-relaunching', async () => {
    fakeGo()
    const lobby = await seedQueueLobby({ match: q.match, botId: bot.id, playersExpected: q.playersExpected, gameNumber: 2 })
    await botPool._onLobbyTeamIds({ lobbyId: String(lobby.id), radiantTeamId: 11, direTeamId: 22 })
    await status(lobby.id)
    expect(launches(lobby.id)).toHaveLength(1)
    botPool._autoLaunchAt.set(lobby.id, 0) // loading took longer than 30s

    await botPool._onGameStarted({ lobbyId: String(lobby.id), matchId: '556' })
    await botPool._onGameAborted({ lobbyId: String(lobby.id), matchId: '556' })
    await status(lobby.id)
    expect(launches(lobby.id)).toHaveLength(1) // abort re-armed the 30s window
    expect(await rowStatus(lobby.id)).toBe('waiting')

    botPool._autoLaunchAt.set(lobby.id, 0)
    await status(lobby.id)
    expect(launches(lobby.id)).toHaveLength(2)
    await execute("UPDATE match_lobbies SET status = 'cancelled' WHERE id = $1", [lobby.id])
  })

  it.each(['cancelled', 'completed'])('a late "waiting" never revives a %s lobby', async (terminal) => {
    fakeGo()
    const lobby = await seedQueueLobby({ match: q.match, botId: bot.id, playersExpected: q.playersExpected, gameNumber: terminal === 'cancelled' ? 3 : 4 })
    await botPool._onLobbyTeamIds({ lobbyId: String(lobby.id), radiantTeamId: 11, direTeamId: 22 })
    await execute('UPDATE match_lobbies SET status = $1 WHERE id = $2', [terminal, lobby.id])
    botPool._autoLaunchAt.delete(lobby.id)
    await status(lobby.id)
    expect(await rowStatus(lobby.id)).toBe(terminal)
    expect(launches(lobby.id)).toHaveLength(0)
  })

  it('forceLaunch does nothing for a lobby that is no longer waiting/launching', async () => {
    fakeGo()
    const lobby = await seedQueueLobby({ match: q.match, botId: bot.id, playersExpected: q.playersExpected, gameNumber: 5, status: 'cancelled' })
    await botPool.forceLaunch(lobby.id)
    expect(await rowStatus(lobby.id)).toBe('cancelled')
    expect(launches(lobby.id)).toHaveLength(0)
  })
})

describe('settlement idempotency', () => {
  it('_autoFillGameWinner pays out a game only once', async () => {
    const seed = await seedCompMatch({ bestOf: 3 })
    compSeeds.push(seed)
    for (const [p, cap] of [[seed.players[0], seed.cap1], [seed.players[1], seed.cap2]]) {
      await execute('INSERT INTO competition_players (competition_id, player_id, drafted_by) VALUES ($1, $2, $3)', [seed.comp.id, p.id, cap.id])
    }
    await execute("INSERT INTO match_games (match_id, game_number, dotabuff_id) VALUES ($1, 1, '777')", [seed.match.id])
    awardXp.mockClear()
    await botPool._autoFillGameWinner(seed.match.id, 1, true, { players: [] })
    const first = awardXp.mock.calls.length
    expect(first).toBeGreaterThan(0)
    await botPool._autoFillGameWinner(seed.match.id, 1, true, { players: [] })
    expect(awardXp.mock.calls.length).toBe(first)
  })

  it('_scheduleStatsFetch does not enqueue a duplicate job for the same game + match id', async () => {
    const seed = await seedCompMatch()
    compSeeds.push(seed)
    await execute("INSERT INTO match_games (match_id, game_number, dotabuff_id) VALUES ($1, 1, '888')", [seed.match.id])
    await botPool._scheduleStatsFetch(seed.match.id, 1, '888')
    await botPool._scheduleStatsFetch(seed.match.id, 1, '888')
    const jobs = await query("SELECT id FROM jobs WHERE type = 'fetch_match_stats' AND payload->>'matchId' = $1", [String(seed.match.id)])
    expect(jobs).toHaveLength(1)
  })
})
