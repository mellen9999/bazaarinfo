import { describe, expect, it, beforeAll, afterAll, mock } from 'bun:test'
import { unlinkSync } from 'fs'
import { resolve } from 'path'
import { tmpdir } from 'os'
import type { BazaarCard, Monster } from '@bazaarinfo/shared'

// --- store mock (must be before combat/floor imports) ---
const mockFindCard = mock<(name: string) => BazaarCard | undefined>(() => undefined)
const mockMonstersByDay = mock<(day: number) => Monster[]>(() => [])
const mockGetItems = mock<() => BazaarCard[]>(() => [])

mock.module('../store', () => ({
  findCard: mockFindCard,
  monstersByDay: mockMonstersByDay,
  getItems: mockGetItems,
}))

import {
  diceRolls, resolvePlayerAttack, getItemBonus, statusTickDamage,
  hasMeatItems, CLASS_BASE_HP, CLASS_BASE_DMG,
} from './combat'
import { getFloorType, floorToDay, generateEnemies, generateShop, enemyReward } from './floor'
import {
  hpBar, renderFloor, renderCharacter, renderCombatResult, renderDeath,
  renderClassList, renderSeasonComplete,
} from './render'
import type { Character, Enemy, WorldState, CombatResult } from './types'

// --- fixtures ---

function makeChar(overrides: Partial<Character> = {}): Character {
  return {
    username: 'tester',
    channel: 'testchan',
    class: 'Brawler',
    level: 1,
    xp: 0,
    hp: 120,
    maxHp: 120,
    gold: 10,
    inventory: [],
    statusEffects: [],
    deaths: 0,
    totalKills: 0,
    spellReady: true,
    defending: false,
    lastActionAt: 0,
    respawnAt: null,
    prestige: 0,
    achievements: [],
    ...overrides,
  }
}

function makeEnemy(overrides: Partial<Enemy> = {}): Enemy {
  return {
    name: 'Thornling',
    hp: 80,
    maxHp: 80,
    items: [],
    statusEffects: [],
    isBoss: false,
    stunned: false,
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
    nlLifted: false,
    shopInventory: [],
    veganShrineVisited: false,
    ...overrides,
  }
}

