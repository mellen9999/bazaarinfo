import type { Statement } from 'bun:sqlite'
import { getDb } from '../db'
import { log } from '../log'
import { CLASS_BASE_STATS, calcMaxHp, calcMaxSpellSlots, getModifier } from './types'
import type { Character, WorldState, EncounterType, ShopItem, Enemy, AbilityScores } from './types'
import { getClassDef, registerClassDef } from './classdef'
import type { ClassDef, Chassis } from './classdef'

let stmts: {
  getChar: Statement
  upsertChar: Statement
  getWorld: Statement
  upsertWorld: Statement
  getActivePlayers: Statement
  getAllChars: Statement
  incrSequence: Statement
  getSequence: Statement
  damageChar: Statement
  healChar: Statement
  killChar: Statement
  respawnChar: Statement
  setDying: Statement
  setDeathSaves: Statement
  stabilizeChar: Statement
  getXpLevel: Statement
  setXpLevel: Statement
  logAction: Statement
  getLog: Statement
  getDeadChars: Statement
  getAllDeadChars: Statement
}

export function initDndDb(): void {
  const db = getDb()

  db.run(`CREATE TABLE IF NOT EXISTS dnd_characters (
    username TEXT NOT NULL,
    channel TEXT NOT NULL,
    class TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 1,
    xp INTEGER NOT NULL DEFAULT 0,
    hp INTEGER NOT NULL DEFAULT 100,
    max_hp INTEGER NOT NULL DEFAULT 100,
    gold INTEGER NOT NULL DEFAULT 10,
    inventory TEXT NOT NULL DEFAULT '[]',
    status_effects TEXT NOT NULL DEFAULT '[]',
    deaths INTEGER NOT NULL DEFAULT 0,
    total_kills INTEGER NOT NULL DEFAULT 0,
    spell_ready INTEGER NOT NULL DEFAULT 1,
    defending INTEGER NOT NULL DEFAULT 0,
    last_action_at INTEGER NOT NULL DEFAULT 0,
    respawn_at INTEGER,
    PRIMARY KEY (username, channel)
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS dnd_world (
    channel TEXT PRIMARY KEY,
    floor INTEGER NOT NULL DEFAULT 1,
    action_sequence INTEGER NOT NULL DEFAULT 0,
    encounter_type TEXT NOT NULL DEFAULT 'combat',
    enemies TEXT NOT NULL DEFAULT '[]',
    floor_cleared INTEGER NOT NULL DEFAULT 0,
    scene TEXT NOT NULL DEFAULT '',
    season INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    nl_lifted INTEGER NOT NULL DEFAULT 0,
    shop_inventory TEXT NOT NULL DEFAULT '[]',
    vegan_shrine_visited INTEGER NOT NULL DEFAULT 0
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS dnd_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    username TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    result TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`)

  db.run(`CREATE INDEX IF NOT EXISTS idx_dnd_log_channel ON dnd_log(channel, created_at)`)

  // custom (AI-generated / synthesized) class definitions, cached by normalized name
  db.run(`CREATE TABLE IF NOT EXISTS dnd_classes (
    name_norm TEXT PRIMARY KEY,
    display TEXT NOT NULL,
    chassis TEXT NOT NULL,
    base_stats TEXT NOT NULL,
    hit_die INTEGER NOT NULL,
    atk_stat TEXT NOT NULL,
    weapon_name TEXT NOT NULL,
    weapon_die INTEGER NOT NULL,
    weapon_count INTEGER NOT NULL,
    ac_archetype TEXT NOT NULL,
    save_profs TEXT NOT NULL,
    signature TEXT NOT NULL,
    role TEXT NOT NULL,
    descr TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'ai',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`)

  // inline migrations — safe to re-run, fail silently if column exists
  const CHAR_MIGRATIONS = [
    `ALTER TABLE dnd_characters ADD COLUMN prestige INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE dnd_characters ADD COLUMN achievements TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE dnd_characters ADD COLUMN stats TEXT NOT NULL DEFAULT '{"str":10,"dex":10,"con":10,"int":10,"wis":10,"cha":10}'`,
    `ALTER TABLE dnd_characters ADD COLUMN spell_slots INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE dnd_characters ADD COLUMN max_spell_slots INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE dnd_characters ADD COLUMN hit_dice INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE dnd_characters ADD COLUMN max_hit_dice INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE dnd_characters ADD COLUMN ki_points INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE dnd_characters ADD COLUMN max_ki_points INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE dnd_characters ADD COLUMN rage_charges INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE dnd_characters ADD COLUMN rage_turns_left INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE dnd_characters ADD COLUMN action_surge_used INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE dnd_characters ADD COLUMN is_dying INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE dnd_characters ADD COLUMN death_successes INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE dnd_characters ADD COLUMN death_failures INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE dnd_world ADD COLUMN long_rest_counter INTEGER NOT NULL DEFAULT 0`,
  ]
  for (const sql of CHAR_MIGRATIONS) {
    try { db.run(sql) } catch { /* already exists */ }
  }

  // class rename migration: old Bazaar classes → D&D names
  const CLASS_RENAMES: Record<string, string> = {
    Merchant: 'Warlock', Tinkerer: 'Fighter', Brawler: 'Barbarian',
    Pyromancer: 'Sorcerer', Veteran: 'Paladin',
  }
  for (const [old, newCls] of Object.entries(CLASS_RENAMES)) {
    try {
      db.run(`UPDATE dnd_characters SET class = '${newCls}' WHERE class = '${old}'`)
    } catch { /* ignore */ }
  }

  // populate stats + max_hp for characters that still have defaults
  try {
    const rows = db.query(`SELECT username, channel, class, level FROM dnd_characters WHERE stats = '{"str":10,"dex":10,"con":10,"int":10,"wis":10,"cha":10}'`).all() as { username: string; channel: string; class: string; level: number }[]
    for (const row of rows) {
      const baseStats = CLASS_BASE_STATS[row.class] ?? { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }
      const newMaxHp = calcMaxHp(row.class, row.level, baseStats.con)
      const slots = calcMaxSpellSlots(row.class, row.level)
      db.run(
        `UPDATE dnd_characters SET stats = ?, max_hp = ?, hp = MIN(hp, ?), max_spell_slots = ?, spell_slots = ? WHERE username = ? AND channel = ?`,
        [JSON.stringify(baseStats), newMaxHp, newMaxHp, slots, slots, row.username, row.channel]
      )
    }
  } catch { /* ignore on fresh DB */ }

  stmts = {
    getChar: db.prepare('SELECT * FROM dnd_characters WHERE username = ? AND channel = ?'),
    upsertChar: db.prepare(`INSERT INTO dnd_characters
      (username, channel, class, level, xp, hp, max_hp, gold, inventory, status_effects,
       deaths, total_kills, defending, last_action_at, respawn_at, prestige, achievements,
       stats, spell_slots, max_spell_slots, hit_dice, max_hit_dice,
       ki_points, max_ki_points, rage_charges, rage_turns_left, action_surge_used,
       is_dying, death_successes, death_failures)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(username, channel) DO UPDATE SET
        class=excluded.class, level=excluded.level, xp=excluded.xp,
        hp=excluded.hp, max_hp=excluded.max_hp, gold=excluded.gold,
        inventory=excluded.inventory, status_effects=excluded.status_effects,
        deaths=excluded.deaths, total_kills=excluded.total_kills,
        defending=excluded.defending,
        last_action_at=excluded.last_action_at, respawn_at=excluded.respawn_at,
        prestige=excluded.prestige, achievements=excluded.achievements,
        stats=excluded.stats,
        spell_slots=excluded.spell_slots, max_spell_slots=excluded.max_spell_slots,
        hit_dice=excluded.hit_dice, max_hit_dice=excluded.max_hit_dice,
        ki_points=excluded.ki_points, max_ki_points=excluded.max_ki_points,
        rage_charges=excluded.rage_charges, rage_turns_left=excluded.rage_turns_left,
        action_surge_used=excluded.action_surge_used,
        is_dying=excluded.is_dying, death_successes=excluded.death_successes,
        death_failures=excluded.death_failures`),
    getWorld: db.prepare('SELECT * FROM dnd_world WHERE channel = ?'),
    upsertWorld: db.prepare(`INSERT INTO dnd_world
      (channel, floor, action_sequence, encounter_type, enemies, floor_cleared,
       scene, season, enabled, nl_lifted, shop_inventory, vegan_shrine_visited, long_rest_counter)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(channel) DO UPDATE SET
        floor=excluded.floor, action_sequence=excluded.action_sequence,
        encounter_type=excluded.encounter_type, enemies=excluded.enemies,
        floor_cleared=excluded.floor_cleared, scene=excluded.scene,
        season=excluded.season, enabled=excluded.enabled,
        nl_lifted=excluded.nl_lifted, shop_inventory=excluded.shop_inventory,
        vegan_shrine_visited=excluded.vegan_shrine_visited,
        long_rest_counter=excluded.long_rest_counter`),
    getActivePlayers: db.prepare(
      `SELECT * FROM dnd_characters WHERE channel = ? AND last_action_at > ?`
    ),
    getAllChars: db.prepare('SELECT * FROM dnd_characters WHERE channel = ? ORDER BY level DESC, xp DESC'),
    incrSequence: db.prepare(
      `UPDATE dnd_world SET action_sequence = action_sequence + 1 WHERE channel = ?`
    ),
    getSequence: db.prepare('SELECT action_sequence FROM dnd_world WHERE channel = ?'),
    damageChar: db.prepare(
      `UPDATE dnd_characters SET hp = MAX(0, hp - ?) WHERE username = ? AND channel = ? RETURNING hp`
    ),
    healChar: db.prepare(
      `UPDATE dnd_characters SET hp = MIN(max_hp, hp + ?), is_dying = 0, death_successes = 0, death_failures = 0 WHERE username = ? AND channel = ? RETURNING hp, max_hp`
    ),
    killChar: db.prepare(
      `UPDATE dnd_characters SET hp = 0, deaths = deaths + 1, respawn_at = ?, is_dying = 0, death_successes = 0, death_failures = 0 WHERE username = ? AND channel = ?`
    ),
    respawnChar: db.prepare(
      `UPDATE dnd_characters SET respawn_at = NULL, hp = MAX(1, max_hp / 2), defending = 0, status_effects = '[]', is_dying = 0, death_successes = 0, death_failures = 0
       WHERE username = ? AND channel = ?`
    ),
    setDying: db.prepare(
      `UPDATE dnd_characters SET is_dying = ?, death_successes = 0, death_failures = 0 WHERE username = ? AND channel = ?`
    ),
    setDeathSaves: db.prepare(
      `UPDATE dnd_characters SET death_successes = ?, death_failures = ? WHERE username = ? AND channel = ?`
    ),
    stabilizeChar: db.prepare(
      `UPDATE dnd_characters SET is_dying = 0, death_successes = 0, death_failures = 0 WHERE username = ? AND channel = ?`
    ),
    getXpLevel: db.prepare('SELECT xp, level, max_hp, class, stats FROM dnd_characters WHERE username = ? AND channel = ?'),
    setXpLevel: db.prepare(
      `UPDATE dnd_characters SET xp = ?, level = ?, max_hp = ?, hp = MIN(hp + ?, max_hp + ?)
       WHERE username = ? AND channel = ?`
    ),
    logAction: db.prepare(
      'INSERT INTO dnd_log (channel, username, action, target, result) VALUES (?, ?, ?, ?, ?)'
    ),
    getLog: db.prepare(
      'SELECT username, action, target, result, created_at FROM dnd_log WHERE channel = ? ORDER BY created_at DESC LIMIT ?'
    ),
    getDeadChars: db.prepare(
      `SELECT username, channel, respawn_at FROM dnd_characters WHERE respawn_at IS NOT NULL AND respawn_at > ?`
    ),
    getAllDeadChars: db.prepare(
      `SELECT * FROM dnd_characters WHERE channel = ? AND respawn_at IS NOT NULL`
    ),
  }

  loadClassDefs()

  log('dnd: db initialized')
}

