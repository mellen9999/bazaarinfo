import { describe, expect, it, beforeAll, afterAll, mock } from 'bun:test'
import { unlinkSync } from 'fs'
import { resolve } from 'path'
import { tmpdir } from 'os'
import type { BazaarCard } from '@bazaarinfo/shared'

const mockFindCard = mock<(name: string) => BazaarCard | undefined>(() => undefined)
mock.module('../store', () => ({
  findCard: mockFindCard,
  monstersByDay: () => [],
  getItems: () => [],
  getMonsters: () => [],
}))

import {
  matchBuiltin, getClassDef, syntheticDef, buildClassDef,
  maxHpFor, maxSpellSlotsFor, charAC, spellHintFor, joinActionFor,
  levelUpBonusFor, CHASSIS_LIST,
} from './classdef'
import type { Chassis } from './classdef'
import {
  boonMods, rollBoonOffer, applyBoonOnPick, offerSeed, getBoon, boonLabels, BOONS,
} from './boons'
import {
  multikillBanner, titleFor, renderLegends, renderGraveyard, renderBoonOffer, renderBossCard,
} from './render'
import { pickEvent, resolveEvent, EVENTS } from './events'
import {
  calcMaxHp, calcMaxSpellSlots, getCharAC, CLASS_BASE_STATS,
} from './types'
import type { Character } from './types'

// --- DB harness ---
let dbPath: string
beforeAll(async () => {
  dbPath = resolve(tmpdir(), `.dnd-legendary-test-${Date.now()}.db`)
  const mainDb = await import('../db'); mainDb.initDb(dbPath)
  const dndDb = await import('./db'); dndDb.initDndDb()
})
afterAll(async () => {
  const mainDb = await import('../db'); try { mainDb.closeDb() } catch {}
  for (const s of ['', '-wal', '-shm']) { try { unlinkSync(dbPath + s) } catch {} }
})

// --- helper ---
function makeChar(overrides: Partial<Character> = {}): Character {
  return {
    username: 'tester',
    channel: 'testchan',
    class: 'Fighter',
    level: 1,
    xp: 0,
    hp: 14,
    maxHp: 14,
    gold: 10,
    inventory: [],
    stats: { ...CLASS_BASE_STATS['Fighter'] },
    spellSlots: 0,
    maxSpellSlots: 0,
    hitDice: 1,
    maxHitDice: 1,
    kiPoints: 0,
    maxKiPoints: 0,
    rageCharges: 0,
    rageTurnsLeft: 0,
    actionSurgeUsed: false,
    isDying: false,
    deathSuccesses: 0,
    deathFailures: 0,
    statusEffects: [],
    deaths: 0,
    totalKills: 0,
    defending: false,
    lastActionAt: 0,
    respawnAt: null,
    prestige: 0,
    achievements: [],
    boons: [],
    pendingBoon: [],
    killStreak: 0,
    deathsSeason: 0,
    ...overrides,
  }
}

// --- classdef.ts ---
describe('matchBuiltin', () => {
  it('exact name → builtin def', () => {
    const def = matchBuiltin('Barbarian')
    expect(def).not.toBeNull()
    expect(def!.name).toBe('Barbarian')
    expect(def!.builtin).toBe(true)
  })

  it('case-insensitive exact', () => {
    expect(matchBuiltin('barbarian')).not.toBeNull()
    expect(matchBuiltin('BARBARIAN')).not.toBeNull()
  })

  it('"barb" prefix → Barbarian', () => {
    const def = matchBuiltin('barb')
    expect(def).not.toBeNull()
    expect(def!.name).toBe('Barbarian')
  })

  it('"wiz" prefix → Wizard', () => {
    const def = matchBuiltin('wiz')
    expect(def).not.toBeNull()
    expect(def!.name).toBe('Wizard')
  })

  it('multiword nonsense → null', () => {
    expect(matchBuiltin('kripps juicy butthole')).toBeNull()
  })

  it('"xyz" → null', () => {
    expect(matchBuiltin('xyz')).toBeNull()
  })
})

