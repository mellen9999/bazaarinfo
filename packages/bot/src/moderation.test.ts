import { test, expect, describe, beforeEach } from 'bun:test'
import {
  formatDuration, renderModeration, noteTimeout, isTimedOut,
  noteDeletedMessage, wasDeleted, noteSentLine, storedLineFor, __resetModerationForTest,
} from './moderation'
import type { IrcClearChat, IrcClearMsg } from './twitch'

beforeEach(() => __resetModerationForTest())

describe('formatDuration', () => {
  test('boundaries', () => {
    expect(formatDuration(59)).toBe('59s')
    expect(formatDuration(60)).toBe('1 min')
    expect(formatDuration(600)).toBe('10 min')
    expect(formatDuration(3600)).toBe('1h')
    expect(formatDuration(86400)).toBe('24h')
  })
})

function clearchat(over: Partial<IrcClearChat> = {}): IrcClearChat {
  return { type: 'clearchat', channel: 'chan', sentTs: 1, ...over }
}
function clearmsg(over: Partial<IrcClearMsg> = {}): IrcClearMsg {
  return { type: 'clearmsg', channel: 'chan', login: 'alice', targetMsgId: 'm1', text: 'deleted text', sentTs: 1, ...over }
}

describe('renderModeration', () => {
  test('timeout', () => {
    const r = renderModeration(clearchat({ login: 'alice', durationSec: 600 }), 'bot')
    expect(r).toEqual({ text: '* alice was timed out for 10 min' })
  })

  test('permanent ban (no durationSec)', () => {
    const r = renderModeration(clearchat({ login: 'alice' }), 'bot')
    expect(r).toEqual({ text: '* alice was banned' })
  })

  test('whole chat cleared (no login)', () => {
    const r = renderModeration(clearchat(), 'bot')
    expect(r).toEqual({ text: '* chat was cleared by a mod' })
  })

  test('single deletion', () => {
    const r = renderModeration(clearmsg({ login: 'alice' }), 'bot')
    expect(r).toEqual({ text: "* a mod deleted alice's message", collapseKey: 'chan:del:alice' })
  })

  test('never includes the deleted text', () => {
    const r = renderModeration(clearmsg({ login: 'alice', text: 'some secret nonsense' }), 'bot')
    expect(JSON.stringify(r)).not.toContain('secret nonsense')
  })

  test('12 deletions from the same login collapse into one key with count 12', () => {
    let last
    for (let i = 0; i < 12; i++) last = renderModeration(clearmsg({ login: 'alice' }), 'bot')
    expect(last).toEqual({ text: "* a mod deleted 12 of alice's messages", collapseKey: 'chan:del:alice' })
  })

  test('two different logins get two separate keys', () => {
    const a = renderModeration(clearmsg({ login: 'alice' }), 'bot')
    const b = renderModeration(clearmsg({ login: 'bob' }), 'bot')
    expect(a?.collapseKey).toBe('chan:del:alice')
    expect(b?.collapseKey).toBe('chan:del:bob')
    expect(b?.text).toBe("* a mod deleted bob's message")
  })

  test('window expiry starts a fresh entry (count resets to 1)', () => {
    const realNow = Date.now
    let now = 1_000_000
    Date.now = () => now
    try {
      renderModeration(clearmsg({ login: 'alice' }), 'bot')
      renderModeration(clearmsg({ login: 'alice' }), 'bot')
      now += 11 * 60_000 // past the 10min collapse window
      const r = renderModeration(clearmsg({ login: 'alice' }), 'bot')
      expect(r).toEqual({ text: "* a mod deleted alice's message", collapseKey: 'chan:del:alice' })
    } finally {
      Date.now = realNow
    }
  })

  test('bot rows render null — clearchat, case-insensitive', () => {
    expect(renderModeration(clearchat({ login: 'MyBot', durationSec: 60 }), 'mybot')).toBeNull()
    expect(renderModeration(clearchat({ login: 'mybot' }), 'MyBot')).toBeNull()
  })

  test('bot rows render null — clearmsg, case-insensitive', () => {
    expect(renderModeration(clearmsg({ login: 'MyBot' }), 'mybot')).toBeNull()
  })
})

describe('noteTimeout / isTimedOut', () => {
  test('a fresh timeout is active', () => {
    noteTimeout('chan', 'alice', 600, 1_000_000)
    expect(isTimedOut('chan', 'alice', 1_000_000 + 599_000)).toBe(true)
  })

  test('expires after the duration', () => {
    noteTimeout('chan', 'alice', 600, 1_000_000)
    expect(isTimedOut('chan', 'alice', 1_000_000 + 600_001)).toBe(false)
  })

  test('a ban (no durationSec) is capped at 24h, not forever', () => {
    noteTimeout('chan', 'alice', undefined, 0)
    expect(isTimedOut('chan', 'alice', 24 * 60 * 60_000 - 1)).toBe(true)
    expect(isTimedOut('chan', 'alice', 24 * 60 * 60_000 + 1)).toBe(false)
  })

  test('keys are lowercased and scoped per channel', () => {
    noteTimeout('Chan', 'Alice', 600, 0)
    expect(isTimedOut('chan', 'alice', 500)).toBe(true)
    expect(isTimedOut('otherchan', 'alice', 500)).toBe(false)
  })
})

describe('noteDeletedMessage / wasDeleted', () => {
  test('a noted id is reported deleted', () => {
    noteDeletedMessage('m1')
    expect(wasDeleted('m1')).toBe(true)
    expect(wasDeleted('unrelated')).toBe(false)
  })

  test('undefined id (eventsub-path asks have none) is never "deleted"', () => {
    expect(wasDeleted(undefined)).toBe(false)
  })

  test('evicts the oldest once past 500', () => {
    for (let i = 0; i < 500; i++) noteDeletedMessage(`id${i}`)
    expect(wasDeleted('id0')).toBe(true)
    noteDeletedMessage('id500') // 501st entry — oldest (id0) must be evicted
    expect(wasDeleted('id0')).toBe(false)
    expect(wasDeleted('id1')).toBe(true)
    expect(wasDeleted('id500')).toBe(true)
  })
})

describe('noteSentLine / storedLineFor', () => {
  test('exact match: maps the actual wire text back to the stored line', () => {
    noteSentLine('chan', '@viewer hi there', 'hi there')
    expect(storedLineFor('chan', '@viewer hi there')).toBe('hi there')
  })

  test('truncated wire text (say() appended "...") matches by prefix', () => {
    const long = 'a'.repeat(50)
    noteSentLine('chan', `${long.slice(0, 20)}...`, long)
    expect(storedLineFor('chan', `${long.slice(0, 20)}...`)).toBe(long)
  })

  test('a non-truncated miss returns undefined (no false prefix match)', () => {
    expect(storedLineFor('chan', 'never sent')).toBeUndefined()
  })

  test('scoped per channel', () => {
    noteSentLine('chan', 'wire', 'stored')
    expect(storedLineFor('otherchan', 'wire')).toBeUndefined()
  })

  test('evicts the oldest once past 500', () => {
    for (let i = 0; i < 500; i++) noteSentLine('chan', `wire${i}`, `stored${i}`)
    expect(storedLineFor('chan', 'wire0')).toBe('stored0')
    noteSentLine('chan', 'wire500', 'stored500') // 501st — oldest (wire0) evicted
    expect(storedLineFor('chan', 'wire0')).toBeUndefined()
    expect(storedLineFor('chan', 'wire1')).toBe('stored1')
    expect(storedLineFor('chan', 'wire500')).toBe('stored500')
  })
})
