import type { Statement } from 'bun:sqlite'
import { getDb } from '../db'
import { log } from '../log'
import type { Character, WorldState, DndClass, StatusEffect, EncounterType, ShopItem, Enemy } from './types'

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
  getXpLevel: Statement
  setXpLevel: Statement
  logAction: Statement
  getLog: Statement
  getDeadChars: Statement
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

  stmts = {
    getChar: db.prepare('SELECT * FROM dnd_characters WHERE username = ? AND channel = ?'),
    upsertChar: db.prepare(`INSERT INTO dnd_characters
      (username, channel, class, level, xp, hp, max_hp, gold, inventory, status_effects,
       deaths, total_kills, spell_ready, defending, last_action_at, respawn_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(username, channel) DO UPDATE SET
        class=excluded.class, level=excluded.level, xp=excluded.xp,
        hp=excluded.hp, max_hp=excluded.max_hp, gold=excluded.gold,
        inventory=excluded.inventory, status_effects=excluded.status_effects,
        deaths=excluded.deaths, total_kills=excluded.total_kills,
        spell_ready=excluded.spell_ready, defending=excluded.defending,
        last_action_at=excluded.last_action_at, respawn_at=excluded.respawn_at`),
    getWorld: db.prepare('SELECT * FROM dnd_world WHERE channel = ?'),
    upsertWorld: db.prepare(`INSERT INTO dnd_world
      (channel, floor, action_sequence, encounter_type, enemies, floor_cleared,
       scene, season, enabled, nl_lifted, shop_inventory, vegan_shrine_visited)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel) DO UPDATE SET
        floor=excluded.floor, action_sequence=excluded.action_sequence,
        encounter_type=excluded.encounter_type, enemies=excluded.enemies,
        floor_cleared=excluded.floor_cleared, scene=excluded.scene,
        season=excluded.season, enabled=excluded.enabled,
        nl_lifted=excluded.nl_lifted, shop_inventory=excluded.shop_inventory,
        vegan_shrine_visited=excluded.vegan_shrine_visited`),
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
      `UPDATE dnd_characters SET hp = MIN(max_hp, hp + ?) WHERE username = ? AND channel = ? RETURNING hp, max_hp`
    ),
    killChar: db.prepare(
      `UPDATE dnd_characters SET hp = 0, deaths = deaths + 1, respawn_at = ? WHERE username = ? AND channel = ?`
    ),
    respawnChar: db.prepare(
      `UPDATE dnd_characters SET respawn_at = NULL, hp = MAX(1, max_hp / 2), defending = 0, status_effects = '[]'
       WHERE username = ? AND channel = ?`
    ),
    getXpLevel: db.prepare('SELECT xp, level, max_hp FROM dnd_characters WHERE username = ? AND channel = ?'),
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
  }

  log('dnd: db initialized')
}

function rowToChar(row: Record<string, unknown>): Character {
  return {
    username: row.username as string,
    channel: row.channel as string,
    class: row.class as DndClass,
    level: row.level as number,
    xp: row.xp as number,
    hp: row.hp as number,
    maxHp: row.max_hp as number,
    gold: row.gold as number,
    inventory: JSON.parse(row.inventory as string) as string[],
    statusEffects: JSON.parse(row.status_effects as string) as StatusEffect[],
    deaths: row.deaths as number,
    totalKills: row.total_kills as number,
    spellReady: (row.spell_ready as number) === 1,
    defending: (row.defending as number) === 1,
    lastActionAt: row.last_action_at as number,
    respawnAt: row.respawn_at as number | null,
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
      char.spellReady ? 1 : 0, char.defending ? 1 : 0,
      char.lastActionAt, char.respawnAt ?? null,
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

const XP_PER_LEVEL = [0, 0, 100, 250, 450, 700, 1000, 1350, 1750, 2200, 2700]

export function addCharacterXp(username: string, channel: string, xp: number): { newLevel: number; leveledUp: boolean } {
  try {
    const row = stmts.getXpLevel.get(username.toLowerCase(), channel.toLowerCase()) as { xp: number; level: number; max_hp: number } | null
    if (!row) return { newLevel: 1, leveledUp: false }

    const newXp = row.xp + xp
    let newLevel = row.level
    while (newLevel < 10 && newXp >= (XP_PER_LEVEL[newLevel + 1] ?? 99999)) {
      newLevel++
    }
    const leveledUp = newLevel > row.level
    const hpGain = leveledUp ? (newLevel - row.level) * 10 : 0
    const newMaxHp = row.max_hp + hpGain

    stmts.setXpLevel.run(newXp, newLevel, newMaxHp, hpGain, hpGain, username.toLowerCase(), channel.toLowerCase())
    return { newLevel, leveledUp }
  } catch (e) {
    log(`dnd: addCharacterXp error: ${e}`)
    return { newLevel: 1, leveledUp: false }
  }
}

export function xpForLevel(level: number): number {
  return XP_PER_LEVEL[Math.min(level, 10)] ?? 2700
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
