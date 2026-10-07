import { describe, it, expect } from 'bun:test'
import { readFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseCardPage, parseSitemap, cdnNewer, fillPageCache, loadPageCache, savePageCache, type PageCache } from './card-pages'

const fx = (n: string) => readFileSync(join(import.meta.dir, '../fixtures', n), 'utf-8')

describe('parseCardPage', () => {
  it('uniform cooldown collapses to a number, with art + segment', () => {
    const p = parseCardPage(fx('page-aged-cask.rsc'))
    expect(p.cooldown).toBe(4)
    expect(p.cdn).toBe('z19.0')
    expect(p.art).toMatch(/^[a-f0-9]{40}$/)
  })

  it('per-tier cooldown stays a tier map', () => {
    expect(parseCardPage(fx('page-ice-cream-truck.rsc')).cooldown).toEqual({ Silver: 9, Gold: 8, Diamond: 7 })
  })

  it('passive card (CooldownMax only in prose) has no cooldown but keeps art', () => {
    const p = parseCardPage(fx('page-eagle-talisman.rsc'))
    expect(p.cooldown).toBeNull()
    expect(p.art).toBe('2675de1265b46b64cca0494d5a47204cb7bc8bc9')
  })

  it('fractional seconds and junk input', () => {
    const row = '["$","tr","CooldownMax",{"children":[["$","td","CooldownMax-Gold",{"children":"2.5s"}]]}]'
    expect(parseCardPage(row).cooldown).toBe(2.5)
    expect(parseCardPage('garbage')).toEqual({ cooldown: null })
  })

  it('only reads its own row, not later rows', () => {
    const t = '["$","tr","CooldownMax",{"children":[["$","td","CooldownMax-Gold",{"children":"3s"}]]}],["$","tr","Other",{"x":"CooldownMax-Gold\\",{\\"children\\":\\"9s\\""}]'
    expect(parseCardPage(t).cooldown).toBe(3)
  })
})

describe('parseSitemap', () => {
  it('keys decoded and raw slugs', () => {
    const m = parseSitemap('<loc>https://bazaardb.gg/card/abc/Mortar-%26-Pestle</loc><loc>https://bazaardb.gg/card/def/Aged-Cask</loc>')
    expect(m.get('Mortar-&-Pestle')).toBe('/card/abc/Mortar-%26-Pestle')
    expect(m.get('Mortar-%26-Pestle')).toBe('/card/abc/Mortar-%26-Pestle')
    expect(m.get('Aged-Cask')).toBe('/card/def/Aged-Cask')
  })
})

it('cdnNewer compares numerically', () => {
  expect(cdnNewer('z19.0', 'z9.9')).toBe(true)
  expect(cdnNewer('z17.0', 'z17.0')).toBe(false)
})

// fake bazaardb: sitemap + card pages by path
function fakeFetch(pages: Record<string, string | number>, seen: string[] = []): typeof fetch {
  return (async (url: string) => {
    const u = String(url)
    if (u.endsWith('/sitemap.xml')) {
      return new Response(Object.keys(pages).map((p) => `<loc>https://bazaardb.gg${p}</loc>`).join(''))
    }
    const path = u.replace('https://bazaardb.gg', '')
    seen.push(path)
    const body = pages[path]
    if (typeof body === 'number') return new Response('x', { status: body })
    return new Response(body)
  }) as unknown as typeof fetch
}
const aged = () => fx('page-aged-cask.rsc')
const truck = () => fx('page-ice-cream-truck.rsc')
const opts = { delayMs: 0, save: false }

describe('fillPageCache', () => {
  it('fetches only titles the cache lacks', async () => {
    const seen: string[] = []
    const cache: PageCache = { cdn: '', cards: { 'Aged Cask': { cd: 4, art: 'a'.repeat(40), at: new Date().toISOString() } } }
    const f = fakeFetch({ '/card/1/Aged-Cask': aged(), '/card/2/Ice-Cream-Truck': truck() }, seen)
    const r = await fillPageCache(['Aged Cask', 'Ice Cream Truck'], cache, { ...opts, fetcher: f })
    expect(seen).toEqual(['/card/2/Ice-Cream-Truck'])
    expect(r.fetched).toBe(1)
    expect(cache.cards['Ice Cream Truck'].cd).toEqual({ Silver: 9, Gold: 8, Diamond: 7 })
    expect(cache.cdn).toBe('z19.0')
  })

  it('respects the cap and reports pending', async () => {
    const seen: string[] = []
    const f = fakeFetch({ '/card/1/A': aged(), '/card/2/B': aged(), '/card/3/C': aged() }, seen)
    const cache: PageCache = { cdn: '', cards: {} }
    const r = await fillPageCache(['A', 'B', 'C'], cache, { ...opts, fetcher: f, cap: 2 })
    expect(seen).toHaveLength(2)
    expect(r.pending).toBe(1)
  })

  it('a bad fetch is fail-soft and retried later', async () => {
    const cache: PageCache = { cdn: '', cards: {} }
    const f = fakeFetch({ '/card/1/A': 500, '/card/2/B': 'not a card page', '/card/3/C': aged() })
    const r = await fillPageCache(['A', 'B', 'C'], cache, { ...opts, fetcher: f })
    expect(r.failed).toBe(2)
    expect(Object.keys(cache.cards)).toEqual(['C'])
  })

  it('stops the whole run on a rate limit instead of hammering the rest', async () => {
    const seen: string[] = []
    const cache: PageCache = { cdn: '', cards: {} }
    const f = fakeFetch({ '/card/1/A': aged(), '/card/2/B': 429, '/card/3/C': aged() }, seen)
    const r = await fillPageCache(['A', 'B', 'C'], cache, { ...opts, fetcher: f })
    expect(seen).toEqual(['/card/1/A', '/card/2/B'])
    expect(r.pending).toBe(2)
  })

  it('sitemap outage leaves everything pending without throwing', async () => {
    const cache: PageCache = { cdn: '', cards: {} }
    const f = (async () => { throw new Error('down') }) as unknown as typeof fetch
    const r = await fillPageCache(['A'], cache, { ...opts, fetcher: f })
    expect(r).toEqual({ fetched: 0, failed: 0, pending: 1 })
  })

  it('refetches stale entries oldest first, and keeps old art if the page has none', async () => {
    const seen: string[] = []
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString()
    const cache: PageCache = { cdn: 'z19.0', cards: { A: { cd: 9, art: 'k'.repeat(40), at: old } } }
    const f = fakeFetch({ '/card/1/A': '["$","tr","CooldownMax",{"children":[["$","td","CooldownMax-Gold",{"children":"5s"}]]}]' }, seen)
    await fillPageCache(['A'], cache, { ...opts, fetcher: f })
    expect(cache.cards.A.cd).toBe(5)
    expect(cache.cards.A.art).toBe('k'.repeat(40))
  })
})

describe('page cache file', () => {
  it('round-trips atomically and tolerates missing/bad files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cardpages-'))
    const path = join(dir, 'sub', 'card-pages.json')
    expect(await loadPageCache(path)).toEqual({ cdn: '', cards: {} })
    await savePageCache({ cdn: 'z19.0', cards: { A: { cd: 4, at: 'x' } } }, path)
    expect((await loadPageCache(path)).cards.A.cd).toBe(4)
    await Bun.write(path, '{nope')
    expect(await loadPageCache(path)).toEqual({ cdn: '', cards: {} })
    await Bun.write(path, JSON.stringify({ cdn: 'bogus', cards: 5 }))
    expect(await loadPageCache(path)).toEqual({ cdn: '', cards: {} })
  })
})
