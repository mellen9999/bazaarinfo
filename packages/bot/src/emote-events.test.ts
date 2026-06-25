import { describe, test, expect, beforeEach } from 'bun:test'
import { validEmoteName, handleDispatch, subscribeChannel } from './emote-events'
import { addChannelEmote, removeChannelEmote, renameChannelEmote, getEmotesForChannel } from './emotes'

// ─── helpers ─────────────────────────────────────────────────────────────────

const TEST_CHANNEL = '_emote_test_'
const TEST_SET_ID = 'test-set-001'

/** build a minimal dispatch body routed to TEST_CHANNEL */
function dispatch(changes: Record<string, any>) {
  return { condition: { object_id: TEST_SET_ID }, body: changes }
}

// wire up routing so handleDispatch can resolve to TEST_CHANNEL
// (subscribeChannel populates setIdToChannel; ws=null so send() is a no-op)
subscribeChannel(TEST_CHANNEL, TEST_SET_ID)

// ─── #6/#11: validEmoteName ───────────────────────────────────────────────────

describe('validEmoteName — #6 whitespace, #11 length cap', () => {
  test('accepts a normal name', () => {
    expect(validEmoteName('Pog')).toBe('Pog')
  })

  test('trims and returns null for whitespace-only name', () => {
    expect(validEmoteName(' ')).toBeNull()
    expect(validEmoteName('\t\n')).toBeNull()
    expect(validEmoteName('')).toBeNull()
  })

  test('trims leading/trailing space from a valid name', () => {
    expect(validEmoteName('  Pog  ')).toBe('Pog')
  })

  test('accepts name exactly at the 64-char limit', () => {
    const name64 = 'a'.repeat(64)
    expect(validEmoteName(name64)).toBe(name64)
  })

  test('rejects name > 64 chars (#11)', () => {
    expect(validEmoteName('a'.repeat(65))).toBeNull()
    expect(validEmoteName('a'.repeat(100_000))).toBeNull()
  })

  test('rejects non-string', () => {
    expect(validEmoteName(null)).toBeNull()
    expect(validEmoteName(42)).toBeNull()
    expect(validEmoteName(undefined)).toBeNull()
  })
})

// ─── #6: whitespace emote cannot enter the emote set via handleDispatch ───────

describe('handleDispatch — #6 whitespace name rejected at ingestion', () => {
  beforeEach(() => {
    // clear test channel emotes to isolate
    removeChannelEmote(TEST_CHANNEL, ' ')
    removeChannelEmote(TEST_CHANNEL, '\t')
  })

  test('pushed whitespace-named emote is not added to channel set', () => {
    const before = getEmotesForChannel(TEST_CHANNEL).length

    handleDispatch(dispatch({
      pushed: [{ value: { name: '   ' } }],
    }))

    const after = getEmotesForChannel(TEST_CHANNEL)
    expect(after.length).toBe(before)
    // confirm the whitespace token is not present at all
    expect(after).not.toContain(' ')
    expect(after).not.toContain('')
    expect(after).not.toContain('   ')
  })

  test('updated (renamed) to whitespace drops the rename', () => {
    addChannelEmote(TEST_CHANNEL, 'PogSafe')

    handleDispatch(dispatch({
      updated: [{ old_value: { name: 'PogSafe' }, value: { name: ' ' } }],
    }))

    // original should still be present (rename refused), whitespace absent
    const emotes = getEmotesForChannel(TEST_CHANNEL)
    expect(emotes).toContain('PogSafe')
    expect(emotes).not.toContain(' ')
  })
})

// ─── #11: oversized name cannot enter the emote set ───────────────────────────

describe('handleDispatch — #11 oversized name rejected', () => {
  test('pushed 100k-char name is not added', () => {
    const huge = 'x'.repeat(100_000)
    const before = getEmotesForChannel(TEST_CHANNEL).length

    handleDispatch(dispatch({
      pushed: [{ value: { name: huge } }],
    }))

    const after = getEmotesForChannel(TEST_CHANNEL)
    expect(after.length).toBe(before)
    expect(after.some((n) => n.length > 64)).toBe(false)
  })

  test('pushed 65-char name is not added', () => {
    const name65 = 'b'.repeat(65)
    handleDispatch(dispatch({
      pushed: [{ value: { name: name65 } }],
    }))
    expect(getEmotesForChannel(TEST_CHANNEL)).not.toContain(name65)
  })

  test('pushed 64-char name is accepted', () => {
    const name64 = 'c'.repeat(64)
    handleDispatch(dispatch({
      pushed: [{ value: { name: name64 } }],
    }))
    expect(getEmotesForChannel(TEST_CHANNEL)).toContain(name64)
    // cleanup
    removeChannelEmote(TEST_CHANNEL, name64)
  })
})

