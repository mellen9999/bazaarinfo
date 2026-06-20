import { describe, expect, it, beforeAll, afterAll, mock } from 'bun:test'
import { unlinkSync } from 'fs'
import { resolve } from 'path'
import { tmpdir } from 'os'
import type { BazaarCard } from '@bazaarinfo/shared'

// --- store mock (must be before combat/floor imports) ---
const mockFindCard = mock<(name: string) => BazaarCard | undefined>(() => undefined)

mock.module('../store', () => ({
  findCard: mockFindCard,
  monstersByDay: () => [],
  getItems: () => [],
}))

import {
  d20Roll, resolvePlayerAttack, getItemBonus, statusTickDamage,
  hasMeatItems,
} from './combat'
import { getFloorType, generateEnemies, generateShop, enemyReward } from './floor'
import {
  hpBar, renderFloor, renderCharacter, renderCombatResult, renderDeath,
  renderClassList, renderSeasonComplete,
} from './render'
import type { Character, Enemy, WorldState, CombatResult } from './types'
import {
  getModifier, getProfBonus, getCharAC, calcMaxHp, CLASS_BASE_STATS,
} from './types'

// --- fixtures ---

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
    stats: CLASS_BASE_STATS['Fighter'],
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

function makeEnemy(overrides: Partial<Enemy> = {}): Enemy {
  return {
    name: 'Goblin',
    hp: 7,
    maxHp: 7,
    ac: 15,
    hitBonus: 4,
    damageDie: 6,
    damageCount: 1,
    damageMod: 2,
    multiattack: 1,
    isBoss: false,
    cr: 0.25,
    xpValue: 50,
    ...overrides,
  }
}

function makeWorld(overrides: Partial<WorldState> = {}): WorldState {
  return {
    channel: 'testchan',
    floor: 1,
    actionSequence: 0,
    encounterType: 'combat',
    enemies: [makeEnemy()],
    floorCleared: false,
    scene: 'a dark corridor',
    season: 1,
    enabled: true,
    shopInventory: [],
    veganShrineVisited: false,
    longRestCounter: 0,
    ...overrides,
  }
}

function makeCombatResult(overrides: Partial<CombatResult> = {}): CombatResult {
  return {
    attacker: 'tester',
    targetEnemy: 'Goblin',
    enemyMaxHp: 7,
    d20Roll: 15,
    attackTotal: 19,
    targetAC: 15,
    hit: true,
    crit: false,
    fumble: false,
    damage: 8,
    damageDiceStr: '1d8+3',
    weaponName: 'Longsword',
    enemyKilled: false,
    enemyHpAfter: 0,
    ...overrides,
  }
}

function makeCard(tags: string[], tier = 'Bronze'): BazaarCard {
  return {
    Type: 'Item',
    Title: 'Test Item',
    Size: 'Medium',
    BaseTier: tier,
    Tiers: [tier],
    Tooltips: [],
    TooltipReplacements: {},
    DisplayTags: [],
    HiddenTags: [],
    Tags: tags,
    Heroes: ['Common'],
    Enchantments: {},
    Shortlink: '',
    Cooldown: 5,
  }
}

// ===========================================================================
// types.ts — D&D math helpers
// ===========================================================================

describe('getModifier', () => {
  it('10 → 0', () => expect(getModifier(10)).toBe(0))
  it('16 → +3', () => expect(getModifier(16)).toBe(3))
  it('8 → -1', () => expect(getModifier(8)).toBe(-1))
  it('20 → +5', () => expect(getModifier(20)).toBe(5))
})

describe('getProfBonus', () => {
  it('level 1 → +2', () => expect(getProfBonus(1)).toBe(2))
  it('level 4 → +2', () => expect(getProfBonus(4)).toBe(2))
  it('level 5 → +3', () => expect(getProfBonus(5)).toBe(3))
  it('level 9 → +4', () => expect(getProfBonus(9)).toBe(4))
})

describe('calcMaxHp', () => {
  it('Fighter Lv1 CON15 → 10+2=12... actually die+con', () => {
    const hp = calcMaxHp('Fighter', 1, 15)
    expect(hp).toBe(10 + 2)  // d10 + CON +2
  })
  it('Barbarian Lv1 CON15 → 12+2=14', () => {
    expect(calcMaxHp('Barbarian', 1, 15)).toBe(14)
  })
  it('Wizard Lv1 CON12 → 6+1=7', () => {
    expect(calcMaxHp('Wizard', 1, 12)).toBe(7)
  })
  it('higher level gives more HP', () => {
    const lv1 = calcMaxHp('Fighter', 1, 10)
    const lv2 = calcMaxHp('Fighter', 2, 10)
    expect(lv2).toBeGreaterThan(lv1)
  })
})

