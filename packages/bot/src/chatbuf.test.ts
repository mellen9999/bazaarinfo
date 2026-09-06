import { describe, expect, it, beforeEach } from 'bun:test'
import { record, getThread, getRecent, restoreChat, cleanupChannel } from './chatbuf'

// P1: getThread is how a bare "!b" reply-in-thread (and later, a mention's context) finds
// the rest of a conversation. it must see every turn tagged to the root — including the
// bot's own line once index.ts starts threading its reply under the same root.
describe('chatbuf getThread', () => {
  beforeEach(() => cleanupChannel('thread-test'))

  it('finds the opening message by its own messageId (the thread root)', () => {
    record('thread-test', 'alice', 'is boomerang good', 'root-1')
    const thread = getThread('thread-test', 'root-1')
    expect(thread.map((m) => m.text)).toEqual(['is boomerang good'])
  })

  it('finds a reply tagged with threadId pointing at the root', () => {
    record('thread-test', 'alice', 'is boomerang good', 'root-1')
    record('thread-test', 'alice', 'specifically for vanessa', undefined, 'root-1')
    const thread = getThread('thread-test', 'root-1')
    expect(thread.map((m) => m.text)).toEqual(['is boomerang good', 'specifically for vanessa'])
  })

  it('includes the bot\'s own line when it is threaded under the same root', () => {
    record('thread-test', 'alice', 'is boomerang good', 'root-1')
    record('thread-test', 'bazaarinfo', 'yeah it holds up', undefined, 'root-1')
    const thread = getThread('thread-test', 'root-1')
    expect(thread.map((m) => m.user)).toEqual(['alice', 'bazaarinfo'])
  })

  it('a bot line recorded with no ids never joins a thread', () => {
    record('thread-test', 'alice', 'is boomerang good', 'root-1')
    record('thread-test', 'bazaarinfo', 'unrelated bare reply') // no messageId/threadId
    const thread = getThread('thread-test', 'root-1')
    expect(thread.some((m) => m.text === 'unrelated bare reply')).toBe(false)
  })

  it('an unknown thread id returns nothing', () => {
    record('thread-test', 'alice', 'is boomerang good', 'root-1')
    expect(getThread('thread-test', 'does-not-exist')).toEqual([])
  })
})

describe('chatbuf restoreChat', () => {
  beforeEach(() => cleanupChannel('restore-test'))

  it('hydrated rows carry no messageId/threadId — history replay, not live threading', () => {
    restoreChat('restore-test', [
      { username: 'alice', message: 'hello', created_at: '2026-01-01 00:00:00' },
      { username: 'bob', message: 'hi there', created_at: '2026-01-01 00:00:05' },
    ])
    const recent = getRecent('restore-test', 10)
    expect(recent.length).toBe(2)
    for (const m of recent) {
      expect(m.messageId).toBeUndefined()
      expect(m.threadId).toBeUndefined()
    }
  })
})