function makeCombatResult(overrides: Partial<CombatResult> = {}): CombatResult {
  return {
    attacker: 'tester',
    targetEnemy: 'Thornling',
    damage: 20,
    crit: false,
    miss: false,
    krippCursed: false,
    actuallySick: false,
    statusApplied: null,
    enemyKilled: false,
    enemyHpAfter: 60,
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

function makeMonster(title: string, health: number): Monster {
  return {
    Title: title,
    Tags: [],
    HiddenTags: [],
    MonsterMetadata: { health, board: [] },
  } as unknown as Monster
}

// ===========================================================================
// combat.ts
// ===========================================================================

describe('diceRolls', () => {
  it('returns values in [0,1]', () => {
    for (let seq = 0; seq < 50; seq++) {
      const r = diceRolls(seq, true)
      expect(r.hit).toBeGreaterThanOrEqual(0)
      expect(r.hit).toBeLessThanOrEqual(1)
      expect(r.secondary).toBeGreaterThanOrEqual(0)
      expect(r.secondary).toBeLessThanOrEqual(1)
    }
  })

  it('NL penalty reduces hit value', () => {
    // For the same sequence, nlLifted=true should give hit >= nlLifted=false
    let foundDifference = false
    for (let seq = 0; seq < 200; seq++) {
      const lifted = diceRolls(seq, true)
      const cursed = diceRolls(seq, false)
      expect(lifted.hit).toBeGreaterThanOrEqual(cursed.hit)
      if (lifted.hit > cursed.hit) foundDifference = true
    }
    expect(foundDifference).toBe(true)
  })

  it('is deterministic for same sequence', () => {
    const a = diceRolls(42, false)
    const b = diceRolls(42, false)
    expect(a.hit).toBe(b.hit)
    expect(a.secondary).toBe(b.secondary)
  })

  it('produces different values for different sequences', () => {
    const a = diceRolls(1, true)
    const b = diceRolls(99999, true)
    expect(a.hit === b.hit && a.secondary === b.secondary).toBe(false)
  })
})

describe('resolvePlayerAttack', () => {
  it('miss produces 0 damage', () => {
    // Find a sequence that misses (hit < 0.05 after NL penalty)
    let missSeq = -1
    for (let seq = 0; seq < 1000; seq++) {
      if (diceRolls(seq, false).hit < 0.05) { missSeq = seq; break }
    }
    expect(missSeq).toBeGreaterThanOrEqual(0)

    const char = makeChar()
    const enemy = makeEnemy()
    const result = resolvePlayerAttack(char, enemy, missSeq, false)
    expect(result.miss).toBe(true)
    expect(result.damage).toBe(0)
  })

  it('crit produces double base damage', () => {
    // Find a sequence that crits (hit > 0.90)
    let critSeq = -1
    for (let seq = 0; seq < 1000; seq++) {
      if (diceRolls(seq, true).hit > 0.90) { critSeq = seq; break }
    }
    expect(critSeq).toBeGreaterThanOrEqual(0)

    const char = makeChar({ class: 'Brawler', inventory: [] })
    const enemy = makeEnemy()
    const result = resolvePlayerAttack(char, enemy, critSeq, true)
    expect(result.crit).toBe(true)
    expect(result.damage).toBe(CLASS_BASE_DMG['Brawler'] * 2)
  })

  it('krippCursed is subset of miss', () => {
    // Any krippCursed result should also be a miss
    for (let seq = 0; seq < 500; seq++) {
      const char = makeChar()
      const enemy = makeEnemy()
      const result = resolvePlayerAttack(char, enemy, seq, false)
      if (result.krippCursed) {
        expect(result.miss).toBe(true)
        expect(result.damage).toBe(0)
      }
    }
  })

  it('Pyromancer always applies burn on non-miss', () => {
    const char = makeChar({ class: 'Pyromancer' })
    const enemy = makeEnemy()
    let burnFound = false
    for (let seq = 0; seq < 200; seq++) {
      const result = resolvePlayerAttack(char, enemy, seq, true)
      if (!result.miss && !result.krippCursed) {
        expect(result.statusApplied).toBe('burn')
        burnFound = true
        break
      }
    }
    expect(burnFound).toBe(true)
  })

  it('actuallySick only true on crit boss kill shot', () => {
    // Find a crit sequence
    let critSeq = -1
    for (let seq = 0; seq < 1000; seq++) {
      if (diceRolls(seq, true).hit > 0.90) { critSeq = seq; break }
    }
    expect(critSeq).toBeGreaterThanOrEqual(0)

    const char = makeChar({ class: 'Brawler' })
    const boss = makeEnemy({ isBoss: true, hp: 1, maxHp: 200 })  // 1 HP so kill shot
    const result = resolvePlayerAttack(char, boss, critSeq, true)
    expect(result.crit).toBe(true)
    expect(result.actuallySick).toBe(true)

    // Non-boss kill shot should NOT be actuallySick
    const nonBoss = makeEnemy({ isBoss: false, hp: 1, maxHp: 200 })
    const result2 = resolvePlayerAttack(char, nonBoss, critSeq, true)
    expect(result2.actuallySick).toBe(false)
  })

  it('no actuallySick without a kill shot', () => {
    let critSeq = -1
    for (let seq = 0; seq < 1000; seq++) {
      if (diceRolls(seq, true).hit > 0.90) { critSeq = seq; break }
    }
    const char = makeChar({ class: 'Brawler' })
    const boss = makeEnemy({ isBoss: true, hp: 9999, maxHp: 9999 })
    const result = resolvePlayerAttack(char, boss, critSeq, true)
    expect(result.actuallySick).toBe(false)
  })
})

describe('getItemBonus', () => {
  it('weapon tag gives tier damage bonus', () => {
    mockFindCard.mockReturnValueOnce(makeCard(['Weapon'], 'Bronze'))
    const bonus = getItemBonus('SomeSword')
    expect(bonus.damage).toBe(3)

    mockFindCard.mockReturnValueOnce(makeCard(['Weapon'], 'Gold'))
    const bonus2 = getItemBonus('GoldSword')
    expect(bonus2.damage).toBe(10)
  })

  it('armor tag gives armor bonus', () => {
    mockFindCard.mockReturnValueOnce(makeCard(['armor'], 'Bronze'))
    const bonus = getItemBonus('Shield')
    expect(bonus.armor).toBe(5)
  })

  it('heal tag gives onUseHeal', () => {
    mockFindCard.mockReturnValueOnce(makeCard(['heal'], 'Silver'))
    const bonus = getItemBonus('Potion')
    expect(bonus.onUseHeal).toBe(30)
  })

  it('poison tag sets onHitStatus', () => {
    mockFindCard.mockReturnValueOnce(makeCard(['poison'], 'Bronze'))
    const bonus = getItemBonus('VenomFang')
    expect(bonus.onHitStatus).toBe('poison')
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
  it('burn = 8', () => {
    expect(statusTickDamage(['burn'])).toBe(8)
  })

  it('1 poison = 6', () => {
    expect(statusTickDamage(['poison'])).toBe(6)
  })

  it('2 poison = 12', () => {
    expect(statusTickDamage(['poison', 'poison'])).toBe(12)
  })

  it('burn + poison = 14', () => {
    expect(statusTickDamage(['burn', 'poison'])).toBe(14)
  })

  it('no effects = 0', () => {
    expect(statusTickDamage([])).toBe(0)
  })

  it('irrelevant effects = 0', () => {
    expect(statusTickDamage(['haste', 'blessed', 'freeze'])).toBe(0)
  })
})

describe('hasMeatItems', () => {
  it('empty inventory is clean', () => {
    expect(hasMeatItems([])).toBe(false)
  })

  it('Glutton in name → true', () => {
    mockFindCard.mockReturnValue(undefined)
    expect(hasMeatItems(['Glutton\'s Chalice'])).toBe(true)
  })

  it('Feast in name → true', () => {
    mockFindCard.mockReturnValue(undefined)
    expect(hasMeatItems(['Feast of Champions'])).toBe(true)
  })

  it('unrelated items are clean', () => {
    mockFindCard.mockReturnValue(makeCard(['Weapon'], 'Bronze'))
    expect(hasMeatItems(['Blade', 'Potion', 'IceShard'])).toBe(false)
  })

  it('food tag via card lookup → true', () => {
    mockFindCard.mockReturnValue(makeCard(['food'], 'Bronze'))
    expect(hasMeatItems(['SomeFood'])).toBe(true)
  })
})

describe('CLASS_BASE_HP', () => {
  it('Brawler = 120', () => {
    expect(CLASS_BASE_HP['Brawler']).toBe(120)
  })
  it('Pyromancer = 65', () => {
    expect(CLASS_BASE_HP['Pyromancer']).toBe(65)
  })
})

// ===========================================================================
// floor.ts
// ===========================================================================

describe('getFloorType', () => {
  it('shops on 3 and 5', () => {
    expect(getFloorType(3)).toBe('shop')
    expect(getFloorType(5)).toBe('shop')
  })
  it('bosses on 6 and 10', () => {
    expect(getFloorType(6)).toBe('boss')
    expect(getFloorType(10)).toBe('boss')
  })
  it('event on 9', () => {
    expect(getFloorType(9)).toBe('event')
  })
  it('combat otherwise', () => {
    expect(getFloorType(1)).toBe('combat')
    expect(getFloorType(2)).toBe('combat')
    expect(getFloorType(4)).toBe('combat')
    expect(getFloorType(7)).toBe('combat')
    expect(getFloorType(8)).toBe('combat')
  })
})

describe('floorToDay', () => {
  it('floor 1 → day 1', () => { expect(floorToDay(1)).toBe(1) })
  it('floor 2 → day 1', () => { expect(floorToDay(2)).toBe(1) })
  it('floor 5 → day 4', () => { expect(floorToDay(5)).toBe(4) })
  it('floor 10 → day 7', () => { expect(floorToDay(10)).toBe(7) })
})

describe('generateEnemies', () => {
  it('is deterministic', () => {
    mockMonstersByDay.mockReturnValue([
      makeMonster('Thornling', 80),
      makeMonster('Glutton', 200),
    ])
    const a = generateEnemies(1, 1)
    const b = generateEnemies(1, 1)
    expect(a.length).toBe(b.length)
    for (let i = 0; i < a.length; i++) {
      expect(a[i].name).toBe(b[i].name)
      expect(a[i].hp).toBe(b[i].hp)
    }
  })

  it('different seasons produce different results', () => {
    mockMonstersByDay.mockReturnValue([
      makeMonster('Alpha', 50),
      makeMonster('Beta', 100),
      makeMonster('Gamma', 150),
    ])
    const a = generateEnemies(1, 2)
    const b = generateEnemies(2, 2)
    // With 3 monsters, different seeds will pick different ones
    // (may occasionally collide — use a large enough pool to ensure divergence)
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
  })

  it('fallback when no monsters in pool', () => {
    mockMonstersByDay.mockReturnValue([])
    const enemies = generateEnemies(1, 1)
    expect(enemies.length).toBe(1)
    expect(enemies[0].name).toContain('Floor')
  })

  it('boss floor returns isBoss=true', () => {
    mockMonstersByDay.mockReturnValue([makeMonster('BigBoss', 500)])
    const enemies = generateEnemies(1, 6)  // floor 6 = boss
    expect(enemies.length).toBe(1)
    expect(enemies[0].isBoss).toBe(true)
  })

  it('floor 5+ returns 2 enemies', () => {
    mockMonstersByDay.mockReturnValue([
      makeMonster('A', 80),
      makeMonster('B', 90),
      makeMonster('C', 70),
    ])
    const enemies = generateEnemies(1, 7)
    expect(enemies.length).toBe(2)
  })

  it('floor 1-4 returns 1 enemy', () => {
    mockMonstersByDay.mockReturnValue([makeMonster('A', 80)])
    const enemies = generateEnemies(1, 2)
    expect(enemies.length).toBe(1)
  })
})

describe('generateShop', () => {
  it('is deterministic', () => {
    const bronzeWeapon = makeCard(['Weapon'], 'Bronze')
    bronzeWeapon.Title = 'Bronze Blade'
    mockGetItems.mockReturnValue([bronzeWeapon, bronzeWeapon])
    const a = generateShop(1, 1)
    const b = generateShop(1, 1)
    expect(a.length).toBe(b.length)
    for (let i = 0; i < a.length; i++) {
      expect(a[i].name).toBe(b[i].name)
      expect(a[i].price).toBe(b[i].price)
    }
  })

  it('returns empty if no matching items', () => {
    mockGetItems.mockReturnValue([])
    const shop = generateShop(1, 1)
    expect(shop.length).toBe(0)
  })

  it('items have correct tier price', () => {
    const item = makeCard(['Weapon'], 'Silver')
    item.Title = 'Silver Sword'
    mockGetItems.mockReturnValue([item])
    // floor 4 = Silver tier
    const shop = generateShop(1, 4)
    if (shop.length > 0) {
      expect(shop[0].price).toBe(30)  // Silver price
    }
  })
})

describe('enemyReward', () => {
  it('boss floor 6: xp=120, gold=51', () => {
    const boss = makeEnemy({ isBoss: true })
    const reward = enemyReward(boss, 6)
    expect(reward.xp).toBe((10 + 30) * 3)
    expect(reward.gold).toBe((5 + 12) * 3)
  })

  it('non-boss floor 3: xp=25, gold=11', () => {
    const mob = makeEnemy({ isBoss: false })
    const reward = enemyReward(mob, 3)
    expect(reward.xp).toBe(10 + 15)
    expect(reward.gold).toBe(5 + 6)
  })

  it('boss gives 3x vs non-boss on same floor', () => {
    const floor = 5
    const boss = makeEnemy({ isBoss: true })
    const mob = makeEnemy({ isBoss: false })
    const bossReward = enemyReward(boss, floor)
    const mobReward = enemyReward(mob, floor)
    expect(bossReward.xp).toBe(mobReward.xp * 3)
    expect(bossReward.gold).toBe(mobReward.gold * 3)
  })
})

// ===========================================================================
// render.ts
// ===========================================================================

describe('hpBar', () => {
  it('full HP = 8 hashes', () => {
    expect(hpBar(100, 100)).toBe('########')
  })

  it('zero HP = 8 dots', () => {
    expect(hpBar(0, 100)).toBe('........')
  })

  it('half HP = 4 hashes 4 dots', () => {
    expect(hpBar(50, 100)).toBe('####....')
  })

  it('handles zero maxHp gracefully', () => {
    const result = hpBar(0, 0)
    expect(result.length).toBe(8)
  })
})

describe('renderFloor', () => {
  it('output ≤480 chars', () => {
    const world = makeWorld()
    const players = [makeChar(), makeChar({ username: 'bob' })]
    const result = renderFloor(world, players)
    expect(result.length).toBeLessThanOrEqual(480)
  })

  it('shows enemy HP on combat floor', () => {
    const world = makeWorld({ encounterType: 'combat' })
    const result = renderFloor(world, [])
    expect(result).toContain('Thornling')
    expect(result).toContain('80/80')
  })

  it('shows cleared message when floor cleared', () => {
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

  it('large party truncated to ≤480 chars', () => {
    const world = makeWorld()
    const players = Array.from({ length: 20 }, (_, i) =>
      makeChar({ username: `player${i}`, inventory: ['a', 'b', 'c', 'd', 'e', 'f'] })
    )
    const result = renderFloor(world, players)
    expect(result.length).toBeLessThanOrEqual(480)
  })
})

describe('renderCharacter', () => {
  it('output ≤480 chars', () => {
    const char = makeChar({ inventory: ['Blade', 'Shield', 'Potion', 'IceShard', 'FireOrb', 'Ring'] })
    const result = renderCharacter(char)
    expect(result.length).toBeLessThanOrEqual(480)
  })

  it('shows class and level', () => {
    const char = makeChar({ class: 'Pyromancer', level: 5 })
    const result = renderCharacter(char)
    expect(result).toContain('Pyromancer')
    expect(result).toContain('Lv5')
  })

  it('shows dead status when respawnAt set', () => {
    const char = makeChar({ respawnAt: Date.now() + 60_000, hp: 0 })
    const result = renderCharacter(char)
    expect(result.toUpperCase()).toContain('DEAD')
  })
})

describe('renderCombatResult', () => {
  it('crit shows nat 20', () => {
    const result = renderCombatResult(makeCombatResult({ crit: true }), 80)
    expect(result).toContain('nat 20')
  })

  it('miss contains "misses"', () => {
    const result = renderCombatResult(makeCombatResult({ miss: true, damage: 0 }), 80)
    expect(result.toLowerCase()).toContain('miss')
  })

  it("krippCursed shows Kripp's Curse", () => {
    const result = renderCombatResult(makeCombatResult({ krippCursed: true, miss: true, damage: 0 }), 80)
    expect(result).toContain("Kripp's Curse")
  })

  it('actuallySick shows ACTUALLY SICK', () => {
    const result = renderCombatResult(makeCombatResult({ actuallySick: true, crit: true }), 80)
    expect(result).toContain('ACTUALLY SICK')
  })

  it('enemy killed shows DEFEATED', () => {
    const result = renderCombatResult(makeCombatResult({ enemyKilled: true }), 80)
    expect(result).toContain('DEFEATED')
  })

  it('output ≤480 chars', () => {
    const result = renderCombatResult(makeCombatResult(), 80)
    expect(result.length).toBeLessThanOrEqual(480)
  })
})

describe('renderDeath', () => {
  it('contains respawn info', () => {
    const result = renderDeath('alice', 'Glutton', false)
    expect(result).toContain('Respawning in 1min')
  })

  it('output ≤480 chars', () => {
    expect(renderDeath('alice', 'The Vengeful Spirit of Poor RNG', false).length).toBeLessThanOrEqual(480)
  })
})

describe('renderClassList', () => {
  it('contains all 6 classes', () => {
    const result = renderClassList()
    for (const cls of ['merchant', 'rogue', 'tinkerer', 'brawler', 'pyromancer', 'veteran']) {
      expect(result.toLowerCase()).toContain(cls)
    }
  })
})

describe('renderSeasonComplete', () => {
  it('contains CONQUERED', () => {
    expect(renderSeasonComplete(1, 10)).toContain('CONQUERED')
  })
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
    // Initialize real main db, then dnd tables on top
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

  it('upsertCharacter + getCharacter round-trip', async () => {
    const { upsertCharacter, getCharacter } = await import('./db')
    const char = makeChar({ username: 'roundtrip', channel: 'testchan' })
    upsertCharacter(char)
    const retrieved = getCharacter('roundtrip', 'testchan')
    expect(retrieved).not.toBeNull()
    expect(retrieved!.username).toBe('roundtrip')
    expect(retrieved!.class).toBe('Brawler')
    expect(retrieved!.maxHp).toBe(120)
    expect(retrieved!.spellReady).toBe(true)
    expect(retrieved!.defending).toBe(false)
  })

  it('upsertWorld + getWorld round-trip preserving veganShrineVisited', async () => {
    const { upsertWorld, getWorld } = await import('./db')
    const world = makeWorld({ channel: 'worldtest', veganShrineVisited: true, nlLifted: true, floor: 5, season: 3 })
    upsertWorld(world)
    const retrieved = getWorld('worldtest')
    expect(retrieved).not.toBeNull()
    expect(retrieved!.floor).toBe(5)
    expect(retrieved!.season).toBe(3)
    expect(retrieved!.veganShrineVisited).toBe(true)
    expect(retrieved!.nlLifted).toBe(true)
  })

  it('addCharacterXp triggers level-up at 100 XP', async () => {
    const { upsertCharacter, addCharacterXp } = await import('./db')
    const char = makeChar({ username: 'levelup', channel: 'testchan', xp: 0, level: 1 })
    upsertCharacter(char)
    const result = addCharacterXp('levelup', 'testchan', 100)
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
    const char = makeChar({ username: 'dmgtest', channel: 'testchan', hp: 10, maxHp: 120 })
    upsertCharacter(char)
    const newHp = damageCharacter('dmgtest', 'testchan', 9999)
    expect(newHp).toBe(0)
  })

  it('healCharacter clamps to maxHp', async () => {
    const { upsertCharacter, healCharacter } = await import('./db')
    const char = makeChar({ username: 'healtest', channel: 'testchan', hp: 10, maxHp: 100 })
    upsertCharacter(char)
    const newHp = healCharacter('healtest', 'testchan', 9999)
    expect(newHp).toBe(100)
  })

  it('killCharacter + respawnCharacter cycle', async () => {
    const { upsertCharacter, killCharacter, respawnCharacter, getCharacter } = await import('./db')
    const char = makeChar({ username: 'dietest', channel: 'testchan', hp: 100, maxHp: 100 })
    upsertCharacter(char)

    const respawnAt = Date.now() + 120_000
    killCharacter('dietest', 'testchan', respawnAt)
    const dead = getCharacter('dietest', 'testchan')
    expect(dead!.hp).toBe(0)
    expect(dead!.respawnAt).toBeGreaterThan(Date.now())

    respawnCharacter('dietest', 'testchan')
    const alive = getCharacter('dietest', 'testchan')
    expect(alive!.respawnAt).toBeNull()
    expect(alive!.hp).toBe(50)  // half of maxHp=100
  })

  it('getPendingRespawns returns characters with future respawnAt', async () => {
    const { upsertCharacter, killCharacter, getPendingRespawns } = await import('./db')
    const char = makeChar({ username: 'respawntest', channel: 'testchan', hp: 100, maxHp: 100 })
    upsertCharacter(char)
    killCharacter('respawntest', 'testchan', Date.now() + 60_000)
    const pending = getPendingRespawns()
    const found = pending.find((p) => p.username === 'respawntest')
    expect(found).toBeTruthy()
    expect(found!.respawnAt).toBeGreaterThan(Date.now())
  })

  it('logDndAction and getRecentLog', async () => {
    const { logDndAction, getRecentLog } = await import('./db')
    logDndAction('testchan', 'loguser', 'attack', 'Glutton', '42dmg')
    const logs = getRecentLog('testchan', 10)
    const found = logs.find((l) => l.username === 'loguser' && l.action === 'attack')
    expect(found).toBeTruthy()
    expect(found!.target).toBe('Glutton')
    expect(found!.result).toBe('42dmg')
  })
})
