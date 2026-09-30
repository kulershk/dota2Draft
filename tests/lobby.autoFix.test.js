// Unit tests for the GET-lobby route's stale-status auto-fix decision.
// Pure function — no DB/app needed (tests/setup.js does not mount the lobby
// router today, see task-10-report.md "Fix round 1" for why this is a
// standalone unit test rather than a route-level integration test).
import { describe, it, expect } from 'vitest'
import { shouldMarkBotDisconnected } from '../server/routes/lobby.js'

describe('shouldMarkBotDisconnected', () => {
  it('marks disconnected when a waiting lobby\'s bot is available again', () => {
    const lobby = { status: 'waiting', bot_id: 5, dota_match_id: null }
    expect(shouldMarkBotDisconnected(lobby, 'available')).toBe(true)
  })

  it('marks disconnected for a launching lobby too', () => {
    const lobby = { status: 'launching', bot_id: 5, dota_match_id: null }
    expect(shouldMarkBotDisconnected(lobby, 'available')).toBe(true)
  })

  it('does nothing when the bot is still busy', () => {
    const lobby = { status: 'waiting', bot_id: 5, dota_match_id: null }
    expect(shouldMarkBotDisconnected(lobby, 'busy')).toBe(false)
  })

  it('does nothing for a lobby with no bot assigned', () => {
    const lobby = { status: 'waiting', bot_id: null, dota_match_id: null }
    expect(shouldMarkBotDisconnected(lobby, 'available')).toBe(false)
  })

  it('does nothing for a completed/active/error lobby', () => {
    expect(shouldMarkBotDisconnected({ status: 'completed', bot_id: 5, dota_match_id: null }, 'available')).toBe(false)
    expect(shouldMarkBotDisconnected({ status: 'active', bot_id: 5, dota_match_id: null }, 'available')).toBe(false)
    expect(shouldMarkBotDisconnected({ status: 'error', bot_id: 5, dota_match_id: null }, 'available')).toBe(false)
  })

  it('skips a loading lobby — dota_match_id set means the game already launched and players are loading in', () => {
    const lobby = { status: 'launching', bot_id: 5, dota_match_id: '111' }
    expect(shouldMarkBotDisconnected(lobby, 'available')).toBe(false)
  })

  it('returns false for a null lobby', () => {
    expect(shouldMarkBotDisconnected(null, 'available')).toBe(false)
  })
})
