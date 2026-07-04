import { describe, expect, it, mock } from 'bun:test'
import type { BazaarCard, Monster } from '@bazaarinfo/shared'

// --- fixture store: a tiny slice of real-shaped game data ---
function makeCard(overrides: Partial<BazaarCard> = {}): BazaarCard {
  return {
    Type: 'Item',
    Title: 'Fiery Pan',
    Size: 'Medium',
    BaseTier: 'Bronze',
    Tiers: ['Bronze', 'Silver', 'Gold', 'Diamond'],
    Tooltips: [{ text: 'Deal {DamageAmount} Damage', type: 'Active' }],
    TooltipReplacements: { '{DamageAmount}': { Fixed: 30 } },
    DisplayTags: ['Weapon'],
    HiddenTags: [],
    Tags: [],
    Heroes: ['Jules'],
    Enchantments: {
      Fiery: { tags: ['Burn'], tooltips: [{ text: 'Burn {BurnAmount}', type: 'Active' }], tooltipReplacements: { '{BurnAmount}': { Fixed: 5 } } },
    },
    Shortlink: 'https://bzdb.to/x',
    ...overrides,
  }
}

const julesCards = [
  makeCard(),
  makeCard({ Title: 'Spatula', DisplayTags: ['Tool'] }),
  makeCard({ Title: 'Grill', Type: 'Skill', DisplayTags: [] }),
]

const crab: Monster = {
  Type: 'CombatEncounter',
  Title: 'Coconut Crab',
  Size: 'Large',
  Tags: [],
  DisplayTags: [],
  HiddenTags: [],
  Heroes: [],
  MonsterMetadata: {
    available: 'yes',
    day: 3,
    health: 400,
    board: [{ title: 'Big Claw', tier: 'Silver', id: 'c1' }],
    skills: [{ title: 'Shell Up', tier: 'Silver', id: 's1' }],
  },
  Shortlink: 'https://bzdb.to/crab',
}

const HEROES = ['Jules', 'Pygmalien', 'Vanessa', 'Dooley']
const HERO_ALIASES: Record<string, string> = { jewels: 'Jules', pyg: 'Pygmalien' }
const TAGS = ['Weapon', 'Burn', 'Tool', 'Food']
const boomerang = makeCard({ Title: 'Boomerang', Heroes: ['Pygmalien'] })

mock.module('./store', () => ({
  exact: (name: string) => {
    const lower = name.toLowerCase()
    return [boomerang, ...julesCards].find((c) => c.Title.toLowerCase() === lower)
  },
  findCard: (name: string) => [boomerang, ...julesCards, makeCard({ Title: 'Big Claw' })].find((c) => c.Title.toLowerCase() === name.toLowerCase()),
  findExactHero: (q: string) => {
    const lower = q.toLowerCase()
    return HEROES.find((h) => h.toLowerCase() === lower) ?? HERO_ALIASES[lower]
  },
  findTagName: (q: string) => TAGS.find((t) => t.toLowerCase() === q.toLowerCase()),
  byHero: (hero: string) => (hero === 'Jules' ? julesCards : []),
  byTag: (tag: string) => (tag === 'Weapon' ? [makeCard(), boomerang] : []),
  getItems: () => [boomerang, ...julesCards.filter((c) => c.Type === 'Item')],
  getMonsters: () => [crab],
  getHeroNames: () => HEROES,
}))

const { detectGameTopic, buildGameDossier } = await import('./trivia-game-topic')

