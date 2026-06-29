import type { BazaarCard, Monster, CardCache, DumpTooltip, DumpEnchantment, ReplacementValue, TierName, ItemSize, MonsterBoardEntry } from '@bazaarinfo/shared'

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

function validTier(t: string): TierName {
  if (!VALID_TIERS.has(t)) throw new Error(`unknown tier: ${t}`)
  return t as TierName
}

function validSize(s: string): ItemSize {
  if (!VALID_SIZES.has(s)) throw new Error(`unknown size: ${s}`)
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

interface ParseResult {
  cache: CardCache
  skipped: number  // hard failures (throw or unknown Type)
  total: number    // all entries seen (excludes CombatEncounters without MonsterMetadata — those are expected)
}

function parseDumpWithStats(dump: Record<string, DumpEntry>, onProgress?: (msg: string) => void): ParseResult {
  const items: BazaarCard[] = []
  const skills: BazaarCard[] = []
  const monsters: Monster[] = []
  const events: BazaarCard[] = []
  let skipped = 0
  let total = 0
  const skippedNames: string[] = []

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
          // event-only cards: same structure as items but kept separate to avoid polluting item search
          // Type field at runtime will be 'EventEncounter'; BazaarCard.Type union needs | 'EventEncounter' once integrator updates shared/src/types.ts
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

  if (skipped > 0) {
    const names = skippedNames.join(', ') + (skipped > 5 ? ` (+${skipped - 5} more)` : '')
    onProgress?.(`skipped ${skipped} bad entries: ${names}`)
  }
  if (events.length > 0) onProgress?.(`parsed ${events.length} event encounters`)

  // events is carried as a bonus field on the cache object; integrator must add
  // events?: BazaarCard[] to CardCache in packages/shared/src/types.ts to access it typed
  return {
    cache: { items, skills, monsters, events, fetchedAt: new Date().toISOString() } as CardCache,
    skipped,
    total,
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

async function fetchCooldowns(onProgress?: (msg: string) => void): Promise<Map<string, CooldownValue>> {
  const map = new Map<string, CooldownValue>()
  try {
    const res = await fetch(HOWBAZAAR_URL, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await res.json() as { data?: HowbazaarItem[] }
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

function applyCooldowns(cache: CardCache, cooldowns: Map<string, CooldownValue>): number {
  let matched = 0
  for (const item of cache.items) {
    const cd = cooldowns.get(item.Title)
    if (cd != null) { item.Cooldown = cd; matched++ }
  }
  return matched
}

// exported for testing
export { computeDisplayTags, toCard, toMonster, parseDump, fetchCooldowns, applyCooldowns, extractCooldown }
export type { DumpEntry }

export async function scrapeDump(onProgress?: (msg: string) => void): Promise<CardCache> {
  let lastErr: Error | undefined

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      onProgress?.(attempt > 0 ? `fetching dump.json (retry ${attempt}/${MAX_RETRIES - 1})...` : 'fetching dump.json...')
      const res = await fetch(DUMP_URL, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const contentLen = parseInt(res.headers.get('content-length') ?? '0')
      if (contentLen > 50_000_000) throw new Error(`response too large: ${contentLen} bytes`)

      const text = await res.text()
      let raw: unknown
      try { raw = JSON.parse(text) } catch { throw new Error('response body was not valid JSON') }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('unexpected dump.json shape (not an object)')
      }
      const dump = raw as Record<string, DumpEntry>
      const { cache, skipped, total } = parseDumpWithStats(dump, onProgress)
      if (total > 50 && skipped / total > SKIP_RATIO_THRESHOLD) {
        throw new Error(
          `bad dump: ${skipped}/${total} entries failed to parse (schema change?) — keeping old cache`
        )
      }
      const cooldowns = await fetchCooldowns(onProgress)
      // cooldown is the #1 stat for a weapon — refuse to ship a cache where enrichment
      // silently matched almost nothing (source drift / fetch failure). ~100 floor avoids
      // flapping on minor title drift; the per-item fail-soft in fetchCooldowns still applies.
      const cooldownsMatched = applyCooldowns(cache, cooldowns)
      if (cooldownsMatched < 100) {
        throw new Error(`cooldown enrichment matched only ${cooldownsMatched} items — refusing to ship a cooldown-less cache`)
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
      return cache
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
