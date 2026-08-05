import type { BazaarCard, CardCache, Monster } from '@bazaarinfo/shared'

// diffs two CardCache snapshots (before/after a data refresh) to surface what
// content the patch added — for a chat announcement, and for a "needs a human"
// alert naming the hand-maintained files that now drifted from the data.

export interface ContentDiff {
  newHeroes: string[]
  removedHeroes: string[]
  newEnchants: string[]
  newDisplayTags: string[]
  newHiddenTags: string[]
  newTiers: string[]
  newSizes: string[]
  itemDelta: number
  skillDelta: number
  monsterDelta: number
  newItemCount: number
  newItemsMissingArt: string[]
  missingArtCount: number
}

const FAKE_HEROES = new Set(['Common'])
const MAX_MISSING_ART_NAMES = 5

function heroSet(cache: CardCache): Set<string> {
  const set = new Set<string>()
  for (const list of [cache.items, cache.skills, cache.monsters] as const) {
    for (const c of list ?? []) {
      for (const h of c.Heroes) if (!FAKE_HEROES.has(h)) set.add(h)
    }
  }
  return set
}

function enchantSet(cache: CardCache): Set<string> {
  const set = new Set<string>()
  for (const list of [cache.items, cache.skills] as const) {
    for (const c of list ?? []) {
      if (!c.Enchantments) continue
      for (const key of Object.keys(c.Enchantments)) set.add(key)
    }
  }
  return set
}

function displayTagSet(cache: CardCache): Set<string> {
  const set = new Set<string>()
  for (const c of cache.items ?? []) {
    for (const t of c.DisplayTags) set.add(t)
  }
  return set
}

function hiddenTagSet(cache: CardCache): Set<string> {
  const set = new Set<string>()
  for (const c of cache.items ?? []) {
    for (const t of c.HiddenTags) {
      if (t.endsWith('Reference')) continue
      set.add(t)
    }
  }
  return set
}

function tierSet(cache: CardCache): Set<string> {
  const set = new Set<string>()
  for (const list of [cache.items, cache.skills] as const) {
    for (const c of list ?? []) {
      set.add(c.BaseTier)
      for (const t of c.Tiers) set.add(t)
    }
  }
  return set
}

function sizeSet(cache: CardCache): Set<string> {
  const set = new Set<string>()
  for (const c of cache.items ?? []) set.add(c.Size)
  for (const c of cache.skills ?? []) set.add(c.Size)
  for (const m of cache.monsters ?? []) set.add(m.Size)
  return set
}

function added(prev: Set<string>, next: Set<string>): string[] {
  return [...next].filter((x) => !prev.has(x)).sort()
}

function removed(prev: Set<string>, next: Set<string>): string[] {
  return [...prev].filter((x) => !next.has(x)).sort()
}

function hasArt(card: BazaarCard): boolean {
  return !!card.ArtKey
}