describe('getClassDef', () => {
  it('builtin name → builtin=true', () => {
    const def = getClassDef('Wizard')
    expect(def.builtin).toBe(true)
    expect(def.name).toBe('Wizard')
  })

  it('unknown name → synthetic (builtin=false), never null', () => {
    const def = getClassDef('kripps juicy butthole')
    expect(def).not.toBeNull()
    expect(def.builtin).toBe(false)
  })
})

describe('syntheticDef', () => {
  const VALID_CHASSIS = new Set(CHASSIS_LIST)
  const HIT_DICE = [6, 8, 10, 12]
  const WEAPON_DICE = [4, 6, 8, 10, 12]
  const STATS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const

  it('chassis is one of 9 valid values', () => {
    const def = syntheticDef('kripps juicy butthole')
    expect(VALID_CHASSIS.has(def.chassis)).toBe(true)
  })

  it('baseStats each 8..17 and sum ≤ 79', () => {
    const def = syntheticDef('kripps juicy butthole')
    for (const k of STATS) {
      expect(def.baseStats[k]).toBeGreaterThanOrEqual(8)
      expect(def.baseStats[k]).toBeLessThanOrEqual(17)
    }
    const sum = STATS.reduce((s, k) => s + def.baseStats[k], 0)
    expect(sum).toBeLessThanOrEqual(79)
  })

  it('hitDie in [6,8,10,12]', () => {
    expect(HIT_DICE).toContain(syntheticDef('buttjuice tornado').hitDie)
  })

  it('weapon.die in [4,6,8,10,12]', () => {
    expect(WEAPON_DICE).toContain(syntheticDef('buttjuice tornado').weapon.die)
  })

  it('weapon.count 1 or 2', () => {
    const c = syntheticDef('buttjuice tornado').weapon.count
    expect(c === 1 || c === 2).toBe(true)
  })

  it('signature ≤ 24 chars and no "undefined"', () => {
    const def = syntheticDef('kripps juicy butthole')
    expect(def.signature.length).toBeLessThanOrEqual(24)
    expect(def.signature).not.toContain('undefined')
  })

  it('signature derives from a word in the name', () => {
    const def = syntheticDef('buttjuice tornado')
    const sig = def.signature.toLowerCase()
    const hasWord = sig.includes('buttjuice') || sig.includes('tornado')
    expect(hasWord).toBe(true)
  })

  it('deterministic: same name (different case/spacing) → same chassis + signature + baseStats', () => {
    const a = syntheticDef('kripps juicy butthole')
    const b = syntheticDef('KRIPPS  juicy butthole')
    expect(a.chassis).toBe(b.chassis)
    expect(a.signature).toBe(b.signature)
    for (const k of STATS) {
      expect(a.baseStats[k]).toBe(b.baseStats[k])
    }
  })
})

describe('buildClassDef', () => {
  const VALID_CHASSIS = new Set(CHASSIS_LIST)
  const HIT_DICE = [6, 8, 10, 12]
  const WEAPON_DICE = [4, 6, 8, 10, 12]
  const STATS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const

  it('garbage input → all fields clamped to valid ranges', () => {
    const def = buildClassDef('weirdclass', {
      chassis: 'bad',
      baseStats: { str: 99, dex: 99, con: 99, int: 99, wis: 99, cha: 99 },
      hitDie: 9999,
      atkStat: 'luck',
      weapon: { name: 'x'.repeat(200), die: 1000, count: 9 },
      acArchetype: 'god',
      signature: 'y'.repeat(99),
      role: '', desc: '',
    })
    expect(VALID_CHASSIS.has(def.chassis)).toBe(true)
    for (const k of STATS) {
      expect(def.baseStats[k]).toBeGreaterThanOrEqual(8)
      expect(def.baseStats[k]).toBeLessThanOrEqual(17)
    }
    const sum = STATS.reduce((s, k) => s + def.baseStats[k], 0)
    expect(sum).toBeLessThanOrEqual(79)
    expect(HIT_DICE).toContain(def.hitDie)
    expect(WEAPON_DICE).toContain(def.weapon.die)
    const c = def.weapon.count
    expect(c === 1 || c === 2).toBe(true)
    expect(def.signature.length).toBeLessThanOrEqual(24)
    expect(def.weapon.name.length).toBeLessThanOrEqual(24)
  })

  it('valid input passthrough', () => {
    const def = buildClassDef('glutemancer', {
      chassis: 'nuke',
      baseStats: { str: 8, dex: 14, con: 13, int: 16, wis: 12, cha: 10 },
      hitDie: 6,
      atkStat: 'int',
      weapon: { name: 'Glute Cannon', die: 10, count: 1 },
      acArchetype: 'mage',
      signature: 'Cheek Clap',
      role: 'r', desc: 'd',
    })
    expect(def.chassis).toBe('nuke')
    expect(def.signature).toBe('Cheek Clap')
    expect(def.weapon.name).toBe('Glute Cannon')
  })
})

