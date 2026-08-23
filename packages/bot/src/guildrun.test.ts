import { describe, expect, it, beforeEach } from 'bun:test'
import {
  cleanGrText, extractGuildrun, findGrCards, findGrListing, grContext,
  describeGrCard, isGrQuery, isGrIntent, isGuildrunCategory, grKeywordCard, __setGrCards,
  type GrCard,
} from './guildrun'

// The guildrun module exists because the model has NO safe memory of a 2026 game —
// every unguarded answer is an invention. These tests pin the two things that make the
// grounding honest: text cleaning never invents a number (holes become "?", args fill
// exactly), and matching never fires on ordinary chat words without question intent.

describe('cleanGrText', () => {
  it('a hole becomes "X" — an honest unknown, never an invented number', () => {
    expect(cleanGrText('lasts {0} seconds longer.')).toBe('lasts X seconds longer.')
  })

  it('strips [text]<tag> markup down to the visible text', () => {
    expect(cleanGrText("[Warrior's]<warrior> [Rush]<rush> abilities")).toBe("Warrior's Rush abilities")
  })

  it('renders a scaling term by its stats, coefficients honestly dropped', () => {
    expect(cleanGrText('inflict [{0}+{1}_AttackSpeed]<statcalc_burn> [Burn]<burn> (Max: {2}).'))
      .toBe('inflict X (scales with Attack Speed) Burn (Max: X).')
  })

  it('names every distinct scaling stat once', () => {
    expect(cleanGrText('deal [{0}+{1}_AttackSpeed+{2}_Attack+{3}_Magic]<statcalc_damage> damage'))
      .toBe('deal X (scales with Attack Speed, Attack, Magic) damage')
  })

  it('a statcalc with no stat refs is just an unknown amount', () => {
    expect(cleanGrText('gain [{0}]<statcalc_shield> shields')).toBe('gain X shields')
  })

  it('collapses newlines and whitespace', () => {
    expect(cleanGrText('line one\n\nline two')).toBe('line one line two')
  })

  it('returns undefined for non-strings and empty results', () => {
    expect(cleanGrText(undefined)).toBeUndefined()
    expect(cleanGrText('')).toBeUndefined()
  })
})

// --- extraction over a minimal but structurally faithful dump ---

const DUMPS = {
  heroes: [
    {
      id: 1, name: 'Irini', class1Id: 5, guildId: 1, passiveAbilityId: 10101,
      stats: { maxHealth: 650, baseAttackDamage: 31, attackSpeed: 20, defense: 29, crit: 15, maxMana: 75, manaRegen: 4, attackRange: 3 },
      balancing: { disabledInGame: false },
    },
    {
      id: 2, name: 'Tilly', class1Id: 1, class2Id: 5, guildId: 2,
      stats: { maxHealth: 750 }, balancing: { disabledInGame: false },
    },
    { id: 3, name: 'Ghost', class1Id: 1, balancing: { disabledInGame: true } },
  ],
  classes: [
    { id: 1, name: 'Warrior', description: '[Warriors]<warrior> use [Attack]<attack>.' },
    { id: 5, name: 'Duelist', description: 'Duelists use Attack Speed.' },
  ],
  guilds: [
    { id: 1, balancing: { title: 'Sporty' } },
    { id: 2, balancing: { title: "L'Héritage" } },
  ],
  relics: [
    { id: 504, name: "Warrior's Endurance Banner", rarity: 'Unique', description: '[Rush]<rush> lasts {0}s longer.', balancing: { disabledInGame: false } },
    { id: 1000, name: "Warrior's Medallion", rarity: 'Common', description: 'Warriors gain {0} Attack.', balancing: { disabledInGame: false, descriptionArgs: [25] } },
    { id: 9, name: 'Dead Relic', rarity: 'Common', balancing: { disabledInGame: true } },
  ],
  items: [
    { id: 101, name: 'Hammer', balancing: { disabledInGame: false, rarity: 'Common', statModifications: [{ TargetStat: 'Attack', Value: 25 }] } },
  ],
  passives: [
    { id: 10101, name: 'Limitless', targetHero: 'Irini', description: 'Gain [{0}]<x> [Attack Speed]<as> per auto.', balancing: { descriptionArgs: [1] } },
    { id: 10102, name: 'The Mighty', targetHero: 'Irini', description: 'Duelists gain speed.', balancing: {} },
    { id: 20201, name: 'Luxurious', targetHero: 'Tilly', description: 'Cross-scale Attack and Attack Speed.', balancing: {} },
  ],
  actives: [
    { id: 1, name: 'Gathering Storm', targetHero: 'Irini', description: 'Call lightning.', balancing: {} },
  ],
  specs: [
    { id: 101, name: 'The Electric' },
    { id: 102, name: 'The Mighty' },
    { id: 103, name: 'The Olympic' },
    { id: 201, name: 'The Stylish' },
  ],
  rankmods: [
    { id: 1, name: 'Burning Attacks', description: 'inflict [{0}+{1}_AttackSpeed]<statcalc_burn> [Burn]<burn>.', balancing: { disabledInGame: false, descriptionArgs: [0, 33] } },
  ],
}

