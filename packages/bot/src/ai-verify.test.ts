import { describe, expect, it } from 'bun:test'
import { findUngroundedStats, correctClockClaim, extractBoardLine, deniesBoardSight, findLiveTierClaims, isDashClause, monotonyStreak } from './ai-verify'

const CARD = 'Game data:\nPumpkin (Vanessa, Medium) — Heal 30/45/60. Cooldown 7 seconds.\n---\n[USER]: what does pumpkin do'

describe('findUngroundedStats — numbers checked against the injected card', () => {
  it('passes numbers that come straight off the card', () => {
    expect(findUngroundedStats('pumpkin heals 60 at diamond on a 7 second cooldown', CARD)).toEqual([])
  })

  it('catches a number invented on top of real data', () => {
    expect(findUngroundedStats('pumpkin heals 85 at diamond', CARD)).toEqual(['85'])
  })

  it('reports every bad number, not just the first', () => {
    const bad = findUngroundedStats('deals 91 damage and 84 burn', CARD).sort()
    expect(bad).toEqual(['84', '91'])
  })

  it('ignores numbers that are not stat claims', () => {
    expect(findUngroundedStats("reacher season 2 is better, and it's $20 on steam", CARD)).toEqual([])
    expect(findUngroundedStats('run 2 of these and you win day 9', CARD)).toEqual([])
  })

  it('does not flag a year sitting next to a stat word', () => {
    expect(findUngroundedStats('the 2025 damage rework changed it', CARD)).toEqual([])
  })

  it('allows arithmetic the model derived from a grounded number', () => {
    expect(findUngroundedStats('about 7.5 damage a second', CARD)).toEqual([])
  })

  it('reads stat-first phrasing too', () => {
    expect(findUngroundedStats('cooldown of 3 seconds', CARD)).toEqual(['3'])
    expect(findUngroundedStats('cooldown of 7 seconds', CARD)).toEqual([])
  })

  it('grounds against the whole context, not only the card block', () => {
    const ctx = `${CARD}\nTrivia standings: bob 42 points`
    expect(findUngroundedStats('bob is on 42 damage worth of points', ctx)).toEqual([])
  })
})

const BOARD = 'Live board (nl_kripp, background — reference ONLY when it genuinely fits): Flame Skirt, Pyro x2, Bar of Gold; skills: Ignition. Card names are real detections; live tiers/enchantments are NOT known — never state or guess them.'

describe('board sight — the bot is a viewer with the overlay, not a blind one', () => {
  it('pulls the board line back out of an assembled context', () => {
    expect(extractBoardLine(`Recent chat:\nbob: hi\n${BOARD}\nStream: nl_kripp is LIVE right now.`)).toBe(BOARD)
    expect(extractBoardLine('no board here')).toBe('')
  })

  it('catches every way the model says it is blind', () => {
    expect(deniesBoardSight('i only see chat, not his board')).toBe(true)
    expect(deniesBoardSight("i can't actually see your board, just chat")).toBe(true)
    expect(deniesBoardSight('no eyes on the board, someone else will have to call it')).toBe(true)
    expect(deniesBoardSight('someone with eyes on the stream will have to make that call')).toBe(true)
    expect(deniesBoardSight('not connected enough to see whatever that overlay is')).toBe(true)
  })

  it('leaves an ordinary board comment alone', () => {
    expect(deniesBoardSight('that skirt is doing a lot of work on the left')).toBe(false)
    expect(deniesBoardSight('i see what he is going for there')).toBe(false)
  })

  it('catches a tier pinned to a card that is only known by name', () => {
    expect(findLiveTierClaims('that gold Flame Skirt is carrying the run', BOARD)).toEqual(['Flame Skirt'])
    expect(findLiveTierClaims('Bar of Gold is probably diamond by now', BOARD)).toEqual(['Bar of Gold'])
  })

  it('does not flag board talk that stays on names', () => {
    expect(findLiveTierClaims('Flame Skirt plus double Pyro is a lot of burn', BOARD)).toEqual([])
    // "Bar of Gold" contains a tier word in its own name — that must not count as a claim
    expect(findLiveTierClaims('Bar of Gold is on the board', BOARD)).toEqual([])
  })

  it('does nothing without a board in context', () => {
    expect(findLiveTierClaims('that gold Flame Skirt is carrying', '')).toEqual([])
  })
})

describe('monotonyStreak — the metronome is the tell, not the em-dash', () => {
  const dash = (s: string) => `${s} is doing real work here — that is the whole build in one card`
  const plain = 'stack shield and let the fountain math grind them out'

  it('recognises the shape', () => {
    expect(isDashClause(dash('flame skirt'))).toBe(true)
    expect(isDashClause(plain)).toBe(false)
    // a dash with nothing substantial on one side is a different sentence, not the pattern
    expect(isDashClause('nope — no')).toBe(false)
  })

  it('counts only the unbroken run at the newest end', () => {
    expect(monotonyStreak([])).toBe(0)
    expect(monotonyStreak([plain, dash('a'), dash('b')])).toBe(2)
    expect(monotonyStreak([dash('a'), dash('b'), plain])).toBe(0)
    expect(monotonyStreak([dash('a'), dash('b'), dash('c')])).toBe(3)
  })
})

describe('correctClockClaim — a weekday claim is always checkable', () => {
  const ctx = 'Right now: wednesday 12 aug 2026, 17:42 UTC.'

  it('repairs the wrong day', () => {
    expect(correctClockClaim('today is monday', ctx)!.text).toBe('today is wednesday')
    expect(correctClockClaim("today's tuesday, chat", ctx)!.text).toBe("today's wednesday, chat")
  })

  it('only rewrites the day inside the claim, never another one in the sentence', () => {
    const r = correctClockClaim("next stream is thursday, and today's monday", ctx)!
    expect(r.text).toBe("next stream is thursday, and today's wednesday")
    expect(r.day).toBe('wednesday')
  })

  it('passes the right day', () => {
    expect(correctClockClaim("today's wednesday", ctx)).toBeNull()
    expect(correctClockClaim('it is Wednesday', ctx)).toBeNull()
  })

  it('leaves any weekday that is not a claim about today alone', () => {
    expect(correctClockClaim('next stream is thursday', ctx)).toBeNull()
    expect(correctClockClaim('he streamed monday and friday last week', ctx)).toBeNull()
  })

  it('does nothing without a clock line', () => {
    expect(correctClockClaim('today is monday', 'no clock here')).toBeNull()
  })
})