describe('maxHpFor / maxSpellSlotsFor parity with types.ts legacy', () => {
  const cases: [string, number, number][] = [
    ['Barbarian', 1, 15],
    ['Barbarian', 5, 15],
    ['Barbarian', 10, 15],
    ['Wizard', 1, 12],
    ['Wizard', 5, 12],
    ['Wizard', 10, 17],
    ['Warlock', 1, 14],
    ['Warlock', 5, 14],
    ['Warlock', 10, 16],
  ]

  for (const [cls, level, conScore] of cases) {
    it(`maxHpFor ${cls} lv${level} con${conScore} matches calcMaxHp`, () => {
      const def = getClassDef(cls)
      expect(maxHpFor(def, level, conScore)).toBe(calcMaxHp(cls, level, conScore))
    })

    it(`maxSpellSlotsFor ${cls} lv${level} matches calcMaxSpellSlots`, () => {
      const def = getClassDef(cls)
      expect(maxSpellSlotsFor(def, level)).toBe(calcMaxSpellSlots(cls, level))
    })
  }
})

describe('charAC parity with types.ts getCharAC', () => {
  it('Paladin → 18 (plate)', () => {
    const def = getClassDef('Paladin')
    const stats = CLASS_BASE_STATS['Paladin']
    expect(charAC({ class: 'Paladin', stats })).toBe(getCharAC('Paladin', stats))
  })

  it('Fighter (mail) matches legacy', () => {
    const stats = CLASS_BASE_STATS['Fighter']
    expect(charAC({ class: 'Fighter', stats })).toBe(getCharAC('Fighter', stats))
  })

  it('Barbarian (unarmored) matches legacy', () => {
    const stats = CLASS_BASE_STATS['Barbarian']
    expect(charAC({ class: 'Barbarian', stats })).toBe(getCharAC('Barbarian', stats))
  })
})

// map each builtin name to its chassis
const BUILTIN_BY_CHASSIS: Record<Chassis, string> = {
  rage: 'Barbarian', surge: 'Fighter', smite: 'Paladin', sneak: 'Rogue',
  nuke: 'Wizard', heal: 'Cleric', chaos: 'Sorcerer', flurry: 'Monk', curse: 'Warlock',
}

describe('spellHintFor / joinActionFor / levelUpBonusFor — all 9 chassis', () => {
  for (const chassis of CHASSIS_LIST) {
    const clsName = BUILTIN_BY_CHASSIS[chassis]
    it(`spellHintFor ${chassis} returns non-empty`, () => {
      const def = getClassDef(clsName)
      expect(spellHintFor(def).length).toBeGreaterThan(0)
    })

    it(`joinActionFor ${chassis} returns non-empty`, () => {
      const def = getClassDef(clsName)
      expect(joinActionFor(def).length).toBeGreaterThan(0)
    })

    it(`levelUpBonusFor ${chassis} lv2 returns non-empty`, () => {
      expect(levelUpBonusFor(chassis, 2).length).toBeGreaterThan(0)
    })
  }
})

