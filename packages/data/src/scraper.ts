import type { BazaarCard, Monster, CardCache, DumpTooltip, DumpEnchantment, ReplacementValue, TierName, ItemSize, MonsterBoardEntry } from '@bazaarinfo/shared'
import { resolve } from 'path'

import artKeys from '../art-keys.json'

const DUMP_URL = 'https://bazaardb.gg/dump.json'
const HOWBAZAAR_URL = 'https://www.howbazaar.gg/api/items'
const USER_AGENT = 'BazaarInfo/1.0 (Twitch bot; github.com/mellen9999/bazaarinfo)'
const COOLDOWN_RE = /^Cooldown\s+([\d.]+)\s+second/i
const ART_MAP: Record<string, string> = artKeys as Record<string, string>

const VALID_TIERS = new Set<string>(['Bronze', 'Silver', 'Gold', 'Diamond', 'Legendary'])
const VALID_SIZES = new Set<string>(['Small', 'Medium', 'Large'])

interface DumpEntry {
  Type: string
  Title: string
  Size: string
  BaseTier: string
  Heroes: string[]
  Tags: string[]
  HiddenTags: string[]
  Tooltips: DumpTooltip[]
  TooltipReplacements?: Record<string, ReplacementValue>
  Tiers: string[]
  Enchantments?: Record<string, DumpEnchantment>
  MonsterMetadata?: {
    available: string
    day: number | null
    health: number
    board: MonsterBoardEntry[]
    skills: MonsterBoardEntry[]
  }
  Shortlink: string
  ArtKey?: string
}

function computeDisplayTags(entry: DumpEntry): string[] {
  const tags = entry.Tags ?? []
  const hidden = entry.HiddenTags ?? []
  const heroes = entry.Heroes ?? []
  return tags.filter((t) =>
    !hidden.includes(t)
    && t !== entry.Type
    && t !== entry.Size
    && !heroes.includes(t),
  )
}

// unknown values PASS THROUGH (cast to the existing type at this boundary) rather than
// throwing — a new game tier/size must not drop items. Callers collect unknowns via
// collectUnknowns() below and surface them so a human notices without data loss.
function validTier(t: string): TierName {
  return t as TierName
}

function validSize(s: string): ItemSize {
  return s as ItemSize
}

function toCard(entry: DumpEntry): BazaarCard {
  if (!entry.Title || typeof entry.Title !== 'string') throw new Error('missing Title')
  const card: BazaarCard = {
    Type: entry.Type as 'Item' | 'Skill',
    Title: entry.Title,
    Size: validSize(entry.Size),
    BaseTier: validTier(entry.BaseTier),
    Tiers: (entry.Tiers ?? []).map(validTier),
    Heroes: entry.Heroes ?? [],
    Tags: entry.Tags ?? [],
    HiddenTags: entry.HiddenTags ?? [],
    DisplayTags: computeDisplayTags(entry),
    Tooltips: entry.Tooltips ?? [],
    TooltipReplacements: entry.TooltipReplacements ?? {},
    Enchantments: entry.Enchantments ?? {},
    Shortlink: entry.Shortlink ?? '',
  }
  const artKey = entry.ArtKey || ART_MAP[entry.Title]
  if (artKey) card.ArtKey = artKey
  return card
}

function toMonster(entry: DumpEntry): Monster | null {
  if (!entry.MonsterMetadata) return null
  return {
    Type: 'CombatEncounter',
    Title: entry.Title,
    Size: validSize(entry.Size),
    Tags: entry.Tags ?? [],
    DisplayTags: computeDisplayTags(entry),
    HiddenTags: entry.HiddenTags ?? [],
    Heroes: entry.Heroes ?? [],
    MonsterMetadata: entry.MonsterMetadata,
    Shortlink: entry.Shortlink ?? '',
  }
}

const MAX_RETRIES = 3
const RETRY_DELAYS = [1000, 2000, 4000]

// if more than this fraction of entries fail to parse, the dump is considered
// structurally broken (e.g. schema change) and we refuse to swap in the new cache
const SKIP_RATIO_THRESHOLD = 0.15

// past this fraction of cards missing art, treat it as a systemic break (a CDN re-key, or
// ART_MAP gone stale) rather than the usual trickle of brand-new cards art hasn't been
// scraped for yet. loud log only — art coverage never fails the scrape.
const ART_MISS_RATIO_THRESHOLD = 0.1