export function diffContent(prev: CardCache, next: CardCache): ContentDiff | null {
  const newHeroes = added(heroSet(prev), heroSet(next))
  const removedHeroes = removed(heroSet(prev), heroSet(next))
  const newEnchants = added(enchantSet(prev), enchantSet(next))
  const newDisplayTags = added(displayTagSet(prev), displayTagSet(next))
  const newHiddenTags = added(hiddenTagSet(prev), hiddenTagSet(next))
  const newTiers = added(tierSet(prev), tierSet(next))
  const newSizes = added(sizeSet(prev), sizeSet(next))

  const itemDelta = (next.items?.length ?? 0) - (prev.items?.length ?? 0)
  const skillDelta = (next.skills?.length ?? 0) - (prev.skills?.length ?? 0)
  const monsterDelta = (next.monsters?.length ?? 0) - (prev.monsters?.length ?? 0)

  const prevItemTitles = new Set((prev.items ?? []).map((i) => i.Title))
  const newItems = (next.items ?? []).filter((i) => !prevItemTitles.has(i.Title))
  const itemsMissingArt = newItems.filter((i) => !hasArt(i))

  const nothingChanged = newHeroes.length === 0
    && removedHeroes.length === 0
    && newEnchants.length === 0
    && newDisplayTags.length === 0
    && newHiddenTags.length === 0
    && newTiers.length === 0
    && newSizes.length === 0
    && itemDelta === 0
    && skillDelta === 0
    && monsterDelta === 0

  if (nothingChanged) return null

  return {
    newHeroes,
    removedHeroes,
    newEnchants,
    newDisplayTags,
    newHiddenTags,
    newTiers,
    newSizes,
    itemDelta,
    skillDelta,
    monsterDelta,
    newItemCount: newItems.length,
    newItemsMissingArt: itemsMissingArt.slice(0, MAX_MISSING_ART_NAMES).map((i) => i.Title),
    missingArtCount: itemsMissingArt.length,
  }
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`
}

const CHAT_MAX = 400

export function renderDiffChat(d: ContentDiff): string {
  const counts: string[] = []
  if (d.itemDelta) counts.push(`${signed(d.itemDelta)} items`)
  if (d.skillDelta) counts.push(`${signed(d.skillDelta)} skills`)
  if (d.monsterDelta) counts.push(`${signed(d.monsterDelta)} monsters`)

  const chunks: string[] = []
  if (counts.length) chunks.push(counts.join(', '))
  if (d.newHeroes.length) chunks.push(`new hero${d.newHeroes.length > 1 ? 'es' : ''}: ${d.newHeroes.join(', ')}`)
  if (d.removedHeroes.length) chunks.push(`removed hero${d.removedHeroes.length > 1 ? 'es' : ''}: ${d.removedHeroes.join(', ')}`)
  if (d.newEnchants.length) chunks.push(`new enchant${d.newEnchants.length > 1 ? 's' : ''}: ${d.newEnchants.join(', ')}`)
  if (d.newTiers.length) chunks.push(`new tier${d.newTiers.length > 1 ? 's' : ''}: ${d.newTiers.join(', ')}`)
  if (d.newSizes.length) chunks.push(`new size${d.newSizes.length > 1 ? 's' : ''}: ${d.newSizes.join(', ')}`)
  if (d.newDisplayTags.length) chunks.push(`new tag${d.newDisplayTags.length > 1 ? 's' : ''}: ${d.newDisplayTags.join(', ')}`)
  if (d.newHiddenTags.length) chunks.push(`new mechanic${d.newHiddenTags.length > 1 ? 's' : ''}: ${d.newHiddenTags.join(', ')}`)

  const line = chunks.length ? `patch absorbed: ${chunks.join(' | ')}` : 'patch absorbed: updated'
  return line.length > CHAT_MAX ? `${line.slice(0, CHAT_MAX - 1)}…` : line
}

export function renderDiffAlert(d: ContentDiff): { title: string, body: string } | null {
  const lines: string[] = []

  if (d.newHeroes.length) {
    lines.push(`new hero${d.newHeroes.length > 1 ? 'es' : ''} (${d.newHeroes.join(', ')}): add KNOWLEDGE line in ai-query.ts + HERO_ALIASES in store.ts`)
  }
  if (d.newHeroes.length || d.newItemCount > 0) {
    lines.push('patch content moved: the official notes are parsed automatically (patch-notes.ts) — check the "patch absorbed" alert for names it could not resolve')
  }
  if (d.newEnchants.length) {
    lines.push(`new enchant${d.newEnchants.length > 1 ? 's' : ''} (${d.newEnchants.join(', ')}): auto-derived def live — curate prose in enchants.ts`)
  }
  if (d.newTiers.length || d.newSizes.length) {
    const items = [...d.newTiers, ...d.newSizes]
    lines.push(`new tier/size (${items.join(', ')}): add to TIER_EMOJI/format + scraper VALID sets`)
  }
  if (d.newHiddenTags.length) {
    lines.push(`new hidden tag${d.newHiddenTags.length > 1 ? 's' : ''} (${d.newHiddenTags.join(', ')}): possible new mechanic — consider glossary.ts entry`)
  }
  if (d.missingArtCount > 0) {
    lines.push(`${d.missingArtCount} item${d.missingArtCount > 1 ? 's' : ''} missing art: run scripts/scrape-images.ts`)
  }

  if (!lines.length) return null
  return { title: 'bazaarinfo: new content needs a manual touch', body: lines.join('\n') }
}