// --- custom class definitions ---
function rowToClassDef(row: Record<string, unknown>): ClassDef {
  return {
    name: row.display as string,
    chassis: row.chassis as Chassis,
    baseStats: JSON.parse(row.base_stats as string) as AbilityScores,
    hitDie: row.hit_die as number,
    atkStat: row.atk_stat as keyof AbilityScores,
    weapon: { name: row.weapon_name as string, die: row.weapon_die as number, count: row.weapon_count as number },
    acArchetype: row.ac_archetype as ClassDef['acArchetype'],
    saveProfs: JSON.parse(row.save_profs as string) as ClassDef['saveProfs'],
    signature: row.signature as string,
    role: row.role as string,
    desc: row.descr as string,
    builtin: false,
  }
}

export function loadClassDefs(): void {
  try {
    const rows = getDb().query('SELECT * FROM dnd_classes').all() as Record<string, unknown>[]
    for (const row of rows) registerClassDef(rowToClassDef(row))
    if (rows.length > 0) log(`dnd: loaded ${rows.length} custom classes`)
  } catch (e) {
    log(`dnd: loadClassDefs error: ${e}`)
  }
}

export function saveClassDef(nameNorm: string, def: ClassDef, source: 'ai' | 'synthetic'): void {
  try {
    getDb().run(
      `INSERT INTO dnd_classes
        (name_norm, display, chassis, base_stats, hit_die, atk_stat, weapon_name, weapon_die,
         weapon_count, ac_archetype, save_profs, signature, role, descr, source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(name_norm) DO NOTHING`,
      [
        nameNorm, def.name, def.chassis, JSON.stringify(def.baseStats), def.hitDie, def.atkStat,
        def.weapon.name, def.weapon.die, def.weapon.count, def.acArchetype,
        JSON.stringify(def.saveProfs), def.signature, def.role, def.desc, source,
      ],
    )
  } catch (e) {
    log(`dnd: saveClassDef error: ${e}`)
  }
}

