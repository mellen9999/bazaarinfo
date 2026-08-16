import { test, expect, describe } from 'bun:test'
import {
  extractBgCards, findHsCards, findHsListing, hsCardContext, describeHsCard,
  isHsCardQuery, isHearthstoneCategory, __setHsCards, type HsCard,
} from './hs-cards'

// shapes lifted from the live HearthstoneJSON dump so the filter is exercised against
// the real field names, including the ones that decide what gets dropped.
const DUMP = [
  {
    dbfId: 96786, id: 'BG_LOE_077', name: 'Brann Bronzebeard', type: 'MINION', set: 'BATTLEGROUNDS',
    attack: 2, health: 4, techLevel: 5, elite: true, isBattlegroundsPoolMinion: true,
    text: 'Your <b>Battlecries</b> trigger twice.',
  },
  {
    dbfId: 111, id: 'BG26_001', name: 'Bubble Gum', type: 'MINION', set: 'BATTLEGROUNDS',
    attack: 3, health: 3, techLevel: 2, races: ['MECHANICAL'], isBattlegroundsPoolMinion: true,
    text: '[x]<b>Deathrattle:</b> Give\nallies +1/+1.',
  },
  {
    dbfId: 112, id: 'BG26_002', name: 'Tidal Surger', type: 'MINION', set: 'BATTLEGROUNDS',
    attack: 5, health: 5, techLevel: 5, races: ['NAGA'], isBattlegroundsPoolMinion: true, text: 'Windfury.',
  },
  // rotated out: no pool flag, so it must not appear in any listing
  {
    dbfId: 113, id: 'BG23_009', name: 'Ancient Relic', type: 'MINION', set: 'BATTLEGROUNDS',
    attack: 9, health: 9, techLevel: 5, races: ['NAGA'], text: 'Old news.',
  },
  {
    dbfId: 109230, id: 'BG28_168', name: 'Shiny Ring', type: 'BATTLEGROUND_SPELL', set: 'BATTLEGROUNDS',
    techLevel: 3, isBattlegroundsPoolSpell: true, text: 'Give your minions +1/+1.',
  },
  { dbfId: 80229, id: 'BG20_HERO_100p', name: 'Glory of Combat', type: 'HERO_POWER', cost: 0, text: 'Give it +1 Attack.' },
  { dbfId: 77876, id: 'BG20_100t', name: 'Icesnarl the Mighty', type: 'MINION' },
  {
    dbfId: 70838, id: 'BG20_HERO_100', name: 'Rokara', type: 'HERO', set: 'BATTLEGROUNDS',
    armor: 18, battlegroundsHero: true, heroPowerDbfId: 80229, battlegroundsBuddyDbfId: 77876,
  },
  // same trinket name in two seasons — newest patch prefix wins
  {
    dbfId: 200, id: 'BG30_MagicItem_301', name: 'Eternal Portrait', type: 'BATTLEGROUND_TRINKET',
    set: 'BATTLEGROUNDS', spellSchool: 'LESSER_TRINKET', battlegroundsAssociatedRaces: ['UNDEAD'],
    text: 'Old wording.',
  },
  {
    dbfId: 201, id: 'BG36_MagicItem_301', name: 'Eternal Portrait', type: 'BATTLEGROUND_TRINKET',
    set: 'BATTLEGROUNDS', spellSchool: 'LESSER_TRINKET', battlegroundsAssociatedRaces: ['UNDEAD'],
    text: 'Get an Eternal Knight.',
  },
  // buddy pair — only the non-golden copy survives
  { dbfId: 300, id: 'BG22_b1', name: 'Sunbaked Buddy', type: 'MINION', isBattlegroundsBuddy: true, attack: 4, health: 4, techLevel: 3, text: 'Buddy up.' },
  { dbfId: 301, id: 'BG22_b1_G', name: 'Sunbaked Buddy', type: 'MINION', isBattlegroundsBuddy: true, battlegroundsNormalDbfId: 300, attack: 8, health: 8, text: 'Buddy up.' },
  { dbfId: 400, id: 'BG27_Anomaly_000', name: 'Money Match', type: 'BATTLEGROUND_ANOMALY', set: 'BATTLEGROUNDS', text: 'Start at 10 Gold.' },
  { dbfId: 401, id: 'BG24_Reward_1', name: 'Ceaseless Surge', type: 'BATTLEGROUND_QUEST_REWARD', set: 'BATTLEGROUNDS', text: 'A reward.' },
  { dbfId: 402, id: 'BG31_Gift_1', name: 'Toxicity', type: 'MINION', isBattlegroundsDarkGift: true, text: 'Poisonous.' },
  // not battlegrounds at all
  { dbfId: 500, id: 'CORE_001', name: 'Fireball', type: 'SPELL', set: 'CORE', text: 'Deal 6 damage.' },
]

