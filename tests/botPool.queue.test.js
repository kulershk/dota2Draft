import { describe, it, expect } from 'vitest'
import { botPool } from '../server/services/botPool.js'

describe('Go message queue', () => {
  it('handles messages one at a time, in order', async () => {
    const log = []
    const orig = botPool._handleGoMessage
    botPool._handleGoMessage = async (msg) => {
      log.push(`start:${msg.type}`)
      await new Promise(r => setTimeout(r, msg.type === 'a' ? 30 : 1))
      log.push(`end:${msg.type}`)
    }
    try {
      botPool._enqueueGoMessage({ type: 'a' })
      botPool._enqueueGoMessage({ type: 'b' })
      await botPool._goQueue
      expect(log).toEqual(['start:a', 'end:a', 'start:b', 'end:b'])
    } finally {
      botPool._handleGoMessage = orig
    }
  })

  it('answers request/response messages immediately, bypassing the queue', async () => {
    let resolved = null
    botPool._botsListPending = (list) => { resolved = list }
    botPool._goQueue = new Promise(() => {}) // a stuck handler
    botPool._enqueueGoMessage({ type: 'bots_list', data: { bots: [{ botId: '1', status: 'available' }] } })
    expect(resolved).toEqual([{ botId: '1', status: 'available' }])
    botPool._goQueue = Promise.resolve()
  })
})
