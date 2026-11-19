import { describe, expect, it } from 'bun:test'
import { thinkingOff } from './models'

describe('thinkingOff', () => {
  it('sonnet 5.5 rejects disabled, gets between_tools', () => {
    expect(thinkingOff('claude-sonnet-5-5')).toEqual({ type: 'between_tools' })
  })
  it('everything else turns thinking off outright', () => {
    for (const m of ['claude-sonnet-5', 'claude-haiku-5-5', 'claude-haiku-4-5-20251001']) {
      expect(thinkingOff(m)).toEqual({ type: 'disabled' })
    }
  })
})
