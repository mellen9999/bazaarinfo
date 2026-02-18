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
  return entry.Tags.filter((t) =>
    !entry.HiddenTags.includes(t)
    && t !== entry.Type
    && t !== entry.Size
    && !entry.Heroes.includes(t),
  )
}

function toCard(entry: DumpEntry): BazaarCard {
  return {
    Type: entry.Type as 'Item' | 'Skill',
    Title: entry.Title,
    Size: entry.Size as BazaarCard['Size'],
    BaseTier: entry.BaseTier as TierName,
    Tiers: entry.Tiers as TierName[],
    Heroes: entry.Heroes,
    Tags: entry.Tags,
    HiddenTags: entry.HiddenTags,
    DisplayTags: computeDisplayTags(entry),
    Tooltips: entry.Tooltips ?? [],
    TooltipReplacements: entry.TooltipReplacements ?? {},
    Enchantments: entry.Enchantments ?? {},
    Shortlink: entry.Shortlink,
  }
}

function toMonster(entry: DumpEntry): Monster {
  return {
    Type: 'CombatEncounter',
    Title: entry.Title,
    Size: entry.Size as Monster['Size'],
    Tags: entry.Tags,
    DisplayTags: computeDisplayTags(entry),
    HiddenTags: entry.HiddenTags,
    Heroes: entry.Heroes,
    MonsterMetadata: entry.MonsterMetadata!,
    Shortlink: entry.Shortlink,
  }
}

export async function scrapeDump(onProgress?: (msg: string) => void): Promise<CardCache> {
  onProgress?.('fetching dump.json...')
  const res = await fetch(DUMP_URL, {
    headers: { 'User-Agent': USER_AGENT },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching dump.json`)

  const dump: Record<string, DumpEntry> = await res.json()
  const entries = Object.values(dump)
  onProgress?.(`parsed ${entries.length} entries`)

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
      case 'CombatEncounter':
        monsters.push(toMonster(entry))
        break
      // EventEncounter ignored
    }
  }

  onProgress?.(`${items.length} items, ${skills.length} skills, ${monsters.length} monsters`)

  return {
    items,
    skills,
    monsters,
    fetchedAt: new Date().toISOString(),
  }
}
