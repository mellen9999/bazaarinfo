import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { unlinkSync } from 'fs'
import { resolve } from 'path'
import { tmpdir } from 'os'

const db = await import('./db')
const hs = await import('./hslogs')
const ctx = await import('./hslogs-context')
const { buildChatRecall, planRecallPrefetch } = await import('./ai-build-recall')
const { findReferencedUser } = await import('./ai-query')
const { isKnownChatter, planLorePrefetch, buildLoreDossier } = await import('./lore')

const realFetch = globalThis.fetch
let calls: string[] = []
let impl: (url: string, init?: RequestInit) => Promise<Response>
let dbPath: string

const cov = { tier: 'hot', from: 'a', to: 'b', rolled_through: null, days_scanned: 1, days_skipped: 0, partial: false, exhausted: true }
const row = (u: string, m: string, ts: string) => ({ username: u, display_name: u, message: m, message_id: m, timestamp: ts, reply_to_id: null })
const ok = (data: unknown) => new Response(JSON.stringify({ data, coverage: cov }), { status: 200 })
const bare = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const profile = (messages: number, first = '2026-04-24T00:00:00.000Z') => bare({ exists: true, username: 'x', first_seen: first, last_seen: '2026-10-01T00:00:00.000Z', messages, active_days: 9 })
// a fetch that only ends when its signal aborts, like the real one
const hang = (_u: string, init?: RequestInit) => new Promise<Response>((_, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('a', 'AbortError'))))

function cleanPath(p: string) {
  for (const s of ['', '-wal', '-shm']) { try { unlinkSync(p + s) } catch {} }
}