// --- boons.ts ---
describe('boonMods', () => {
  it('empty boons → defaults', () => {
    const mods = boonMods(makeChar({ boons: [] }))
    expect(mods.dmgMult).toBe(1)
    expect(mods.critThreshold).toBe(20)
    expect(mods.toHit).toBe(0)
    expect(mods.acBonus).toBe(0)
    expect(mods.lifestealPct).toBe(0)
    expect(mods.rerollMiss).toBe(false)
  })

  it('berserker → dmgMult 1.2', () => {
    expect(boonMods(makeChar({ boons: ['berserker'] })).dmgMult).toBeCloseTo(1.2)
  })

  it('berserker x2 stacks → 1.4', () => {
    expect(boonMods(makeChar({ boons: ['berserker', 'berserker'] })).dmgMult).toBeCloseTo(1.4)
  })

  it('deadeye → critThreshold 19', () => {
    expect(boonMods(makeChar({ boons: ['deadeye'] })).critThreshold).toBe(19)
  })

  it('ironhide + bulwark → acBonus 5', () => {
    expect(boonMods(makeChar({ boons: ['ironhide', 'bulwark'] })).acBonus).toBe(5)
  })

  it('lucky → rerollMiss true', () => {
    expect(boonMods(makeChar({ boons: ['lucky'] })).rerollMiss).toBe(true)
  })

  it('vampiric → lifestealPct 0.25', () => {
    expect(boonMods(makeChar({ boons: ['vampiric'] })).lifestealPct).toBeCloseTo(0.25)
  })
})

describe('rollBoonOffer', () => {
  it('returns ≤3 distinct ids, none in char.boons', () => {
    const char = makeChar({ boons: [] })
    const offer = rollBoonOffer(char, 42)
    expect(offer.length).toBeLessThanOrEqual(3)
    const set = new Set(offer)
    expect(set.size).toBe(offer.length) // distinct
    for (const id of offer) {
      expect(char.boons).not.toContain(id)
    }
  })

  it('deterministic for same (boons, seed)', () => {
    const char = makeChar({ boons: [] })
    expect(rollBoonOffer(char, 99)).toEqual(rollBoonOffer(char, 99))
  })

  it('different seed → potentially different result', () => {
    const char = makeChar({ boons: [] })
    const a = rollBoonOffer(char, 1)
    const b = rollBoonOffer(char, 999999)
    // they could theoretically be equal but in practice shouldn't be
    // just assert both are valid offers
    expect(a.length).toBeGreaterThanOrEqual(1)
    expect(b.length).toBeGreaterThanOrEqual(1)
  })

  it('if only 2 boons remain, returns exactly those 2', () => {
    const allIds = BOONS.map((b) => b.id)
    const ownAll = allIds.slice(0, allIds.length - 2)
    const char = makeChar({ boons: ownAll })
    const offer = rollBoonOffer(char, 1)
    const remaining = allIds.filter((id) => !ownAll.includes(id))
    expect(offer.length).toBe(remaining.length)
    expect(new Set(offer)).toEqual(new Set(remaining))
  })
})

describe('applyBoonOnPick', () => {
  it('titan → maxHp+30, hp+30', () => {
    const char = makeChar({ hp: 50, maxHp: 50 })
    applyBoonOnPick(char, 'titan')
    expect(char.maxHp).toBe(80)
    expect(char.hp).toBe(80)
  })

  it('glasscannon → maxHp reduced ~25%', () => {
    const char = makeChar({ hp: 100, maxHp: 100 })
    applyBoonOnPick(char, 'glasscannon')
    expect(char.maxHp).toBe(75)
    expect(char.hp).toBeLessThanOrEqual(75)
  })

  it('battery on char with spellSlots → +2 max & current', () => {
    const char = makeChar({ spellSlots: 2, maxSpellSlots: 2 })
    applyBoonOnPick(char, 'battery')
    expect(char.maxSpellSlots).toBe(4)
    expect(char.spellSlots).toBe(4)
  })
})

describe('offerSeed', () => {
  it('deterministic', () => {
    expect(offerSeed('kripp', 3)).toBe(offerSeed('kripp', 3))
  })

  it('differs for different level', () => {
    expect(offerSeed('kripp', 2)).not.toBe(offerSeed('kripp', 3))
  })
})