function rowToChar(row: Record<string, unknown>): Character {
  const defaultStats = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }
  return {
    username: row.username as string,
    channel: row.channel as string,
    class: row.class as string,
    level: row.level as number,
    xp: row.xp as number,
    hp: row.hp as number,
    maxHp: row.max_hp as number,
    gold: row.gold as number,
    inventory: JSON.parse(row.inventory as string) as string[],
    statusEffects: JSON.parse(row.status_effects as string) as string[],
    deaths: row.deaths as number,
    totalKills: row.total_kills as number,
    defending: (row.defending as number) === 1,
    lastActionAt: row.last_action_at as number,
    respawnAt: row.respawn_at as number | null,
    prestige: (row.prestige as number) ?? 0,
    achievements: JSON.parse((row.achievements as string) ?? '[]') as string[],
    stats: JSON.parse((row.stats as string) ?? JSON.stringify(defaultStats)) as AbilityScores,
    spellSlots: (row.spell_slots as number) ?? 0,
    maxSpellSlots: (row.max_spell_slots as number) ?? 0,
    hitDice: (row.hit_dice as number) ?? 1,
    maxHitDice: (row.max_hit_dice as number) ?? 1,
    kiPoints: (row.ki_points as number) ?? 0,
    maxKiPoints: (row.max_ki_points as number) ?? 0,
    rageCharges: (row.rage_charges as number) ?? 0,
    rageTurnsLeft: (row.rage_turns_left as number) ?? 0,
    actionSurgeUsed: (row.action_surge_used as number) === 1,
    isDying: (row.is_dying as number) === 1,
    deathSuccesses: (row.death_successes as number) ?? 0,
    deathFailures: (row.death_failures as number) ?? 0,
  }
}

