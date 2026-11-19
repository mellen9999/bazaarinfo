import { describe, expect, it } from 'bun:test'
import { modelName, thinkingOff } from './models'

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

describe('modelName', () => {
  it('reads like a name, version dotted, date dropped', () => {
    expect(modelName('claude-sonnet-5')).toBe('claude sonnet 5')
    expect(modelName('claude-sonnet-5-5')).toBe('claude sonnet 5.5')
    expect(modelName('claude-haiku-4-5-20251001')).toBe('claude haiku 4.5')
  })
})
