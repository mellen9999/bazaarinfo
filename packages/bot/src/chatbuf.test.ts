import { describe, expect, it, beforeEach } from 'bun:test'
import {
  record, recordEvent, getThread, getRecent, getActiveThreads, restoreChat, cleanupChannel,
  setSummarizer, setLessonExtractor, removeMessage, removeUser, removeBotLine, clearRing,
  restoreSessionId, restoreSummary, getSummary,
} from './chatbuf'

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

  it('restoreChat rows carry no kind — plain history replay untouched by events', () => {
    restoreChat('restore-test-2', [{ username: 'alice', message: 'hello', created_at: '2026-01-01 00:00:00' }])
    const recent = getRecent('restore-test-2', 10)
    expect(recent[0].kind).toBeUndefined()
  })
})

// stream events (raid/sub/gift/announce) render into the same transcript as chat — the
// "* " sentinel-user line the model reads inline — but must never look like a chat message
// to anything that measures chat ACTIVITY: no session bump, no summarizer/lesson tick.
describe('chatbuf recordEvent', () => {
  beforeEach(() => cleanupChannel('event-test'))

  it('appends a "*" sentinel entry, kind "event", visible via getRecent', () => {
    recordEvent('event-test', '* raid: someone arrived with 5 viewers')
    const recent = getRecent('event-test', 10)
    expect(recent.length).toBe(1)
    expect(recent[0]).toMatchObject({ user: '*', text: '* raid: someone arrived with 5 viewers', kind: 'event' })
  })

  it('a matching collapseKey mutates the existing entry in place instead of appending', () => {
    record('event-test', 'alice', 'hi')
    recordEvent('event-test', '* carl gifted 1 subs', 'chan:carl')
    recordEvent('event-test', '* carl gifted 2 subs', 'chan:carl')
    const recent = getRecent('event-test', 10)
    expect(recent.length).toBe(2) // alice's line + ONE event line, never two
    expect(recent[1]).toMatchObject({ text: '* carl gifted 2 subs', kind: 'event' })
  })

  it('a collapse key dies with its ring entry — a later gift renders a NEW visible line, not a write into the void', () => {
    recordEvent('event-test', '* carl gifted 1 subs', 'chan:carl')
    for (let i = 0; i < 120; i++) record('event-test', 'alice', `line ${i}`)
    expect(getRecent('event-test', 200).some((e) => e.kind === 'event')).toBe(false)
    recordEvent('event-test', '* carl gifted 2 subs', 'chan:carl')
    const recent = getRecent('event-test', 200)
    expect(recent[recent.length - 1]).toMatchObject({ text: '* carl gifted 2 subs', kind: 'event' })
  })

  it('a different collapseKey starts its own entry alongside an existing one', () => {
    recordEvent('event-test', '* alice gifted 1 subs', 'chan:alice')
    recordEvent('event-test', '* bob gifted 1 subs', 'chan:bob')
    expect(getRecent('event-test', 10).length).toBe(2)
  })

  it('does not touch lastMessageTime or bump the session — a later record() still measures the gap from the last REAL message', () => {
    const realWrite = process.stdout.write.bind(process.stdout)
    const lines: string[] = []
    process.stdout.write = ((chunk: unknown) => { lines.push(String(chunk)); return true }) as typeof process.stdout.write
    const realNow = Date.now
    let now = 2_000_000_000_000
    Date.now = () => now
    try {
      record('event-test', 'alice', 'hello')
      now += 31 * 60_000 // past SESSION_GAP (30min)
      recordEvent('event-test', '* raid: someone arrived with 5 viewers')
      expect(lines.some((l) => l.includes('session bump'))).toBe(false) // recordEvent alone never bumps
      record('event-test', 'bob', 'hi again')
      // if recordEvent had touched lastMessageTime, this record() would see only a ~0min
      // gap and never bump — it must still see the full 31min gap from alice's real line.
      expect(lines.some((l) => l.includes('session bump'))).toBe(true)
    } finally {
      Date.now = realNow
      process.stdout.write = realWrite
    }
  })

  it('does not tick the summarizer or lesson-extractor counters', () => {
    let summarizerCalls = 0
    let lessonCalls = 0
    setSummarizer(async () => { summarizerCalls++; return '' })
    setLessonExtractor(async () => { lessonCalls++ })
    try {
      for (let i = 0; i < 600; i++) recordEvent('event-test', `* event ${i}`)
      expect(summarizerCalls).toBe(0)
      expect(lessonCalls).toBe(0)
    } finally {
      setSummarizer(null)
      setLessonExtractor(null)
    }
  })

  it('event entries never appear in getActiveThreads (excluded from consecutive-exchange detection)', () => {
    record('event-test', 'alice', 'hows it going')
    recordEvent('event-test', '* raid: someone arrived with 5 viewers')
    record('event-test', 'bob', 'pretty good')
    record('event-test', 'alice', 'nice')
    const threads = getActiveThreads('event-test')
    expect(threads.some((t) => t.users.includes('*'))).toBe(false)
  })
})