interface ScrapeStats {
  unknownTiers: string[]
  unknownSizes: string[]
  skipped: number  // hard failures (throw or unknown Type)
  total: number    // all entries seen (excludes CombatEncounters without MonsterMetadata — those are expected)
  artMisses: number       // items/skills/events that ended up with no ArtKey
  artMissSamples: string[] // first few titles missing art, for the alert message
}

interface ParseResult {
  cache: CardCache
  stats: ScrapeStats
}

// scan a parsed card/monster for tier/size values outside the known set (they were
// passed through by validTier/validSize rather than dropped) and record them
function collectUnknowns(unknownTiers: Set<string>, unknownSizes: Set<string>, card: { BaseTier?: string; Tiers?: string[]; Size: string }) {
  if (card.BaseTier && !VALID_TIERS.has(card.BaseTier)) unknownTiers.add(card.BaseTier)
  for (const t of card.Tiers ?? []) if (!VALID_TIERS.has(t)) unknownTiers.add(t)
  if (!VALID_SIZES.has(card.Size)) unknownSizes.add(card.Size)
}

function parseDumpWithStats(dump: Record<string, DumpEntry>, onProgress?: (msg: string) => void): ParseResult {
  const items: BazaarCard[] = []
  const skills: BazaarCard[] = []
  const monsters: Monster[] = []
  const events: BazaarCard[] = []
  let skipped = 0
  let total = 0
  const skippedNames: string[] = []
  const unknownTiers = new Set<string>()
  const unknownSizes = new Set<string>()

  for (const entry of Object.values(dump)) {
    try {
      switch (entry.Type) {
        case 'Item':
          total++
          items.push(toCard(entry))
          break
        case 'Skill':
          total++
          skills.push(toCard(entry))
          break
        case 'CombatEncounter': {
          const m = toMonster(entry)
          // CombatEncounters without MonsterMetadata are intentionally incomplete
          // entries in the dump — don't count them as hard failures
          if (m) {
            total++
            monsters.push(m)
          }
          break
        }
        case 'EventEncounter':
        // PedestalEncounter (the map locations — Murkwood Bayou, Plains of Edin) has the
        // same shape and, like events, carries no Tooltips: a name, a tier and a shortlink.
        // These 28 were the entire "skipped bad entries" line in every scrape, which meant
        // asking about a real location got a miss and then an invented answer. Same bucket,
        // so the same name-only recognition applies; event lookup is lowest priority, so an
        // item or monster of the same name still wins. Verified: zero title collisions.
        case 'PedestalEncounter':
          // event-only cards: same structure as items but kept separate to avoid polluting item search
          total++
          events.push(toCard(entry))
          break
        default:
          total++
          skipped++
          if (skippedNames.length < 5) skippedNames.push(entry.Title ?? '(no title)')
          break
      }
    } catch (e) {
      total++
      skipped++
      if (skippedNames.length < 5) skippedNames.push(entry.Title ?? '(no title)')
    }
  }

  const artCards = [...items, ...skills, ...events]
  let artMisses = 0
  const artMissSamples: string[] = []
  for (const c of artCards) {
    collectUnknowns(unknownTiers, unknownSizes, c)
    if (!c.ArtKey) {
      artMisses++
      if (artMissSamples.length < 5) artMissSamples.push(c.Title)
    }
  }
  for (const m of monsters) collectUnknowns(unknownTiers, unknownSizes, m)

  if (skipped > 0) {
    const names = skippedNames.join(', ') + (skipped > 5 ? ` (+${skipped - 5} more)` : '')
    onProgress?.(`skipped ${skipped} bad entries: ${names}`)
  }
  if (unknownTiers.size > 0) onProgress?.(`unknown tiers seen (kept): ${[...unknownTiers].join(', ')}`)
  if (unknownSizes.size > 0) onProgress?.(`unknown sizes seen (kept): ${[...unknownSizes].join(', ')}`)
  if (events.length > 0) onProgress?.(`parsed ${events.length} event encounters`)
  if (artCards.length > 0 && artMisses / artCards.length > ART_MISS_RATIO_THRESHOLD) {
    const names = artMissSamples.join(', ') + (artMisses > artMissSamples.length ? ` (+${artMisses - artMissSamples.length} more)` : '')
    onProgress?.(`ALERT: art coverage low — ${artMisses}/${artCards.length} cards missing ArtKey: ${names}`)
  } else if (artMisses > 0) {
    onProgress?.(`${artMisses}/${artCards.length} cards missing art (below alert threshold)`)
  }

  return {
    cache: { items, skills, monsters, events, fetchedAt: new Date().toISOString() },
    stats: { unknownTiers: [...unknownTiers], unknownSizes: [...unknownSizes], skipped, total, artMisses, artMissSamples },
  }
}

