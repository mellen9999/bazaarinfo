import { Database } from 'bun:sqlite'
import { log } from '../log'
import * as store from '../store'
import type { RaidState, RaidSlot, Resolution, BoardItem, VoteOption } from './types'

// set by initRaidDb — same db instance as db.ts
let db: Database

export function setDb(d: Database) { db = d }

// ---------- in-memory map ----------
const raids = new Map<string, RaidState>()

function makeNPCSlots(): RaidSlot[] {
  return Array.from({ length: 10 }, (_, i) => ({
    position: i,
    username: null,
    boardItems: [],
    submittedThisDay: null,
  }))
}

function randomHero(): string {
  const heroes = store.getHeroNames().filter((h) => h !== 'Common' && h !== '???')
  return heroes[Math.floor(Math.random() * heroes.length)] ?? 'Pygmalien'
}

function createRaidInDb(channel: string, hero: string): number {
  const r = db.run(
    `INSERT INTO raids (channel, hero, day, hp, gold, wins, losses, status, last_resolved_at)
     VALUES (?, ?, 1, 20, 0, 0, 0, 'active', NULL)`,
    [channel, hero],
  )
  return Number(r.lastInsertRowid)
}

function buildState(row: RaidRow): RaidState {
  const slotRows = db.query(
    `SELECT position, username, board_json, submitted_this_day FROM raid_slots WHERE raid_id = ? ORDER BY position`,
  ).all(row.id) as SlotRow[]

  const slots: RaidSlot[] = makeNPCSlots()
  for (const sr of slotRows) {
    let boardItems: BoardItem[] = []
    try { boardItems = JSON.parse(sr.board_json) } catch {}
    slots[sr.position] = {
      position: sr.position,
      username: sr.username ?? null,
      boardItems,
      submittedThisDay: sr.submitted_this_day ?? null,
    }
  }

  // load last resolution
  let lastResolution: Resolution | null = null
  const resRow = db.query(
    `SELECT day, narrative, outcome, combat_log_json, created_at FROM raid_resolutions WHERE raid_id = ? ORDER BY day DESC LIMIT 1`,
  ).get(row.id) as ResRow | null
  if (resRow) {
    lastResolution = {
      day: resRow.day,
      narrative: resRow.narrative,
      outcome: resRow.outcome as 'win' | 'loss',
      combatLog: {},
      createdAt: new Date(resRow.created_at).getTime(),
    }
  }

  return {
    raidId: row.id,
    channel: row.channel,
    hero: row.hero,
    day: row.day,
    hp: row.hp,
    gold: row.gold,
    wins: row.wins,
    losses: row.losses,
    status: row.status as RaidState['status'],
    lastResolvedAt: row.last_resolved_at ? new Date(row.last_resolved_at).getTime() : 0,
    enabled: row.enabled === 1,
    slots,
    lastResolution,
    pendingVote: null,
  }
}

interface RaidRow {
  id: number
  channel: string
  hero: string
  day: number
  hp: number
  gold: number
  wins: number
  losses: number
  status: string
  last_resolved_at: string | null
  enabled: number
}
interface SlotRow {
  position: number
  username: string | null
  board_json: string
  submitted_this_day: number | null
}
interface ResRow {
  day: number
  narrative: string
  outcome: string
  combat_log_json: string
  created_at: string
}

export function restoreFromDb() {
  const rows = db.query(
    `SELECT id, channel, hero, day, hp, gold, wins, losses, status, last_resolved_at, enabled FROM raids WHERE status = 'active'`,
  ).all() as RaidRow[]
  for (const row of rows) {
    raids.set(row.channel.toLowerCase(), buildState(row))
  }
  log(`raid: restored ${rows.length} active raid(s) from db`)
}

export function getOrCreateRaid(channel: string): RaidState {
  const key = channel.toLowerCase()
  let state = raids.get(key)
  if (state) return state

  const hero = randomHero()
  const raidId = createRaidInDb(key, hero)
  state = {
    raidId,
    channel: key,
    hero,
    day: 1,
    hp: 20,
    gold: 0,
    wins: 0,
    losses: 0,
    status: 'active',
    lastResolvedAt: 0,
    enabled: true,
    slots: makeNPCSlots(),
    lastResolution: null,
    pendingVote: null,
  }
  raids.set(key, state)
  return state
}