const CARDS = extractBgCards(DUMP)

describe('extractBgCards — reduces the dump to real battlegrounds cards', () => {
  test('keeps every battlegrounds kind and drops the rest', () => {
    const kinds = CARDS.reduce<Record<string, number>>((a, c) => ({ ...a, [c.k]: (a[c.k] ?? 0) + 1 }), {})
    expect(kinds).toEqual({ minion: 3, spell: 1, hero: 1, trinket: 1, buddy: 1, anomaly: 1, reward: 1, gift: 1 })
    expect(CARDS.some((c) => c.n === 'Fireball')).toBe(false)
  })

  test('a pool minion carries its tier, stats, tribe and cleaned text', () => {
    const gum = CARDS.find((c) => c.n === 'Bubble Gum')!
    expect(gum).toMatchObject({ k: 'minion', t: 2, a: 3, h: 3, r: 'Mech', p: 1 })
    expect(gum.x).toBe('Deathrattle: Give allies +1/+1.')
  })

  test('only minions, tavern spells and heroes are flagged as in the pool', () => {
    expect(CARDS.find((c) => c.n === 'Brann Bronzebeard')!.p).toBe(1)
    expect(CARDS.find((c) => c.n === 'Shiny Ring')!.p).toBe(1)
    expect(CARDS.find((c) => c.n === 'Rokara')!.p).toBe(1)
    // no rotation signal exists for these — so none is asserted
    for (const n of ['Eternal Portrait', 'Sunbaked Buddy', 'Money Match', 'Ceaseless Surge', 'Toxicity']) {
      expect(CARDS.find((c) => c.n === n)!.p).toBeUndefined()
    }
    expect(CARDS.find((c) => c.n === 'Ancient Relic')).toBeUndefined()
  })

  test('a hero resolves its hero power and buddy by dbfId', () => {
    expect(CARDS.find((c) => c.n === 'Rokara')).toMatchObject({
      k: 'hero', ar: 18, bd: 'Icesnarl the Mighty',
      x: 'Glory of Combat (0 gold): Give it +1 Attack.',
    })
  })

  test('a reprinted trinket keeps the newest season\'s text', () => {
    expect(CARDS.find((c) => c.k === 'trinket')!.x).toBe('Get an Eternal Knight.')
  })

  test('the golden copy of a buddy is dropped, not merged', () => {
    const buddies = CARDS.filter((c) => c.k === 'buddy')
    expect(buddies).toHaveLength(1)
    expect(buddies[0]).toMatchObject({ a: 4, h: 4 })
  })

  test('a reshaped dump degrades to nothing rather than throwing', () => {
    expect(extractBgCards([])).toEqual([])
    expect(extractBgCards(null as unknown as unknown[])).toEqual([])
    expect(extractBgCards([{ nonsense: true }, null, 'x'] as unknown[])).toEqual([])
  })
})

describe('isHsCardQuery — routes a hearthstone question', () => {
  test('matches the asks that are actually about hearthstone', () => {
    for (const q of [
      'what does brann do in bgs',
      'is tidal surger good battlegrounds',
      'hearthstone tier 6 minions',
      "whats the best hero power in bob's tavern",
      'how do triples work in bg',
    ]) expect(isHsCardQuery(q)).toBe(true)
  })

  test('leaves bazaar questions alone', () => {
    for (const q of [
      'what does bubble gum do',
      'best vanessa build',
      'is dooley busted this patch',
      'whats the weather in vancouver',
    ]) expect(isHsCardQuery(q)).toBe(false)
  })
})

test('isHearthstoneCategory reads the live twitch category', () => {
  expect(isHearthstoneCategory('Hearthstone')).toBe(true)
  expect(isHearthstoneCategory('hearthstone')).toBe(true)
  expect(isHearthstoneCategory('The Bazaar')).toBe(false)
  expect(isHearthstoneCategory(null)).toBe(false)
  expect(isHearthstoneCategory(undefined)).toBe(false)
})

