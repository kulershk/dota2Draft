import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { initDb, queryOne, query } from '../server/db.js'
import { botPool } from '../server/services/botPool.js'
import { seedCompMatch, seedBot, seedLobby, cleanupSeed } from './helpers/botSeed.js'

let seed, botA, botB
const sent = []
function fakeGo(liveStatuses) {
  botPool.goWs = {
    readyState: 1,
    send: (raw) => {
      const msg = JSON.parse(raw)
      sent.push(msg)
      if (msg.type === 'list_bots') {
        setImmediate(() => botPool._onBotsList({ bots: liveStatuses() }))
      }
    },
  }
}

beforeAll(async () => {
  await initDb()
  seed = await seedCompMatch()
  botA = await seedBot({ status: 'busy' })
  botB = await seedBot({ status: 'available' })
})
afterEach(() => { botPool.goWs = null; sent.length = 0 })
afterAll(async () => { await cleanupSeed({ ...seed, bots: [botA, botB] }) })

describe('_onLobbyError idempotency', () => {
  it('ignores a replayed lobby_error on an already-errored lobby (no retry, no side effects)', async () => {
    fakeGo(() => [
      { botId: String(botA.id), status: 'available' },
      { botId: String(botB.id), status: 'available' },
    ])
    const errored = await seedLobby({ match: seed.match, botId: botA.id, status: 'error', gameNumber: 1 })

    await botPool._onLobbyError({ lobbyId: errored.id, error: 'replayed GC deadline exceeded' })

    const rows = await query('SELECT * FROM match_lobbies WHERE match_id = $1 AND game_number = 1', [seed.match.id])
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe('error')
    const createMsgs = sent.filter(m => m.type === 'create_lobby')
    expect(createMsgs.length).toBe(0)
  })

  it('a first lobby_error on a creating comp lobby still triggers exactly one retry', async () => {
    fakeGo(() => [
      { botId: String(botA.id), status: 'available' },
      { botId: String(botB.id), status: 'available' },
    ])
    const creating = await seedLobby({ match: seed.match, botId: botA.id, status: 'creating', gameNumber: 2 })

    await botPool._onLobbyError({ lobbyId: creating.id, error: 'context deadline exceeded' })

    const createMsgs = sent.filter(m => m.type === 'create_lobby')
    expect(createMsgs.length).toBe(1)
    const rows = await query('SELECT * FROM match_lobbies WHERE match_id = $1 AND game_number = 2 ORDER BY id', [seed.match.id])
    expect(rows.length).toBe(2)
    expect(rows[0].status).toBe('error')
    expect(rows[1].status).toBe('creating')
  })
})
