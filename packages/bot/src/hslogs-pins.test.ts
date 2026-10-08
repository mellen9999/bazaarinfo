import { describe, expect, it, beforeEach, afterEach } from 'bun:test'

const hs = await import('./hslogs')
const pins = await import('./hslogs-pins')

const realFetch = globalThis.fetch
let reqs: { method: string; url: string }[] = []
let remote: string[] = []
let override: (method: string, url: string) => Response | Promise<Response> | undefined

beforeEach(() => {
  process.env.HEATSYNC_LOGS_KEY = 'k'
  process.env.HEATSYNC_LOGS_URL = 'http://hs.test/api/v1/logs'
  hs.resetHslogs(); pins.resetPinNotes()
  reqs = []; remote = []; override = () => undefined
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    reqs.push({ method, url: String(url) })
    const o = override(method, String(url))
    if (o) return Promise.resolve(o)
    if (method === 'GET') return Promise.resolve(new Response(JSON.stringify({ data: remote.map((channel) => ({ channel })) })))
    return Promise.resolve(new Response('{}'))
  }) as unknown as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch; delete process.env.HEATSYNC_LOGS_KEY })

const muts = () => reqs.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.url.split('/twitch/')[1]}`)
const tick = () => Bun.sleep(5)

describe('pins', () => {
  it('reconcile puts missing and deletes extras', async () => {
    remote = ['a', 'old']
    await pins.reconcilePins(['A', 'b', 'c'])
    expect(muts().sort()).toEqual(['DELETE old/pin', 'PUT b/pin', 'PUT c/pin'])
    expect(reqs[0].url).toBe('http://hs.test/api/v1/logs/pins')
  })

  it('reconcile in sync does nothing', async () => {
    remote = ['a']
    await pins.reconcilePins(['a'])
    expect(muts()).toEqual([])
  })

  it('no key → no requests anywhere', async () => {
    delete process.env.HEATSYNC_LOGS_KEY
    await pins.reconcilePins(['a'])
    pins.pinChannel('a'); pins.unpinChannel('a')
    await tick()
    expect(reqs.length).toBe(0)
    expect(await hs.listPins()).toBeNull()
  })

  it('failed list → no mutations (never deletes blind)', async () => {
    override = () => new Response('', { status: 503 })
    await pins.reconcilePins(['a'])
    expect(muts()).toEqual([])
  })

  it('join/part hooks fire pin/unpin, lowercased', async () => {
    pins.pinChannel('Foo'); pins.unpinChannel('Bar')
    await tick()
    expect(muts().sort()).toEqual(['DELETE bar/pin', 'PUT foo/pin'])
  })

  it('errors never throw; outcomes log once and 4xx do not trip breaker', async () => {
    override = (m) => (m === 'PUT' ? new Response('{"error":"pins_full"}', { status: 409 }) : undefined)
    expect(() => pins.pinChannel('x')).not.toThrow()
    await tick()
    for (const c of ['a', 'b', 'c', 'd']) pins.pinChannel(c)
    await tick()
    expect(reqs.length).toBe(5)
    override = () => Promise.reject(new Error('boom')) as unknown as Response
    expect(() => pins.unpinChannel('x')).not.toThrow()
    await tick()
  })

  it('pin() surfaces the error code', async () => {
    override = () => new Response('{"error":"channel_unavailable"}', { status: 404 })
    expect(await hs.pin('x')).toEqual({ ok: false, code: 'channel_unavailable' })
    override = () => undefined
    expect(await hs.unpin('x')).toEqual({ ok: true })
  })
})