function parseDump(dump: Record<string, DumpEntry>, onProgress?: (msg: string) => void): CardCache {
  return parseDumpWithStats(dump, onProgress).cache
}

type CooldownValue = number | Partial<Record<TierName, number>>

interface HowbazaarTier { tooltips?: string[] }
interface HowbazaarItem { name?: string; tiers?: Partial<Record<TierName, HowbazaarTier>> }

function extractCooldown(it: HowbazaarItem): CooldownValue | null {
  if (!it.tiers) return null
  const perTier: Partial<Record<TierName, number>> = {}
  for (const t of ['Bronze', 'Silver', 'Gold', 'Diamond', 'Legendary'] as TierName[]) {
    const tier = it.tiers[t]
    if (!tier?.tooltips) continue
    for (const tt of tier.tooltips) {
      const m = COOLDOWN_RE.exec(tt)
      if (m) { perTier[t] = parseFloat(m[1]); break }
    }
  }
  const vals = Object.values(perTier)
  if (!vals.length) return null
  const first = vals[0]
  return vals.every((v) => v === first) ? first : perTier
}

// read a response body with a hard byte ceiling, aborting past it — the only size
// guard that holds against chunked transfer-encoding / a missing or lying content-length.
async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      reader.cancel().catch(() => {})
      throw new Error(`response exceeded ${maxBytes} bytes mid-stream`)
    }
    chunks.push(value)
  }
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { buf.set(c, off); off += c.byteLength }
  return new TextDecoder().decode(buf)
}