describe('getBoon / boonLabels', () => {
  it('known id → object with name/desc', () => {
    const b = getBoon('berserker')
    expect(b).toBeDefined()
    expect(b!.name).toBeTruthy()
    expect(b!.desc).toBeTruthy()
  })

  it('unknown id → undefined', () => {
    expect(getBoon('nonexistent_boon')).toBeUndefined()
  })

  it('boonLabels → comma-joined names', () => {
    const char = makeChar({ boons: ['berserker', 'deadeye'] })
    const labels = boonLabels(char)
    expect(labels).toContain('Berserker')
    expect(labels).toContain('Deadeye')
  })
})

// --- db.ts (legend functions) ---
describe('recordBest', () => {
  it('first call returns true', async () => {
    const { recordBest } = await import('./db')
    const ch = 'test-legends-1'
    expect(recordBest(ch, 'deepest_floor', 5, 'kripp', 'details')).toBe(true)
  })

  it('lower value → false, record unchanged', async () => {
    const { recordBest, getRecords } = await import('./db')
    const ch = 'test-legends-2'
    recordBest(ch, 'deepest_floor', 10, 'kripp', '')
    expect(recordBest(ch, 'deepest_floor', 3, 'impostor', '')).toBe(false)
    const recs = getRecords(ch)
    const rec = recs.find((r) => r.rkey === 'deepest_floor')
    expect(rec!.holder).toBe('kripp')
    expect(rec!.value).toBe(10)
  })

  it('higher value → true, record updated', async () => {
    const { recordBest, getRecords } = await import('./db')
    const ch = 'test-legends-3'
    recordBest(ch, 'biggest_crit', 50, 'first', '')
    expect(recordBest(ch, 'biggest_crit', 999, 'beast', 'nat20')).toBe(true)
    const recs = getRecords(ch)
    const rec = recs.find((r) => r.rkey === 'biggest_crit')
    expect(rec!.holder).toBe('beast')
    expect(rec!.value).toBe(999)
  })
})

describe('recordFirst', () => {
  it('first call → true', async () => {
    const { recordFirst } = await import('./db')
    const ch = 'test-first-1'
    expect(recordFirst(ch, 'firstkill_dragon', 'kripp', '')).toBe(true)
  })

  it('second call → false, holder unchanged', async () => {
    const { recordFirst, getRecords } = await import('./db')
    const ch = 'test-first-2'
    recordFirst(ch, 'firstkill_golem', 'early', '')
    expect(recordFirst(ch, 'firstkill_golem', 'late', '')).toBe(false)
    const recs = getRecords(ch)
    const rec = recs.find((r) => r.rkey === 'firstkill_golem')
    expect(rec!.holder).toBe('early')
  })
})

describe('addGrave / getGraves', () => {
  it('returns most-recent-first, respects limit, fields correct', async () => {
    const { addGrave, getGraves } = await import('./db')
    const ch = 'test-graves-1'
    addGrave(ch, 'first_dead', 'Barbarian', 3, 5, 'Dragon', 1)
    addGrave(ch, 'second_dead', 'Wizard', 7, 12, 'Lich', 1)
    const graves = getGraves(ch, 10)
    expect(graves.length).toBe(2)
    // most recent first
    expect(graves[0].username).toBe('second_dead')
    expect(graves[1].username).toBe('first_dead')
    // field checks
    expect(graves[0].class).toBe('Wizard')
    expect(graves[0].level).toBe(7)
    expect(graves[0].floor).toBe(12)
    expect(graves[0].killer).toBe('Lich')
  })

  it('respects limit', async () => {
    const { addGrave, getGraves } = await import('./db')
    const ch = 'test-graves-limit'
    for (let i = 0; i < 5; i++) addGrave(ch, `dead${i}`, 'Fighter', 1, i, 'enemy', 1)
    expect(getGraves(ch, 3).length).toBe(3)
  })
})

