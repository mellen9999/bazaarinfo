// dungeon persistence. the run is stored as a JSON blob (shape can evolve freely) so a
// bot restart resumes a live run; records are the Hall of Legends (deepest floor, wins,
// contributors). uses the shared sqlite handle from ../db.
import { getDb } from '../db'
import { log } from '../log'
import type { Run } from './types'

export function initDungeonDb(): void {
  const db = getDb()
  // retire the old per-player D&D tables — replaced by the shared-hero model.
  for (const t of ['dnd_characters', 'dnd_world', 'dnd_log']) {
    try { db.run(`DROP TABLE IF EXISTS ${t}`) } catch { /* best-effort */ }
  }
  db.run(`CREATE TABLE IF NOT EXISTS dungeon_run (
    channel TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS dungeon_records (
    channel TEXT PRIMARY KEY,
    deepest INTEGER NOT NULL DEFAULT 0,
    victories INTEGER NOT NULL DEFAULT 0,
    last_hero TEXT NOT NULL DEFAULT '',
    top_contributors TEXT NOT NULL DEFAULT '[]'
  )`)
}

export function saveRun(run: Run): void {
  try {
    getDb().query(
      `INSERT INTO dungeon_run (channel, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(channel) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    ).run(run.channel.toLowerCase(), JSON.stringify(run), run.updatedAt)
  } catch (e) { log(`dungeon: saveRun ${e}`) }
}

export function loadAllRuns(): Run[] {
  try {
    const rows = getDb().query(`SELECT data FROM dungeon_run`).all() as { data: string }[]
    const out: Run[] = []
    for (const r of rows) {
      try { out.push(JSON.parse(r.data) as Run) } catch { /* skip a corrupt row */ }
    }
    return out
  } catch (e) { log(`dungeon: loadAllRuns ${e}`); return [] }
}

export function deleteRun(channel: string): void {
  try { getDb().query(`DELETE FROM dungeon_run WHERE channel = ?`).run(channel.toLowerCase()) }
  catch (e) { log(`dungeon: deleteRun ${e}`) }
}

export interface DungeonRecord {
  deepest: number
  victories: number
  lastHero: string
  topContributors: string[]
}

export function getRecord(channel: string): DungeonRecord {
  try {
    const row = getDb().query(
      `SELECT deepest, victories, last_hero, top_contributors FROM dungeon_records WHERE channel = ?`,
    ).get(channel.toLowerCase()) as { deepest: number; victories: number; last_hero: string; top_contributors: string } | null
    if (!row) return { deepest: 0, victories: 0, lastHero: '', topContributors: [] }
    let contributors: string[] = []
    try { contributors = JSON.parse(row.top_contributors || '[]') } catch { /* ignore */ }
    return { deepest: row.deepest, victories: row.victories, lastHero: row.last_hero, topContributors: contributors }
  } catch (e) { log(`dungeon: getRecord ${e}`); return { deepest: 0, victories: 0, lastHero: '', topContributors: [] } }
}

// fold a finished run into the channel record (deepest floor is a high-water mark).
export function recordRunEnd(channel: string, floorReached: number, hero: string, victory: boolean, topContributors: string[]): void {
  try {
    const cur = getRecord(channel)
    const deepest = Math.max(cur.deepest, floorReached)
    const victories = cur.victories + (victory ? 1 : 0)
    getDb().query(
      `INSERT INTO dungeon_records (channel, deepest, victories, last_hero, top_contributors) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel) DO UPDATE SET deepest = excluded.deepest, victories = excluded.victories,
         last_hero = excluded.last_hero, top_contributors = excluded.top_contributors`,
    ).run(channel.toLowerCase(), deepest, victories, hero, JSON.stringify(topContributors.slice(0, 5)))
  } catch (e) { log(`dungeon: recordRunEnd ${e}`) }
}
