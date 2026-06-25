import { describe, expect, it, beforeAll } from 'bun:test'
import { initDb } from '../db'
import { makeHero, resolveTurn, applyBuff, restHeal } from './combat'
import { makeEnemy } from './monsters'
import * as state from './state'
import * as votes from './votes'
import * as store from './db'
import type { Archetype } from './ai-archetype'
import type { Enemy, Hero } from './types'

const ARCH: Archetype = {
  title: 'Test Knight', blurb: 'a test', build: 'balanced', specialKind: 'burst',
  moveName: 'Test Strike', moveFlavor: 'a blow lands on {enemy}',
}
const rng = () => 0.5 // deterministic
function enemy(over: Partial<Enemy> = {}): Enemy {
  return { name: 'Goblin', hp: 16, maxHp: 16, dmg: 4, intent: 'normal', staggered: false, stunned: false, isElite: false, isBoss: false, phase: 0, ...over }
}

describe('combat — the fixed chassis', () => {
  it('attack deals hero.atk and the enemy hits back per its telegraph', () => {
    const h = makeHero(ARCH) // balanced: 32hp / 8atk
    const e = enemy()
    const r = resolveTurn(h, e, 'attack', rng)
    expect(r.heroDmg).toBe(8)
    expect(e.hp).toBe(8)
    expect(r.enemyDmg).toBe(4) // normal hit
    expect(h.hp).toBe(28)
  })

  it('defend parries a telegraphed heavy: negates the hit AND staggers the enemy', () => {
    const h = makeHero(ARCH)
    const e = enemy({ intent: 'heavy' })
    const r = resolveTurn(h, e, 'defend', rng)
    expect(r.parried).toBe(true)
    expect(r.enemyDmg).toBe(0)
    expect(h.hp).toBe(32)
    expect(e.staggered).toBe(true)
  })

  it('attacking a staggered enemy lands a bonus hit', () => {
    const h = makeHero(ARCH)
    const e = enemy({ staggered: true })
    const r = resolveTurn(h, e, 'attack', rng)
    expect(r.staggeredHit).toBe(true)
    expect(r.heroDmg).toBe(12) // 8 * 1.5
    expect(e.staggered).toBe(false)
  })

  it('special: burst spends a charge for big damage', () => {
    const h = makeHero(ARCH) // burst
    const e = enemy({ hp: 40, maxHp: 40 })
    const r = resolveTurn(h, e, 'special', rng)
    expect(r.special).toBe(true)
    expect(r.heroDmg).toBe(20) // 8 * 2.5
    expect(h.special).toBe(2)
  })

  it('special: heal restores HP, stun skips the enemy, guard grants a shield', () => {
    const heal = makeHero({ ...ARCH, specialKind: 'heal' }); heal.hp = 10
    resolveTurn(heal, enemy(), 'special', rng)
    expect(heal.hp).toBeGreaterThan(10)

    const stun = makeHero({ ...ARCH, specialKind: 'stun' })
    const e2 = enemy({ intent: 'heavy' })
    const r2 = resolveTurn(stun, e2, 'special', rng)
    expect(r2.enemyDmg).toBe(0) // stunned -> no counterattack

    const guard = makeHero({ ...ARCH, specialKind: 'guard' })
    resolveTurn(guard, enemy(), 'special', rng)
    expect(guard.shield).toBeGreaterThan(0)
  })

  it('special with no charges degrades to a normal attack (never a wasted turn)', () => {
    const h = makeHero(ARCH); h.special = 0
    const r = resolveTurn(h, enemy(), 'special', rng)
    expect(r.verb).toBe('attack')
    expect(r.special).toBe(false)
  })

  it('flee takes only a small parting hit', () => {
    const h = makeHero(ARCH)
    const r = resolveTurn(h, enemy({ dmg: 10 }), 'flee', rng)
    expect(r.fled).toBe(true)
    expect(r.enemyDmg).toBe(5) // 10 * 0.5
  })

  it('a boss phase-shifts instead of dying the first time', () => {
    const h = makeHero(ARCH)
    const e = enemy({ hp: 5, maxHp: 88, dmg: 12, isBoss: true, phase: 1 })
    const r = resolveTurn(h, e, 'attack', rng)
    expect(r.enemyKilled).toBe(false)
    expect(r.bossPhase).toBe(true)
    expect(e.phase).toBe(2)
    expect(e.hp).toBe(44) // maxHp/2
    expect(e.dmg).toBe(17) // 12 * 1.4
  })

  it('the hero can die (no respawn — caller ends the run)', () => {
    const h = makeHero(ARCH); h.hp = 3
    const r = resolveTurn(h, enemy({ dmg: 10, intent: 'heavy' }), 'attack', rng)
    expect(r.heroDied).toBe(true)
    expect(h.hp).toBeLessThanOrEqual(0)
  })

  it('shield absorbs damage before HP; buffs apply', () => {
    const h = makeHero(ARCH)
    applyBuff(h, 'shield') // +12
    expect(h.shield).toBe(12)
    applyBuff(h, 'atk')
    expect(h.atk).toBe(11)
    h.hp = 5
    expect(restHeal(h)).toBeGreaterThan(0)
  })
})