// CLEARMSG/CLEARCHAT: what a mod removes in twitch must vanish from the live ring too, or
// the model keeps reading it in "Recent chat" long after sqlite already forgot it.
describe('chatbuf mod-removal ops', () => {
  beforeEach(() => cleanupChannel('mod-test'))

  it('removeMessage drops the matching entry by messageId', () => {
    record('mod-test', 'alice', 'keep me', 'keep-1')
    record('mod-test', 'alice', 'delete me', 'del-1')
    expect(removeMessage('mod-test', 'del-1')).toBe(true)
    expect(getRecent('mod-test', 10).map((m) => m.text)).toEqual(['keep me'])
  })

  it('removeMessage returns false for an unknown id', () => {
    record('mod-test', 'alice', 'hi', 'root-1')
    expect(removeMessage('mod-test', 'does-not-exist')).toBe(false)
  })

  it("removeUser drops only that user's lines — the bot's threaded reply survives", () => {
    record('mod-test', 'troll', 'spam 1')
    record('mod-test', 'troll', 'spam 2', undefined, 'root-1')
    record('mod-test', 'bazaarinfo', 'reply', undefined, 'root-1')
    record('mod-test', 'alice', 'unrelated')
    expect(removeUser('mod-test', 'TROLL')).toBe(2)
    expect(getRecent('mod-test', 10).map((m) => m.user)).toEqual(['bazaarinfo', 'alice'])
  })

  it('removeBotLine removes only the newest matching bot line', () => {
    record('mod-test', 'bazaarinfo', 'same text')
    record('mod-test', 'alice', 'unrelated')
    record('mod-test', 'bazaarinfo', 'same text')
    expect(removeBotLine('mod-test', 'same text')).toBe(true)
    const recent = getRecent('mod-test', 10)
    expect(recent.filter((m) => m.text === 'same text').length).toBe(1)
    expect(recent[recent.length - 1].user).toBe('alice')
  })

  it('removeBotLine returns false when no bot line matches', () => {
    record('mod-test', 'alice', 'not the bot')
    expect(removeBotLine('mod-test', 'not the bot')).toBe(false)
  })

  it('clearRing empties the ring but preserves session id and summary — contrast cleanupChannel', () => {
    const realWrite = process.stdout.write.bind(process.stdout)
    const lines: string[] = []
    const realNow = Date.now
    let now = 3_000_000_000_000
    Date.now = () => now
    try {
      record('mod-test', 'alice', 'first')
      restoreSessionId('mod-test', 5)
      restoreSummary('mod-test', 'preserved summary')

      clearRing('mod-test')
      expect(getRecent('mod-test', 10)).toEqual([])
      expect(getSummary('mod-test')).toBe('preserved summary')

      now += 31 * 60_000 // past SESSION_GAP — a bump here proves the session id survived
      process.stdout.write = ((chunk: unknown) => { lines.push(String(chunk)); return true }) as typeof process.stdout.write
      record('mod-test', 'alice', 'second')
      expect(lines.some((l) => l.includes('5 -> 6'))).toBe(true)
    } finally {
      Date.now = realNow
      process.stdout.write = realWrite
    }
  })
})

describe('chatbuf restoreChat with a hydrated stream event', () => {
  beforeEach(() => cleanupChannel('restore-event-test'))

  it('an entry with kind "event" is pushed as a "*" sentinel — history, not a live collapse target', () => {
    restoreChat('restore-event-test', [
      { username: 'irrelevant', message: '* raid: someone arrived', created_at: '2026-01-01 00:00:00', kind: 'event' },
    ])
    expect(getRecent('restore-event-test', 10)[0]).toMatchObject({ user: '*', text: '* raid: someone arrived', kind: 'event' })
  })
})

describe('chatbuf record tag', () => {
  beforeEach(() => cleanupChannel('tag-test'))

  it('stores tag when given, omits it otherwise', () => {
    record('tag-test', 'alice', 'cheered', undefined, undefined, false, '500 bits')
    record('tag-test', 'bob', 'plain message')
    const recent = getRecent('tag-test', 10)
    expect(recent[0].tag).toBe('500 bits')
    expect(recent[1].tag).toBeUndefined()
  })
})