describe('findHsCards — resolving a name out of a chat message', () => {
  __setHsCards(CARDS)

  test('matches a full name inside a sentence', () => {
    expect(findHsCards('is brann bronzebeard still tier 5 in bgs').map((c) => c.n)).toEqual(['Brann Bronzebeard'])
  })

  test('matches a name with the spaces taken out', () => {
    expect(findHsCards('bubblegum bgs').map((c) => c.n)).toEqual(['Bubble Gum'])
  })

  test('matches a distinctive one-word nickname', () => {
    expect(findHsCards('is brann worth it').map((c) => c.n)).toEqual(['Brann Bronzebeard'])
    expect(findHsCards('rokara any good').map((c) => c.n)).toEqual(['Rokara'])
  })

  test('an ordinary english word is never a card', () => {
    for (const q of ['what is the best minion', 'whats that ring worth', 'gold is the whole game', 'tell me about the hero power']) {
      expect(findHsCards(q)).toEqual([])
    }
  })

  test('only heroes and legendaries answer to a one-word nickname', () => {
    // "Tidal Surger" is an ordinary pool minion — a bare "surger" is not a nickname for it
    expect(findHsCards('is surger any good')).toEqual([])
    expect(findHsCards('is tidal surger any good').map((c) => c.n)).toEqual(['Tidal Surger'])
    // and the reason the rule exists: an ordinary phrase used as a card name
    __setHsCards([...CARDS, { n: 'Broken Horn', k: 'buddy', t: 6, a: 4, h: 4, x: 'Sell it.' }])
    expect(findHsCards('are undead broken in bg')).toEqual([])
    __setHsCards(CARDS)
  })

  test('a rotated-out card still resolves by name, it just carries no pool flag', () => {
    __setHsCards([...CARDS, { n: 'Ancient Relic', k: 'minion', t: 5, a: 9, h: 9, r: 'Naga', x: 'Old news.' }])
    const hit = findHsCards('what did ancient relic do')
    expect(hit.map((c) => c.n)).toEqual(['Ancient Relic'])
    expect(hit[0].p).toBeUndefined()
    __setHsCards(CARDS)
  })

  test('a pool card outranks a rotated one with the same name', () => {
    __setHsCards([
      { n: 'Twin Card', k: 'buddy', x: 'old' },
      { n: 'Twin Card', k: 'minion', t: 4, p: 1, x: 'new' },
    ])
    expect(findHsCards('twin card bgs')[0].k).toBe('minion')
    __setHsCards(CARDS)
  })

  test('an empty index never matches', () => {
    __setHsCards([])
    expect(findHsCards('brann bronzebeard')).toEqual([])
    __setHsCards(CARDS)
  })
})

describe('findHsListing — tier and tribe questions', () => {
  __setHsCards(CARDS)

  test('lists the current pool for a tier', () => {
    const l = findHsListing('whats on tier 5 in bgs')!
    expect(l.tier).toBe(5)
    expect(l.cards.map((c) => c.n).sort()).toEqual(['Brann Bronzebeard', 'Tidal Surger'])
  })

  test('lists a tribe', () => {
    expect(findHsListing('any good nagas right now')!.cards.map((c) => c.n)).toEqual(['Tidal Surger'])
  })

  test('never lists a card that is not flagged in the current pool', () => {
    __setHsCards([...CARDS, { n: 'Ancient Relic', k: 'minion', t: 5, r: 'Naga', x: 'Old news.' }])
    expect(findHsListing('tier 5 naga')!.cards.map((c) => c.n)).toEqual(['Tidal Surger'])
    __setHsCards(CARDS)
  })

  test('returns nothing when the question names neither', () => {
    expect(findHsListing('is the meta stale')).toBeNull()
  })
})

describe('hsCardContext — the grounding block', () => {
  __setHsCards(CARDS)

  test('a matched card is grounded and states the real text', () => {
    const { text, grounded } = hsCardContext('what does brann bronzebeard do in bgs', true)
    expect(grounded).toBe(true)
    expect(text).toContain('Brann Bronzebeard — BG minion, tier 5, 2/4, legendary: Your Battlecries trigger twice. [in the current pool]')
    expect(text).toContain('not Bazaar cards')
  })

  test('a card with no rotation flag never claims one', () => {
    const { text } = hsCardContext('eternal portrait bgs', true)
    const line = text.split('\n').find((l) => l.startsWith('Eternal Portrait'))!
    expect(line).toBe('Eternal Portrait — BG trinket, lesser trinket, Undead: Get an Eternal Knight.')
    expect(line).not.toContain('[in the current pool]')
    expect(text).toContain('never claim whether they are offered right now')
  })

  test('a miss on a card-shaped ask blocks answering from memory, and is NOT grounded', () => {
    const { text, grounded } = hsCardContext('what does murozond do in bgs', true)
    expect(grounded).toBe(false)
    expect(text).toContain('Do NOT state any specific BG card')
  })

  test('a miss on a non-card ask stays silent', () => {
    expect(hsCardContext('bgs is so rigged lately', false)).toEqual({ text: '', grounded: false })
  })

  test('with no card data loaded it injects nothing at all', () => {
    __setHsCards([])
    expect(hsCardContext('what does brann do in bgs', true)).toEqual({ text: '', grounded: false })
    __setHsCards(CARDS)
  })
})

test('describeHsCard renders a hero as its hero power', () => {
  expect(describeHsCard(CARDS.find((c) => c.n === 'Rokara') as HsCard))
    .toBe('Rokara — BG hero, 18 starting armor, buddy: Icesnarl the Mighty: Glory of Combat (0 gold): Give it +1 Attack. [in the current pool]')
})