describe('monsters — per-floor scaling', () => {
  it('ramps HP/damage by floor and flags the boss', () => {
    const f1 = makeEnemy(1, rng, {})
    const f4 = makeEnemy(4, rng, {})
    expect(f4.hp).toBeGreaterThan(f1.hp)
    const boss = makeEnemy(5, rng, { boss: true })
    expect(boss.isBoss).toBe(true)
    expect(boss.phase).toBe(1)
    const elite = makeEnemy(2, rng, { elite: true })
    expect(elite.isElite).toBe(true)
    expect(elite.hp).toBeGreaterThan(makeEnemy(2, rng, {}).hp)
  })
})

describe('state — run lifecycle', () => {
  it('newRun starts in recruiting on floor 1', () => {
    const run = state.newRun('#t', 'me', 1000)
    expect(run.phase).toBe('recruiting')
    expect(run.floor).toBe(1)
    expect(run.hero).toBeNull()
  })

  it('startRun builds the hero from its build and spawns floor 1', () => {
    const run = state.newRun('#t', 'me', 1000)
    state.startRun(run, ARCH)
    expect(run.phase).toBe('combat')
    expect(run.hero?.atk).toBe(8) // balanced
    expect(run.enemy).not.toBeNull()
    expect(run.floor).toBe(1)
  })

  it('advanceFloor increments, spawns the boss on floor 5, and wins past it', () => {
    const run = state.newRun('#t', 'me', 1000)
    state.startRun(run, ARCH)
    run.floor = 4
    expect(state.advanceFloor(run)).toBe('combat')
    expect(run.floor).toBe(5)
    expect(run.enemy?.isBoss).toBe(true)
    expect(state.advanceFloor(run)).toBe('victory')
    expect(run.phase).toBe('over')
  })

  it('an elite fork spawns an elite + queues its buff, granted on the elite\'s defeat', () => {
    const run = state.newRun('#t', 'me', 1000)
    state.startRun(run, ARCH)
    run.fork = [{ n: 1, label: '', kind: 'elite', buff: 'atk' }, { n: 2, label: '', kind: 'skip' }]
    run.phase = 'fork'
    const o = state.chooseFork(run, 1)
    expect(o.tag).toBe('elite')
    expect(run.enemy?.isElite).toBe(true)
    expect(run.pendingBuff).toBe('atk')
    const atkBefore = run.hero!.atk
    state.eliteDownAdvance(run)
    expect(run.hero!.atk).toBe(atkBefore + 3) // buff granted
    expect(run.pendingBuff).toBeNull()
    expect(run.floor).toBe(2)
  })

  it('flee advances and forfeits any pending elite reward', () => {
    const run = state.newRun('#t', 'me', 1000)
    state.startRun(run, ARCH)
    run.pendingBuff = 'atk'
    const atkBefore = run.hero!.atk
    state.fleeAdvance(run)
    expect(run.floor).toBe(2)
    expect(run.pendingBuff).toBeNull()
    expect(run.hero!.atk).toBe(atkBefore) // NOT granted — you fled it
  })

  it('a rest fork heals then advances', () => {
    const run = state.newRun('#t', 'me', 1000)
    state.startRun(run, ARCH)
    run.hero!.hp = 5
    run.fork = [{ n: 1, label: '', kind: 'rest' }, { n: 2, label: '', kind: 'skip' }]
    run.phase = 'fork'
    const o = state.chooseFork(run, 1)
    expect(o.tag).toBe('rest')
    expect(run.hero!.hp).toBeGreaterThan(5)
    expect(run.floor).toBe(2)
  })
})

describe('votes — tally', () => {
  it('majority wins; ties break by listed order; one vote per user', () => {
    votes.clearVotes('#v')
    votes.castVote('#v', 'a', 'attack')
    votes.castVote('#v', 'b', 'defend')
    votes.castVote('#v', 'c', 'attack')
    votes.castVote('#v', 'a', 'defend') // a changes their mind -> last wins
    const w = votes.tallyWinner('#v', ['attack', 'defend', 'special', 'flee'])
    expect(w).toEqual({ choice: 'defend', count: 2, total: 3 })
  })
  it('topChoices ranks free-text suggestions; votersFor credits', () => {
    votes.clearVotes('#v2')
    votes.castVote('#v2', 'a', 'knight')
    votes.castVote('#v2', 'b', 'knight')
    votes.castVote('#v2', 'c', 'wizard')
    expect(votes.topChoices('#v2', 4)[0]).toEqual({ choice: 'knight', count: 2 })
    expect(votes.votersFor('#v2', 'knight').sort()).toEqual(['a', 'b'])
  })
  it('no votes -> null winner', () => {
    votes.clearVotes('#v3')
    expect(votes.tallyWinner('#v3', ['attack'])).toBeNull()
  })
})