export function getRaid(channel: string): RaidState | undefined {
  return raids.get(channel.toLowerCase())
}

export function isEnabled(channel: string): boolean {
  const state = raids.get(channel.toLowerCase())
  return state?.enabled !== false
}

export function setEnabled(channel: string, on: boolean) {
  const key = channel.toLowerCase()
  const state = raids.get(key)
  if (state) state.enabled = on
  db.run(`UPDATE raids SET enabled = ? WHERE channel = ? AND status = 'active'`, [on ? 1 : 0, key])
}

export function claimSlot(channel: string, username: string): boolean {
  const state = getOrCreateRaid(channel)
  if (state.status !== 'active') return false
  const lower = username.toLowerCase()
  // already in a slot
  if (state.slots.some((s) => s.username?.toLowerCase() === lower)) return false
  const open = state.slots.find((s) => s.username === null)
  if (!open) return false
  open.username = lower
  db.run(
    `INSERT OR REPLACE INTO raid_slots (raid_id, position, username, board_json, submitted_this_day)
     VALUES (?, ?, ?, ?, NULL)`,
    [state.raidId, open.position, lower, JSON.stringify(open.boardItems)],
  )
  return true
}

export function releaseSlot(channel: string, username: string): boolean {
  const state = getRaid(channel)
  if (!state) return false
  const lower = username.toLowerCase()
  const slot = state.slots.find((s) => s.username?.toLowerCase() === lower)
  if (!slot) return false
  slot.username = null
  slot.boardItems = []
  slot.submittedThisDay = null
  db.run(
    `DELETE FROM raid_slots WHERE raid_id = ? AND position = ?`,
    [state.raidId, slot.position],
  )
  return true
}

export function submitPick(channel: string, username: string, shopSlot: number): boolean {
  const state = getRaid(channel)
  if (!state || state.status !== 'active') return false
  const lower = username.toLowerCase()
  const slot = state.slots.find((s) => s.username?.toLowerCase() === lower)
  if (!slot) return false
  if (shopSlot < 0 || shopSlot > 7) return false
  slot.submittedThisDay = shopSlot
  // last-write-wins via REPLACE
  const userId = getUserId(lower)
  if (userId !== null) {
    db.run(
      `INSERT OR REPLACE INTO raid_submissions (raid_id, day, user_id, shop_slot) VALUES (?, ?, ?, ?)`,
      [state.raidId, state.day, userId, shopSlot],
    )
  }
  return true
}

export function submitVote(channel: string, username: string, choice: string): boolean {
  const state = getRaid(channel)
  if (!state || !state.pendingVote) return false
  const lower = username.toLowerCase()
  const [a, b] = state.pendingVote.options
  const valid = [a.label.toLowerCase(), b.label.toLowerCase()]
  if (!valid.includes(choice.toLowerCase())) return false
  state.pendingVote.tally.set(lower, choice.toLowerCase())
  const userId = getUserId(lower)
  if (userId !== null) {
    db.run(
      `INSERT OR REPLACE INTO raid_votes (raid_id, day, user_id, choice) VALUES (?, ?, ?, ?)`,
      [state.raidId, state.day, userId, choice.toLowerCase()],
    )
  }
  return true
}

function getUserId(username: string): number | null {
  const row = db.query(`SELECT id FROM users WHERE username = ?`).get(username.toLowerCase()) as { id: number } | null
  return row?.id ?? null
}

// in-memory mutation only; caller renders narrative then calls commitResolution
export function applyDayOutcome(channel: string, outcome: 'win' | 'loss', margin: number): RaidState {
  const state = getOrCreateRaid(channel)
  if (outcome === 'win') {
    state.wins++
    state.gold += 6 + state.day
  } else {
    state.losses++
    state.hp -= 5 + Math.floor(margin * 10)
    if (state.hp < 0) state.hp = 0
  }
  if (state.wins >= 7) state.status = 'won'
  else if (state.losses >= 3 || state.hp <= 0) state.status = 'lost'
  state.lastResolvedAt = Date.now()
  return state
}

// channel-level pace setting (persists across runs)
export type Pace = 'fast' | 'normal' | 'slow'
const paceCache = new Map<string, Pace>()