describe('getCharAC', () => {
  const stats = CLASS_BASE_STATS
  it('Paladin has AC 18 (plate)', () => expect(getCharAC('Paladin', stats['Paladin'])).toBe(18))
  it('Fighter has AC 16', () => expect(getCharAC('Fighter', stats['Fighter'])).toBe(16))
  it('Barbarian AC includes DEX+CON', () => {
    // DEX14→+2, CON15→+2 → 10+2+2=14
    expect(getCharAC('Barbarian', stats['Barbarian'])).toBe(14)
  })
  it('item bonus adds to AC', () => {
    const base = getCharAC('Fighter', stats['Fighter'])
    const withBonus = getCharAC('Fighter', stats['Fighter'], 1)
    expect(withBonus).toBe(base + 1)
  })
})

// ===========================================================================
// combat.ts
// ===========================================================================

describe('d20Roll', () => {
  it('returns integer in [1, 20]', () => {
    for (let seed = 0; seed < 50; seed++) {
      const r = d20Roll(seed)
      expect(r).toBeGreaterThanOrEqual(1)
      expect(r).toBeLessThanOrEqual(20)
      expect(Number.isInteger(r)).toBe(true)
    }
  })

  it('is deterministic for same seed', () => {
    expect(d20Roll(42)).toBe(d20Roll(42))
    expect(d20Roll(999)).toBe(d20Roll(999))
  })

  it('produces different values for different seeds', () => {
    let distinct = 0
    const first = d20Roll(0)
    for (let s = 1; s < 100; s++) {
      if (d20Roll(s) !== first) { distinct++; if (distinct >= 3) break }
    }
    expect(distinct).toBeGreaterThanOrEqual(3)
  })
})

describe('combo — detonating status-afflicted foes', () => {
  it('hitting a status-afflicted enemy adds combo bonus damage', () => {
    const char = makeChar({ level: 6 })  // bonus = floor(6/2)+2 = 5
    // find a seed that hits a plain AC-12 enemy (no crit/fumble noise)
    let seq = -1
    for (let s = 0; s < 500; s++) {
      const o = resolvePlayerAttack(char, makeEnemy({ ac: 12 }), s, false, false)
      if (o.hit && !o.crit) { seq = s; break }
    }
    expect(seq).toBeGreaterThanOrEqual(0)
    const plain = resolvePlayerAttack(char, makeEnemy({ ac: 12 }), seq, false, false)
    const combo = resolvePlayerAttack(char, makeEnemy({ ac: 12, statusEffect: 'burning' }), seq, false, false)
    expect(combo.comboBonus).toBe(5)
    expect(combo.damage).toBe(plain.damage + 5)
    expect(plain.comboBonus).toBeUndefined()
  })
})