describe('killCharacter → creates gravestone', () => {
  it('gravestone has right killer/class/level/floor', async () => {
    const { upsertCharacter, upsertWorld, killCharacter, getGraves } = await import('./db')
    const ch = 'test-kill-grave'
    const char = makeChar({
      username: 'doomed', channel: ch, class: 'Rogue', level: 4, hp: 10, maxHp: 10,
    })
    upsertCharacter(char)
    upsertWorld({
      channel: ch, floor: 7, actionSequence: 0, encounterType: 'combat',
      enemies: [], floorCleared: false, scene: '', season: 2,
      enabled: true, shopInventory: [], veganShrineVisited: false, longRestCounter: 0,
    })
    killCharacter('doomed', ch, 'the Boss')
    const graves = getGraves(ch, 10)
    expect(graves.length).toBeGreaterThan(0)
    const g = graves[0]
    expect(g.username).toBe('doomed')
    expect(g.class).toBe('Rogue')
    expect(g.level).toBe(4)
    expect(g.floor).toBe(7)
    expect(g.killer).toBe('the Boss')
  })
})

describe('death stakes', () => {
  it('death costs 40% gold, escalates respawn, counts the season death', async () => {
    const { upsertCharacter, getCharacter, killCharacter, resetSeasonDeaths } = await import('./db')
    const ch = 'stakeschan'
    upsertCharacter(makeChar({ username: 'risky', channel: ch, gold: 100, hp: 14, maxHp: 14 }))
    const d1 = killCharacter('risky', ch, 'Goblin')
    let c = getCharacter('risky', ch)!
    expect(c.gold).toBe(60)            // lost 40%
    expect(c.deathsSeason).toBe(1)
    const d2 = killCharacter('risky', ch, 'Goblin')
    c = getCharacter('risky', ch)!
    expect(c.deathsSeason).toBe(2)
    expect(d2).toBeGreaterThan(d1)     // respawn escalates with each death
    resetSeasonDeaths(ch)
    expect(getCharacter('risky', ch)!.deathsSeason).toBe(0)
  })
})

// --- render.ts (pure) ---
describe('multikillBanner', () => {
  it('n<2 → null', () => expect(multikillBanner('user', 1)).toBeNull())
  it('2 → DOUBLE KILL', () => expect(multikillBanner('user', 2)).toContain('DOUBLE KILL'))
  it('3+ → generic MULTI KILL (3+ unreachable in normal play)', () => {
    expect(multikillBanner('user', 3)).toContain('MULTI KILL')
    expect(multikillBanner('user', 5)).toContain('MULTI KILL')
  })
})

describe('titleFor', () => {
  it('prestige 3 → the Eternal', () => {
    expect(titleFor(makeChar({ prestige: 3 }))).toBe('the Eternal')
  })

  it('prestige shown as ★, not duplicated as a title — boss achievement wins', () => {
    expect(titleFor(makeChar({ prestige: 1, achievements: ['boss'] }))).toBe('Boss Slayer')
  })

  it('totalKills 120 → the Butcher', () => {
    expect(titleFor(makeChar({ totalKills: 120 }))).toBe('the Butcher')
  })

  it('achievements ["boss"] (no prestige, no 50+ kills) → Boss Slayer', () => {
    expect(titleFor(makeChar({ achievements: ['boss'], totalKills: 0 }))).toBe('Boss Slayer')
  })

  it('deaths 15 (no other milestone) → the Doomed', () => {
    expect(titleFor(makeChar({ deaths: 15 }))).toBe('the Doomed')
  })

  it('empty char → ""', () => {
    expect(titleFor(makeChar())).toBe('')
  })
})

describe('renderLegends', () => {
  it('empty → non-empty hint string', () => {
    const s = renderLegends([])
    expect(s.length).toBeGreaterThan(0)
  })

  it('with records → contains holder', () => {
    const s = renderLegends([{ rkey: 'deepest_floor', holder: 'kripp', value: 20, detail: '' }])
    expect(s).toContain('kripp')
  })
})