export function getPace(channel: string): Pace {
  const key = channel.toLowerCase()
  const cached = paceCache.get(key)
  if (cached) return cached
  const row = db.query(`SELECT pace FROM raid_channel_settings WHERE channel = ?`).get(key) as { pace: string } | null
  const pace = (row?.pace === 'fast' || row?.pace === 'slow') ? row.pace as Pace : 'normal'
  paceCache.set(key, pace)
  return pace
}

export function setPace(channel: string, pace: Pace) {
  const key = channel.toLowerCase()
  paceCache.set(key, pace)
  db.run(
    `INSERT INTO raid_channel_settings (channel, pace, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(channel) DO UPDATE SET pace = excluded.pace, updated_at = datetime('now')`,
    [key, pace],
  )
}

// who picked most items this run — used in run-end MVP callout
export function getRunMvp(raidId: number): { username: string; picks: number } | null {
  const row = db.query(
    `SELECT u.username, COUNT(*) as picks FROM raid_submissions s
     JOIN users u ON s.user_id = u.id
     WHERE s.raid_id = ?
     GROUP BY u.id ORDER BY picks DESC LIMIT 1`,
  ).get(raidId) as { username: string; picks: number } | null
  return row
}

// persist resolution + state changes + advance day in one pass
export function commitResolution(channel: string, resolution: Resolution): RaidState {
  const state = getOrCreateRaid(channel)
  state.lastResolution = resolution

  db.run(
    `INSERT INTO raid_resolutions (raid_id, day, narrative, combat_log_json, outcome)
     VALUES (?, ?, ?, ?, ?)`,
    [state.raidId, state.day, resolution.narrative, JSON.stringify(resolution.combatLog), resolution.outcome],
  )

  if (state.status !== 'active') {
    db.run(
      `UPDATE raids SET status = ?, wins = ?, losses = ?, hp = ?, gold = ?, last_resolved_at = datetime('now') WHERE id = ?`,
      [state.status, state.wins, state.losses, state.hp, state.gold, state.raidId],
    )
    return state
  }

  state.day++
  for (const slot of state.slots) slot.submittedThisDay = null

  const options: [VoteOption, VoteOption] = [
    { label: 'Galleon', monsterHint: 'sea' },
    { label: "Witch's Hut", monsterHint: 'forest' },
  ]
  state.pendingVote = { options, tally: new Map() }

  db.run(
    `UPDATE raids SET day = ?, wins = ?, losses = ?, hp = ?, gold = ?, last_resolved_at = datetime('now'), enabled = ? WHERE id = ?`,
    [state.day, state.wins, state.losses, state.hp, state.gold, state.enabled ? 1 : 0, state.raidId],
  )
  db.run(`UPDATE raid_slots SET submitted_this_day = NULL WHERE raid_id = ?`, [state.raidId])

  return state
}

export interface VoteResult {
  winner: VoteOption
  winnerCount: number
  loserCount: number
}

// resolves the channel's pending vote (consumed before monster pick). Default to options[0] on tie/empty.
export function resolveVote(channel: string): VoteResult | null {
  const state = getRaid(channel)
  if (!state?.pendingVote) return null
  const counts = new Map<string, number>()
  for (const choice of state.pendingVote.tally.values()) {
    counts.set(choice, (counts.get(choice) ?? 0) + 1)
  }
  const [a, b] = state.pendingVote.options
  const ca = counts.get(a.label.toLowerCase()) ?? 0
  const cb = counts.get(b.label.toLowerCase()) ?? 0
  const winner = cb > ca ? b : a
  return {
    winner,
    winnerCount: cb > ca ? cb : ca,
    loserCount: cb > ca ? ca : cb,
  }
}

// clear in-memory raid (DB row persists with terminal status). Next !b join creates a fresh raid + intro.
export function endRaid(channel: string) {
  raids.delete(channel.toLowerCase())
}

// kept for tests / admin: explicit reset to a fresh raid
export function startNewRun(channel: string): RaidState {
  const key = channel.toLowerCase()
  raids.delete(key)
  return getOrCreateRaid(key)
}

export function cleanupChannel(channel: string) {
  raids.delete(channel.toLowerCase())
}

// used by engine to get all active channels
export function getActiveChannels(): string[] {
  return [...raids.keys()].filter((ch) => raids.get(ch)?.status === 'active' && raids.get(ch)?.enabled)
}