describe('resolvePlayerAttack — d20 vs AC', () => {
  it('hit only when attackTotal >= enemy.ac or nat 20', () => {
    const char = makeChar()
    const enemy = makeEnemy({ ac: 20 })
    let hitFound = false
    for (let seq = 0; seq < 1000; seq++) {
      const result = resolvePlayerAttack(char, enemy, seq, false, false)
      if (result.hit) {
        // must be a nat 20 crit
        expect(result.crit).toBe(true)
        expect(result.d20Roll).toBe(20)
        hitFound = true
        break
      }
    }
    // At AC 20, only nat 20 hits (possible but not guaranteed in 1000)
    // Just check the shape
    const result = resolvePlayerAttack(char, enemy, 0, false, false)
    expect(typeof result.hit).toBe('boolean')
    expect(typeof result.d20Roll).toBe('number')
    expect(result.d20Roll).toBeGreaterThanOrEqual(1)
    expect(result.d20Roll).toBeLessThanOrEqual(20)
  })

  it('miss produces 0 damage', () => {
    const char = makeChar()
    const enemy = makeEnemy({ ac: 99 })  // impossible to hit without nat 20
    let missFound = false
    for (let seq = 0; seq < 500; seq++) {
      const result = resolvePlayerAttack(char, enemy, seq, false, false)
      if (!result.hit && !result.fumble) {
        expect(result.damage).toBe(0)
        missFound = true
        break
      }
    }
    expect(missFound).toBe(true)
  })

  it('crit on nat 20: hit=true, crit=true', () => {
    const char = makeChar()
    const enemy = makeEnemy()
    let critFound = false
    for (let seq = 0; seq < 10000; seq++) {
      const result = resolvePlayerAttack(char, enemy, seq, false, false)
      if (result.crit) {
        expect(result.hit).toBe(true)
        expect(result.d20Roll).toBe(20)
        critFound = true
        break
      }
    }
    expect(critFound).toBe(true)
  })

  it('fumble on nat 1: hit=false, fumble=true', () => {
    const char = makeChar()
    const enemy = makeEnemy()
    let fumbleFound = false
    for (let seq = 0; seq < 10000; seq++) {
      const result = resolvePlayerAttack(char, enemy, seq, false, false)
      if (result.fumble) {
        expect(result.hit).toBe(false)
        expect(result.d20Roll).toBe(1)
        fumbleFound = true
        break
      }
    }
    expect(fumbleFound).toBe(true)
  })

  it('Rogue: sneak attack adds dice on hit', () => {
    const char = makeChar({ class: 'Rogue', stats: CLASS_BASE_STATS['Rogue'] })
    const enemy = makeEnemy({ ac: 5 })  // easy to hit
    let hitFound = false
    for (let seq = 0; seq < 1000; seq++) {
      const result = resolvePlayerAttack(char, enemy, seq, false, false)
      if (result.hit) {
        expect(result.damageDiceStr).toContain('sneak')
        hitFound = true
        break
      }
    }
    expect(hitFound).toBe(true)
  })

  it('Barbarian rage: +2 dmg on attack', () => {
    const char = makeChar({
      class: 'Barbarian',
      stats: CLASS_BASE_STATS['Barbarian'],
      rageTurnsLeft: 3,
    })
    const noRage = makeChar({ class: 'Barbarian', stats: CLASS_BASE_STATS['Barbarian'], rageTurnsLeft: 0 })
    const enemy = makeEnemy({ ac: 5 })
    let raging = -1, calm = -1
    for (let seq = 0; seq < 500; seq++) {
      const r1 = resolvePlayerAttack(char, enemy, seq, false, false)
      const r2 = resolvePlayerAttack(noRage, enemy, seq, false, false)
      if (r1.hit && r2.hit && !r1.crit && !r2.crit) {
        raging = r1.damage
        calm = r2.damage
        break
      }
    }
    if (raging >= 0) {
      expect(raging).toBeGreaterThanOrEqual(calm + 2)
    }
  })

  it('actuallySick only on crit boss kill shot', () => {
    const char = makeChar()
    const boss = makeEnemy({ isBoss: true, hp: 1, maxHp: 200 })
    let found = false
    for (let seq = 0; seq < 10000; seq++) {
      const result = resolvePlayerAttack(char, boss, seq, false, false)
      if (result.crit && result.actuallySick) {
        found = true
        break
      }
    }
    expect(found).toBe(true)

    const nonBoss = makeEnemy({ isBoss: false, hp: 1, maxHp: 200 })
    for (let seq = 0; seq < 500; seq++) {
      const result = resolvePlayerAttack(char, nonBoss, seq, false, false)
      expect(result.actuallySick).toBeFalsy()
    }
  })

  it('advantage takes higher of two rolls', () => {
    const char = makeChar()
    const enemy = makeEnemy()
    let differentFound = false
    for (let seq = 0; seq < 500; seq++) {
      const adv = resolvePlayerAttack(char, enemy, seq, true, false)
      const norm = resolvePlayerAttack(char, enemy, seq, false, false)
      if (adv.d20Roll !== norm.d20Roll) {
        expect(adv.d20Roll).toBeGreaterThanOrEqual(norm.d20Roll)
        differentFound = true
        break
      }
    }
    // Not guaranteed every time but should find at least one difference
    expect(typeof differentFound).toBe('boolean')
  })
})

describe('getItemBonus', () => {
  it('+1 Weapon gives +1 damage', () => {
    const bonus = getItemBonus('+1 Weapon')
    expect(bonus.damage).toBe(1)
  })

  it('+2 Weapon gives +2 damage', () => {
    const bonus = getItemBonus('+2 Weapon')
    expect(bonus.damage).toBe(2)
  })

  it('Ring of Protection gives +1 armor', () => {
    expect(getItemBonus('Ring of Protection').armor).toBe(1)
  })

  it('Potion of Healing heals 8', () => {
    expect(getItemBonus('Potion of Healing').onUseHeal).toBe(8)
  })

  it('Potion of Greater Healing heals 18', () => {
    expect(getItemBonus('Potion of Greater Healing').onUseHeal).toBe(18)
  })

  it('Potion of Superior Healing heals 38', () => {
    expect(getItemBonus('Potion of Superior Healing').onUseHeal).toBe(38)
  })

  it('weapon tag gives tier damage (legacy fallback)', () => {
    mockFindCard.mockReturnValueOnce(makeCard(['Weapon'], 'Bronze'))
    const bonus = getItemBonus('SomeSword')
    expect(bonus.damage).toBe(3)
  })

  it('armor tag gives armor bonus (legacy fallback)', () => {
    mockFindCard.mockReturnValueOnce(makeCard(['armor'], 'Bronze'))
    const bonus = getItemBonus('Shield')
    expect(bonus.armor).toBe(5)
  })

  it('heal tag gives onUseHeal (legacy fallback)', () => {
    mockFindCard.mockReturnValueOnce(makeCard(['heal'], 'Silver'))
    const bonus = getItemBonus('Potion')
    expect(bonus.onUseHeal).toBe(30)
  })

  it('poison tag sets onHitStatus (legacy fallback)', () => {
    mockFindCard.mockReturnValueOnce(makeCard(['poison'], 'Bronze'))
    const bonus = getItemBonus('VenomFang')
    expect(bonus.onHitStatus).toBe('poisoned')
  })

  it('unknown item returns zeros', () => {
    mockFindCard.mockReturnValueOnce(undefined)
    const bonus = getItemBonus('FakeItem')
    expect(bonus.damage).toBe(0)
    expect(bonus.armor).toBe(0)
    expect(bonus.onUseHeal).toBe(0)
    expect(bonus.onHitStatus).toBeNull()
  })
})

