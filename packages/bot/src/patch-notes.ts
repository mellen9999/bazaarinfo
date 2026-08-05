// current-patch grounding.
//
// bazaardb's dump is the source of truth for *current* card stats, but it lags a patch
// drop by hours-to-days and never records what actually CHANGED. this module closes both
// gaps: it floors the reported version until the scraper catches up, and it indexes the
// per-card deltas so "did X get nerfed" is answerable from real data instead of guessed.
//
// the data is parsed from the official patch notes (patch-parse.ts) and cached; the
// committed SEED in patch-seed.ts is the offline/first-run fallback. nothing here is
// hand-maintained on a normal patch day.

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { log } from './log'
import { notify } from './notify'
import { writeAtomic } from './fs-util'
import { SEED } from './patch-seed'
import { parsePatchDoc, pickLatest } from './patch-parse'
import * as store from './store'
import type { PatchInfo } from './patch'

export interface PatchChange {
  card: string
  hero: string
  text: string
}

export interface PatchOverlay {
  version: string
  name: string
  /** "Aug 5" — same shape as PatchInfo.patchDate */
  date: string
  /** ISO release date; used to age the overlay out rather than trusting it forever */
  released: string
  /** heroes shipped in this patch that the dump may not list yet */
  newHeroes: string[]
  /** general / meta bullets, terse enough to drop straight into a 480-char reply */
  notes: string[]
  changes: PatchChange[]
}

const MANIFEST_URL = 'https://www.playthebazaar.com/api/cdn/data/data/patch-notes.json'
const CDN_BASE = 'https://www.playthebazaar.com/api/cdn/data'
const UA = 'BazaarInfo/1.0 (Twitch bot; github.com/mellen9999/bazaarinfo)'
const CACHE_DEFAULT = resolve(import.meta.dir, '../../../cache/patch-notes.json')

function cachePath(): string {
  return process.env.BAZAARINFO_NOTES_CACHE || CACHE_DEFAULT
}

/** normalize a name for matching — lowercase, alnum only (apostrophes/hyphens/spaces drop) */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

// --- live state -------------------------------------------------------------
// OVERLAY is a live binding: importers see whatever the newest accepted parse produced.

export let OVERLAY: PatchOverlay = SEED
let byCard = indexChanges(SEED)

function indexChanges(o: PatchOverlay): Map<string, PatchChange> {
  const m = new Map<string, PatchChange>()
  for (const c of o.changes) m.set(norm(c.card), c)
  return m
}

/** semver-ish compare: 1 if a > b, -1 if a < b, 0 if equal. non-numeric parts sort as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

/**
 * a parsed or cached overlay is only adopted if it's structurally sound AND not a
 * downgrade. an upstream format change that yields three junk entries must never
 * replace a good one — the seed is the floor, not a starting point to erode.
 */
export function validateOverlay(o: unknown): o is PatchOverlay {
  const p = o as PatchOverlay | null
  if (!p || typeof p !== 'object') return false
  if (typeof p.version !== 'string' || !/^\d+(\.\d+)*$/.test(p.version)) return false
  if (typeof p.name !== 'string' || p.name.length > 80) return false
  if (typeof p.date !== 'string' || !/^[A-Z][a-z]{2} \d{1,2}$/.test(p.date)) return false
  if (typeof p.released !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.released)) return false
  if (isNaN(new Date(p.released + 'T00:00:00Z').getTime())) return false
  if (!Array.isArray(p.newHeroes) || p.newHeroes.some(h => typeof h !== 'string' || h.length > 40)) return false
  if (!Array.isArray(p.notes) || p.notes.some(n => typeof n !== 'string' || n.length > 600)) return false
  if (!Array.isArray(p.changes) || p.changes.length < 5) return false
  return p.changes.every(
    c => c && typeof c.card === 'string' && c.card.length > 1 && c.card.length < 60
      && typeof c.hero === 'string' && c.hero.length > 1
      && typeof c.text === 'string' && c.text.length > 5 && c.text.length <= 400,
  )
}

/** swap in a newer overlay. returns false (and changes nothing) if invalid or older. */
export function adoptOverlay(next: unknown): boolean {
  if (!validateOverlay(next)) return false
  if (compareVersions(next.version, OVERLAY.version) < 0) return false
  OVERLAY = next
  byCard = indexChanges(next)
  return true
}

/** test hook — drop back to the committed seed */
export function resetOverlay(): void {
  OVERLAY = SEED
  byCard = indexChanges(SEED)
}

/** read the cached parse at startup. fail-soft: any problem leaves the seed in place. */
export function loadOverlayCache(): boolean {
  try {
    if (!existsSync(cachePath())) return false
    const parsed = JSON.parse(readFileSync(cachePath(), 'utf8'))
    const ok = adoptOverlay(parsed)
    if (ok) log(`patch notes: ${OVERLAY.version} "${OVERLAY.name}" (${OVERLAY.changes.length} changes) from cache`)
    return ok
  } catch (e) {
    log(`patch notes: cache read failed: ${e}`)
    return false
  }
}

// --- fetch ------------------------------------------------------------------

async function getJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) })
    if (!res.ok) {
      log(`patch notes: ${url} returned ${res.status}`)
      return null
    }
    return await res.json()
  } catch (e) {
    log(`patch notes: fetch failed: ${e}`)
    return null
  }
}

async function getText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) })
    if (!res.ok) {
      log(`patch notes: ${url} returned ${res.status}`)
      return null
    }
    return await res.text()
  } catch (e) {
    log(`patch notes: fetch failed: ${e}`)
    return null
  }
}

/**
 * pull the newest official patch notes, parse them, adopt and cache.
 * never throws. returns the adopted overlay, or null if nothing changed.
 */