function rowToWorld(row: Record<string, unknown>): WorldState {
  return {
    channel: row.channel as string,
    floor: row.floor as number,
    actionSequence: row.action_sequence as number,
    encounterType: row.encounter_type as EncounterType,
    enemies: JSON.parse(row.enemies as string) as Enemy[],
    floorCleared: (row.floor_cleared as number) === 1,
    scene: row.scene as string,
    season: row.season as number,
    enabled: (row.enabled as number) === 1,
    nlLifted: (row.nl_lifted as number) === 1,
    shopInventory: JSON.parse(row.shop_inventory as string) as ShopItem[],
    veganShrineVisited: (row.vegan_shrine_visited as number) === 1,
    longRestCounter: (row.long_rest_counter as number) ?? 0,
  }
}

export function getCharacter(username: string, channel: string): Character | null {
  try {
    const row = stmts.getChar.get(username.toLowerCase(), channel.toLowerCase()) as Record<string, unknown> | null
    return row ? rowToChar(row) : null
  } catch (e) {
    log(`dnd: getCharacter error: ${e}`)
    return null
  }
}

export function upsertCharacter(char: Character): void {
  try {
    stmts.upsertChar.run(
      char.username.toLowerCase(), char.channel.toLowerCase(),
      char.class, char.level, char.xp, char.hp, char.maxHp, char.gold,
      JSON.stringify(char.inventory), JSON.stringify(char.statusEffects),
      char.deaths, char.totalKills,
      char.defending ? 1 : 0,
      char.lastActionAt, char.respawnAt ?? null,
      char.prestige ?? 0, JSON.stringify(char.achievements ?? []),
      JSON.stringify(char.stats),
      char.spellSlots, char.maxSpellSlots,
      char.hitDice, char.maxHitDice,
      char.kiPoints, char.maxKiPoints,
      char.rageCharges, char.rageTurnsLeft,
      char.actionSurgeUsed ? 1 : 0,
      char.isDying ? 1 : 0,
      char.deathSuccesses, char.deathFailures,
    )
  } catch (e) {
    log(`dnd: upsertCharacter error: ${e}`)
  }
}