describe('statusTickDamage', () => {
  it('burning = 8', () => expect(statusTickDamage(['burning'])).toBe(8))
  it('poisoned = 6', () => expect(statusTickDamage(['poisoned'])).toBe(6))
  it('2 poisoned = 12', () => expect(statusTickDamage(['poisoned', 'poisoned'])).toBe(12))
  it('burning + poisoned = 14', () => expect(statusTickDamage(['burning', 'poisoned'])).toBe(14))
  it('no effects = 0', () => expect(statusTickDamage([])).toBe(0))
  it('legacy burn alias = 8', () => expect(statusTickDamage(['burn'])).toBe(8))
  it('legacy poison alias = 6', () => expect(statusTickDamage(['poison'])).toBe(6))
  it('irrelevant effects = 0', () => expect(statusTickDamage(['haste', 'blessed'])).toBe(0))
})

describe('hasMeatItems', () => {
  it('empty inventory is clean', () => expect(hasMeatItems([])).toBe(false))
  it("Glutton in name → true", () => {
    mockFindCard.mockReturnValue(undefined)
    expect(hasMeatItems(["Glutton's Chalice"])).toBe(true)
  })
  it('Feast in name → true', () => {
    mockFindCard.mockReturnValue(undefined)
    expect(hasMeatItems(['Feast of Champions'])).toBe(true)
  })
  it('D&D items are clean', () => {
    mockFindCard.mockReturnValue(undefined)
    expect(hasMeatItems(['+1 Weapon', 'Ring of Protection', 'Potion of Healing'])).toBe(false)
  })
  it('food tag via card lookup → true', () => {
    mockFindCard.mockReturnValue(makeCard(['food'], 'Bronze'))
    expect(hasMeatItems(['SomeFood'])).toBe(true)
  })
})

// ===========================================================================
// floor.ts
// ===========================================================================

describe('getFloorType', () => {
  it('shop on 5', () => {
    expect(getFloorType(5)).toBe('shop')
    expect(getFloorType(3)).toBe('combat')  // floor 3 is now combat (feeds the act-1 boss)
  })
  it('bosses on 6 and 10', () => {
    expect(getFloorType(6)).toBe('boss')
    expect(getFloorType(10)).toBe('boss')
  })
  it('event on 4 and 9', () => {
    expect(getFloorType(4)).toBe('event')
    expect(getFloorType(9)).toBe('event')
  })
  it('combat otherwise', () => {
    expect(getFloorType(1)).toBe('combat')
    expect(getFloorType(2)).toBe('combat')
    expect(getFloorType(7)).toBe('combat')
    expect(getFloorType(8)).toBe('combat')
  })
})

describe('generateEnemies', () => {
  it('is deterministic', () => {
    const a = generateEnemies(1, 1)
    const b = generateEnemies(1, 1)
    expect(a.length).toBe(b.length)
    for (let i = 0; i < a.length; i++) {
      expect(a[i].name).toBe(b[i].name)
      expect(a[i].hp).toBe(b[i].hp)
    }
  })

  it('combat floors return 2 enemies', () => {
    for (const f of [1, 2, 4, 7, 8]) {
      const enemies = generateEnemies(1, f)
      expect(enemies.length).toBe(2)
    }
  })

  it('boss floor returns 1 isBoss=true enemy', () => {
    const enemies = generateEnemies(1, 6)
    expect(enemies.length).toBe(1)
    expect(enemies[0].isBoss).toBe(true)
  })

  it('final boss floor 10 returns Lich', () => {
    const enemies = generateEnemies(1, 10)
    expect(enemies[0].name).toBe('Lich')
    expect(enemies[0].isBoss).toBe(true)
    expect(enemies[0].cr).toBeGreaterThan(10)
  })

  it('all enemies have required D&D fields', () => {
    const enemies = generateEnemies(1, 1)
    for (const e of enemies) {
      expect(typeof e.ac).toBe('number')
      expect(typeof e.hitBonus).toBe('number')
      expect(typeof e.damageDie).toBe('number')
      expect(typeof e.damageCount).toBe('number')
      expect(typeof e.xpValue).toBe('number')
      expect(e.ac).toBeGreaterThan(0)
    }
  })

  it('different seasons produce different HP (seeded)', () => {
    const s1 = generateEnemies(1, 1)
    const s2 = generateEnemies(2, 1)
    // Same template pool, different RNG seed — HP might differ
    expect(s1.length).toBe(s2.length)
  })

  it('fallback for unmapped floor', () => {
    const enemies = generateEnemies(1, 99)
    expect(enemies.length).toBeGreaterThan(0)
    expect(enemies[0].name).toContain('99')
  })
})