export async function fetchPatchNotes(): Promise<PatchOverlay | null> {
  const manifest = await getJson(MANIFEST_URL)
  if (!manifest) return null
  const latest = pickLatest(manifest)
  if (!latest) {
    await notify('patch-notes-manifest', 'bazaarinfo: patch notes manifest unreadable',
      'playthebazaar patch-notes.json parsed but had no usable entries — format changed.', 'default')
    return null
  }
  // already have this patch and it came from a real parse — nothing to do
  if (compareVersions(latest.version, OVERLAY.version) <= 0 && OVERLAY !== SEED) return null

  const doc = await getText(CDN_BASE + latest.path)
  if (!doc) return null

  const parsed = parsePatchDoc(doc, store.getHeroNames(), store.getAllTitles())
  if (!parsed) {
    await notify('patch-notes-parse', 'bazaarinfo: patch notes parser broke',
      `fetched ${latest.version} notes but parsed nothing — the document format changed. running on ${OVERLAY.version}.`, 'high')
    return null
  }

  const overlay: PatchOverlay = {
    version: parsed.version,
    name: parsed.name,
    date: parsed.date,
    released: parsed.released,
    newHeroes: parsed.newHeroes,
    notes: parsed.notes,
    changes: parsed.changes,
  }
  if (!adoptOverlay(overlay)) {
    await notify('patch-notes-invalid', 'bazaarinfo: patch notes parse rejected',
      `parsed ${parsed.version} but it failed validation (${parsed.changes.length} changes) — kept ${OVERLAY.version}.`, 'high')
    return null
  }

  try {
    await writeAtomic(cachePath(), JSON.stringify(overlay, null, 2))
  } catch (e) {
    log(`patch notes: cache write failed: ${e}`)
  }

  log(`patch notes: adopted ${overlay.version} "${overlay.name}" — ${overlay.changes.length} changes, ${overlay.notes.length} notes`)

  // things worth a human glance: unresolved names are either brand-new cards or naming
  // drift, and a new hero has no card data until the dump catches up.
  const flags: string[] = []
  if (parsed.newHeroes.length) flags.push(`new hero detected: ${parsed.newHeroes.join(', ')} — confirm the name`)
  if (parsed.unmatchedCards.length) flags.push(`${parsed.unmatchedCards.length} names not in the card db: ${parsed.unmatchedCards.slice(0, 12).join(', ')}`)
  if (parsed.emptySections.length) flags.push(`sections with no entries: ${parsed.emptySections.join(', ')}`)
  if (flags.length) {
    await notify('patch-notes-review', `bazaarinfo: patch ${overlay.version} absorbed`, flags.join('\n'), 'default')
  }
  return overlay
}

// --- queries ----------------------------------------------------------------

/**
 * the overlay only speaks while it's plausibly current. after this window it stops
 * flooring the version and stops volunteering "what's new" — a stale patch description
 * must never become a permanently-wrong source of truth.
 */
const OVERLAY_LIFETIME_MS = 60 * 24 * 60 * 60 * 1000 // 60 days

export function isOverlayFresh(now: number = Date.now()): boolean {
  const t = new Date(OVERLAY.released + 'T00:00:00Z').getTime()
  if (isNaN(t)) return false
  return now - t < OVERLAY_LIFETIME_MS
}

export interface PatchStatus {
  /** best known patch — the scraped one, or the overlay's while upstream lags */
  info: PatchInfo | null
  /** true while the overlay describes a patch the card database hasn't absorbed yet */
  dbBehind: boolean
}

/**
 * merge the scraped patch info with the overlay. the scraper is authoritative the moment
 * it catches up (>= overlay version); until then — and only while the overlay is fresh —
 * the overlay floors the answer so the bot isn't a patch behind on drop day.
 */
export function resolvePatch(scraped: PatchInfo | null, now: number = Date.now()): PatchStatus {
  if (!isOverlayFresh(now)) return { info: scraped, dbBehind: false }
  if (scraped && compareVersions(scraped.latestPatch, OVERLAY.version) >= 0) {
    return { info: scraped, dbBehind: false }
  }
  return {
    info: {
      latestPatch: OVERLAY.version,
      patchDate: OVERLAY.date,
      sizeBadge: '', // bazaardb's own badge — never invented here
      activeEvent: scraped?.activeEvent ?? null,
      fetchedAt: new Date(now).toISOString(),
    },
    dbBehind: true,
  }
}

/** overlay heroes the dump hasn't listed yet — empty once the scraper catches up */
export function pendingHeroes(dumpHeroes: string[], now: number = Date.now()): string[] {
  if (!isOverlayFresh(now)) return []
  const have = new Set(dumpHeroes.map(norm))
  return OVERLAY.newHeroes.filter(h => !have.has(norm(h)))
}

/** up to `max` general notes, ranked by overlap with the query's words */
export function selectNotes(query: string, max = 3): string[] {
  const words = new Set(
    query.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4),
  )
  const scored = OVERLAY.notes.map((n, i) => {
    const nw = n.toLowerCase()
    let score = 0
    for (const w of words) if (nw.includes(w)) score++
    return { n, i, score }
  })
  scored.sort((a, b) => b.score - a.score || a.i - b.i)
  return scored.slice(0, max).map(s => s.n)
}

/** the delta line for a card, or null. exact-name match only — no fuzzy, no guessing. */
export function getCardChange(name: string): PatchChange | null {
  if (!name) return null
  return byCard.get(norm(name)) ?? null
}

/** every change for a hero (case-insensitive), newest patch only */
export function getHeroChanges(hero: string): PatchChange[] {
  const h = norm(hero)
  return OVERLAY.changes.filter(c => norm(c.hero) === h)
}
