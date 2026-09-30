import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { initDb, queryOne } from '../server/db.js'
import { botPool } from '../server/services/botPool.js'
import { seedCompMatch, cleanupSeed } from './helpers/botSeed.js'

const seeds = []
beforeAll(async () => { await initDb() })
afterAll(async () => { for (const s of seeds) await cleanupSeed(s) })

describe('_autoFillGameWinner — competition matches', () => {
  it('completes a Bo1 series and advances the winner in the bracket', async () => {
    const seed = await seedCompMatch({ bestOf: 1, withNext: true })
    seeds.push(seed)
    await queryOne("INSERT INTO match_games (match_id, game_number, dotabuff_id) VALUES ($1, 1, '111') RETURNING id", [seed.match.id])
    const errSpy = vi.spyOn(console, 'error')

    await botPool._autoFillGameWinner(seed.match.id, 1, true, { players: [] })
    await new Promise(r => setTimeout(r, 200)) // awardXp is fire-and-forget

    const m = await queryOne('SELECT status, winner_captain_id FROM matches WHERE id = $1', [seed.match.id])
    expect(m.status).toBe('completed')
    expect(m.winner_captain_id).toBe(seed.cap1.id) // fallback: team1 = radiant
    const next = await queryOne('SELECT team1_captain_id FROM matches WHERE id = $1', [seed.next.id])
    expect(next.team1_captain_id).toBe(seed.cap1.id)
    expect(errSpy.mock.calls.flat().join(' ')).not.toMatch(/Failed to auto-fill winner/)
    errSpy.mockRestore()
  })

  it('does not throw for a non-final game of a Bo3', async () => {
    const seed = await seedCompMatch({ bestOf: 3 })
    seeds.push(seed)
    await queryOne("INSERT INTO match_games (match_id, game_number, dotabuff_id) VALUES ($1, 1, '112') RETURNING id", [seed.match.id])
    const errSpy = vi.spyOn(console, 'error')
    await botPool._autoFillGameWinner(seed.match.id, 1, false, { players: [] })
    await new Promise(r => setTimeout(r, 200))
    expect(errSpy.mock.calls.flat().join(' ')).not.toMatch(/Failed to auto-fill winner/)
    const m = await queryOne('SELECT score1, score2, status FROM matches WHERE id = $1', [seed.match.id])
    expect([m.score1, m.score2, m.status]).toEqual([0, 1, 'live'])
    errSpy.mockRestore()
  })
})