export function getWorld(channel: string): WorldState | null {
  try {
    const row = stmts.getWorld.get(channel.toLowerCase()) as Record<string, unknown> | null
    return row ? rowToWorld(row) : null
  } catch (e) {
    log(`dnd: getWorld error: ${e}`)
    return null
  }
}

export function upsertWorld(world: WorldState): void {
  try {
    stmts.upsertWorld.run(
      world.channel.toLowerCase(),
      world.floor, world.actionSequence, world.encounterType,
      JSON.stringify(world.enemies), world.floorCleared ? 1 : 0,
      world.scene, world.season, world.enabled ? 1 : 0,
      world.nlLifted ? 1 : 0,
      JSON.stringify(world.shopInventory),
      world.veganShrineVisited ? 1 : 0,
      world.longRestCounter ?? 0,
    )
  } catch (e) {
    log(`dnd: upsertWorld error: ${e}`)
  }
}

// players active in last 10 minutes
export function getActivePlayers(channel: string): Character[] {
  try {
    const cutoff = Date.now() - 10 * 60 * 1000
    const rows = stmts.getActivePlayers.all(channel.toLowerCase(), cutoff) as Record<string, unknown>[]
    return rows.map(rowToChar)
  } catch (e) {
    log(`dnd: getActivePlayers error: ${e}`)
    return []
  }
}

export function getAllCharacters(channel: string): Character[] {
  try {
    const rows = stmts.getAllChars.all(channel.toLowerCase()) as Record<string, unknown>[]
    return rows.map(rowToChar)
  } catch (e) {
    log(`dnd: getAllCharacters error: ${e}`)
    return []
  }
}

export function nextSequence(channel: string): number {
  try {
    stmts.incrSequence.run(channel.toLowerCase())
    const row = stmts.getSequence.get(channel.toLowerCase()) as { action_sequence: number } | null
    return row?.action_sequence ?? 0
  } catch (e) {
    log(`dnd: nextSequence error: ${e}`)
    return 0
  }
}

export function damageCharacter(username: string, channel: string, amount: number): number {
  try {
    const rows = stmts.damageChar.all(amount, username.toLowerCase(), channel.toLowerCase()) as { hp: number }[]
    return rows[0]?.hp ?? 0
  } catch (e) {
    log(`dnd: damageCharacter error: ${e}`)
    return 0
  }
}

export function healCharacter(username: string, channel: string, amount: number): number {
  try {
    const rows = stmts.healChar.all(amount, username.toLowerCase(), channel.toLowerCase()) as { hp: number; max_hp: number }[]
    return rows[0]?.hp ?? 0
  } catch (e) {
    log(`dnd: healCharacter error: ${e}`)
    return 0
  }
}

export function killCharacter(username: string, channel: string, respawnMs: number): void {
  try {
    stmts.killChar.run(respawnMs, username.toLowerCase(), channel.toLowerCase())
  } catch (e) {
    log(`dnd: killCharacter error: ${e}`)
  }
}

export function respawnCharacter(username: string, channel: string): void {
  try {
    stmts.respawnChar.run(username.toLowerCase(), channel.toLowerCase())
  } catch (e) {
    log(`dnd: respawnCharacter error: ${e}`)
  }
}

export function setDying(username: string, channel: string, isDying: boolean): void {
  try {
    stmts.setDying.run(isDying ? 1 : 0, username.toLowerCase(), channel.toLowerCase())
  } catch (e) {
    log(`dnd: setDying error: ${e}`)
  }
}

