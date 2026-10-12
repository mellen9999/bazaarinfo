import { describe, expect, it, beforeEach, afterEach } from 'bun:test'

const hs = await import('./hslogs')

const realFetch = globalThis.fetch
let calls: string[] = []
let impl: (url: string) => Promise<Response>

const cov = { tier: 'hot', from: 'a', to: 'b', rolled_through: null, days_scanned: 1, days_skipped: 0, partial: false, exhausted: true }
const row = (u: string, m: string, id = m) => ({ username: u, display_name: u, message: m, message_id: id, timestamp: '2026-01-01T00:00:00Z', reply_to_id: null })
const ok = (data: unknown) => new Response(JSON.stringify({ data, coverage: cov }), { status: 200 })

beforeEach(() => {
  delete process.env.HEATSYNC_LOGS_KEY
  process.env.HEATSYNC_LOGS_KEY = 'k'
  process.env.HEATSYNC_LOGS_URL = 'http://hs.test/api/v1/logs'
  hs.resetHslogs(); hs.setForgottenCheck(() => false)
  calls = []
  impl = async () => ok([])
  globalThis.fetch = ((url: string) => { calls.push(String(url)); return impl(String(url)) }) as unknown as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch; delete process.env.HEATSYNC_LOGS_KEY })

describe('hslogs', () => {
  it('no key → null without fetch', async () => {
    delete process.env.HEATSYNC_LOGS_KEY
    expect(await hs.search('nl_kripp', 'x')).toBeNull()
    expect(calls.length).toBe(0)
  })

  it('parses success, sends auth + ua, builds url', async () => {
    let init: RequestInit | undefined
    globalThis.fetch = ((u: string, i: RequestInit) => { calls.push(u); init = i; return Promise.resolve(ok([row('a', 'hi')])) }) as unknown as typeof fetch
    const r = await hs.search('NL_Kripp', 'hello', { user: 'Bob', limit: 5 })
    expect(r?.data[0].message).toBe('hi')
    expect(calls[0]).toBe('http://hs.test/api/v1/logs/twitch/nl_kripp/search?q=hello&user=bob&limit=5')
    const h = init!.headers as Record<string, string>
    expect(h.Authorization).toBe('Bearer k')
    expect(h['User-Agent']).toStartWith('bazaarinfo/')
  })

  it('timeout / network error → null', async () => {
    impl = () => Promise.reject(new DOMException('t', 'TimeoutError'))
    expect(await hs.search('c', 'x')).toBeNull()
  })

  it('5xx → null; bad json → null', async () => {
    impl = async () => new Response('no', { status: 503 })
    expect(await hs.search('c', 'x')).toBeNull()
    impl = async () => new Response('{nope', { status: 200 })
    expect(await hs.search('c', 'y')).toBeNull()
  })

  it('429 Retry-After opens breaker immediately', async () => {
    impl = async () => new Response('', { status: 429, headers: { 'retry-after': '30' } })
    expect(await hs.search('c', 'a')).toBeNull()
    impl = async () => ok([])
    expect(await hs.search('c', 'b')).toBeNull()
    expect(calls.length).toBe(1)
  })

  it('breaker opens after 3 failures and recovers', async () => {
    impl = async () => new Response('', { status: 500 })
    for (const q of ['a', 'b', 'c']) await hs.search('c', q)
    impl = async () => ok([])
    expect(await hs.search('c', 'd')).toBeNull()
    expect(calls.length).toBe(3)
    const real = Date.now
    Date.now = () => real() + 61_000
    try { expect(await hs.search('c', 'd')).not.toBeNull() } finally { Date.now = real }
  })

  it('a success resets the failure streak', async () => {
    impl = async () => new Response('', { status: 500 })
    await hs.search('c', 'a'); await hs.search('c', 'b')
    impl = async () => ok([])
    await hs.search('c', 'c')
    impl = async () => new Response('', { status: 500 })
    await hs.search('c', 'd'); await hs.search('c', 'e')
    impl = async () => ok([])
    expect(await hs.search('c', 'f')).not.toBeNull()
  })

  it('cache hit within ttl, refetch after, bounded at 200', async () => {
    await hs.search('c', 'a'); await hs.search('c', 'a')
    expect(calls.length).toBe(1)
    const real = Date.now
    Date.now = () => real() + 61_000
    try { await hs.search('c', 'a') } finally { Date.now = real }
    expect(calls.length).toBe(2)
    hs.resetHslogs()
    for (let i = 0; i < 205; i++) await hs.search('c', `q${i}`)
    calls = []
    await hs.search('c', 'q204'); expect(calls.length).toBe(0)
    await hs.search('c', 'q0'); expect(calls.length).toBe(1)
  })

  it('aggregates cache for an hour', async () => {
    await hs.getTermFootprint('c', 't')
    const real = Date.now
    Date.now = () => real() + 600_000
    try { await hs.getTermFootprint('c', 't') } finally { Date.now = real }
    expect(calls.length).toBe(1)
  })

  it('drops rows by forgotten users, and skips their endpoints', async () => {
    impl = async () => ok([row('Gone', 'x'), row('stay', 'y')])
    hs.setForgottenCheck((u) => u.toLowerCase() === 'gone')
    const r = await hs.search('c', 'q')
    expect(r?.data.map((x) => x.username)).toEqual(['stay'])
    expect(await hs.getUserProfile('c', 'gone')).toBeNull()
    expect(calls.length).toBe(1)
  })
})