const EXT = {
  Relic_504: { name: "Warrior's Endurance Banner", description: 'Rush lasts 3 seconds longer.' },
}

describe('extractGuildrun', () => {
  const cards = extractGuildrun(DUMPS as any, EXT)
  const by = (n: string) => cards.find((c) => c.n === n)!

  it('builds heroes with class, dual class, guild and stats', () => {
    expect(by('Irini').c).toBe('Duelist')
    expect(by('Irini').g).toBe('Sporty')
    expect(by('Irini').st).toContain('650 HP')
    expect(by('Irini').st).toContain('31 base hit')
    expect(by('Tilly').c).toBe('Warrior/Duelist')
  })

  it('resolves the linked base kit and keeps spec-named abilities out of it', () => {
    expect(by('Irini').x).toContain('Limitless')
    expect(by('Irini').x).not.toContain('The Mighty')
  })

  it('falls back to targetHero abilities when no kit is linked by id', () => {
    expect(by('Tilly').x).toContain('Luxurious')
  })

  it('attaches spec text from the same-named ability, bare name when none exists', () => {
    const sp = by('Irini').sp!
    expect(sp.some((s) => s.startsWith('The Mighty: Duelists gain speed.'))).toBe(true)
    expect(sp).toContain('The Electric')
  })

  it('prefers the ext db resolved relic text over the raw template', () => {
    expect(by("Warrior's Endurance Banner").x).toBe('Rush lasts 3 seconds longer.')
  })

  it('falls back to the qualitative template when the ext db lacks the relic', () => {
    expect(by("Warrior's Medallion").x).toBe('Warriors gain X Attack.')
  })

  it('renders item stat modifications with exact values', () => {
    expect(by('Hammer').x).toBe('+25 Attack')
    expect(by('Hammer').r).toBe('common')
  })

  it('drops disabled entries — a card the game turned off must not be quotable', () => {
    expect(by('Ghost' as any)).toBeUndefined()
    expect(cards.find((c) => c.n === 'Dead Relic')).toBeUndefined()
  })

  it('keeps classes and rank modifiers with cleaned text', () => {
    expect(by('Warrior').x).toBe('Warriors use Attack.')
    expect(by('Burning Attacks').x).toBe('inflict X (scales with Attack Speed) Burn.')
  })
})

// --- matching ---

