// run state machine: pure transitions over a Run (no I/O). the loop drives these and
// renders one line per step. seeded RNG (run.seed) keeps everything deterministic + resumable.
import { makeEnemy } from './monsters'
import { makeHero, applyBuff, restHeal } from './combat'
import { mulberry32, pick } from './util'
import type { Run, BuffKind } from './types'
import { FLOORS } from './types'
import type { Archetype } from './ai-archetype'

const BUFFS: BuffKind[] = ['maxhp', 'atk', 'special', 'shield']
const BUFF_LABEL: Record<BuffKind, string> = {
  maxhp: '+10 max HP', atk: '+3 attack', special: '+1 special', shield: 'a shield',
}

function hashSeed(channel: string, now: number): number {
  let h = now >>> 0
  for (let i = 0; i < channel.length; i++) h = (Math.imul(h, 31) + channel.charCodeAt(i)) | 0
  return h >>> 0
}

export function newRun(channel: string, startedBy: string, now: number): Run {
  return {
    channel, phase: 'recruiting', floor: 1, hero: null, enemy: null, fork: null,
    pendingBuff: null, windowEndsAt: 0, firstVoteAt: 0, seed: hashSeed(channel, now),
    startedBy, contributors: {}, updatedAt: now,
  }
}

// fresh seeded RNG per draw; bumping the stored seed so successive draws differ + resume.
export function nextRng(run: Run): () => number {
  run.seed = (run.seed + 0x9e3779b9) | 0
  return mulberry32(run.seed >>> 0)
}

export function startRun(run: Run, a: Archetype): void {
  run.hero = makeHero(a)
  run.enemy = makeEnemy(1, nextRng(run), {})
  run.fork = null
  run.pendingBuff = null
  run.phase = 'combat'
}

// floor++ and spawn the next foe (boss at floor 5). does NOT grant buffs — callers do that.
export function advanceFloor(run: Run): 'combat' | 'victory' {
  run.floor += 1
  if (run.floor > FLOORS) { run.phase = 'over'; return 'victory' }
  run.enemy = makeEnemy(run.floor, nextRng(run), { boss: run.floor >= FLOORS })
  run.fork = null
  run.phase = 'combat'
  return 'combat'
}

// a normal floor enemy fell -> offer a fork (risk/reward or rest). ~60% elite forks.
export function buildFork(run: Run): void {
  const rng = nextRng(run)
  const buff = pick(BUFFS, rng)
  if (rng() < 0.6) {
    run.fork = [
      { n: 1, label: `brave the elite (reward: ${BUFF_LABEL[buff]})`, kind: 'elite', buff },
      { n: 2, label: 'slip past (safe, nothing)', kind: 'skip' },
    ]
  } else {
    run.fork = [
      { n: 1, label: 'make camp & heal', kind: 'rest' },
      { n: 2, label: 'press on (save time, no heal)', kind: 'skip' },
    ]
  }
  run.phase = 'fork'
}

export type ForkOutcome =
  | { tag: 'elite' }
  | { tag: 'rest'; healed: number }
  | { tag: 'skip' }
  | { tag: 'victory' }

// resolve a fork pick. invalid/`n` not found -> the safe (last) option, so a stuck fork
// never hard-blocks the run.
export function chooseFork(run: Run, n: number): ForkOutcome {
  const opts = run.fork ?? []
  const chosen = opts.find((o) => o.n === n) ?? opts[opts.length - 1]
  run.fork = null
  if (!chosen) { advanceFloor(run); return { tag: 'skip' } }

  if (chosen.kind === 'elite') {
    run.enemy = makeEnemy(run.floor, nextRng(run), { elite: true })
    run.pendingBuff = chosen.buff ?? null
    run.phase = 'combat'
    return { tag: 'elite' }
  }
  if (chosen.kind === 'rest') {
    const healed = run.hero ? restHeal(run.hero) : 0
    advanceFloor(run)
    return { tag: 'rest', healed }
  }
  advanceFloor(run)
  return { tag: 'skip' }
}

// an elite (from an elite fork) fell -> grant its promised buff, then advance.
export function eliteDownAdvance(run: Run): { tag: 'victory' } | { tag: 'combat'; granted: BuffKind | null } {
  const granted = run.pendingBuff
  if (granted && run.hero) applyBuff(run.hero, granted)
  run.pendingBuff = null
  const r = advanceFloor(run)
  return r === 'victory' ? { tag: 'victory' } : { tag: 'combat', granted }
}

// flee: forfeit this floor's enemy + loot, advance with banked HP (no buff, parting hit
// already applied by combat). clears any pending elite reward.
export function fleeAdvance(run: Run): 'combat' | 'victory' {
  run.pendingBuff = null
  return advanceFloor(run)
}