// real response shapes, verified against prod on 2026-10-12
describe('hslogs contract', () => {
  const wrapped = (data: unknown) => new Response(JSON.stringify({ status: 'ready', computed_at: '2026-10-12T00:00:00Z', data, coverage: cov }), { status: 200 })

  it('profile is wrapped in {data, coverage} with first_seen/messages', async () => {
    const body = { exists: true, username: 'mellen', first_seen: '2026-04-24T01:02:03.000Z', last_seen: '2026-10-12T00:00:00.000Z', messages: 16091, active_days: 120 }
    impl = async () => ok(body)
    const p = await hs.getUserProfile('nl_kripp', 'Mellen')
    expect(p?.messages).toBe(16091)
    expect(p?.first_seen).toBe('2026-04-24T01:02:03.000Z')
    expect(calls[0]).toBe('http://hs.test/api/v1/logs/twitch/nl_kripp/users/mellen/profile')
  })

  it('profile that is not an object with exists → null', async () => {
    impl = async () => new Response(JSON.stringify({ data: {} }), { status: 200 })
    expect(await hs.getUserProfile('c', 'bob')).toBeNull()
  })

  it('a bare (unwrapped) profile is not the contract → null', async () => {
    impl = async () => new Response(JSON.stringify({ exists: true, username: 'bob', messages: 5 }), { status: 200 })
    expect(await hs.getUserProfile('c', 'bob')).toBeNull()
  })

  it('top-chatters rows are {username, messages, active_days}, forgotten dropped', async () => {
    impl = async () => ok([{ username: 'a', messages: 90, active_days: 9 }, { username: 'gone', messages: 50, active_days: 5 }])
    hs.setForgottenCheck((u) => u === 'gone')
    const r = await hs.getTopChatters('c', 'all', 15)
    expect(r?.data).toEqual([{ username: 'a', messages: 90, active_days: 9 }])
    expect(calls[0]).toContain('days=all&limit=15')
  })

  it('pastas rows are {text, repeats, users, days, first_at, last_at}', async () => {
    impl = async () => ok([{ text: 'day 1,847 of asking', repeats: 316, users: 40, days: 12, first_at: 'x', last_at: 'y' }])
    const r = await hs.getPastas('c', { q: 'whammy', limit: 5 })
    expect(r?.data[0].text).toBe('day 1,847 of asking')
    expect(r?.data[0].repeats).toBe(316)
  })

  it('term-footprint unwraps {status, computed_at, data}', async () => {
    impl = async () => wrapped({ term: 'tidolar', count: 30, distinct_users: 9, first_seen: '2026-03-01T00:00:00.000Z' })
    const r = await hs.getTermFootprint('c', 'tidolar')
    expect(r?.data.count).toBe(30)
    expect(r?.data.distinct_users).toBe(9)
  })

  it('term-count unwraps {status, computed_at, data}', async () => {
    impl = async () => wrapped({ term: 'lul', count: 4, first_at: 'x', last_at: 'y' })
    const r = await hs.getTermCount('c', 'Bob', 'lul')
    expect(r?.data.count).toBe(4)
    expect(calls[0]).toContain('/users/bob/term-count?term=lul')
  })

  it('202 (still computing) → null and is not cached', async () => {
    impl = async () => new Response(JSON.stringify({ status: 'computing' }), { status: 202 })
    expect(await hs.getTermFootprint('c', 'x')).toBeNull()
    impl = async () => wrapped({ term: 'x', count: 2, distinct_users: 1, first_seen: null })
    expect((await hs.getTermFootprint('c', 'x'))?.data.count).toBe(2)
    expect(calls.length).toBe(2)
  })

  it('202 does not feed the failure breaker', async () => {
    impl = async () => new Response('{}', { status: 202 })
    for (const t of ['a', 'b', 'c', 'd']) await hs.getTermFootprint('c', t)
    impl = async () => ok([])
    expect(await hs.search('c', 'q')).not.toBeNull()
  })

  it('envelope coverage carries days_scanned/exhausted/partial', async () => {
    impl = async () => ok([row('a', 'hi')])
    const r = await hs.search('c', 'hi')
    expect(r?.coverage.days_scanned).toBe(1)
    expect(r?.coverage.exhausted).toBe(true)
  })

  it('an outer abort signal cuts the call short', async () => {
    impl = () => new Promise(() => {})
    const ac = new AbortController()
    globalThis.fetch = ((_u: string, i: RequestInit) => new Promise((_, rej) => { i.signal?.addEventListener('abort', () => rej(new DOMException('a', 'AbortError'))) })) as unknown as typeof fetch
    const p = hs.search('c', 'slow', { signal: ac.signal })
    ac.abort()
    expect(await p).toBeNull()
  })

  it('clamps params the api rejects (400 bad_query)', async () => {
    await hs.getPastas('c', { min_len: 25, limit: 24, min_repeats: 1 })
    expect(calls[0]).toContain('min_len=80')
    expect(calls[0]).toContain('limit=20')
    expect(calls[0]).toContain('min_repeats=2')
    calls = []
    await hs.getPastas('c', { q: 'x' })
    expect(calls[0]).not.toContain('min_len') // unset stays unset (server default)
    await hs.getUserMessages('c', 'bob', { limit: 999 })
    expect(calls[1]).toContain('limit=200')
    await hs.getTopChatters('c', 'all', 100)
    expect(calls[2]).toContain('limit=25')
  })

  it('budget_ms is clamped, sent, and kept out of the cache key', async () => {
    await hs.search('c', 'x', { budget_ms: 50 })
    expect(calls[0]).toContain('budget_ms=300')
    await hs.search('c', 'x', { budget_ms: 900 })
    expect(calls).toHaveLength(1) // same query, different budget → cache hit
    await hs.getUserMessages('c', 'bob', { budget_ms: 99_999 })
    expect(calls[1]).toContain('budget_ms=5000')
  })

  it('a page the budget cut short is never cached', async () => {
    impl = async () => new Response(JSON.stringify({ data: [], coverage: { ...cov, partial: true, exhausted: false }, next_cursor: 'c1' }), { status: 200 })
    await hs.search('c', 'y', { budget_ms: 400 })
    await hs.search('c', 'y', { budget_ms: 400 })
    expect(calls).toHaveLength(2)
  })
})
