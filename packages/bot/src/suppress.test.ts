import { describe, expect, it, beforeEach, afterEach, setSystemTime } from 'bun:test'
import { suppress, unsuppress, isSuppressed, remainingMinutes, listSuppressions, suppressHint, suppressNotice, resetForTest, SUPPRESS_DEFAULT_MIN, SUPPRESS_MAX_MIN } from './suppress'
import { validate } from './ai-directive'

describe('suppress state', () => {
  beforeEach(() => resetForTest())
  afterEach(() => setSystemTime())

  it('defaults to 30m and reports remaining minutes', () => {
    expect(suppress('ch', 'trivia', 'modguy')).toBe(SUPPRESS_DEFAULT_MIN)
    expect(isSuppressed('ch', 'trivia')).toBe(true)
    expect(isSuppressed('ch', 'ai')).toBe(false)
    expect(remainingMinutes('ch', 'trivia')).toBe(SUPPRESS_DEFAULT_MIN)
  })

  it('clamps minutes to 1..180', () => {
    expect(suppress('ch', 'ai', 'm', 0)).toBe(1)
    expect(suppress('ch', 'ai', 'm', 9999)).toBe(SUPPRESS_MAX_MIN)
    expect(suppress('ch', 'ai', 'm', -5)).toBe(1)
  })

  it('channel is case-insensitive', () => {
    suppress('ChAn', 'trivia', 'm')
    expect(isSuppressed('chan', 'trivia')).toBe(true)
  })

  it("'all' implies every feature", () => {
    suppress('ch', 'all', 'm')
    expect(isSuppressed('ch', 'trivia')).toBe(true)
    expect(isSuppressed('ch', 'depths')).toBe(true)
    expect(isSuppressed('ch', 'ai')).toBe(true)
    expect(remainingMinutes('ch', 'depths')).toBeGreaterThan(0)
  })

  it('expires lazily', () => {
    suppress('ch', 'trivia', 'm', 10)
    setSystemTime(new Date(Date.now() + 11 * 60_000))
    expect(isSuppressed('ch', 'trivia')).toBe(false)
    expect(listSuppressions('ch').length).toBe(0)
  })

  it('unsuppress lifts one feature; all clears everything', () => {
    suppress('ch', 'trivia', 'm')
    suppress('ch', 'ai', 'm')
    expect(unsuppress('ch', 'trivia')).toBe(true)
    expect(isSuppressed('ch', 'trivia')).toBe(false)
    expect(isSuppressed('ch', 'ai')).toBe(true)
    suppress('ch', 'depths', 'm')
    expect(unsuppress('ch', 'all')).toBe(true)
    expect(listSuppressions('ch').length).toBe(0)
  })

  it('unsuppress on a clean channel is false (resume falls through)', () => {
    expect(unsuppress('ch', 'trivia')).toBe(false)
    expect(unsuppress('ch', 'all')).toBe(false)
  })

  it('hint is empty when nothing is paused, names features when paused', () => {
    expect(suppressHint('ch')).toBe('')
    suppress('ch', 'trivia', 'm', 18)
    expect(suppressHint('ch')).toContain('[MOD PAUSE]')
    expect(suppressHint('ch')).toContain('trivia (18m left)')
  })

  it('notice fires only under ai pause and throttles to one per 5min', () => {
    expect(suppressNotice('ch')).toBeNull()
    suppress('ch', 'ai', 'm', 20)
    expect(suppressNotice('ch')).toContain('back in ~20m')
    expect(suppressNotice('ch')).toBeNull() // throttled
    setSystemTime(new Date(Date.now() + 6 * 60_000))
    expect(suppressNotice('ch')).toContain('a mod paused my answers')
  })
})

// the AI-parse backstop: even a model-emitted suppress object is discarded for a
// non-mod call — mod authority is badge-derived, never text- or model-derived.
describe('ai-directive validate suppress backstop', () => {
  const sup = '{"ok":true,"kind":"suppress","feature":"trivia","minutes":30}'
  const res = '{"ok":true,"kind":"resume","feature":"all"}'

  it('accepts suppress/resume for mods', () => {
    expect(validate(sup, true)).toEqual({ kind: 'suppress', feature: 'trivia', minutes: 30 })
    expect(validate(res, true)).toEqual({ kind: 'resume', feature: 'all', minutes: undefined })
  })

  it('rejects suppress/resume for non-mods', () => {
    expect(validate(sup, false)).toBeNull()
    expect(validate(res, false)).toBeNull()
    expect(validate(sup)).toBeNull() // default arg is the safe one
  })

  it('rejects unknown features and junk minutes', () => {
    expect(validate('{"ok":true,"kind":"suppress","feature":"everything"}', true)).toBeNull()
    expect(validate('{"ok":true,"kind":"suppress","feature":"trivia","minutes":"lol"}', true))
      .toEqual({ kind: 'suppress', feature: 'trivia', minutes: undefined })
  })

  it('still parses a plain viewer directive with isMod false', () => {
    const d = validate('{"ok":true,"mute":false,"target":"","trigger":["topology"],"instruction":"pirate speak"}', false)
    expect(d).toEqual({ trigger: ['topology'], targetUser: undefined, mute: false, instruction: 'pirate speak' })
  })
})
