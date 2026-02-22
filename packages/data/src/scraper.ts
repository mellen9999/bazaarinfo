import type { BazaarCard, Monster, CardCache, DumpTooltip, DumpEnchantment, ReplacementValue, TierName, ItemSize, MonsterBoardEntry } from '@bazaarinfo/shared'

const DUMP_URL = 'https://bazaardb.gg/dump.json'
const USER_AGENT = 'BazaarInfo/1.0 (Twitch bot; github.com/mellen9999/bazaarinfo)'

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
  return {
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

function parseDump(dump: Record<string, DumpEntry>, onProgress?: (msg: string) => void): CardCache {
  const entries = Object.values(dump)
  const items: BazaarCard[] = []
  const skills: BazaarCard[] = []
  const monsters: Monster[] = []
  let skipped = 0
  const skippedNames: string[] = []

  for (const entry of entries) {
    try {
      switch (entry.Type) {
        case 'Item':
          items.push(toCard(entry))
          break
        case 'Skill':
          skills.push(toCard(entry))
          break
        case 'CombatEncounter': {
          const m = toMonster(entry)
          if (m) monsters.push(m)
          break
        }
        default:
          skipped++
          if (skipped <= 5) skippedNames.push(entry.Title ?? '(no title)')
          break
      }
    } catch (e) {
      skipped++
      if (skipped <= 5) skippedNames.push(entry.Title ?? '(no title)')
    }
  }

  if (skipped > 0) {
    const names = skippedNames.join(', ') + (skipped > 5 ? ` (+${skipped - 5} more)` : '')
    onProgress?.(`skipped ${skipped} bad entries: ${names}`)
  }

  return { items, skills, monsters, fetchedAt: new Date().toISOString() }
}

// exported for testing
export { computeDisplayTags, toCard, toMonster, parseDump }
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
      const cache = parseDump(dump, onProgress)
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
