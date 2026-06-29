// the runtime: per-channel run registry + the vote-window loop. silent by construction —
// opens a window only when there's input, resolves to exactly ONE line, gated entirely on
// the stream being offline. all mechanics live in state.ts/combat.ts; this is the I/O glue.
import { log } from '../log'
import type { Run, Verb } from './types'
import { FLOORS } from './types'
import { resolveTurn } from './combat'
import * as state from './state'
import * as votes from './votes'
import * as render from './render'
import * as store from './db'
import { generateArchetype } from './ai-archetype'

const RECRUIT_MS = 60_000   // archetype vote window (armed on `descend`)
const TURN_MS = 60_000      // combat / fork vote window (armed on the first vote)
const EARLY_RESOLVE = 12    // a clear hype-majority resolves the window early
const START_WORD = 'descend'
const VERBS: Verb[] = ['attack', 'defend', 'special', 'flee']

const runs = new Map<string, Run>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

let sayFn: (channel: string, msg: string) => void = () => {}
let isLiveFn: (channel: string) => boolean = () => false

export function initDungeon(say: (channel: string, msg: string) => void): void { sayFn = say }
export function setIsLive(fn: (channel: string) => boolean): void { isLiveFn = fn }

function say(channel: string, msg: string): void {
  try { sayFn(channel, msg) } catch (e) { log(`dungeon: say ${e}`) }
}
function persist(run: Run): void { run.updatedAt = Date.now(); store.saveRun(run) }
function clearTimer(channel: string): void {
  const t = timers.get(channel)
  if (t) { clearTimeout(t); timers.delete(channel) }
}
function armTimer(channel: string, ms: number): void {
  clearTimer(channel)
  timers.set(channel, setTimeout(() => { timers.delete(channel); void resolve(channel) }, Math.max(0, ms)))
}

// --- input ---------------------------------------------------------------------------

// called on every offline-channel message (index.ts gates on !isLive; we double-check).
export function castInput(channel: string, user: string, text: string): void {
  const ch = channel.toLowerCase()
  if (isLiveFn(ch)) return
  const t = text.trim().toLowerCase()
  if (!t) return
  // normalize once: strip non-alphanumeric per token (handles "attack!", caps already lowered)
  const tokens = t.split(/\s+/).map(w => w.replace(/[^a-z0-9]/g, '')).filter(Boolean)
  const run = runs.get(ch)

  // no run (or finished) -> only the start word does anything.
  if (!run || run.phase === 'idle' || run.phase === 'over') {
    if (t.replace(/[^a-z0-9]/g, '') === START_WORD) startRun(ch, user)
    return
  }

  if (run.phase === 'recruiting') {
    if (t.replace(/[^a-z0-9]/g, '') === START_WORD) return // already recruiting
    if (tokens.length > 5 || t.length > 40) return // ignore long chatter; keep concise suggestions
    if (/^https?:\/\//.test(t)) return
    votes.castVote(ch, user, t) // free-text archetype suggestion (raw t for name fidelity)
    return
  }

  if (run.phase === 'combat') {
    const boss = run.enemy?.isBoss ?? false
    if (new Set(tokens).size > 3) return // short verb vote; reject real sentences (not emote spam)
    const verb = VERBS.find((v) => tokens.includes(v) && (v !== 'flee' || !boss))
    if (!verb) return
    votes.castVote(ch, user, verb)
    onCombatVote(ch, run)
    return
  }

  if (run.phase === 'fork') {
    const n = tokens.includes('1') ? '1' : tokens.includes('2') ? '2' : null
    if (!n) return
    votes.castVote(ch, user, n)
    onCombatVote(ch, run)
    return
  }
}

function onCombatVote(channel: string, run: Run): void {
  const now = Date.now()
  if (run.firstVoteAt === 0) {
    run.firstVoteAt = now
    run.windowEndsAt = now + TURN_MS
    persist(run)
    armTimer(channel, TURN_MS)
  } else if (votes.voteCount(channel) >= EARLY_RESOLVE) {
    clearTimer(channel)
    void resolve(channel)
  }
}

function startRun(channel: string, user: string): void {
  const run = state.newRun(channel, user, Date.now())
  run.windowEndsAt = Date.now() + RECRUIT_MS
  runs.set(channel, run)
  votes.clearVotes(channel)
  persist(run)
  say(channel, render.renderRecruit())
  armTimer(channel, RECRUIT_MS)
}

// --- resolution ----------------------------------------------------------------------

async function resolve(channel: string): Promise<void> {
  const run = runs.get(channel)
  if (!run) return
  if (isLiveFn(channel)) { clearTimer(channel); return } // went live mid-window -> freeze, stay silent
  try {
    if (run.phase === 'recruiting') await resolveRecruit(channel, run)
    else if (run.phase === 'combat') resolveCombat(channel, run)
    else if (run.phase === 'fork') resolveFork(channel, run)
  } catch (e) {
    log(`dungeon: resolve ${channel} ${e}`)
  }
}

// open the next vote window silently: clear votes + reset the arming state. the next vote
// re-arms the timer, so nothing fires (and nothing is said) until chat acts again.
function reopen(run: Run): void {
  votes.clearVotes(run.channel)
  run.firstVoteAt = 0
  run.windowEndsAt = 0
  persist(run)
}

async function resolveRecruit(channel: string, run: Run): Promise<void> {
  const top = votes.topChoices(channel, 4).map((c) => ({ text: c.choice, votes: c.count }))
  votes.clearVotes(channel)
  const archetype = await generateArchetype(top, channel) // never null -> default kit
  if (isLiveFn(channel)) { clearTimer(channel); return }   // re-check: AI call can span a go-live
  // ownership re-check: a mod `depths reset` (or any run replacement) during the ~12-24s
  // archetype await would have runs.delete'd this run + deleted its DB row. without this guard
  // the stale closure resurrects the deleted row (persist re-INSERTs) and posts a hero-reveal
  // for a run that no longer exists — memory/DB desync + a ghost run on next restart.
  if (runs.get(channel) !== run) return
  state.startRun(run, archetype)
  reopen(run)
  say(channel, render.renderHeroReveal(run))
}

function credit(run: Run, channel: string, winningChoice: string): void {
  for (const u of votes.votersFor(channel, winningChoice)) {
    run.contributors[u] = (run.contributors[u] ?? 0) + 1
  }
}
function topContributors(run: Run): string[] {
  return Object.entries(run.contributors).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([u]) => u)
}
function endRun(channel: string, run: Run, victory: boolean): void {
  store.recordRunEnd(channel, run.floor, run.hero?.title ?? 'a nameless hero', victory, topContributors(run))
  runs.delete(channel)
  store.deleteRun(channel)
  clearTimer(channel)
  votes.clearVotes(channel)
}

