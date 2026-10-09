import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { CardCache } from '@bazaarinfo/shared'
import { buildLang, collectWanted, extractI18n, formatReport, md5, LANGS } from './i18n'

// a fixture "game cache": same shape as the real .bytes files, built from scratch
function makeBytes(path: string, pairs: Record<string, string>) {
  const db = new Database(path)
  db.run('CREATE TABLE translation (hash TEXT PRIMARY KEY, text TEXT)')
  for (const [en, tr] of Object.entries(pairs)) db.run('INSERT INTO translation VALUES (?, ?)', [md5(en), tr])
  db.close()
}

const card = (over: Record<string, unknown> = {}) => ({
  Type: 'Item', Title: 'Fang', Size: 'Small', BaseTier: 'Bronze', Tiers: ['Bronze', 'Silver'],
  Heroes: ['Vanessa'], Tags: ['Weapon', 'FangReference'], HiddenTags: ['Secret'], DisplayTags: ['Weapon'],
  Tooltips: [{ text: 'Deal {ability.0} damage', type: 'Active' }],
  TooltipReplacements: {}, Shortlink: 'x',
  Enchantments: { Heavy: { tooltips: [{ text: 'Slow an item', type: 'Active' }] } },
  ...over,
}) as never

const CACHE = {
  items: [card()], skills: [card({ Type: 'Skill', Title: 'Zap', Tooltips: [{ text: 'Brand new text', type: 'Passive' }], Enchantments: {} })],
  monsters: [{ Title: 'Dragon', Size: 'Large', Tags: [], DisplayTags: [], HiddenTags: [], Heroes: [] }],
  fetchedAt: 'x',
} as unknown as CardCache

const DE = {
  Fang: 'Reißzahn', 'Deal {ability.0} damage': 'Verursache {ability.0} Schaden', 'Slow an item': 'Verlangsame einen Gegenstand',
  Dragon: 'Dragon', Weapon: 'Waffe', Small: 'Klein', Heavy: 'Schwer', Bronze: 'Bronze', Vanessa: 'Vanessa',
  'Some menu string we never show': 'Nie gezeigt',
}

let root: string
let src: string
let out: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'i18n-'))
  src = join(root, 'src')
  out = join(root, 'out')
  mkdirSync(src)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('md5 keying', () => {
  it('is lowercase hex md5 of the utf8 english string', () => {
    expect(md5('Burn')).toMatch(/^[0-9a-f]{32}$/)
    expect(md5('Burn')).toBe(new Bun.CryptoHasher('md5').update('Burn').digest('hex'))
  })
})

describe('collectWanted', () => {
  it('gathers titles, tooltips (base + enchantment), tags, heroes, sizes, tiers, enchant names', () => {
    const w = collectWanted(CACHE)
    expect([...w.titles].sort()).toEqual(['Dragon', 'Fang', 'Zap'])
    expect(w.tooltips.has('Deal {ability.0} damage')).toBe(true)
    expect(w.tooltips.has('Slow an item')).toBe(true)
    for (const x of ['Weapon', 'Vanessa', 'Small', 'Silver', 'Heavy', 'Burn', 'Cooldown']) expect(w.words.has(x)).toBe(true)
  })
  it('skips hidden tags and internal *Reference keys', () => {
    const w = collectWanted(CACHE)
    expect(w.words.has('Secret')).toBe(false)
    expect(w.words.has('FangReference')).toBe(false)
  })
})