export function updateDeathSaves(username: string, channel: string, successes: number, failures: number): void {
  try {
    stmts.setDeathSaves.run(successes, failures, username.toLowerCase(), channel.toLowerCase())
  } catch (e) {
    log(`dnd: updateDeathSaves error: ${e}`)
  }
}

export function stabilizeCharacter(username: string, channel: string): void {
  try {
    stmts.stabilizeChar.run(username.toLowerCase(), channel.toLowerCase())
  } catch (e) {
    log(`dnd: stabilizeCharacter error: ${e}`)
  }
}

const XP_PER_LEVEL = [0, 0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000]

export function addCharacterXp(username: string, channel: string, xp: number): { newLevel: number; leveledUp: boolean } {
  try {
    const row = stmts.getXpLevel.get(username.toLowerCase(), channel.toLowerCase()) as { xp: number; level: number; max_hp: number; class: string; stats: string } | null
    if (!row) return { newLevel: 1, leveledUp: false }

    const newXp = row.xp + xp
    let newLevel = row.level
    while (newLevel < 10 && newXp >= (XP_PER_LEVEL[newLevel + 1] ?? 999999)) {
      newLevel++
    }
    const leveledUp = newLevel > row.level
    let hpGain = 0
    if (leveledUp) {
      const cls = row.class
      const stats = JSON.parse(row.stats ?? '{"con":10}') as AbilityScores
      const conMod = getModifier(stats.con)
      const hitDie = getClassDef(cls).hitDie
      const hpPerLevel = Math.floor(hitDie / 2) + 1 + conMod
      hpGain = (newLevel - row.level) * hpPerLevel
    }
    const newMaxHp = row.max_hp + hpGain

    stmts.setXpLevel.run(newXp, newLevel, newMaxHp, hpGain, hpGain, username.toLowerCase(), channel.toLowerCase())
    return { newLevel, leveledUp }
  } catch (e) {
    log(`dnd: addCharacterXp error: ${e}`)
    return { newLevel: 1, leveledUp: false }
  }
}

export function xpForLevel(level: number): number {
  return XP_PER_LEVEL[Math.min(level, 10)] ?? 64000
}

export function logDndAction(channel: string, username: string, action: string, target?: string, result?: string): void {
  try {
    stmts.logAction.run(channel.toLowerCase(), username.toLowerCase(), action, target ?? null, result ?? null)
  } catch (e) {
    log(`dnd: logDndAction error: ${e}`)
  }
}

export function getRecentLog(channel: string, limit: number): { username: string; action: string; target: string | null; result: string | null; created_at: number }[] {
  try {
    return stmts.getLog.all(channel.toLowerCase(), limit) as { username: string; action: string; target: string | null; result: string | null; created_at: number }[]
  } catch (e) {
    log(`dnd: getRecentLog error: ${e}`)
    return []
  }
}

export function getPendingRespawns(): { username: string; channel: string; respawnAt: number }[] {
  try {
    const rows = stmts.getDeadChars.all(Date.now()) as { username: string; channel: string; respawn_at: number }[]
    return rows.map((r) => ({ username: r.username, channel: r.channel, respawnAt: r.respawn_at }))
  } catch (e) {
    log(`dnd: getPendingRespawns error: ${e}`)
    return []
  }
}

export function getAllDeadCharacters(channel: string): Character[] {
  try {
    const rows = stmts.getAllDeadChars.all(channel.toLowerCase()) as Record<string, unknown>[]
    return rows.map(rowToChar)
  } catch (e) {
    log(`dnd: getAllDeadCharacters error: ${e}`)
    return []
  }
}

export function grantAchievement(username: string, channel: string, achievement: string): void {
  try {
    const char = getCharacter(username, channel)
    if (!char || char.achievements.includes(achievement)) return
    char.achievements.push(achievement)
    upsertCharacter(char)
  } catch (e) {
    log(`dnd: grantAchievement error: ${e}`)
  }
}

export function addPrestige(username: string, channel: string): void {
  try {
    const char = getCharacter(username, channel)
    if (!char) return
    char.prestige = (char.prestige ?? 0) + 1
    upsertCharacter(char)
  } catch (e) {
    log(`dnd: addPrestige error: ${e}`)
  }
}