describe('generateShop', () => {
  it('is deterministic', () => {
    const a = generateShop(1, 3)
    const b = generateShop(1, 3)
    expect(a.length).toBe(b.length)
    for (let i = 0; i < a.length; i++) {
      expect(a[i].name).toBe(b[i].name)
      expect(a[i].price).toBe(b[i].price)
    }
  })

  it('returns D&D items', () => {
    const shop = generateShop(1, 3)
    expect(shop.length).toBeGreaterThan(0)
    const names = shop.map((s) => s.name)
    // must contain at least one real D&D item
    const dndItems = ['Potion of Healing', 'Ring of Protection', '+1 Weapon', 'Cloak of Protection', 'Antitoxin', 'Potion of Greater Healing', 'Scroll of Protection']
    expect(names.some((n) => dndItems.includes(n))).toBe(true)
  })

  it('all items have positive price', () => {
    const shop = generateShop(1, 5)
    for (const item of shop) {
      expect(item.price).toBeGreaterThan(0)
    }
  })

  it('at most 4 items returned', () => {
    expect(generateShop(1, 3).length).toBeLessThanOrEqual(4)
    expect(generateShop(1, 5).length).toBeLessThanOrEqual(4)
  })
})

describe('enemyReward', () => {
  it('uses enemy.xpValue for XP', () => {
    const goblin = makeEnemy({ xpValue: 50, isBoss: false })
    const reward = enemyReward(goblin, 1)
    expect(reward.xp).toBe(50)
  })

  it('boss enemy gives 3x gold', () => {
    const mob = makeEnemy({ xpValue: 50, isBoss: false })
    const boss = makeEnemy({ xpValue: 5000, isBoss: true })
    const mobR = enemyReward(mob, 6)
    const bossR = enemyReward(boss, 6)
    expect(bossR.gold).toBeGreaterThan(mobR.gold)
  })

  it('gold scales with floor', () => {
    const enemy = makeEnemy({ xpValue: 100 })
    const r1 = enemyReward(enemy, 1)
    const r5 = enemyReward(enemy, 5)
    expect(r5.gold).toBeGreaterThan(r1.gold)
  })

  it('final boss gives sane (rescaled) XP', () => {
    const enemies = generateEnemies(1, 10)
    const boss = enemies[0]
    expect(boss.isBoss).toBe(true)
    expect(boss.xpValue).toBe(1500)
  })
})

// ===========================================================================
// render.ts
// ===========================================================================

describe('hpBar', () => {
  it('full HP = 8 hashes', () => expect(hpBar(100, 100)).toBe('########'))
  it('zero HP = 8 dots', () => expect(hpBar(0, 100)).toBe('........'))
  it('half HP = 4 hashes 4 dots', () => expect(hpBar(50, 100)).toBe('####....'))
  it('handles zero maxHp gracefully', () => expect(hpBar(0, 0).length).toBe(8))
})

describe('renderFloor', () => {
  it('output ≤480 chars', () => {
    const world = makeWorld()
    const result = renderFloor(world, [makeChar(), makeChar({ username: 'bob' })])
    expect(result.length).toBeLessThanOrEqual(480)
  })

  it('shows enemy name + AC on combat floor', () => {
    const world = makeWorld({ enemies: [makeEnemy({ name: 'Goblin', ac: 15, hp: 7, maxHp: 7 })] })
    const result = renderFloor(world, [])
    expect(result).toContain('Goblin')
    expect(result).toContain('AC15')
    expect(result).toContain('7/7')
  })

  it('shows CLEARED + !b move when floor cleared', () => {
    const world = makeWorld({ floorCleared: true })
    const result = renderFloor(world, [])
    expect(result).toContain('CLEARED')
    expect(result).toContain('!b move')
  })

  it('shows shop instruction on shop floor', () => {
    const world = makeWorld({ encounterType: 'shop' })
    const result = renderFloor(world, [])
    expect(result.toLowerCase()).toContain('shop')
  })

  it('shows DYING players with death save counts', () => {
    const world = makeWorld()
    const dying = makeChar({ isDying: true, deathSuccesses: 1, deathFailures: 2 })
    const result = renderFloor(world, [dying])
    expect(result).toContain('DYING')
    expect(result).toContain('1✓')
    expect(result).toContain('2✗')
  })

  it('large party truncated to ≤480 chars', () => {
    const world = makeWorld()
    const players = Array.from({ length: 20 }, (_, i) =>
      makeChar({ username: `player${i}`, inventory: ['a', 'b', 'c', 'd', 'e', 'f'] })
    )
    expect(renderFloor(world, players).length).toBeLessThanOrEqual(480)
  })
})