describe('detectGameTopic — conservative game-content routing', () => {
  it('routes "<hero> items" to the hero', () => {
    expect(detectGameTopic('jules items')).toEqual({ kind: 'hero', name: 'Jules', tag: undefined })
    expect(detectGameTopic('Jules Items')).toEqual({ kind: 'hero', name: 'Jules', tag: undefined })
  })

  it('routes a bare hero name and a hero alias', () => {
    expect(detectGameTopic('jules')).toEqual({ kind: 'hero', name: 'Jules', tag: undefined })
    expect(detectGameTopic('jewels items')).toEqual({ kind: 'hero', name: 'Jules', tag: undefined })
    expect(detectGameTopic('pyg')).toEqual({ kind: 'hero', name: 'Pygmalien', tag: undefined })
  })

  it('captures a tag focus next to the hero ("jules weapons")', () => {
    expect(detectGameTopic('jules weapons')).toEqual({ kind: 'hero', name: 'Jules', tag: 'Weapon' })
    expect(detectGameTopic('dooley burn items')).toEqual({ kind: 'hero', name: 'Dooley', tag: 'Burn' })
  })

  it('does NOT hijack a world topic that merely contains a hero word', () => {
    expect(detectGameTopic('jules verne')).toBeNull()
    expect(detectGameTopic('jules verne novels')).toBeNull()
  })

  it('leaves plain world topics alone', () => {
    expect(detectGameTopic('napoleon')).toBeNull()
    expect(detectGameTopic('roman history')).toBeNull()
    expect(detectGameTopic('deep sea creatures')).toBeNull()
    expect(detectGameTopic('weapons')).toBeNull() // bare tag word stays a world topic
    expect(detectGameTopic('crab')).toBeNull() // not an exact monster title
  })

  it('matches an exact item title and an exact monster title', () => {
    expect(detectGameTopic('boomerang')).toEqual({ kind: 'item', name: 'Boomerang' })
    expect(detectGameTopic('the boomerang')).toEqual({ kind: 'item', name: 'Boomerang' })
    expect(detectGameTopic('coconut crab')).toEqual({ kind: 'monster', name: 'Coconut Crab' })
  })

  it('an explicit bazaar marker always routes to game data', () => {
    expect(detectGameTopic('the bazaar')).toEqual({ kind: 'general', name: '' })
    expect(detectGameTopic('bazaar monsters')).toEqual({ kind: 'monsters', name: '' })
    expect(detectGameTopic('bazaar weapons')).toEqual({ kind: 'tag', name: 'Weapon' })
  })

  it('handles empty/garbage input', () => {
    expect(detectGameTopic('')).toBeNull()
    expect(detectGameTopic('???')).toBeNull()
  })
})

describe('buildGameDossier — compact current-patch data block', () => {
  it('hero dossier lists titles and resolved base-tier details', () => {
    const d = buildGameDossier({ kind: 'hero', name: 'Jules' })!
    expect(d).toContain('HERO: Jules')
    expect(d).toContain('Fiery Pan')
    expect(d).toContain('Spatula')
    expect(d).toContain('Grill') // skills included
    expect(d).toContain('Deal 30 Damage') // placeholder resolved
    expect(d.length).toBeLessThanOrEqual(3200)
  })

  it('hero dossier honors a tag focus', () => {
    const d = buildGameDossier({ kind: 'hero', name: 'Jules', tag: 'Weapon' })!
    expect(d).toContain('Fiery Pan')
    expect(d).not.toContain('Spatula') // Tool, filtered out
  })

  it('item dossier carries tiers, heroes, and enchantments', () => {
    const d = buildGameDossier({ kind: 'item', name: 'Boomerang' })!
    expect(d).toContain('CARD: Boomerang')
    expect(d).toContain('Pygmalien')
    expect(d).toContain('Fiery')
    expect(d).toContain('Burn 5')
  })

  it('monster dossier carries day, HP, and board details', () => {
    const d = buildGameDossier({ kind: 'monster', name: 'Coconut Crab' })!
    expect(d).toContain('day 3')
    expect(d).toContain('400 HP')
    expect(d).toContain('Big Claw')
    expect(d).toContain('Shell Up')
  })

  it('returns null when the cache has nothing for the topic', () => {
    expect(buildGameDossier({ kind: 'hero', name: 'Vanessa' })).toBeNull() // no cards in fixture
    expect(buildGameDossier({ kind: 'tag', name: 'Food' })).toBeNull()
  })
})
