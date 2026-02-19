import type { BazaarCard, Monster, CardCache, DumpTooltip, DumpEnchantment, ReplacementValue, TierName, MonsterBoardEntry } from '@bazaarinfo/shared'

const DUMP_URL = 'https://bazaardb.gg/dump.json'
const USER_AGENT = 'BazaarInfo/1.0 (Twitch bot; github.com/mellen9999/bazaarinfo)'

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

function toCard(entry: DumpEntry): BazaarCard {
  return {
    Type: entry.Type as 'Item' | 'Skill',
    Title: entry.Title,
    Size: entry.Size as BazaarCard['Size'],
    BaseTier: entry.BaseTier as TierName,
    Tiers: entry.Tiers as TierName[],
    Heroes: entry.Heroes ?? [],
    Tags: entry.Tags ?? [],
    HiddenTags: entry.HiddenTags ?? [],
    DisplayTags: computeDisplayTags(entry),
    Tooltips: entry.Tooltips ?? [],
    TooltipReplacements: entry.TooltipReplacements ?? {},
    Enchantments: entry.Enchantments ?? {},
    Shortlink: entry.Shortlink,
  }
}

function toMonster(entry: DumpEntry): Monster | null {
  if (!entry.MonsterMetadata) return null
  return {
    Type: 'CombatEncounter',
    Title: entry.Title,
    Size: entry.Size as Monster['Size'],
    Tags: entry.Tags ?? [],
    DisplayTags: computeDisplayTags(entry),
    HiddenTags: entry.HiddenTags ?? [],
    Heroes: entry.Heroes ?? [],
    MonsterMetadata: entry.MonsterMetadata,
    Shortlink: entry.Shortlink,
  }
}

const MAX_RETRIES = 3
const RETRY_DELAYS = [1000, 2000, 4000]

function parseDump(dump: Record<string, DumpEntry>): CardCache {
  const entries = Object.values(dump)
  const items: BazaarCard[] = []
  const skills: BazaarCard[] = []
  const monsters: Monster[] = []

  for (const entry of entries) {
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
    }
  }

  return { items, skills, monsters, fetchedAt: new Date().toISOString() }
}

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

      const raw = await res.json()
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('unexpected dump.json shape (not an object)')
      }
      const dump = raw as Record<string, DumpEntry>
      const cache = parseDump(dump)
      if (cache.items.length < 50) {
        throw new Error(`suspiciously few items (${cache.items.length}), refusing to use`)
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
