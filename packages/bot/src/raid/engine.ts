import * as store from '../store'
import { log } from '../log'
import { getShop } from './shop'
import { simulate } from './sim'
import { renderResolution } from './render'
import * as state from './state'
import type { BoardItem, Resolution } from './types'

const FLOOR_MS = 90_000
const TICK_MS = 60_000
const SLOW_CHAT_MS = 10 * 60_000
const FORCE_MS = 30 * 60_000

type SayFn = (channel: string, msg: string) => void
let say: SayFn = () => {}

function itemToBoard(title: string, tier: string, size: string, cd: number | undefined | null, tags: string[]): BoardItem {
  return {
    title,
    tier,
    size,
    cooldownMs: typeof cd === 'number' ? cd * 1000 : 0,
    tags,
  }
}

// pick a monster for the day, optionally biased toward a hint (e.g. "sea" / "forest")
// from the resolved vote. Falls back to random if no match.
function pickMonster(day: number, hint?: string): { title: string; board: BoardItem[] } {
  const pool = store.monstersByDay(day)
  if (!pool.length) return { title: `Day ${day} Boss`, board: [] }
  let candidates = pool
  if (hint) {
    const h = hint.toLowerCase()
    const filtered = pool.filter((m) =>
      m.Title.toLowerCase().includes(h)
      || (m.Tags ?? []).some((t) => t.toLowerCase().includes(h))
      || (m.HiddenTags ?? []).some((t) => t.toLowerCase().includes(h)),
    )
    if (filtered.length) candidates = filtered
  }
  const m = candidates[Math.floor(Math.random() * candidates.length)]
  const board = (m.MonsterMetadata?.board ?? []).map((b) => ({
    title: b.title,
    tier: b.tier,
    size: 'Medium',
    cooldownMs: 0,
    tags: [],
  }))
  return { title: m.Title, board }
}

function resolvePartyBoard(channel: string, day: number, hero: string, raidId: number): {
  board: BoardItem[]
  namedPicks: Map<string, string>
} {
  const raid = state.getRaid(channel)
  if (!raid) return { board: [], namedPicks: new Map() }

  const shop = getShop(raidId, day, hero)
  const namedPicks = new Map<string, string>()
  const board: BoardItem[] = []

  for (const slot of raid.slots) {
    let card = slot.submittedThisDay !== null
      ? shop.find((s) => s.shopSlot === slot.submittedThisDay)?.card ?? null
      : null

    // NPC autofill: pick first shop item (cheapest / lowest slot)
    if (!card) card = shop[0]?.card ?? null
    if (!card) continue

    // use the card's base tier (simplified — real pick would track selected tier)
    const tier = card.BaseTier
    const cd = typeof card.Cooldown === 'number'
      ? card.Cooldown
      : card.Cooldown?.[tier] ?? undefined

    board.push(itemToBoard(card.Title, tier, card.Size, cd, card.Tags ?? []))

    if (slot.username && slot.submittedThisDay !== null) {
      namedPicks.set(slot.username, card.Title)
    }
  }

  return { board, namedPicks }
}

function shouldResolve(channel: string): boolean {
  const raid = state.getRaid(channel)
  if (!raid || raid.status !== 'active' || !raid.enabled) return false

  const now = Date.now()
  // lastResolvedAt=0 means brand-new raid, never resolved — use raid creation time
  const base = raid.lastResolvedAt > 0 ? raid.lastResolvedAt : now
  const elapsed = now - base

  // hard 90s floor
  if (elapsed < FLOOR_MS) return false

  const filledSlots = raid.slots.filter((s) => s.username !== null)
  const submitted = filledSlots.filter((s) => s.submittedThisDay !== null).length

  // trigger 1: ≥50% of filled slots submitted + 90s elapsed
  if (filledSlots.length > 0 && submitted >= Math.ceil(filledSlots.length / 2)) return true

  // trigger 2: 10min elapsed + at least 1 submission
  if (elapsed >= SLOW_CHAT_MS && submitted >= 1) return true

  // trigger 3: 30min force-progress (fills NPCs, always fires)
  if (elapsed >= FORCE_MS) return true

  return false
}

async function resolveChannel(channel: string) {
  const raid = state.getRaid(channel)
  if (!raid) return

  const { board: partyBoard, namedPicks } = resolvePartyBoard(channel, raid.day, raid.hero, raid.raidId)
  const vote = state.resolveVote(channel)
  const monster = pickMonster(raid.day, vote?.winner.monsterHint)

  // crowd influence: lopsided consensus rallies the party. (winner − loser) × 0.3%, capped at +20%.
  // a divided crowd offers no boost. one tipping vote in a close fight can decide the run.
  const netVotes = vote ? vote.winnerCount - vote.loserCount : 0
  const crowdBoost = Math.min(1.20, 1 + Math.max(0, netVotes) * 0.003)

  const result = simulate(partyBoard, monster.board, raid.raidId, raid.day, crowdBoost)

  const outcome: 'win' | 'loss' = result.winner === 'party' ? 'win' : 'loss'
  const updated = state.applyDayOutcome(channel, outcome, result.margin)
  const narrative = renderResolution(updated, result, monster.title, namedPicks, vote, crowdBoost)

  state.commitResolution(channel, {
    day: raid.day,
    narrative,
    outcome,
    combatLog: {
      margin: result.margin,
      vote: vote?.winner.label ?? null,
      votes: vote ? [vote.winnerCount, vote.loserCount] : null,
      crowdBoost,
    },
    createdAt: Date.now(),
  })

  say(channel, narrative)
  log(`raid: [#${channel}] day ${raid.day} resolved — ${outcome}`)

  if (updated.status !== 'active') {
    const endMsg = updated.status === 'won'
      ? `The party wins the run after ${updated.wins} days. A new adventure begins...`
      : `The run ends in defeat (${updated.losses} losses, HP:${updated.hp}). A new adventure begins...`
    say(channel, endMsg)
    state.startNewRun(channel)
  }
}

let tickTimer: Timer | null = null

export function initEngine(sayFn: SayFn) {
  say = sayFn
  tickTimer = setInterval(tick, TICK_MS)
  log('raid: engine started')
}

export function stopEngine() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
}

function tick() {
  for (const channel of state.getActiveChannels()) {
    if (shouldResolve(channel)) {
      resolveChannel(channel).catch((e) => log(`raid: resolve error [#${channel}]: ${e}`))
    }
  }
}

// fast-path trigger after a submission
export function triggerCheck(channel: string) {
  if (shouldResolve(channel)) {
    resolveChannel(channel).catch((e) => log(`raid: trigger resolve error [#${channel}]: ${e}`))
  }
}

export { resolveChannel }
