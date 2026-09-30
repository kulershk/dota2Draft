import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { initDb, queryOne, execute } from '../server/db.js'
import { botPool } from '../server/services/botPool.js'
import { isMatchParticipant } from '../server/routes/lobby.js'
import { seedCompMatch, seedBot, seedLobby, cleanupSeed } from './helpers/botSeed.js'

let seed, bot, standin
const sent = []
beforeAll(async () => {
  delete process.env.STEAM_API_KEY
  await initDb()
  seed = await seedCompMatch()
  bot = await seedBot({ status: 'available' })
  standin = await queryOne("INSERT INTO players (name, steam_id, mmr, roles) VALUES ('Standin', $1, 3000, '[\"Mid\"]') RETURNING *", [`7656119${Date.now()}`.slice(0, 17)])
})
afterEach(() => { botPool.goWs = null; sent.length = 0 })
afterAll(async () => { await cleanupSeed({ ...seed, players: [...seed.players, standin], bots: [bot] }) })

const fakeGo = () => { botPool.goWs = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) } }

describe('orchestrator fixes', () => {
  it('zombie cleanup tells Go to cancel the lobby', async () => {
    fakeGo()
    const lobby = await seedLobby({ match: seed.match, botId: bot.id, status: 'cointoss' })
    await execute("UPDATE matches SET status = 'completed' WHERE id = $1", [seed.match.id])
    await botPool._cleanupZombieLobbies()
    expect(sent).toContainEqual({ type: 'cancel_lobby', data: { lobbyId: String(lobby.id) } })
  })

  it('concurrent GC match-detail requests for one match all resolve', async () => {
    fakeGo()
    const p1 = botPool.requestMatchDetailsFromGC('999')
    const p2 = botPool.requestMatchDetailsFromGC('999')
    await new Promise(r => setTimeout(r, 20))
    botPool._onMatchDetails({ matchId: '999', radiant_win: true, players: [] })
    await expect(Promise.all([p1, p2])).resolves.toHaveLength(2)
  })

  it('stand-ins count as match participants', async () => {
    await execute(
      'INSERT INTO match_standins (match_id, original_player_id, standin_player_id, captain_id) VALUES ($1, $2, $3, $4)',
      [seed.match.id, seed.players[0].id, standin.id, seed.cap1.id],
    )
    expect(await isMatchParticipant(standin.id, seed.match.id)).toBe(true)
  })
})