describe('buildLang', () => {
  const table = new Map(Object.entries(DE).map(([en, tr]) => [md5(en), tr]))

  it('maps english to translated and ignores strings we never show', () => {
    const { map } = buildLang(table, collectWanted(CACHE))
    expect(map.Fang).toBe('Reißzahn')
    expect(map['Deal {ability.0} damage']).toBe('Verursache {ability.0} Schaden')
    expect(map['Some menu string we never show']).toBeUndefined()
  })

  it('drops identity entries but still counts them as covered', () => {
    const { map, report } = buildLang(table, collectWanted(CACHE))
    expect('Dragon' in map).toBe(false)
    expect('Bronze' in map).toBe(false)
    expect(report.titles).toEqual({ total: 3, hit: 2 })
  })

  it('a miss (new/changed english) is simply absent so the client falls back', () => {
    const { map, report } = buildLang(table, collectWanted(CACHE))
    expect('Brand new text' in map).toBe(false)
    expect(report.tooltips).toEqual({ total: 3, hit: 2 })
  })

  it('output keys are sorted for deterministic files', () => {
    const { map } = buildLang(table, collectWanted(CACHE))
    const keys = Object.keys(map)
    expect(keys).toEqual([...keys].sort())
  })
})

describe('extractI18n', () => {
  const run = (over: Partial<Parameters<typeof extractI18n>[0]> = {}, logs: string[] = []) =>
    extractI18n({ cache: CACHE, srcDirs: [src], outDir: out, log: (m) => logs.push(m), ...over })

  it('writes one json per language present and reports coverage', () => {
    makeBytes(join(src, 'de-DE.bytes'), DE)
    makeBytes(join(src, 'fr-FR.bytes'), { Fang: 'Croc' })
    const reports = run()
    expect(reports.map((r) => r.lang).sort()).toEqual(['de', 'fr'])
    expect(JSON.parse(readFileSync(join(out, 'de.json'), 'utf-8')).Fang).toBe('Reißzahn')
    expect(reports.find((r) => r.lang === 'de')!.bytes).toBeGreaterThan(10)
    expect(formatReport(reports[0])).toMatch(/titles .*%/)
  })

  it('lang codes are the twitch short codes mapped to the game file stems', () => {
    expect(LANGS.zh).toBe('zh-CN')
    expect(LANGS.pt).toBe('pt-BR')
  })

  it('missing source dir: logs, writes nothing, leaves existing output untouched', () => {
    mkdirSync(out)
    writeFileSync(join(out, 'de.json'), '{"keep":"me"}')
    const logs: string[] = []
    expect(run({ srcDirs: [join(root, 'nope')] }, logs)).toEqual([])
    expect(logs.join()).toContain('no translations dir')
    expect(readFileSync(join(out, 'de.json'), 'utf-8')).toBe('{"keep":"me"}')
  })

  it('a missing or corrupt language file keeps that language\'s existing output', () => {
    mkdirSync(out)
    writeFileSync(join(out, 'es.json'), '{"keep":"me"}')
    writeFileSync(join(src, 'es-ES.bytes'), 'not sqlite at all')
    makeBytes(join(src, 'de-DE.bytes'), DE)
    const logs: string[] = []
    expect(run({}, logs).map((r) => r.lang)).toEqual(['de'])
    expect(readFileSync(join(out, 'es.json'), 'utf-8')).toBe('{"keep":"me"}')
  })

  it('a table that matches none of our strings never overwrites good output', () => {
    mkdirSync(out)
    writeFileSync(join(out, 'de.json'), '{"keep":"me"}')
    makeBytes(join(src, 'de-DE.bytes'), { Unrelated: 'Anderes' })
    expect(run()).toEqual([])
    expect(readFileSync(join(out, 'de.json'), 'utf-8')).toBe('{"keep":"me"}')
  })

  it('writes atomically: no temp file left behind, rerun is byte-identical', () => {
    makeBytes(join(src, 'de-DE.bytes'), DE)
    run()
    const first = readFileSync(join(out, 'de.json'), 'utf-8')
    run()
    expect(readFileSync(join(out, 'de.json'), 'utf-8')).toBe(first)
    expect(readdirSync(out).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('never modifies the game files', () => {
    const f = join(src, 'de-DE.bytes')
    makeBytes(f, DE)
    const before = readFileSync(f)
    run()
    expect(Buffer.compare(readFileSync(f), before)).toBe(0)
    expect(existsSync(f + '-wal')).toBe(false)
  })
})