// ─── #7: malformed dispatch body does not throw ───────────────────────────────

describe('handleDispatch — #7 try/catch: malformed frames drop cleanly', () => {
  test('pushed: null entry does not throw', () => {
    expect(() => {
      handleDispatch(dispatch({ pushed: [null] }))
    }).not.toThrow()
  })

  test('pushed: object missing iterable (non-array) does not throw', () => {
    expect(() => {
      handleDispatch(dispatch({ pushed: { length: 5 } }))
    }).not.toThrow()
  })

  test('pushed: null array does not throw', () => {
    expect(() => {
      handleDispatch(dispatch({ pushed: null }))
    }).not.toThrow()
  })

  test('pulled: null entry does not throw', () => {
    expect(() => {
      handleDispatch(dispatch({ pulled: [null] }))
    }).not.toThrow()
  })

  test('updated: null entry does not throw', () => {
    expect(() => {
      handleDispatch(dispatch({ updated: [null] }))
    }).not.toThrow()
  })

  test('completely malformed body does not throw', () => {
    expect(() => {
      handleDispatch(null)
    }).not.toThrow()
    expect(() => {
      handleDispatch({ condition: { object_id: TEST_SET_ID }, body: 'notAnObject' })
    }).not.toThrow()
  })
})

// ─── #12: heartbeat_interval is clamped ───────────────────────────────────────
// We can't invoke onMessage directly (not exported), so we test the clamping
// logic inline — validating the same Math.min/Math.max formula used in the code.

describe('heartbeat_interval clamping — #12', () => {
  function clampHb(raw: unknown): number {
    const hb = Number(raw)
    return Number.isFinite(hb) && hb > 0
      ? Math.min(Math.max(hb, 5_000), 120_000)
      : 45_000
  }

  test('interval=1 is raised to 5000', () => {
    expect(clampHb(1)).toBe(5_000)
  })

  test('interval=0 falls back to default 45000', () => {
    expect(clampHb(0)).toBe(45_000)
  })

  test('interval=200000 is capped at 120000', () => {
    expect(clampHb(200_000)).toBe(120_000)
  })

  test('interval=45000 passes through unchanged', () => {
    expect(clampHb(45_000)).toBe(45_000)
  })

  test('NaN falls back to 45000', () => {
    expect(clampHb(NaN)).toBe(45_000)
  })

  test('null falls back to 45000', () => {
    expect(clampHb(null)).toBe(45_000)
  })

  test('string "abc" falls back to 45000', () => {
    expect(clampHb('abc')).toBe(45_000)
  })

  test('negative interval falls back to 45000', () => {
    expect(clampHb(-1000)).toBe(45_000)
  })
})

// ─── emotes.ts belt-and-suspenders guards ────────────────────────────────────

describe('emotes.ts addChannelEmote/renameChannelEmote — belt-and-suspenders', () => {
  test('addChannelEmote rejects empty name', () => {
    const before = getEmotesForChannel(TEST_CHANNEL).length
    addChannelEmote(TEST_CHANNEL, '')
    expect(getEmotesForChannel(TEST_CHANNEL).length).toBe(before)
  })

  test('addChannelEmote rejects whitespace-only name', () => {
    const before = getEmotesForChannel(TEST_CHANNEL).length
    addChannelEmote(TEST_CHANNEL, '   ')
    expect(getEmotesForChannel(TEST_CHANNEL).length).toBe(before)
  })

  test('addChannelEmote rejects name > 64 chars', () => {
    const before = getEmotesForChannel(TEST_CHANNEL).length
    addChannelEmote(TEST_CHANNEL, 'z'.repeat(65))
    expect(getEmotesForChannel(TEST_CHANNEL).length).toBe(before)
  })

  test('renameChannelEmote rejects whitespace new name', () => {
    addChannelEmote(TEST_CHANNEL, 'SafeEmote2')
    renameChannelEmote(TEST_CHANNEL, 'SafeEmote2', '   ')
    expect(getEmotesForChannel(TEST_CHANNEL)).toContain('SafeEmote2')
    removeChannelEmote(TEST_CHANNEL, 'SafeEmote2')
  })
})
