import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { initDb, queryOne } from '../server/db.js'
import { botPool } from '../server/services/botPool.js'
import { seedCompMatch, seedBot, seedLobby, cleanupSeed } from './helpers/botSeed.js'

let seed, bot, lobby
beforeAll(async () => {
  delete process.env.STEAM_API_KEY // keep startLivePolling from polling Steam during the test
  await initDb()
  seed = await seedCompMatch()
  bot = await seedBot({ status: 'busy' })
  lobby = await seedLobby({ match: seed.match, botId: bot.id, status: 'launching' })
})
afterAll(async () => { await cleanupSeed({ ...seed, bots: [bot] }) })

const row = () => queryOne('SELECT status, dota_match_id FROM match_lobbies WHERE id = $1', [lobby.id])
const game = () => queryOne('SELECT dotabuff_id FROM match_games WHERE match_id = $1 AND game_number = 1', [seed.match.id])

describe('lobby lifecycle', () => {
  it('game_started records the match id but keeps the lobby open and the bot busy', async () => {
    await botPool._onGameStarted({ lobbyId: String(lobby.id), matchId: '111' })
    expect(await row()).toEqual({ status: 'launching', dota_match_id: '111' })
    expect((await game()).dotabuff_id).toBe('111')
    expect((await queryOne('SELECT status FROM lobby_bots WHERE id = $1', [bot.id])).status).toBe('busy')
  })

  it('game_aborted rolls the lobby back so it can be relaunched', async () => {
    await botPool._onLobbyStatus({ lobbyId: String(lobby.id), status: 'active', playersJoined: [] })
    await botPool._onGameAborted({ lobbyId: String(lobby.id), matchId: '111' })
    await botPool._onLobbyStatus({ lobbyId: String(lobby.id), status: 'waiting', playersJoined: [] })
    expect(await row()).toEqual({ status: 'waiting', dota_match_id: null })
    expect((await game()).dotabuff_id).toBeNull()
  })

  it('draft_started completes the lobby; replays are no-ops', async () => {
    await botPool._onGameStarted({ lobbyId: String(lobby.id), matchId: '222' })
    await botPool._onDraftStarted({ lobbyId: String(lobby.id), matchId: '222', confirmed: true })
    expect(await row()).toEqual({ status: 'completed', dota_match_id: '222' })
    await botPool._onGameStarted({ lobbyId: String(lobby.id), matchId: '222' }) // replay after reconnect
    expect(await row()).toEqual({ status: 'completed', dota_match_id: '222' })
  })
})

describe('game_aborted id guard', () => {
  let lobby2
  const row2 = () => queryOne('SELECT status, dota_match_id FROM match_lobbies WHERE id = $1', [lobby2.id])

  beforeAll(async () => {
    lobby2 = await seedLobby({ match: seed.match, botId: bot.id, status: 'launching', gameNumber: 2 })
    await botPool._onGameStarted({ lobbyId: String(lobby2.id), matchId: '333' })
  })

  it('does nothing when the aborted matchId does not match the lobby\'s current dota_match_id', async () => {
    await botPool._onGameAborted({ lobbyId: String(lobby2.id), matchId: '999' })
    expect(await row2()).toEqual({ status: 'launching', dota_match_id: '333' })
  })

  it('replayed draft_started and game_aborted on an already-completed lobby do nothing', async () => {
    await botPool._onDraftStarted({ lobbyId: String(lobby2.id), matchId: '333', confirmed: true })
    const completed = await row2()
    expect(completed).toEqual({ status: 'completed', dota_match_id: '333' })

    // Replay draft_started — no-op (status already completed)
    await botPool._onDraftStarted({ lobbyId: String(lobby2.id), matchId: '333', confirmed: true })
    expect(await row2()).toEqual(completed)

    // A late game_aborted for the now-completed lobby must not roll it back
    await botPool._onGameAborted({ lobbyId: String(lobby2.id), matchId: '333' })
    expect(await row2()).toEqual(completed)
  })
})