describe('renderGraveyard', () => {
  it('empty → non-empty hint', () => {
    expect(renderGraveyard([]).length).toBeGreaterThan(0)
  })

  it('with graves → contains usernames', () => {
    const s = renderGraveyard([{ username: 'dead_kripp', class: 'Wizard', level: 7, floor: 5, killer: 'Dragon' }])
    expect(s).toContain('dead_kripp')
  })
})

describe('renderBoonOffer', () => {
  it('contains "pick" and boon names', () => {
    const s = renderBoonOffer('kripp', ['berserker', 'deadeye', 'vampiric'])
    expect(s.toLowerCase()).toContain('pick')
    expect(s).toContain('Berserker')
    expect(s).toContain('Deadeye')
    expect(s).toContain('Vampiric')
  })
})

describe('renderBossCard', () => {
  it('contains boss name and floor', () => {
    const s = renderBossCard(10, 'The Lich King', 500)
    expect(s).toContain('The Lich King')
    expect(s).toContain('10')
  })
})

describe('events', () => {
  it('floor 9 always rolls the shrine', () => {
    expect(pickEvent(1, 9).id).toBe('shrine')
    expect(pickEvent(7, 9).id).toBe('shrine')
  })
  it('non-9 floors never roll the shrine', () => {
    for (let s = 1; s <= 6; s++) expect(pickEvent(s, 4).id).not.toBe('shrine')
  })
  it('pickEvent is deterministic', () => {
    expect(pickEvent(3, 4).id).toBe(pickEvent(3, 4).id)
  })
  it('shrine heals + blesses the vegan, denies the meat-eater', () => {
    const vegan = resolveEvent(EVENTS.shrine, { char: makeChar(), hasMeat: false, itemReward: null }, 1)
    expect(vegan.fullHeal).toBe(true)
    expect(vegan.blessed).toBe(true)
    const carn = resolveEvent(EVENTS.shrine, { char: makeChar(), hasMeat: true, itemReward: null }, 1)
    expect(carn.fullHeal).toBe(false)
  })
  it('altar grants permanent max HP when affordable, else does nothing', () => {
    const paid = resolveEvent(EVENTS.altar, { char: makeChar({ gold: 60 }), hasMeat: false, itemReward: null }, 1)
    expect(paid.maxHpDelta).toBeGreaterThan(0)
    expect(paid.goldDelta).toBeLessThan(0)
    const broke = resolveEvent(EVENTS.altar, { char: makeChar({ gold: 5 }), hasMeat: false, itemReward: null }, 1)
    expect(broke.maxHpDelta).toBe(0)
    expect(broke.goldDelta).toBe(0)
  })
  it('gamble is a coin flip on a seed (some win, some lose)', () => {
    const outcomes = Array.from({ length: 20 }, (_, i) =>
      resolveEvent(EVENTS.gamble, { char: makeChar({ gold: 100 }), hasMeat: false, itemReward: null }, i).goldDelta)
    expect(outcomes.some((g) => g > 0)).toBe(true)
    expect(outcomes.some((g) => g < 0)).toBe(true)
  })
  it('gamble refuses when broke', () => {
    const r = resolveEvent(EVENTS.gamble, { char: makeChar({ gold: 5 }), hasMeat: false, itemReward: null }, 1)
    expect(r.goldDelta).toBe(0)
  })
  it('chest grants an item or bites (never both)', () => {
    const r = resolveEvent(EVENTS.chest, { char: makeChar(), hasMeat: false, itemReward: 'Plague Glaive' }, 3)
    const item = r.grantItem === 'Plague Glaive'
    const bite = r.healAmount < 0
    expect(item || bite).toBe(true)
    expect(item && bite).toBe(false)
  })
  it('spring heals a positive amount', () => {
    const r = resolveEvent(EVENTS.spring, { char: makeChar({ maxHp: 40 }), hasMeat: false, itemReward: null }, 2)
    expect(r.healAmount).toBeGreaterThan(0)
  })
  it('fountain offers a boon', () => {
    const r = resolveEvent(EVENTS.fountain, { char: makeChar(), hasMeat: false, itemReward: null }, 9)
    expect(r.boonOffer).toBe(true)
  })
})
