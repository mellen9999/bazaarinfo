import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { log } from './log'
import { writeAtomic } from './fs-util'
import { notify } from './notify'

const CACHE_PATH_DEFAULT = resolve(import.meta.dir, '../../../cache/patch.json')
const UA = 'BazaarInfo/1.0 (Twitch bot; github.com/mellen9999/bazaarinfo)'
const STALE_MS = 3 * 24 * 60 * 60 * 1000 // 3 days
const STALE_WATCHDOG_MS = 24 * 60 * 60 * 1000 // 24h — checkPatchStaleness threshold

// resolved fresh each call so tests can point at a scratch file (mirrors notify.ts's alertEnvPath)
function cachePath(): string {
  return process.env.BAZAARINFO_PATCH_CACHE || CACHE_PATH_DEFAULT
}

export interface PatchInfo {
  latestPatch: string
  patchDate: string
  sizeBadge: string
  activeEvent: string | null
  fetchedAt: string
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_RE = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i

function isoToBadgeDate(iso: string): string | null {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
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

    // strip HTML comments, normalize whitespace, split "SIZE - DATE" (date may be absent)
    const cleanBadge = rawBadge.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim()
    const bm = /^(\S+)\s*-\s*(.*)$/.exec(cleanBadge)
    const sizeBadge = bm ? bm[1] : cleanBadge
    let patchDate = bm ? bm[2].trim() : ''

    // since ~Jul 2026 the per-entry date is hydrated client-side and missing from
    // server HTML — recover it from the ISO date Next.js ships in its flight payload
    if (!MONTH_RE.test(patchDate)) {
      const iso = /latestPatchDate\\?":\s*\\?"\$D([^"\\]+)/.exec(html)?.[1]
        ?? /\\?"date\\?":\s*\\?"\$D([^"\\]+)/.exec(html)?.[1]
      patchDate = (iso && isoToBadgeDate(iso)) || patchDate
    }

    // plausibility check: date must contain a month abbreviation
    if (!MONTH_RE.test(patchDate)) return null

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
  let res: Response
  try {
    res = await fetch('https://bazaardb.gg/patchnotes', {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    // transient network error — not escalated directly; the staleness watchdog
    // pages if this keeps failing long enough for the cache to actually go stale
    log(`patch: fetch failed: ${e}`)
    return null
  }
  if (!res.ok) {
    log(`patch: fetch non-ok status ${res.status}`)
    return null
  }
  let html: string
  try {
    html = await res.text()
  } catch (e) {
    log(`patch: response read failed: ${e}`)
    return null
  }
  const info = parsePatchHtml(html)
  if (!info) {
    log('patch: parse failed — page structure may have changed')
    await notify(
      'patch-parse',
      'bazaarinfo: patchnotes parser broken',
      'bazaardb.gg/patchnotes returned 200 but parse failed — page structure changed. whats-new answers degrade in 3d.',
      'high',
    )
    return null
  }
  try {
    // atomic (tmp+rename) like every other cache write — a crash mid-write must not
    // leave a truncated patch.json
    await writeAtomic(cachePath(), JSON.stringify(info, null, 2))
  } catch (e) {
    log(`patch: cache write failed: ${e}`)
  }
  return info
}

// synchronous cache read — returns null if missing, stale (>3d), or unparseable
export function getPatchInfo(): PatchInfo | null {
  try {
    if (!existsSync(cachePath())) return null
    const raw = readFileSync(cachePath(), 'utf8')
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

// owner-alert watchdog: pages if the cache is missing or older than 24h (fetchedAt-based,
// independent of getPatchInfo's 3d serving cutoff). call periodically — dedupe is notify's job.
export function checkPatchStaleness(): void {
  try {
    const raw = readFileSync(cachePath(), 'utf8')
    const info = JSON.parse(raw) as PatchInfo
    const age = Date.now() - new Date(info.fetchedAt).getTime()
    if (age <= STALE_WATCHDOG_MS) return
  } catch {
    // missing / corrupt cache — fall through to notify
  }
  notify(
    'patch-stale',
    'bazaarinfo: patch info stale',
    'patch.json older than 24h — refetches failing. whats-new degrades at 3d.',
    'high',
  )
}
