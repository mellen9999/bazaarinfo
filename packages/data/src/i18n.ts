// i18n.ts — per-language card text, lifted from the game's own translation cache.
//
// The game ships every translated string as a plain sqlite file per language
// (`translation(hash, text)`), keyed by the lowercase hex MD5 of the ENGLISH string.
// Our card data is that same English, so a card title or tooltip looks itself up by
// hash and comes out in the player's language, placeholders ({ability.0}) intact.
// Only strings the overlay can actually show are kept — the table is ~8.6k rows,
// most of it dialogue and menus nobody here renders.
//
// Read-only on the game's files, no network. A missing source dir or language leaves
// whatever is already in the output dir untouched: stale text beats no text.

import { Database } from 'bun:sqlite'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, renameSync, writeFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import type { CardCache } from '@bazaarinfo/shared'

// twitch's language codes -> the game's file stems
export const LANGS: Record<string, string> = {
  de: 'de-DE', es: 'es-ES', fr: 'fr-FR', it: 'it-IT',
  ko: 'ko-KR', pt: 'pt-BR', tr: 'tr-TR', zh: 'zh-CN',
}

// words the overlay prints that are not read off a card (labels, keywords, enums).
// Anything the table does not carry is simply absent and falls back to English.
const FIXED_WORDS = [
  'Small', 'Medium', 'Large',
  'Bronze', 'Silver', 'Gold', 'Diamond', 'Legendary',
  'Item', 'Skill', 'Common',
  'Burn', 'Poison', 'Shield', 'Heal', 'Regen', 'Crit', 'Haste', 'Slow', 'Freeze', 'Charge',
  'Multicast', 'Damage', 'Ammo', 'Lifesteal', 'Flying', 'Rage', 'Health', 'Max Health',
  'Cooldown', 'Tier', 'Hero', 'Heroes', 'Enchantments', 'Enchantment', 'Tags', 'Size', 'Type',
]

// the game's own folder; Proton prefix first (this machine), then native Windows
const GAME_SUBPATH = join('Tempo Storm', 'The Bazaar', 'prod', 'cache', 'translations')
const PROTON_LOCALLOW = join('.local', 'share', 'Steam', 'steamapps', 'compatdata', '1617400',
  'pfx', 'drive_c', 'users', 'steamuser', 'AppData', 'LocalLow')

export function defaultSourceDirs(): string[] {
  const dirs: string[] = []
  if (process.env.BAZAAR_TRANSLATIONS_DIR) dirs.push(process.env.BAZAAR_TRANSLATIONS_DIR)
  dirs.push(join(homedir(), PROTON_LOCALLOW, GAME_SUBPATH))
  const win = process.env.USERPROFILE
  if (win) dirs.push(join(win, 'AppData', 'LocalLow', GAME_SUBPATH))
  return dirs
}

// repo-root cache/i18n; env override because the ebs may run from another checkout
export const DEFAULT_I18N_DIR = resolve(import.meta.dir, '../../../cache/i18n')
export function i18nDir(): string {
  return process.env.BAZAARINFO_I18N_DIR || DEFAULT_I18N_DIR
}

export const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex')

export interface Wanted {
  titles: Set<string>
  tooltips: Set<string>
  words: Set<string>
}

// every English string our overlay can show, split by kind so coverage is reportable
export function collectWanted(cache: CardCache): Wanted {
  const titles = new Set<string>()
  const tooltips = new Set<string>()
  const words = new Set<string>(FIXED_WORDS)
  const cards = [...cache.items, ...cache.skills, ...(cache.events ?? [])]
  for (const c of cards) {
    titles.add(c.Title)
    for (const t of c.Tooltips) tooltips.add(t.text)
    for (const [name, e] of Object.entries(c.Enchantments ?? {})) {
      words.add(name)
      for (const t of e.tooltips) tooltips.add(t.text)
    }
    for (const w of [...c.Tags, ...c.DisplayTags, ...c.Heroes, c.Size, c.BaseTier, ...c.Tiers]) words.add(w)
  }
  for (const m of cache.monsters) titles.add(m.Title)
  // *Reference tags are internal keys the overlay never prints
  for (const w of words) if (w.endsWith('Reference')) words.delete(w)
  titles.delete('')
  tooltips.delete('')
  return { titles, tooltips, words }
}