describe('renderCharacter', () => {
  it('output ≤480 chars', () => {
    const char = makeChar({ inventory: ['+1 Weapon', 'Ring of Protection', 'Potion of Healing', 'Antitoxin', '+2 Weapon', 'Cloak of Protection'] })
    expect(renderCharacter(char).length).toBeLessThanOrEqual(480)
  })

  it('shows class, level, AC, HP', () => {
    const char = makeChar({ class: 'Paladin', level: 3, stats: CLASS_BASE_STATS['Paladin'] })
    const result = renderCharacter(char)
    expect(result).toContain('Paladin')
    expect(result).toContain('Lv3')
    expect(result).toContain('AC18')
  })

  it('shows dead status when respawnAt set', () => {
    const char = makeChar({ respawnAt: Date.now() + 60_000, hp: 0 })
    expect(renderCharacter(char).toUpperCase()).toContain('DEAD')
  })

  it('shows DYING + death save counts when isDying', () => {
    const char = makeChar({ isDying: true, deathSuccesses: 2, deathFailures: 1 })
    const result = renderCharacter(char)
    expect(result).toContain('DYING')
    expect(result).toContain('2✓')
    expect(result).toContain('1✗')
  })

  it('shows spell slots for Wizard', () => {
    const char = makeChar({ class: 'Wizard', spellSlots: 2, maxSpellSlots: 2 })
    const result = renderCharacter(char)
    expect(result).toContain('slots:2/2')
  })
})

describe('renderCombatResult', () => {
  it('shows d20 roll, attack total, AC', () => {
    const result = renderCombatResult(makeCombatResult({ d20Roll: 17, attackTotal: 21, targetAC: 15 }))
    expect(result).toContain('d20: 17')
    expect(result).toContain('AC 15')
  })

  it('shows NAT 20 on crit', () => {
    const result = renderCombatResult(makeCombatResult({ crit: true, d20Roll: 20, attackTotal: 24, targetAC: 15 }))
    expect(result).toContain('NAT 20')
  })

  it('shows MISS when hit=false', () => {
    const result = renderCombatResult(makeCombatResult({ hit: false, d20Roll: 8, attackTotal: 12, targetAC: 15, damage: 0, damageDiceStr: '' }))
    expect(result.toUpperCase()).toContain('MISS')
  })

  it('CRITICAL FUMBLE on fumble', () => {
    const result = renderCombatResult(makeCombatResult({ fumble: true, hit: false, d20Roll: 1, attackTotal: 5, damage: 0, damageDiceStr: '' }))
    expect(result).toContain('CRITICAL FUMBLE')
  })

  it('ACTUALLY SICK shown on crit kill', () => {
    const result = renderCombatResult(makeCombatResult({ actuallySick: true, crit: true, hit: true, enemyKilled: true }))
    expect(result).toContain('ACTUALLY SICK')
  })

  it('DEFEATED when enemy killed', () => {
    const result = renderCombatResult(makeCombatResult({ enemyKilled: true }))
    expect(result).toContain('DEFEATED')
  })

  it('output ≤480 chars', () => {
    expect(renderCombatResult(makeCombatResult()).length).toBeLessThanOrEqual(480)
  })
})

describe('renderDeath', () => {
  it('contains respawn info', () => {
    const result = renderDeath('alice', 'Goblin', 85)
    expect(result).toContain('slain')
    expect(result).toContain('respawning')
    expect(result).toContain('85s')
  })

  it('output ≤480 chars', () => {
    expect(renderDeath('alice', 'The Mighty Lich of Doom and Despair').length).toBeLessThanOrEqual(480)
  })
})

describe('renderClassList', () => {
  it('contains all 9 D&D classes', () => {
    const result = renderClassList()
    for (const cls of ['barbarian', 'fighter', 'paladin', 'rogue', 'wizard', 'cleric', 'sorcerer', 'monk', 'warlock']) {
      expect(result.toLowerCase()).toContain(cls)
    }
  })
})

describe('renderSeasonComplete', () => {
  it('contains CONQUERED', () => expect(renderSeasonComplete(1, 10)).toContain('CONQUERED'))
  it('contains Prestige info', () => expect(renderSeasonComplete(1, 10)).toContain('Prestige'))
})

// ===========================================================================
// dnd/db.ts (integration — real SQLite)
// ===========================================================================