describe('findGrCards / grContext', () => {
  beforeEach(() => __setGrCards(extractGuildrun(DUMPS as any, EXT)))

  it('matches a hero by bare name', () => {
    const hits = findGrCards('is irini good', true)
    expect(hits[0]?.n).toBe('Irini')
  })

  it('matches a multiword relic inside a sentence', () => {
    const hits = findGrCards("does warrior's endurance banner stack", true)
    expect(hits.some((c) => c.n === "Warrior's Endurance Banner")).toBe(true)
  })

  it('matches spacing-insensitive single tokens', () => {
    __setGrCards([{ n: 'Bubble Gum', k: 'relic' }])
    expect(findGrCards('bubblegum any good', true)[0]?.n).toBe('Bubble Gum')
  })

  it('an ambient-word name needs intent — "hammer" in passing is not an item question', () => {
    expect(findGrCards('lol hammer time', false)).toHaveLength(0)
    expect(findGrCards('what does hammer give', true).some((c) => c.n === 'Hammer')).toBe(true)
  })

  it('a hero outranks a relic sharing the name', () => {
    __setGrCards([
      { n: 'Nyx', k: 'relic' },
      { n: 'Nyx', k: 'hero' },
    ])
    expect(findGrCards('nyx stats', true)[0]?.k).toBe('hero')
  })

  it('grContext grounds on a hit', () => {
    const r = grContext('what does irini do', true)
    expect(r.grounded).toBe(true)
    expect(r.text).toContain('Irini')
    expect(r.text).toContain('never invent')
  })

  it('grContext warns instead of staying silent on an unresolved question', () => {
    const r = grContext('what does zorbo the unknowable do', true)
    expect(r.grounded).toBe(false)
    expect(r.text).toContain('Do NOT state')
  })

  it('grContext stays empty for a non-question — a greeting must not drag a warning in', () => {
    const r = grContext('hello everyone', false)
    expect(r.text).toBe('')
  })

  it('class listing returns only heroes of that class', () => {
    const l = findGrListing('what duelists are there')!
    expect(l.cards.map((c) => c.n).sort()).toEqual(['Irini', 'Tilly'])
  })

  it('hero listing lists the whole roster', () => {
    const l = findGrListing('list the heroes')!
    expect(l.cards).toHaveLength(2)
  })

  it('describeGrCard renders a hero as one dense grounded line', () => {
    const line = describeGrCard(findGrCards('irini', true)[0])
    expect(line).toContain('guildrun hero')
    expect(line).toContain('Duelist')
    expect(line).toContain('Specs:')
  })
})

// --- keyword glossary ---
// The dump has no keywords file — statuses exist only as markup tags — so mechanic
// questions ("how does burn work") matched nothing and either got the model's
// non-existent memory of a 2026 game, or the BAZAAR glossary's wrong-game rules.

describe('keyword glossary', () => {
  beforeEach(() => __setGrCards(extractGuildrun(DUMPS as any, EXT)))

  it('a mechanic question hits the curated keyword, not thin air', () => {
    const hit = findGrCards('how does burn work', true)[0]
    expect(hit?.k).toBe('keyword')
    expect(hit?.x).toContain('1 damage per stack every second')
  })

  it('a bare mention of a keyword word never fires — "burn baby burn" is not a question', () => {
    expect(findGrCards('burn baby burn', false)).toHaveLength(0)
  })

  it('aliases resolve — "the storm" answers as Storm, "spec" as Specialization', () => {
    expect(findGrCards('what is the storm', true)[0]?.n).toBe('The Storm')
    expect(grKeywordCard('whats a spec')?.n).toBe('Specialization')
  })

  it('the keyword rule outranks a relic sharing the name — the mechanic IS the answer', () => {
    __setGrCards([{ n: 'Burn', k: 'relic' }])
    expect(findGrCards('what does burn do', true)[0]?.k).toBe('keyword')
  })

  it('keywords answer even before the first dump fetch succeeds', () => {
    __setGrCards([])
    const r = grContext('how does rush work', true)
    expect(r.grounded).toBe(true)
    expect(r.text).toContain('first N seconds')
  })

  it('grKeywordCard is the collision probe — keyword or nothing', () => {
    expect(grKeywordCard('what is crit')?.n).toBe('Crit')
    expect(grKeywordCard('hello everyone')).toBeUndefined()
  })

  it('describeGrCard renders a keyword as a mechanic line', () => {
    expect(describeGrCard(grKeywordCard('how does poison work')!)).toStartWith('Poison — guildrun mechanic:')
  })

  it('inactive-in-demo mechanics say so instead of inventing rules', () => {
    expect(grKeywordCard('does bleed exist')?.x).toContain('NOT active')
  })
})

describe('routing', () => {
  it('isGrQuery needs the game named', () => {
    expect(isGrQuery('is irini good in guildrun')).toBe(true)
    expect(isGrQuery('guild run tier list')).toBe(true)
    expect(isGrQuery('is irini good')).toBe(false)
  })

  it('isGuildrunCategory matches the twitch category', () => {
    expect(isGuildrunCategory('Guildrun')).toBe(true)
    expect(isGuildrunCategory('Guild Run')).toBe(true)
    expect(isGuildrunCategory('Hearthstone')).toBe(false)
    expect(isGuildrunCategory(undefined)).toBe(false)
  })

  it('isGrIntent separates questions from moods', () => {
    expect(isGrIntent('what does irini do')).toBe(true)
    expect(isGrIntent('irini pog')).toBe(false)
  })
})
