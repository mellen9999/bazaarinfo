import { test, expect, describe, beforeEach } from 'bun:test'
import {
  isHsBoardQuery, isHsLobbyQuery, describeMinion, describeHero, describeHeroShort,
  getHsBoardLine, __setHsBoardCacheForTest,
} from './hs-board'
import { __setHsCards } from './hs-cards'
import type { HsState } from '@bazaarinfo/shared'

// the ids and names below are the real ones the parser pulled out of a real game log
const IDS: Record<string, string> = {
  BGS_071: 'Deflect-o-Bot',
  BGS_049: 'Freedealing Gambler',
  BG23_HERO_305_SKIN_B: 'Sparkhoarder Togwaggle',
  TB_BaconShop_HERO_62: 'Maiev Shadowsong',
  TB_BaconShop_HERO_34: 'Patchwerk',
  BG28_403: 'Phaerix, Wrath of the Sun',
}

const STATE: HsState = {
  turn: 7,
  phase: 'shop',
  board: [
    { id: 'BGS_071', pos: 1, atk: 3, hp: 2, tier: 3, kw: ['divine shield'] },
    { id: 'BGS_049', pos: 2, atk: 3, hp: 3, tier: 2 },
  ],
  hero: { id: 'BG23_HERO_305_SKIN_B', hp: 30, armor: 9, tier: 3, place: 2 },
  lobby: [
    { id: 'TB_BaconShop_HERO_62', hp: 30, armor: 12, tier: 2, place: 1 },
    { id: 'TB_BaconShop_HERO_34', hp: 0, place: 8 },
  ],
}

beforeEach(() => {
  __setHsCards([], IDS)
  __setHsBoardCacheForTest('nl_kripp', { hs: STATE, ageMs: 2_000 })
})

describe('isHsBoardQuery', () => {
  test('catches the way chat asks about a live battlegrounds game', () => {
    for (const q of [
      "what's his board", 'whats his comp', 'what tier is he', 'how much health does he have',
      'who is he fighting', 'what place is he in', 'how many are left in the lobby',
      'what is he running',
    ]) expect(isHsBoardQuery(q)).toBe(true)
  })

  test('ignores questions that are not about the live game', () => {
    for (const q of ['what does brann do', 'when is the next stream', 'tell me a joke']) {
      expect(isHsBoardQuery(q)).toBe(false)
    }
  })
})

describe('describeMinion / describeHero', () => {
  test('names a minion with its real stats and keywords', () => {
    expect(describeMinion({ id: 'BGS_071', pos: 1, atk: 3, hp: 2, kw: ['divine shield'] }))
      .toBe('Deflect-o-Bot 3/2 (divine shield)')
  })

  test('marks a golden copy', () => {
    expect(describeMinion({ id: 'BGS_049', pos: 1, atk: 6, hp: 6, golden: true }))
      .toBe('golden Freedealing Gambler 6/6')
  })

  test('a card id this patch no longer has is dropped, never printed raw', () => {
    expect(describeMinion({ id: 'BG29_843', pos: 1, atk: 1, hp: 1 })).toBeNull()
    expect(describeHero({ id: 'BG29_843', hp: 30 })).toBeNull()
  })

  test('a hero reads as name, effective health, tier and place', () => {
    expect(describeHero(STATE.hero!)).toBe('Sparkhoarder Togwaggle (30+9 armor, tavern tier 3, 2nd)')
  })
})

describe('getHsBoardLine', () => {
  test('states the board, the hero and the turn', () => {
    const line = getHsBoardLine('nl_kripp')
    expect(line).toContain('Live Battlegrounds board for nl_kripp')
    expect(line).toContain('playing Sparkhoarder Togwaggle (30+9 armor, tavern tier 3, 2nd)')
    expect(line).toContain('turn 7')
    expect(line).toContain('board: Deflect-o-Bot 3/2 (divine shield), Freedealing Gambler 3/3')
  })

  test('says plainly there is no opponent while in the shop', () => {
    const line = getHsBoardLine('nl_kripp')
    expect(line).toContain('In the shop right now, not in a fight — no current opponent')
    expect(line).not.toContain('Fighting')
  })

  test('names the opponent only during a combat', () => {
    __setHsBoardCacheForTest('nl_kripp', {
      hs: {
        ...STATE,
        phase: 'combat',
        opponent: {
          hero: { id: 'TB_BaconShop_HERO_62', hp: 24, armor: 3, place: 1 },
          board: [{ id: 'BG28_403', pos: 1, atk: 5, hp: 5 }],
        },
      },
      ageMs: 1_000,
    })
    const line = getHsBoardLine('nl_kripp')
    expect(line).toContain('Fighting Maiev Shadowsong (24+3 armor, 1st) with Phaerix, Wrath of the Sun 5/5')
    expect(line).not.toContain('no current opponent')
  })

  test('reports the lobby only when someone asked about it', () => {
    expect(getHsBoardLine('nl_kripp', "what's on his board")).not.toContain('Rest of the lobby')
    const line = getHsBoardLine('nl_kripp', "what place is he in")
    expect(line).toContain('Rest of the lobby: 1st Maiev Shadowsong 30+12 t2')
    expect(line).toContain('1 already out')
    expect(line).not.toContain('Patchwerk')  // dead players are counted, not listed
  })

  test('isHsLobbyQuery separates a lobby ask from a board ask', () => {
    expect(isHsLobbyQuery('how many are left')).toBe(true)
    expect(isHsLobbyQuery('what place is he in')).toBe(true)
    expect(isHsLobbyQuery("what's on his board")).toBe(false)
  })

  test('describeHeroShort is the compact form the lobby uses', () => {
    expect(describeHeroShort({ id: 'TB_BaconShop_HERO_62', hp: 30, armor: 12, tier: 2, place: 1 }))
      .toBe('1st Maiev Shadowsong 30+12 t2')
  })

  test('always states what it can and cannot see', () => {
    const line = getHsBoardLine('nl_kripp')
    expect(line).toContain('read from the game log and are real')
    expect(line).toContain('You do NOT see the shop or their hand')
  })

  test('ambient framing tells the model not to force it in', () => {
    expect(getHsBoardLine('nl_kripp', '', true)).toContain('never force it into an unrelated answer')
  })

  test('a stale frame is silence, not a stale board', () => {
    __setHsBoardCacheForTest('nl_kripp', { hs: STATE, ageMs: 20 * 60_000 })
    expect(getHsBoardLine('nl_kripp')).toBe('')
  })

  test('no companion, no line', () => {
    __setHsBoardCacheForTest('nl_kripp', null)
    expect(getHsBoardLine('nl_kripp')).toBe('')
  })

  test('a board of only unresolvable ids says nothing rather than something empty', () => {
    __setHsCards([], {})
    expect(getHsBoardLine('nl_kripp')).toBe('')
  })

  test('an empty board is reported as empty, not as missing', () => {
    __setHsBoardCacheForTest('nl_kripp', { hs: { ...STATE, board: [] }, ageMs: 1_000 })
    expect(getHsBoardLine('nl_kripp')).toContain('board: empty')
  })
})