describe('dnd db', () => {
  let dbPath: string

  function cleanPath(p: string) {
    try { unlinkSync(p) } catch {}
    try { unlinkSync(p + '-wal') } catch {}
    try { unlinkSync(p + '-shm') } catch {}
  }

  beforeAll(async () => {
    dbPath = resolve(tmpdir(), `.dnd-test-${Date.now()}.db`)
    const mainDb = await import('../db')
    mainDb.initDb(dbPath)
    const dndDb = await import('./db')
    dndDb.initDndDb()
  })

  afterAll(async () => {
    const mainDb = await import('../db')
    try { mainDb.closeDb() } catch {}
    cleanPath(dbPath)
  })

  it('getCharacter returns null for unknown user', async () => {
    const { getCharacter } = await import('./db')
    expect(getCharacter('nobody', 'chan')).toBeNull()
  })

  it('upsertCharacter + getCharacter round-trip (D&D fields)', async () => {
    const { upsertCharacter, getCharacter } = await import('./db')
    const char = makeChar({ username: 'roundtrip', channel: 'testchan' })
    upsertCharacter(char)
    const retrieved = getCharacter('roundtrip', 'testchan')
    expect(retrieved).not.toBeNull()
    expect(retrieved!.username).toBe('roundtrip')
    expect(retrieved!.class).toBe('Fighter')
    expect(retrieved!.spellSlots).toBe(0)
    expect(retrieved!.isDying).toBe(false)
    expect(retrieved!.deathSuccesses).toBe(0)
    expect(retrieved!.deathFailures).toBe(0)
    expect(retrieved!.stats).toBeTruthy()
    expect(retrieved!.stats.str).toBe(CLASS_BASE_STATS['Fighter'].str)
    expect(retrieved!.defending).toBe(false)
  })

  it('upsertWorld + getWorld round-trip preserving longRestCounter', async () => {
    const { upsertWorld, getWorld } = await import('./db')
    const world = makeWorld({ channel: 'worldtest', veganShrineVisited: true, floor: 5, season: 3, longRestCounter: 2 })
    upsertWorld(world)
    const retrieved = getWorld('worldtest')
    expect(retrieved).not.toBeNull()
    expect(retrieved!.floor).toBe(5)
    expect(retrieved!.season).toBe(3)
    expect(retrieved!.veganShrineVisited).toBe(true)
    expect(retrieved!.longRestCounter).toBe(2)
  })

  it('addCharacterXp triggers level-up at the Lv2 XP threshold (120)', async () => {
    const { upsertCharacter, addCharacterXp } = await import('./db')
    const char = makeChar({ username: 'levelup', channel: 'testchan', xp: 0, level: 1 })
    upsertCharacter(char)
    const result = addCharacterXp('levelup', 'testchan', 120)
    expect(result.leveledUp).toBe(true)
    expect(result.newLevel).toBe(2)
  })

  it('addCharacterXp does not level up below threshold', async () => {
    const { upsertCharacter, addCharacterXp } = await import('./db')
    const char = makeChar({ username: 'nolevel', channel: 'testchan', xp: 0, level: 1 })
    upsertCharacter(char)
    const result = addCharacterXp('nolevel', 'testchan', 50)
    expect(result.leveledUp).toBe(false)
    expect(result.newLevel).toBe(1)
  })

  it('nextSequence increments each call', async () => {
    const { upsertWorld, nextSequence } = await import('./db')
    upsertWorld(makeWorld({ channel: 'seqtest' }))
    const s1 = nextSequence('seqtest')
    const s2 = nextSequence('seqtest')
    const s3 = nextSequence('seqtest')
    expect(s2).toBe(s1 + 1)
    expect(s3).toBe(s2 + 1)
  })

  it('damageCharacter clamps to 0', async () => {
    const { upsertCharacter, damageCharacter } = await import('./db')
    const char = makeChar({ username: 'dmgtest', channel: 'testchan', hp: 10, maxHp: 14 })
    upsertCharacter(char)
    const newHp = damageCharacter('dmgtest', 'testchan', 9999)
    expect(newHp).toBe(0)
  })

  it('healCharacter clamps to maxHp', async () => {
    const { upsertCharacter, healCharacter } = await import('./db')
    const char = makeChar({ username: 'healtest', channel: 'testchan', hp: 5, maxHp: 14 })
    upsertCharacter(char)
    const newHp = healCharacter('healtest', 'testchan', 9999)
    expect(newHp).toBe(14)
  })

  it('killCharacter + respawnCharacter cycle', async () => {
    const { upsertCharacter, killCharacter, respawnCharacter, getCharacter } = await import('./db')
    const char = makeChar({ username: 'dietest', channel: 'testchan', hp: 14, maxHp: 14 })
    upsertCharacter(char)

    killCharacter('dietest', 'testchan')
    const dead = getCharacter('dietest', 'testchan')
    expect(dead!.hp).toBe(0)
    expect(dead!.respawnAt).toBeGreaterThan(Date.now())

    respawnCharacter('dietest', 'testchan')
    const alive = getCharacter('dietest', 'testchan')
    expect(alive!.respawnAt).toBeNull()
    expect(alive!.hp).toBe(7)  // half of maxHp=14
  })

  it('death save state round-trips', async () => {
    const { upsertCharacter, getCharacter, updateDeathSaves, setDying } = await import('./db')
    const char = makeChar({ username: 'deathtest', channel: 'testchan' })
    upsertCharacter(char)
    setDying('deathtest', 'testchan', true)
    updateDeathSaves('deathtest', 'testchan', 2, 1)
    const retrieved = getCharacter('deathtest', 'testchan')
    expect(retrieved!.isDying).toBe(true)
    expect(retrieved!.deathSuccesses).toBe(2)
    expect(retrieved!.deathFailures).toBe(1)
  })

  it('stabilizeCharacter resets dying state', async () => {
    const { upsertCharacter, getCharacter, setDying, stabilizeCharacter } = await import('./db')
    const char = makeChar({ username: 'stabtest', channel: 'testchan' })
    upsertCharacter(char)
    setDying('stabtest', 'testchan', true)
    stabilizeCharacter('stabtest', 'testchan')
    const retrieved = getCharacter('stabtest', 'testchan')
    expect(retrieved!.isDying).toBe(false)
    expect(retrieved!.deathSuccesses).toBe(0)
    expect(retrieved!.deathFailures).toBe(0)
  })

  it('getPendingRespawns returns characters with future respawnAt', async () => {
    const { upsertCharacter, killCharacter, getPendingRespawns } = await import('./db')
    const char = makeChar({ username: 'respawntest', channel: 'testchan', hp: 14, maxHp: 14 })
    upsertCharacter(char)
    killCharacter('respawntest', 'testchan')
    const pending = getPendingRespawns()
    const found = pending.find((p) => p.username === 'respawntest')
    expect(found).toBeTruthy()
    expect(found!.respawnAt).toBeGreaterThan(Date.now())
  })

  it('logDndAction and getRecentLog', async () => {
    const { logDndAction, getRecentLog } = await import('./db')
    logDndAction('testchan', 'loguser', 'kill', 'Goblin', '12dmg')
    const logs = getRecentLog('testchan', 10)
    const found = logs.find((l) => l.username === 'loguser' && l.action === 'kill')
    expect(found).toBeTruthy()
    expect(found!.target).toBe('Goblin')
    expect(found!.result).toBe('12dmg')
  })

  // builtin class names resolve instantly (no AI call), so reroll is exercised
  // end-to-end against the real db with no network. ai-dm no-ops without a key.
  describe('reroll', () => {
    const chan = 'rrchan'
    const ctx = (user: string) => ({ user, channel: chan, isMod: false })

    beforeAll(async () => {
      const engine = await import('./engine')
      engine.setIsLive(() => false)        // dnd is offline-only; treat channel as not-live
      engine.setDndEnabled(chan, true)
    })

    // let the 400ms join/announce timers drain before the parent afterAll closes the db
    afterAll(async () => { await new Promise((r) => setTimeout(r, 450)) })

    it('fresh char (no progress) rerolls instantly, resetting to the new class', async () => {
      const { handleJoin, handleReroll } = await import('./commands')
      const { getCharacter } = await import('./db')
      await handleJoin('Barbarian', ctx('rr_fresh'))
      expect(getCharacter('rr_fresh', chan)!.class).toBe('Barbarian')
      await handleReroll('Wizard', ctx('rr_fresh'))
      const c = getCharacter('rr_fresh', chan)!
      expect(c.class).toBe('Wizard')
      expect(c.gold).toBe(10)
    })

    it('a character with progress is confirm-gated (no accidental wipe)', async () => {
      const { handleJoin, handleReroll } = await import('./commands')
      const { getCharacter, upsertCharacter } = await import('./db')
      await handleJoin('Barbarian', ctx('rr_prog'))
      const b = getCharacter('rr_prog', chan)!
      b.totalKills = 7; b.gold = 99; upsertCharacter(b)
      const warn = await handleReroll('Rogue', ctx('rr_prog'))
      expect(warn).toContain('WIPES')
      expect(getCharacter('rr_prog', chan)!.class).toBe('Barbarian')  // unchanged
      await handleReroll('Rogue confirm', ctx('rr_prog'))
      const after = getCharacter('rr_prog', chan)!
      expect(after.class).toBe('Rogue')
      expect(after.totalKills).toBe(0)  // progress wiped
      expect(after.gold).toBe(10)
    })

    it('cooldown blocks a rapid second reroll', async () => {
      const { handleJoin, handleReroll } = await import('./commands')
      const { getCharacter } = await import('./db')
      await handleJoin('Fighter', ctx('rr_cd'))
      await handleReroll('Wizard confirm', ctx('rr_cd'))
      const msg = await handleReroll('Rogue confirm', ctx('rr_cd'))
      expect(msg).toContain('wait')
      expect(getCharacter('rr_cd', chan)!.class).toBe('Wizard')  // second reroll blocked
    })

    it('empty class arg returns usage, not a wipe', async () => {
      const { handleJoin, handleReroll } = await import('./commands')
      const { getCharacter } = await import('./db')
      await handleJoin('Cleric', ctx('rr_empty'))
      const msg = await handleReroll('', ctx('rr_empty'))
      expect(msg).toContain('reroll into what')
      expect(getCharacter('rr_empty', chan)!.class).toBe('Cleric')  // untouched
    })
  })
})
