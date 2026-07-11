import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { log } from './log'
import { writeAtomic } from './fs-util'

const CACHE_PATH = resolve(import.meta.dir, '../../../cache/patch.json')
const UA = 'BazaarInfo/1.0 (Twitch bot; github.com/mellen9999/bazaarinfo)'
const STALE_MS = 3 * 24 * 60 * 60 * 1000 // 3 days

export interface PatchInfo {
  latestPatch: string
  patchDate: string
  sizeBadge: string
  activeEvent: string | null
  fetchedAt: string
}

// pure parser — used by fetchPatchInfo and tests; no network
export function parsePatchHtml(html: string): PatchInfo | null {
  try {
    // first <a href="/patchnotes/..."> block: bold span = title, secondary span = "SIZE - DATE"
    const re = /href="\/patchnotes\/[^"]*"[^>]*>(?:<[^>]*>)*<span[^>]*font-weight:\s*bold[^>]*>(.*?)<\/span><span[^>]*secondary[^>]*>(.*?)<\/span>/
    const m = re.exec(html)
    if (!m) return null

    const rawTitle = m[1].trim()
    const rawBadge = m[2]

    // version: leading semver digits from title (e.g. "15.2" from "15.2" or "13.3 Event Apr 29")
    const verMatch = /^(\d+(?:\.\d+)+)/.exec(rawTitle)
    if (!verMatch) return null
    const latestPatch = verMatch[1]
    if (!/^\d+(\.\d+)+$/.test(latestPatch)) return null

    // strip HTML comments, normalize whitespace, split on " - "
    const cleanBadge = rawBadge.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim()
    const sep = ' - '
    const dashIdx = cleanBadge.indexOf(sep)
    const sizeBadge = dashIdx >= 0 ? cleanBadge.slice(0, dashIdx).trim() : ''
    const patchDate = dashIdx >= 0 ? cleanBadge.slice(dashIdx + sep.length).trim() : ''

    // plausibility check: date must contain a month abbreviation
    if (!/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i.test(patchDate)) return null

    // event: latest entry title contains the word "Event" (e.g. "13.3 Event Apr 29")
    const activeEvent = /\bEvent\b/i.test(rawTitle) ? rawTitle : null

    return { latestPatch, patchDate, sizeBadge, activeEvent, fetchedAt: new Date().toISOString() }
  } catch {
    return null
  }
}

// fetch from bazaardb.gg/patchnotes, parse, and write cache/patch.json
// returns null on any failure — never throws
export async function fetchPatchInfo(): Promise<PatchInfo | null> {
  try {
    const res = await fetch('https://bazaardb.gg/patchnotes', {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const html = await res.text()
    const info = parsePatchHtml(html)
    if (!info) {
      log('patch: parse failed — page structure may have changed')
      return null
    }
    try {
      // atomic (tmp+rename) like every other cache write — a crash mid-write must not
      // leave a truncated patch.json
      await writeAtomic(CACHE_PATH, JSON.stringify(info, null, 2))
    } catch (e) {
      log(`patch: cache write failed: ${e}`)
    }
    return info
  } catch {
    return null
  }
}

// synchronous cache read — returns null if missing, stale (>3d), or unparseable
export function getPatchInfo(): PatchInfo | null {
  try {
    if (!existsSync(CACHE_PATH)) return null
    const raw = readFileSync(CACHE_PATH, 'utf8')
    const info = JSON.parse(raw) as PatchInfo
    if (!info?.fetchedAt || !info.latestPatch) return null
    if (!/^\d+(\.\d+)+$/.test(info.latestPatch)) return null
    const age = Date.now() - new Date(info.fetchedAt).getTime()
    if (age > STALE_MS) return null
    return info
  } catch {
    return null
  }
}