export interface Coverage { total: number, hit: number }
export interface LangReport {
  lang: string
  entries: number
  bytes: number
  titles: Coverage
  tooltips: Coverage
  words: Coverage
}

function readTable(file: string): Map<string, string> | null {
  const db = new Database(file, { readonly: true })
  try {
    const rows = db.query('SELECT hash, text FROM translation').all() as { hash: string, text: string }[]
    return new Map(rows.map((r) => [r.hash, r.text]))
  } catch {
    return null
  } finally {
    db.close()
  }
}

// english -> translated for one language, identity entries dropped (the client falls
// back to English on a miss, so storing them is dead weight)
export function buildLang(table: Map<string, string>, wanted: Wanted): { map: Record<string, string>, report: Omit<LangReport, 'lang' | 'bytes'> } {
  const out = new Map<string, string>()
  const cov = (set: Set<string>): Coverage => {
    const c: Coverage = { total: set.size, hit: 0 }
    for (const s of set) {
      // exact match only: against the live dump, trimming/squashing whitespace recovered
      // nothing — every miss is text newer than the game's cache, not formatting drift
      const t = table.get(md5(s))
      if (!t) continue
      c.hit++
      if (t !== s) out.set(s, t)
    }
    return c
  }
  const titles = cov(wanted.titles)
  const tooltips = cov(wanted.tooltips)
  const words = cov(wanted.words)
  const map: Record<string, string> = {}
  for (const k of [...out.keys()].sort()) map[k] = out.get(k)!
  return { map, report: { entries: out.size, titles, tooltips, words } }
}

function writeAtomicSync(path: string, data: string) {
  const tmp = path + '.tmp'
  writeFileSync(tmp, data, { mode: 0o644 })
  renameSync(tmp, path)
}

export interface ExtractOpts {
  cache: CardCache
  srcDirs?: string[]
  outDir?: string
  log?: (msg: string) => void
}

// returns one report per language actually written; [] when there is nothing to read
export function extractI18n(opts: ExtractOpts): LangReport[] {
  const log = opts.log ?? (() => {})
  const outDir = opts.outDir ?? i18nDir()
  const srcDirs = opts.srcDirs ?? defaultSourceDirs()
  const src = srcDirs.find((d) => existsSync(d))
  if (!src) {
    log(`i18n: no translations dir found (tried ${srcDirs.length}); keeping existing ${outDir}. set BAZAAR_TRANSLATIONS_DIR`)
    return []
  }
  const wanted = collectWanted(opts.cache)
  mkdirSync(outDir, { recursive: true })
  const reports: LangReport[] = []
  for (const [lang, stem] of Object.entries(LANGS)) {
    const file = join(src, `${stem}.bytes`)
    if (!existsSync(file)) { log(`i18n: ${stem}.bytes missing, keeping existing ${lang}`); continue }
    try {
      const table = readTable(file)
      if (!table || table.size === 0) { log(`i18n: ${stem}.bytes unreadable or empty, keeping existing ${lang}`); continue }
      const { map, report } = buildLang(table, wanted)
      // a tiny map means the hashing scheme or the dump changed under us; never overwrite good data with that
      if (report.entries === 0) { log(`i18n: ${lang} matched nothing, keeping existing`); continue }
      const path = join(outDir, `${lang}.json`)
      writeAtomicSync(path, JSON.stringify(map))
      reports.push({ lang, bytes: statSync(path).size, ...report })
    } catch (e) {
      log(`i18n: ${lang} failed (${e}), keeping existing`)
    }
  }
  return reports
}

const pct = (c: Coverage) => c.total ? (100 * c.hit / c.total).toFixed(1) : '0.0'

export function formatReport(r: LangReport): string {
  const { titles: t, tooltips: x, words: w } = r
  return `${r.lang}: ${r.entries} entries, ${(r.bytes / 1024).toFixed(0)}KB, titles ${pct(t)}% (${t.hit}/${t.total}), tooltips ${pct(x)}% (${x.hit}/${x.total}), words ${w.hit}/${w.total}`
}