beforeEach(() => {
  delete process.env.HEATSYNC_LOGS_KEY // a developer's .env must never leak in
  process.env.HEATSYNC_LOGS_URL = 'http://hs.test/api/v1/logs'
  hs.resetHslogs(); hs.setForgottenCheck(() => false)
  calls = []
  impl = async () => ok([])
  globalThis.fetch = ((url: string, init?: RequestInit) => { calls.push(String(url)); return impl(String(url), init) }) as unknown as typeof fetch
  dbPath = resolve(tmpdir(), `.bazaarinfo-hsctx-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  db.initDb(dbPath)
})
afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.HEATSYNC_LOGS_KEY
  try { db.closeDb() } catch {}
  cleanPath(dbPath)
})

const withKey = () => { process.env.HEATSYNC_LOGS_KEY = 'k' }

describe('prefetchHistory', () => {
  it('no key → null, nothing fetched', async () => {
    expect(await ctx.prefetchHistory('c', { content: 'boomerang' })).toBeNull()
    expect(calls.length).toBe(0)
  })

  it('nothing needed → null, nothing fetched', async () => {
    withKey()
    expect(await ctx.prefetchHistory('c', {})).toBeNull()
    expect(await ctx.prefetchHistory('c', { userSearch: 'x' })).toBeNull() // no user to search for
    expect(calls.length).toBe(0)
  })

  it('runs only the needed calls, all in parallel', async () => {
    withKey()
    impl = (url) => (url.includes('/profile') ? Promise.resolve(profile(5)) : new Promise(() => {}))
    const p = ctx.prefetchHistory('c', { user: 'Bob', userSearch: 'boomerang', userOldest: true, profiles: ['bob'] }, 60)
    await Bun.sleep(10)
    expect(calls.length).toBe(3) // search, messages, profile — all in flight before any resolved
    expect(calls.some((u) => u.includes('/search?q=boomerang&user=bob'))).toBe(true)
    expect(calls.some((u) => u.includes('/users/bob/messages') && u.includes('order=old'))).toBe(true)
    const r = await p
    expect(r?.profiles?.get('bob')?.messages).toBe(5)
    expect(r?.userSearch).toBeUndefined()
  })

  it('one total budget: slow calls are aborted, the wait is bounded', async () => {
    withKey()
    impl = hang
    const t = performance.now()
    const r = await ctx.prefetchHistory('c', { content: 'a', user: 'bob', userOldest: true, profiles: ['bob'] }, 80)
    expect(r).toBeNull()
    expect(performance.now() - t).toBeLessThan(400)
  })

  it('bounded even when fetch ignores the abort signal', async () => {
    withKey()
    impl = () => new Promise(() => {})
    const t = performance.now()
    expect(await ctx.prefetchHistory('c', { content: 'a' }, 60)).toBeNull()
    expect(performance.now() - t).toBeLessThan(400)
  })

  it('partial: fast answers are kept, the slow one is dropped', async () => {
    withKey()
    impl = (url, init) => (url.includes('/search') ? Promise.resolve(ok([row('a', 'hi', '2026-05-01T00:00:00.000Z')])) : hang(url, init))
    const r = await ctx.prefetchHistory('c', { content: 'hi', user: 'bob', userOldest: true }, 80)
    expect(r?.content?.length).toBe(1)
    expect(r?.userOldest).toBeUndefined()
  })

  it('a failing call (5xx) leaves the others intact; all failing → null', async () => {
    withKey()
    impl = async (url) => (url.includes('/profile') ? new Response('', { status: 500 }) : ok([row('a', 'hi', '2026-05-01T00:00:00.000Z')]))
    const r = await ctx.prefetchHistory('c', { content: 'hi', profiles: ['bob'] })
    expect(r?.content?.length).toBe(1)
    expect(r?.profiles).toBeUndefined()
    hs.resetHslogs()
    impl = async () => new Response('', { status: 500 })
    expect(await ctx.prefetchHistory('c', { content: 'hi', profiles: ['bob'] })).toBeNull()
  })

  it('never throws on garbage or a throwing fetch', async () => {
    withKey()
    impl = async () => new Response('{nope', { status: 200 })
    expect(await ctx.prefetchHistory('c', { content: 'x', profiles: ['u'], footprint: 't' })).toBeNull()
    globalThis.fetch = (() => { throw new Error('boom') }) as unknown as typeof fetch
    hs.resetHslogs()
    expect(await ctx.prefetchHistory('c', { content: 'x' })).toBeNull()
  })

  it('202 (computing) is not an answer', async () => {
    withKey()
    impl = async () => new Response('{"status":"computing"}', { status: 202 })
    expect(await ctx.prefetchHistory('c', { footprint: 'tidolar' })).toBeNull()
  })

  it('forgotten users never reach the wire', async () => {
    withKey()
    hs.setForgottenCheck((u) => u === 'gone')
    expect(await ctx.prefetchHistory('c', { user: 'gone', userOldest: true, profiles: ['gone'] })).toBeNull()
    expect(calls.length).toBe(0)
  })
})

describe('mergeHistory', () => {
  const local = [
    { username: 'bob', message: 'local newest', created_at: '2026-10-10 10:00:00' },
    { username: 'bob', message: 'local oldest', created_at: '2026-09-20 10:00:00' },
  ]

  it('adds only remote rows older than the oldest local row', () => {
    const remote = [
      row('bob', 'older than horizon', '2026-08-01T00:00:00.000Z'),
      row('bob', 'newer than horizon', '2026-10-01T00:00:00.000Z'),
      row('bob', 'exactly horizon', '2026-09-20T10:00:00.000Z'),
    ]
    const out = ctx.mergeHistory(local, remote)
    expect(out.map((r) => r.message)).toEqual(['local newest', 'local oldest', 'older than horizon'])
    expect(out[2].created_at).toBe('2026-08-01 00:00:00')
  })

  it('dedupes by lowercase user + normalized text, also within remote', () => {
    const remote = [
      row('BOB', '  Local   OLDEST ', '2026-01-01T00:00:00.000Z'),
      row('amy', 'dup', '2026-02-01T00:00:00.000Z'),
      row('AMY', 'DUP', '2026-02-02T00:00:00.000Z'),
    ]
    expect(ctx.mergeHistory(local, remote).map((r) => r.message)).toEqual(['local newest', 'local oldest', 'dup'])
  })

  it('empty local has no horizon: everything remote counts', () => {
    const out = ctx.mergeHistory([], [row('a', 'x', '2026-10-11T00:00:00.000Z'), row('b', 'y', '2026-01-01T00:00:00.000Z')])
    expect(out.length).toBe(2)
  })

  it('oldestFirst puts the older remote rows ahead of local', () => {
    const out = ctx.mergeHistory(local, [row('bob', 'ancient', '2026-03-01T00:00:00.000Z'), row('bob', 'old', '2026-04-01T00:00:00.000Z')], { oldestFirst: true })
    expect(out.map((r) => r.message)).toEqual(['ancient', 'old', 'local newest', 'local oldest'])
  })

  it('null / empty / malformed remote returns local untouched', () => {
    expect(ctx.mergeHistory(local, null)).toBe(local)
    expect(ctx.mergeHistory(local, undefined)).toBe(local)
    expect(ctx.mergeHistory(local, [])).toBe(local)
    expect(ctx.mergeHistory(local, [{ nope: 1 } as never, null as never])).toBe(local)
  })
})

describe('remote pasta', () => {
  const rows = [
    { text: 'whammy cane lion day 1,847 of asking', repeats: 316, users: 40, days: 12, first_at: 'x', last_at: 'y' },
    { text: 'unrelated spam wall', repeats: 900, users: 3, days: 2, first_at: 'x', last_at: 'y' },
  ]
  it('picks the keyword match, not the loudest row', () => {
    const hit = ctx.pickRemotePasta('remind me of the whammy cane copypasta', rows)
    expect(hit?.message).toContain('whammy')
    expect(hit?.reps).toBe(316)
    expect(hit?.coverage).toBeGreaterThanOrEqual(2)
  })
  it('no keyword overlap or no keywords → null', () => {
    expect(ctx.pickRemotePasta('remind me of the zzzqqq copypasta', rows)).toBeNull()
    expect(ctx.pickRemotePasta('remind me of the pasta', rows)).toBeNull()
    expect(ctx.pickRemotePasta('whammy', null)).toBeNull()
  })
  it('remotePasta: no key → null without fetch; key → hit', async () => {
    expect(await ctx.remotePasta('c', 'the whammy cane copypasta')).toBeNull()
    expect(calls.length).toBe(0)
    withKey()
    impl = async () => ok(rows)
    expect((await ctx.remotePasta('c', 'the whammy cane copypasta'))?.reps).toBe(316)
  })
})

describe('planRecallPrefetch — only when recall will run', () => {
  it('no key → null', () => {
    expect(planRecallPrefetch('what did bob say earlier about boomerang', 'c', 'asker')).toBeNull()
  })

  it('ordinary replies cost nothing', () => {
    withKey()
    expect(planRecallPrefetch('whats the best item for shield', 'c', 'asker')).toBeNull()
    expect(planRecallPrefetch('hello', 'c', 'asker')).toBeNull()
  })

  it('content recall → a keyword search', () => {
    withKey()
    const need = planRecallPrefetch('anything funny about boomerang earlier', 'c', 'asker')
    expect(need?.content).toContain('boomerang')
    expect(need?.user).toBeUndefined()
  })

  it('@mention → profile existence + that user\'s search/recent', () => {
    withKey()
    const need = planRecallPrefetch('what did @OldTimer say about boomerang', 'c', 'asker')
    expect(need?.user).toBe('oldtimer')
    expect(need?.profiles).toEqual(['oldtimer'])
    expect(need?.userSearch).toContain('boomerang')
    expect(need?.userRecent).toBe(true)
  })

  it('"first message" → oldest', () => {
    withKey()
    expect(planRecallPrefetch('what was @oldtimer first message', 'c', 'asker')?.userOldest).toBe(true)
  })

  it('local rows already filling the recent read skip the recent fetch', () => {
    withKey()
    for (let i = 0; i < 12; i++) db.logChat('c', 'oldtimer', `message number ${i} here`)
    db.flushWrites()
    const need = planRecallPrefetch('what did @oldtimer say about boomerang', 'c', 'asker')
    expect(need?.userRecent).toBeUndefined()
  })

  it('all-time count → profile; windowed word count past the local horizon → term-count capped at it', () => {
    withKey()
    expect(planRecallPrefetch('how many messages did @oldtimer send all time', 'c', 'asker')?.profiles).toContain('oldtimer')
    db.logChat('c', 'oldtimer', 'hello there friend')
    db.flushWrites()
    db.getDb().run(`UPDATE chat_messages SET created_at = datetime('now', '-10 days')`)
    const need = planRecallPrefetch('how many times did @oldtimer say "boomerang" in the last 3 months', 'c', 'asker')
    expect(need?.words?.term).toBe('boomerang')
    expect(need?.words?.to).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/)
    // window fully inside local retention → local answers, no word fetch
    expect(planRecallPrefetch('how many times did @oldtimer say "boomerang" this week', 'c', 'asker')?.words).toBeUndefined()
  })

  it('pasta recall: fetched only when local has no matching pasta', () => {
    withKey()
    expect(planRecallPrefetch('remind me of the whammy cane copypasta', 'c', 'asker')).toEqual({ pasta: 'remind me of the whammy cane copypasta' })
    for (let i = 0; i < 4; i++) db.logChat('c', `u${i}`, 'whammy cane lion '.repeat(15))
    db.flushWrites()
    expect(planRecallPrefetch('remind me of the whammy cane copypasta', 'c', 'asker')).toBeNull()
  })
})

describe('builders with a remote result, and the fallback when it is null', () => {
  const old = (m: string, days: number) => ({ username: 'oldtimer', display_name: 'oldtimer', message: m, message_id: m, timestamp: new Date(Date.now() - days * 86_400_000).toISOString(), reply_to_id: null })

  it('null remote === no remote: byte-identical recall', () => {
    db.logChat('c', 'oldtimer', 'i love the boomerang build')
    db.flushWrites()
    const q = 'what did @oldtimer say about boomerang'
    const base = buildChatRecall(q, 'c', 'asker')
    expect(base).toContain('boomerang')
    expect(buildChatRecall(q, 'c', 'asker', null)).toBe(base)
    expect(buildChatRecall(q, 'c', 'asker', {})).toBe(base)
  })

  it('remote fills time older than the local horizon', () => {
    db.logChat('c', 'oldtimer', 'i love the boomerang build')
    db.flushWrites()
    const out = buildChatRecall('what did @oldtimer say about boomerang', 'c', 'asker', {
      userSearch: [old('ancient boomerang hot take', 90), old('i love the boomerang build', 0)],
    })
    expect(out).toContain('ancient boomerang hot take')
    expect(out.match(/i love the boomerang build/g)?.length).toBe(1) // not duplicated
  })

  it('a user who exists only in old history is still found (profile.exists)', () => {
    expect(findReferencedUser('what did @ghostly say', 'c')).toBeNull()
    const profiles = new Map([['ghostly', { exists: true, username: 'ghostly', first_seen: '2026-04-24T00:00:00.000Z', last_seen: '2026-05-01T00:00:00.000Z', messages: 40, active_days: 3 }]])
    expect(findReferencedUser('what did @ghostly say', 'c', { profiles })).toBe('ghostly')
    expect(findReferencedUser('what did @ghostly say', 'c', {})).toBeNull()
  })

  it('oldest-message ask leads with the remote history', () => {
    db.logChat('c', 'oldtimer', 'a recent line about stuff')
    db.flushWrites()
    const out = buildChatRecall('what was @oldtimer first message', 'c', 'asker', { userOldest: [old('the very first line ever', 120)] })
    expect(out.indexOf('the very first line ever')).toBeLessThan(out.indexOf('a recent line about stuff'))
  })

  it('all-time total never drops below local; remote profile can raise it', () => {
    db.logChat('c', 'oldtimer', 'one')
    db.flushWrites()
    const profiles = new Map([['oldtimer', { exists: true, username: 'oldtimer', first_seen: '2026-04-24T00:00:00.000Z', last_seen: 'x', messages: 4000, active_days: 90 }]])
    expect(buildChatRecall('how many messages did @oldtimer send all time', 'c', 'asker', { profiles })).toContain('4000 total')
    expect(buildChatRecall('how many messages did @oldtimer send all time', 'c', 'asker', null)).toContain('1 total')
  })

  it('remote pasta beats the local "most repeated" fallback but not a real local match', () => {
    for (let i = 0; i < 4; i++) db.logChat('c', `u${i}`, 'something entirely different that chat repeats '.repeat(5))
    db.flushWrites()
    const remote = { pasta: { message: 'whammy cane lion from long ago', reps: 316, coverage: 2 } }
    const q = 'remind me of the whammy cane copypasta'
    expect(buildChatRecall(q, 'c', 'asker', remote)).toContain('whammy cane lion from long ago')
    expect(buildChatRecall(q, 'c', 'asker', null)).not.toContain('whammy cane lion from long ago')
  })
})

describe('regulars and lore', () => {
  it('isKnownChatter: remote profile with enough messages is an extra positive', () => {
    const mk = (messages: number) => ({ profiles: new Map([['veteran', { exists: true, username: 'veteran', first_seen: 'x', last_seen: 'y', messages, active_days: 10 }]]) })
    expect(isKnownChatter('veteran', 'c')).toBe(false)
    expect(isKnownChatter('veteran', 'c', null)).toBe(false)
    expect(isKnownChatter('veteran', 'c', mk(5000))).toBe(true)
    expect(isKnownChatter('veteran', 'c', mk(20))).toBe(false)
  })

  it('planLorePrefetch: nothing without a key or a multi-word topic', () => {
    expect(planLorePrefetch('the tidolar crime family', 'c')).toBeNull()
    withKey()
    expect(planLorePrefetch('matrix', 'c')).toBeNull()
    expect(planLorePrefetch('the tidolar crime family', 'c')?.profiles).toContain('tidolar')
  })

  it('lore footprint widens with the remote term-footprint', () => {
    const PASTA = 'trumpBirdge MANY PEOPLE ARE SAYING THAT mellen IS WORKING WITH THE TRICKY-TIDOLAR CRIME FAMILY! SAD!! THEY SHOULD BOTH BE LOCKED UP IF YOU ASK ME'
    db.logChat('c', 'tidolar', 'anyone else running boomerang')
    for (const u of ['alice', 'bob', 'carol']) db.logChat('c', u, PASTA)
    db.flushWrites()
    const local = buildLoreDossier('the tidolar crime family', 'c')
    expect(local).not.toBeNull()
    const remote = { footprint: { term: 'tidolar', count: 777, distinct_users: 55, first_seen: '2026-03-01T00:00:00.000Z' } }
    const wide = buildLoreDossier('the tidolar crime family', 'c', remote)
    expect(wide?.text).toContain('777 messages from 55 different chatters')
    expect(wide?.text).toContain('first seen 2026-03-01')
    expect(buildLoreDossier('the tidolar crime family', 'c', null)?.text).toBe(local!.text)
  })
})
