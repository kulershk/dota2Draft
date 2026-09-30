import { describe, it, expect } from 'vitest'
import { statsJobSuperseded } from '../server/helpers/statsJobs.js'

describe('statsJobSuperseded', () => {
  it('is false when the game still carries the job match id', () => {
    expect(statsJobSuperseded({ dotabuff_id: '111' }, '111')).toBe(false)
    expect(statsJobSuperseded({ dotabuff_id: '111' }, 111)).toBe(false)
  })
  it('is true when the game now has a different match id (relaunch)', () => {
    expect(statsJobSuperseded({ dotabuff_id: '222' }, '111')).toBe(true)
  })
  it('is true when the match id was cleared (aborted start)', () => {
    expect(statsJobSuperseded({ dotabuff_id: null }, '111')).toBe(true)
    expect(statsJobSuperseded({ dotabuff_id: '' }, '111')).toBe(true)
  })
})