async function fetchCooldowns(onProgress?: (msg: string) => void): Promise<Map<string, CooldownValue>> {
  const map = new Map<string, CooldownValue>()
  try {
    const res = await fetch(HOWBAZAAR_URL, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = JSON.parse(await readTextCapped(res, 50_000_000)) as { data?: HowbazaarItem[] }
    const list = body.data ?? []
    for (const it of list) {
      if (!it.name) continue
      const cd = extractCooldown(it)
      if (cd != null) map.set(it.name, cd)
    }
    onProgress?.(`fetched ${map.size} cooldowns from howbazaar`)
  } catch (e) {
    onProgress?.(`cooldown fetch failed (continuing without): ${e instanceof Error ? e.message : e}`)
  }
  return map
}

// onlyMissing=true skips items that already have a Cooldown (used for the carry-forward
// pass, so freshly-fetched cooldowns always win over stale ones).
function applyCooldowns(cache: CardCache, cooldowns: Map<string, CooldownValue>, onlyMissing = false): number {
  let matched = 0
  for (const item of cache.items) {
    if (onlyMissing && item.Cooldown != null) continue
    const cd = cooldowns.get(item.Title)
    if (cd != null) { item.Cooldown = cd; matched++ }
  }
  return matched
}

// repo-root cache/items.json — the same file the bot's store.ts loads. read directly here
// (rather than threaded through ScrapeOptions) so a cooldown-source outage can self-heal
// without every caller having to pass the previous cache through.
const PREV_CACHE_PATH = resolve(import.meta.dir, '../../../cache/items.json')

// pull Title -> Cooldown out of a previously-scraped cache, for carrying cooldowns forward
// when the live cooldown source is down or matched too few items. fail-soft: a missing
// file, bad JSON, or no cooldowns in the old cache just means nothing to carry forward.
async function loadPrevCooldowns(path: string = PREV_CACHE_PATH): Promise<Map<string, CooldownValue>> {
  const map = new Map<string, CooldownValue>()
  try {
    const cache = await Bun.file(path).json() as CardCache
    for (const item of cache.items ?? []) {
      if (item.Cooldown != null) map.set(item.Title, item.Cooldown)
    }
  } catch {}
  return map
}

// exported for testing
export { computeDisplayTags, toCard, toMonster, parseDump, parseDumpWithStats, fetchCooldowns, applyCooldowns, extractCooldown, loadPrevCooldowns }
export type { DumpEntry, ScrapeStats, ParseResult as ScrapeResult }

interface PrevCounts { items: number; skills: number; monsters: number }

interface ScrapeOptions {
  prev?: PrevCounts
  force?: boolean  // bypass ONLY the delta guard, not the floors/skip-ratio guards
}

// prev.items > 200 gates this off for a cold start / near-empty prior cache — a >30%
// swing on a small base is expected noise, not a bad dump
const DELTA_DROP_THRESHOLD = 0.3
const DELTA_MIN_PREV_ITEMS = 200

function checkDeltaGuard(cache: CardCache, prev: PrevCounts | undefined, force: boolean | undefined) {
  if (!prev || force || prev.items <= DELTA_MIN_PREV_ITEMS) return
  const categories: [string, number, number][] = [
    ['items', prev.items, cache.items.length],
    ['skills', prev.skills, cache.skills.length],
    ['monsters', prev.monsters, cache.monsters.length],
  ]
  for (const [name, prevCount, curCount] of categories) {
    if (prevCount <= 0) continue
    const drop = (prevCount - curCount) / prevCount
    if (drop > DELTA_DROP_THRESHOLD) {
      throw new Error(`bad dump: ${name} ${prevCount}→${curCount} (>30% drop vs previous cache)`)
    }
  }
}

// exported for testing
export { checkDeltaGuard }

export async function scrapeDump(onProgress?: (msg: string) => void, opts?: ScrapeOptions): Promise<ParseResult> {
  let lastErr: Error | undefined

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      onProgress?.(attempt > 0 ? `fetching dump.json (retry ${attempt}/${MAX_RETRIES - 1})...` : 'fetching dump.json...')
      const res = await fetch(DUMP_URL, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      // size cap enforced while STREAMING — content-length alone is bypassable (chunked
      // transfer or a lying header would let res.text() buffer unbounded).
      const contentLen = parseInt(res.headers.get('content-length') ?? '0')
      if (contentLen > 50_000_000) throw new Error(`response too large: ${contentLen} bytes`)
      const text = await readTextCapped(res, 50_000_000)
      let raw: unknown
      try { raw = JSON.parse(text) } catch { throw new Error('response body was not valid JSON') }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('unexpected dump.json shape (not an object)')
      }
      const dump = raw as Record<string, DumpEntry>
      const { cache, stats } = parseDumpWithStats(dump, onProgress)
      if (stats.total > 50 && stats.skipped / stats.total > SKIP_RATIO_THRESHOLD) {
        throw new Error(
          `bad dump: ${stats.skipped}/${stats.total} entries failed to parse (schema change?) — keeping old cache`
        )
      }
      checkDeltaGuard(cache, opts?.prev, opts?.force)
      const cooldowns = await fetchCooldowns(onProgress)
      // cooldown is the #1 stat for a weapon — refuse to ship a cache where enrichment
      // silently matched almost nothing (source drift / fetch failure). ~100 floor avoids
      // flapping on minor title drift; the per-item fail-soft in fetchCooldowns still applies.
      const cooldownsMatched = applyCooldowns(cache, cooldowns)
      if (cooldownsMatched < 100) {
        // enrichment source is down or has drifted hard — carry forward cooldowns from the
        // previous cache rather than aborting a perfectly good dump scrape (which would
        // otherwise re-download the full 50MB dump on retry for no reason). only a genuine
        // first run — no previous cache to carry from — still hard-fails here.
        const prevCooldowns = await loadPrevCooldowns()
        if (prevCooldowns.size === 0) {
          throw new Error(`cooldown enrichment matched only ${cooldownsMatched} items and no previous cache available to carry forward — refusing to ship a cooldown-less cache`)
        }
        const carried = applyCooldowns(cache, prevCooldowns, true)
        onProgress?.(`ALERT: cooldown enrichment low (${cooldownsMatched} matched) — carried forward ${carried} cooldowns from the previous cache`)
      }
      if (cache.items.length < 50) {
        throw new Error(`suspiciously few items (${cache.items.length}), refusing to use`)
      }
      if (cache.skills.length < 10) {
        throw new Error(`suspiciously few skills (${cache.skills.length}), refusing to use`)
      }
      if (cache.monsters.length < 5) {
        throw new Error(`suspiciously few monsters (${cache.monsters.length}), refusing to use`)
      }
      onProgress?.(`${cache.items.length} items, ${cache.skills.length} skills, ${cache.monsters.length} monsters`)
      return { cache, stats }
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e))
      onProgress?.(`fetch failed: ${lastErr.message}`)
      if (attempt < MAX_RETRIES - 1) {
        const delay = RETRY_DELAYS[attempt]
        onProgress?.(`retrying in ${delay / 1000}s...`)
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }

  throw new Error(`dump.json fetch failed after ${MAX_RETRIES} attempts: ${lastErr?.message}`)
}