function resolveCombat(channel: string, run: Run): void {
  const hero = run.hero, enemy = run.enemy
  if (!hero || !enemy) { reopen(run); return }
  const boss = enemy.isBoss
  const order: string[] = boss ? ['attack', 'defend', 'special'] : ['attack', 'defend', 'special', 'flee']
  const winner = votes.tallyWinner(channel, order)
  if (!winner) { reopen(run); return } // no votes -> stay silent, keep waiting
  const verb = winner.choice as Verb
  const killerName = enemy.name

  const res = resolveTurn(hero, enemy, verb, state.nextRng(run))

  if (res.heroDied) {
    say(channel, render.renderDeath(run, killerName))
    endRun(channel, run, false)
    return
  }
  if (res.fled) {
    state.fleeAdvance(run)
    reopen(run)
    say(channel, render.renderFled(run, res.enemyDmg))
    return
  }
  if (res.enemyKilled) {
    credit(run, channel, winner.choice)
    if (boss) {
      const top = topContributors(run)
      say(channel, render.renderVictory(run, top))
      endRun(channel, run, true)
      return
    }
    if (enemy.isElite) {
      state.eliteDownAdvance(run)
      reopen(run)
      say(channel, render.renderAdvance(run, `the elite falls — reward claimed!`))
      return
    }
    state.buildFork(run)
    reopen(run)
    say(channel, render.renderCleared(run, killerName))
    return
  }
  // ongoing fight
  reopen(run)
  say(channel, render.renderTurn(run, res))
}

function resolveFork(channel: string, run: Run): void {
  const winner = votes.tallyWinner(channel, ['1', '2'])
  if (!winner) { reopen(run); return }
  const outcome = state.chooseFork(run, parseInt(winner.choice, 10))
  reopen(run)
  if (outcome.tag === 'elite') say(channel, render.renderAdvance(run, 'you brave the elite!'))
  else if (outcome.tag === 'rest') say(channel, render.renderAdvance(run, `you make camp (+${outcome.healed}hp).`))
  else say(channel, render.renderAdvance(run, 'you slip past the danger.'))
}

// --- lifecycle -----------------------------------------------------------------------

export function onStreamOnline(channel: string): void {
  const ch = channel.toLowerCase()
  clearTimer(ch) // freeze, silent
  // mirror restoreFromDb: drop the stale arm-state so the next vote after going offline
  // can re-arm the window. without this, firstVoteAt stays non-zero and onCombatVote's
  // arming branch never fires again — the vote window strands.
  const run = runs.get(ch)
  if (run && (run.phase === 'combat' || run.phase === 'fork')) {
    run.firstVoteAt = 0
    run.windowEndsAt = 0
    persist(run)
  }
}
export function onStreamOffline(channel: string): void {
  const ch = channel.toLowerCase()
  const run = runs.get(ch)
  if (run && run.phase === 'recruiting') armTimer(ch, RECRUIT_MS) // resume a frozen recruit
}

export function cleanup(channel: string): void {
  const ch = channel.toLowerCase()
  clearTimer(ch)
  runs.delete(ch)
}

export function restoreFromDb(): void {
  for (const run of store.loadAllRuns()) {
    runs.set(run.channel.toLowerCase(), run)
    // re-arm a recruit that was mid-window; combat/fork re-arm on the next vote (votes are
    // in-memory and were lost on restart, which is fine — chat just votes again).
    if (run.phase === 'recruiting' && !isLiveFn(run.channel)) {
      armTimer(run.channel.toLowerCase(), Math.max(2_000, run.windowEndsAt - Date.now()))
    } else {
      run.firstVoteAt = 0
      run.windowEndsAt = 0
    }
  }
}

// --- on-demand commands --------------------------------------------------------------

export function statusLine(channel: string): string {
  const ch = channel.toLowerCase()
  return render.renderStatus(runs.get(ch) ?? null, store.getRecord(ch).deepest)
}

export function resetRun(channel: string): string {
  const ch = channel.toLowerCase()
  clearTimer(ch)
  runs.delete(ch)
  votes.clearVotes(ch)
  store.deleteRun(ch)
  return 'the Depths have been reset — type `descend` to begin anew.'
}

export const FLOOR_COUNT = FLOORS
