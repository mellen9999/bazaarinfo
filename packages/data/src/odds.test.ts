import { describe, it, expect } from 'bun:test'
import { readFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseItemOdds, parseShopOdds, OddsClient } from './odds'
import { itemOddsLine, shopOddsLine } from '@bazaarinfo/shared'

const fx = JSON.parse(readFileSync(join(import.meta.dir, '../fixtures/item-odds-airplane-glue.json'), 'utf-8'))
const SITEMAP = '<urlset><url><loc>https://bazaardb.gg/card/1d9dfhfhxmtswzgl3zpv9v7gp/Airplane-Glue</loc></url></urlset>'

function client(handler: (url: string, init?: RequestInit) => Response, extra: { now?: () => number } = {}) {
  const calls: string[] = []
  const fetcher = (async (url: string, init?: RequestInit) => { calls.push(url); return handler(url, init) }) as unknown as typeof fetch
  const path = join(mkdtempSync(join(tmpdir(), 'odds-')), 'odds.json')
  return { calls, path, c: new OddsClient({ fetcher, path, key: () => 'k', ...extra }) }
}
const route = (url: string) =>
  url.endsWith('sitemap.xml') ? new Response(SITEMAP) : new Response(JSON.stringify(fx))

describe('parseItemOdds', () => {
  it('reads per-day chance and ranks merchants by peak', () => {
    const o = parseItemOdds(fx)!
    expect(o.name).toBe('Airplane Glue')
    expect(o.pAny).toHaveLength(o.days.length)
    expect(o.top).toHaveLength(3)
    expect(o.top[0].peak).toBeGreaterThanOrEqual(o.top[1].peak)
  })
  it('null on drifted shape', () => {
    expect(parseItemOdds({ ...fx, pAnyByDay: 'x' })).toBeNull()
    expect(parseItemOdds({ ...fx, itemUri: 'javascript:1' })).toBeNull()
    expect(parseItemOdds(null)).toBeNull()
  })
})

describe('parseShopOdds', () => {
  it('parses days, rejects junk', () => {
    expect(parseShopOdds({ days: [{ day: 1, samples: 5, tiers: { Bronze: 97.4, Silver: 2.6 } }] })!.days[0].tiers.Bronze).toBe(97.4)
    expect(parseShopOdds({ days: [{ day: 1 }] })).toBeNull()
    expect(parseShopOdds({})).toBeNull()
  })
})

describe('formatters carry credit + link', () => {
  it('item line', () => {
    const line = itemOddsLine(parseItemOdds(fx)!)
    expect(line).toContain('Airplane Glue (stelle gold)')
    expect(line).toContain('bazaardb.gg/card/1d9dfhfhxmtswzgl3zpv9v7gp/Airplane-Glue')
    expect(line.length).toBeLessThan(400)
  })
  it('shop line, with and without a day', () => {
    const s = parseShopOdds({ days: [{ day: 1, samples: 9, tiers: { Bronze: 97.4, Silver: 2.6 } }, { day: 5, samples: 9, tiers: { Silver: 74.77, Bronze: 25.13, Gold: 0.1 } }] })!
    expect(shopOddsLine(s, 5)).toBe('shop tiers d5 silver 75% bronze 25% gold 0.1% | odds via bazaardb.gg/shop-odds')
    expect(shopOddsLine(s)).toContain('d1 bronze 97%')
    expect(shopOddsLine(s, 99)).toContain('no shop data for day 99')
  })
})

describe('OddsClient', () => {
  it('fetches once, then serves the day cache (also across a restart)', async () => {
    const { c, calls, path } = client(route)
    expect((await c.item('Airplane Glue', 'Stelle', 'Gold'))?.name).toBe('Airplane Glue')
    await c.item('Airplane Glue', 'Stelle', 'Gold')
    expect(calls.filter((u) => u.includes('item-odds'))).toHaveLength(1)
    const again = new OddsClient({ fetcher: (async () => { throw new Error('no network') }) as unknown as typeof fetch, path, key: () => 'k' })
    expect((await again.item('Airplane Glue', 'Stelle', 'Gold'))).toBeNull() // sitemap needs the net; cache keyed by id
  })
  it('sends bearer + the shared user-agent', async () => {
    let seen: HeadersInit | undefined
    const { c } = client((u, init) => { if (u.includes('item-odds')) seen = init?.headers; return route(u) })
    await c.item('Airplane Glue', 'Stelle', 'Gold')
    const h = seen as Record<string, string>
    expect(h.Authorization).toBe('Bearer k')
    expect(h['User-Agent']).toContain('BazaarInfo/1.0')
  })
  it('no key = disabled, zero calls', async () => {
    const { calls } = client(route)
    const off = new OddsClient({ fetcher: (async (u: string) => { calls.push(u); return route(u) }) as unknown as typeof fetch, key: () => '' })
    expect(off.enabled).toBe(false)
    expect(await off.shop()).toBeNull()
    expect(calls).toHaveLength(0)
  })
  it('403 parks the client: one call, then silence', async () => {
    let t = 0
    const { c, calls } = client((u) => u.includes('shop-odds') ? new Response('Forbidden', { status: 403 }) : route(u), { now: () => t })
    expect(await c.shop()).toBeNull()
    expect(await c.shop()).toBeNull()
    expect(calls.filter((u) => u.includes('shop-odds'))).toHaveLength(1)
    t += 3_700_000
    await c.shop()
    expect(calls.filter((u) => u.includes('shop-odds'))).toHaveLength(2)
  })
  it('404 is cached as "no odds"; legendary tier never calls', async () => {
    const { c, calls } = client((u) => u.includes('item-odds') ? new Response('{"error":"Unknown item"}', { status: 404 }) : route(u))
    expect(await c.item('Airplane Glue', 'Stelle', 'Gold')).toBeNull()
    expect(await c.item('Airplane Glue', 'Stelle', 'Gold')).toBeNull()
    expect(calls.filter((u) => u.includes('item-odds'))).toHaveLength(1)
    expect(await c.item('Airplane Glue', 'Stelle', 'Legendary')).toBeNull()
  })
  it('429 stops pulling for the day', async () => {
    const { c, calls } = client((u) => u.includes('item-odds') ? new Response('', { status: 429 }) : route(u))
    expect(await c.item('Airplane Glue', 'Stelle', 'Gold')).toBeNull()
    expect(await c.item('Airplane Glue', 'Stelle', 'Silver')).toBeNull()
    expect(calls.filter((u) => u.includes('item-odds'))).toHaveLength(1)
  })
  it('drifted payload is not cached', async () => {
    const { c, calls } = client((u) => u.includes('item-odds') ? new Response('{"nope":1}') : route(u))
    expect(await c.item('Airplane Glue', 'Stelle', 'Gold')).toBeNull()
    await c.item('Airplane Glue', 'Stelle', 'Gold')
    expect(calls.filter((u) => u.includes('item-odds'))).toHaveLength(2)
  })
})
