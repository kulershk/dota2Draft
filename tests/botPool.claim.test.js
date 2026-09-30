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
})
