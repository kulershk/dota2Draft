import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { initDb, queryOne } from '../server/db.js'
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
  botA = await seedBot({ status: 'available' })
  botB = await seedBot({ status: 'available' })
})
afterEach(() => { botPool.goWs = null; sent.length = 0 })
afterAll(async () => { await cleanupSeed({ ...seed, bots: [botA, botB] }) })

describe('bot claiming', () => {
  it('refuses to claim a bot while Go is offline', async () => {
    botPool.goWs = null
    await expect(botPool._findAvailableBotId()).rejects.toThrow(/offline/)
    const a = await queryOne('SELECT status FROM lobby_bots WHERE id = $1', [botA.id])
    expect(a.status).toBe('available')
  })

  it('comp retry claims a different bot atomically and hands it to Go', async () => {
    fakeGo(() => [
      { botId: String(botA.id), status: 'available' },
      { botId: String(botB.id), status: 'available' },
    ])
    const errored = await seedLobby({ match: seed.match, botId: botA.id, status: 'error' })
    const ok = await botPool._retryCompLobby(errored)
    expect(ok).toBe(true)
    const create = sent.find(m => m.type === 'create_lobby')
    expect(create.data.botId).not.toBe(String(botA.id))
    const claimed = await queryOne('SELECT status FROM lobby_bots WHERE id = $1', [Number(create.data.botId)])
    expect(claimed.status).toBe('busy')
  })

  it('comp retry whose match row is missing claims no bot', async () => {
    // Dedicated bots (rather than the shared botA/botB) so an earlier test's
    // successful claim in this file can't leave a 'busy' row that makes this
    // assertion a false negative.
    const botC = await seedBot({ status: 'available' })
    const botD = await seedBot({ status: 'available' })
    try {
      fakeGo(() => [
        { botId: String(botC.id), status: 'available' },
        { botId: String(botD.id), status: 'available' },
      ])
      // Not seeded from the DB — match_id points at a match row that doesn't
      // exist, so _retryCompLobby's `if (!match) return false` fires. The bot
      // claim must happen AFTER that read, so this early-out never strands a
      // bot 'busy' with nothing to release it.
      const erroredLobby = {
        match_id: 987654321,
        game_number: 1,
        competition_id: seed.comp.id,
        bot_id: botC.id,
        server_region: 3,
        game_name: 'ghost lobby',
        password: 'pw',
        players_expected: [],
      }
      const ok = await botPool._retryCompLobby(erroredLobby)
      expect(ok).toBe(false)
      expect(sent.find(m => m.type === 'create_lobby')).toBeUndefined()
      const c = await queryOne('SELECT status FROM lobby_bots WHERE id = $1', [botC.id])
      const d = await queryOne('SELECT status FROM lobby_bots WHERE id = $1', [botD.id])
      expect(c.status).toBe('available')
      expect(d.status).toBe('available')
    } finally {
      await cleanupSeed({ bots: [botC, botD] })
    }
  })
})
