import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { initDb, execute } from '../server/db.js'
import { botPool } from '../server/services/botPool.js'
import { seedCompMatch, seedBot, seedLobby, cleanupSeed } from './helpers/botSeed.js'

let seed, bot
beforeAll(async () => {
  await initDb()
  seed = await seedCompMatch()
  bot = await seedBot({ status: 'connecting_gc' })
  await execute("UPDATE bot_status_history SET created_at = NOW() - INTERVAL '10 minutes' WHERE bot_id = $1", [bot.id])
  await seedLobby({ match: seed.match, botId: bot.id, status: 'waiting' })
})
afterAll(async () => { await cleanupSeed({ ...seed, bots: [bot] }) })
// (the status trigger fires on INSERT, so seedBot already wrote the history row we backdate)

describe('stuck-connecting watchdog', () => {
  it('skips bots in a live lobby', async () => {
    const dis = vi.spyOn(botPool, 'disconnectBot').mockResolvedValue()
    const con = vi.spyOn(botPool, 'connectBot').mockResolvedValue()
    await botPool._cleanupStuckConnectingBots()
    expect(dis).not.toHaveBeenCalledWith(bot.id)
    dis.mockRestore(); con.mockRestore()
  })
})
