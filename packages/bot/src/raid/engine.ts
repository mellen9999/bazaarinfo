import * as store from '../store'
import { log } from '../log'
import { getShop } from './shop'
import { simulate } from './sim'
import { renderResolution, renderIntro } from './render'
import * as state from './state'
import type { BoardItem, Resolution } from './types'

const TICK_MS = 60_000

// per-pace tuning. normal is the default; fast for active chat, slow for deliberate streams.
// targets a full run inside a single stream segment: ~30min normal, ~1hr worst case.
const PACE_CONFIG: Record<string, { floor: number; slow: number; force: number }> = {
  fast:   { floor: 30_000, slow:  90_000,   force:  4 * 60_000 },
  normal: { floor: 60_000, slow: 3 * 60_000, force:  6 * 60_000 },
  slow:   { floor: 90_000, slow: 5 * 60_000, force: 10 * 60_000 },
}

type SayFn = (channel: string, msg: string) => void
type IsLiveFn = (channel: string) => boolean
let say: SayFn = () => {}
let isLive: IsLiveFn = () => true  // default: assume live (engine works without stream-state wired)
export function setIsLive(fn: IsLiveFn) { isLive = fn }

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
// Monster board items look up the real card to recover size + tags (the metadata
// only stores title/tier/id), so sim weights and tag-synergy bonuses apply fairly
// to both sides of the fight.
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
  const board = (m.MonsterMetadata?.board ?? []).map((b) => {
    const card = store.findCard(b.title)
    const cd = typeof card?.Cooldown === 'number'
      ? card.Cooldown
      : card?.Cooldown?.[b.tier] ?? undefined
    return itemToBoard(b.title, b.tier, card?.Size ?? 'Medium', cd, card?.Tags ?? [])
  })
  return { title: m.Title, board }
}

// deterministic NPC pick — varies per (raid, day, slot position) so the 7-NPC
// majority doesn't homogenize the party board with 7 copies of shop slot 0.
function npcShopSlot(raidId: number, day: number, position: number): number {
  return ((raidId * 31 + day * 17 + position * 13) >>> 0) % 8
}

// Appends today's pick into each slot's accumulated board (FIFO, capped) and
// returns the full combined party board for sim. Accumulation is the roguelike
// core: a day-5 party board has ~5 items per slot, building synergies over time.
function resolvePartyBoard(channel: string, day: number, hero: string, raidId: number): {
  board: BoardItem[]
  namedPicks: Map<string, string>
} {
  const raid = state.getRaid(channel)
  if (!raid) return { board: [], namedPicks: new Map() }

  const shop = getShop(raidId, day, hero)
  const namedPicks = new Map<string, string>()

  for (const slot of raid.slots) {
    let card = slot.submittedThisDay !== null
      ? shop.find((s) => s.shopSlot === slot.submittedThisDay)?.card ?? null
      : null

    // NPC autofill: deterministic varied slot per (raid, day, position).
    if (!card && slot.username === null) {
      const npcSlot = npcShopSlot(raidId, day, slot.position)
      card = shop.find((s) => s.shopSlot === npcSlot)?.card ?? null
    }

    if (!card) continue

    const tier = card.BaseTier
    const cd = typeof card.Cooldown === 'number'
      ? card.Cooldown
      : card.Cooldown?.[tier] ?? undefined
    const item = itemToBoard(card.Title, tier, card.Size, cd, card.Tags ?? [])

    state.appendSlotPick(slot, item)

    if (slot.username && slot.submittedThisDay !== null) {
      namedPicks.set(slot.username, card.Title)
    }
  }

  const board: BoardItem[] = []
  for (const slot of raid.slots) board.push(...slot.boardItems)
  return { board, namedPicks }
}

function shouldResolve(channel: string, manual = false): boolean {
  const raid = state.getRaid(channel)
  if (!raid || raid.status !== 'active' || !raid.enabled) return false

  // stream-aware: only manual resolves fire when stream is offline. prevents burning runs at 3am.
  if (!manual && !isLive(channel)) return false

  const cfg = PACE_CONFIG[state.getPace(channel)] ?? PACE_CONFIG.normal
  const now = Date.now()
  const base = raid.lastResolvedAt > 0 ? raid.lastResolvedAt : now
  const elapsed = now - base

  if (elapsed < cfg.floor) return false

  const filledSlots = raid.slots.filter((s) => s.username !== null)
  const submitted = filledSlots.filter((s) => s.submittedThisDay !== null).length

  if (filledSlots.length > 0 && submitted >= Math.ceil(filledSlots.length / 2)) return true
  if (elapsed >= cfg.slow && submitted >= 1) return true
  if (elapsed >= cfg.force) return true

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
    const mvp = state.getRunMvp(updated.raidId)
    const mvpLine = mvp ? ` MVP: @${mvp.username} (${mvp.picks} picks).` : ''
    const endMsg = updated.status === 'won'
      ? `🏆 The party wins the run after ${updated.wins} days!${mvpLine} !b join to begin the next.`
      : `💀 The run ends — ${updated.losses} losses, HP:${updated.hp}.${mvpLine} !b join to begin again.`
    say(channel, endMsg)
    state.endRaid(channel)
  }
}

// emit the intro narrative for a freshly-created raid. one-shot per raid lifecycle.
export function announceStart(channel: string, firstUser: string) {
  const raid = state.getRaid(channel)
  if (!raid) return
  const shop = getShop(raid.raidId, raid.day, raid.hero)
  say(channel, renderIntro(raid, firstUser, shop))
  log(`raid: [#${channel}] intro posted (raid ${raid.raidId}, hero ${raid.hero})`)
}

let tickTimer: Timer | null = null

// test seam: set the bot output sink without starting the periodic tick
export function setSay(sayFn: SayFn) { say = sayFn }

export function initEngine(sayFn: SayFn) {
  setSay(sayFn)
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
