import { describe, expect, it, beforeEach, afterEach } from 'bun:test'

const hs = await import('./hslogs')
const shadow = await import('./hslogs-shadow')

const realFetch = globalThis.fetch
let calls: string[] = []
let impl: (url: string) => Promise<Response>

const cov = { tier: 'hot', from: 'a', to: 'b', rolled_through: null, partial: false, exhausted: true }
const row = (u: string, m: string, id = m) => ({ username: u, display_name: u, message: m, message_id: id, timestamp: '2026-01-01T00:00:00Z', reply_to_id: null })
const ok = (data: unknown) => new Response(JSON.stringify({ data, coverage: cov }), { status: 200 })

beforeEach(() => {
  process.env.HEATSYNC_LOGS_KEY = 'k'
  process.env.HEATSYNC_LOGS_URL = 'http://hs.test/api/v1/logs'
  process.env.HEATSYNC_LOGS_SHADOW = '1'
  hs.resetHslogs(); shadow.resetShadow(); hs.setForgottenCheck(() => false)
  calls = []
  impl = async () => ok([])
  globalThis.fetch = ((url: string) => { calls.push(String(url)); return impl(String(url)) }) as unknown as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch; delete process.env.HEATSYNC_LOGS_KEY; delete process.env.HEATSYNC_LOGS_SHADOW })

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

describe('hslogs shadow', () => {
  it('off unless HEATSYNC_LOGS_SHADOW=1', async () => {
    delete process.env.HEATSYNC_LOGS_SHADOW
    shadow.shadowRecall('c', 'hello', undefined, [])
    await Bun.sleep(5)
    expect(calls.length).toBe(0)
  })

  it('returns synchronously without waiting on a hung fetch', () => {
    impl = () => new Promise(() => {})
    const t = performance.now()
    shadow.shadowRecall('c', 'hello', 'bob', [{ username: 'bob', message: 'hi' }])
    shadow.shadowPasta('c', 'x', null)
    shadow.shadowProfile('c', 'bob', null)
    expect(performance.now() - t).toBeLessThan(20)
  })

  it('never throws on failures or garbage', async () => {
    impl = () => Promise.reject(new Error('boom'))
    expect(() => shadow.shadowRecall('c', 'hello', undefined, [])).not.toThrow()
    impl = async () => new Response('{"data":null}', { status: 200 })
    expect(() => shadow.shadowPasta('c', 'x', { message: 'm', reps: 3 })).not.toThrow()
    await Bun.sleep(10)
  })

  it('rate-limits repeats of one kind', async () => {
    shadow.shadowRecall('c', 'one', undefined, [])
    shadow.shadowRecall('c', 'two', undefined, [])
    await Bun.sleep(5)
    expect(calls.length).toBe(1)
  })
})