// regression #25 — heal at full HP must degrade to attack (no wasted charge)
describe('combat — heal-at-full-HP degrades to attack, no charge spent', () => {
  it('heal special at full HP: verb degrades to attack, charge preserved, damage dealt', () => {
    const h = makeHero({ ...ARCH, specialKind: 'heal' })
    // hero is already at full HP (makeHero sets hp = maxHp)
    const chargeBefore = h.special
    const e = enemy()
    const r = resolveTurn(h, e, 'special', rng)
    expect(r.verb).toBe('attack')       // degraded
    expect(r.special).toBe(false)       // did not fire the special
    expect(h.special).toBe(chargeBefore) // charge not spent
    expect(r.healed).toBe(0)            // no heal happened
    expect(r.heroDmg).toBeGreaterThan(0) // dealt attack damage instead
  })

  it('heal special below full HP: fires normally, spends charge, restores HP', () => {
    const h = makeHero({ ...ARCH, specialKind: 'heal' })
    h.hp = 10 // damaged
    const chargeBefore = h.special
    const r = resolveTurn(h, enemy(), 'special', rng)
    expect(r.verb).toBe('special')
    expect(r.special).toBe(true)
    expect(h.special).toBe(chargeBefore - 1)
    expect(r.healed).toBeGreaterThan(0)
    expect(h.hp).toBeGreaterThan(10)
  })
})

// regression #16 — combat/fork vote window strands after a go-live freeze
// reproduce: vote (arms window) → go live (clears timer) → go offline → more votes →
// without the fix firstVoteAt stays non-zero so onCombatVote's arming branch is skipped
// and the window never resolves. with the fix, go-live resets firstVoteAt so re-arm fires.
describe('loop — onStreamOnline resets firstVoteAt so offline votes re-arm the window (#16)', () => {
  it('vote → go-live → go-offline → EARLY_RESOLVE votes resolve the round (no strand)', async () => {
    // ensure DB is initialised before dungeon store calls
    initDb('/tmp/bzi-dungeon-test.db')
    store.initDungeonDb()

    const loop = await import('./loop')

    const ch = '#strandtest16'
    const says: string[] = []
    let live = false

    loop.initDungeon((_c, msg) => says.push(msg))
    loop.setIsLive((_c) => live)
    loop.cleanup(ch)

    // build a combat run in the DB and restore it (puts run in loop's private map)
    const run = state.newRun(ch, 'u', Date.now())
    state.startRun(run, ARCH)
    // make sure hero has enough HP to survive; enemy has low enough HP to die from EARLY votes
    run.hero!.atk = 999
    store.saveRun(run)
    loop.restoreFromDb()

    // cast one vote while offline → arms the window (firstVoteAt becomes non-zero)
    live = false
    votes.clearVotes(ch)
    loop.castInput(ch, 'user1', 'attack')

    // stream goes live → onStreamOnline clears timer but (before fix) left firstVoteAt dirty
    live = true
    loop.onStreamOnline(ch)

    // stream goes offline again
    live = false
    says.length = 0

    // reach EARLY_RESOLVE (12) unique votes → should resolve; before fix firstVoteAt≠0
    // blocks re-arm so the window never fires and says stays empty
    votes.clearVotes(ch)
    for (let i = 0; i < 12; i++) loop.castInput(ch, `voter${i}`, 'attack')

    // give the (synchronous early-resolve path) a tick to process
    await new Promise((r) => setTimeout(r, 10))

    expect(says.length).toBeGreaterThan(0) // window resolved, something was said

    loop.cleanup(ch)
    store.deleteRun(ch)
  })
})

describe('db — persistence round-trip (real sqlite)', () => {
  beforeAll(() => {
    initDb('/tmp/bzi-dungeon-test.db')
    store.initDungeonDb()
  })
  it('saves + reloads a run and records a high-water deepest floor', () => {
    const run = state.newRun('#dbchan', 'me', 1000)
    run.floor = 3
    store.saveRun(run)
    const loaded = store.loadAllRuns().find((r) => r.channel === '#dbchan')
    expect(loaded?.floor).toBe(3)

    store.recordRunEnd('#dbchan', 3, 'Test Knight', false, ['me'])
    store.recordRunEnd('#dbchan', 2, 'Other', false, ['you']) // lower -> shouldn't lower deepest
    expect(store.getRecord('#dbchan').deepest).toBe(3)

    store.deleteRun('#dbchan')
    expect(store.loadAllRuns().find((r) => r.channel === '#dbchan')).toBeUndefined()
  })
})
