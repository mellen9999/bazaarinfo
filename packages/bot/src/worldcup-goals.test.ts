import { describe, expect, test } from 'bun:test'
import { diffAnnouncements, nextDelay, type GoalState } from './worldcup-goals'
import type { WcData, WcGoal, WcMatch, WcTeam } from './worldcup'

const NOW = Date.parse('2026-07-11T18:00:00Z')

function team(name: string, score: number, extra: Partial<WcTeam> = {}): WcTeam {
  return { name, short: name, score, shootout: null, winner: false, ...extra }
}

function match(a: WcTeam, b: WcTeam, state: WcMatch['state'], detail = '', date = '2026-07-11T17:00:00Z'): WcMatch {
  return { date, state, detail, teams: [a, b] }
}

function data(...matches: WcMatch[]): WcData {
  return { fetchedAt: new Date(NOW).toISOString(), matches }
}

describe('diffAnnouncements', () => {
  test('first sighting seeds silently — restart mid-match replays nothing', () => {
    const state: GoalState = new Map()
    const out = diffAnnouncements(data(match(team('France', 2), team('Brazil', 1), 'in', "67'")), state, NOW)
    expect(out).toEqual([])
    expect(state.size).toBe(1)
  })

  test('score increase announces a goal with the minute', () => {
    const state: GoalState = new Map()
    diffAnnouncements(data(match(team('France', 0), team('Brazil', 0), 'in', "12'")), state, NOW)
    const out = diffAnnouncements(data(match(team('France', 1), team('Brazil', 0), 'in', "23'")), state, NOW)
    expect(out).toEqual(["⚽ goal — France 1-0 Brazil (23')"])
  })

  test('two goals in one poll collapse to one line with the current score', () => {
    const state: GoalState = new Map()
    diffAnnouncements(data(match(team('France', 0), team('Brazil', 0), 'in', "12'")), state, NOW)
    const out = diffAnnouncements(data(match(team('France', 1), team('Brazil', 1), 'in', "40'")), state, NOW)
    expect(out).toEqual(["⚽ goal — France 1-1 Brazil (40')"])
  })

  test('same score announces nothing', () => {
    const state: GoalState = new Map()
    const d = data(match(team('France', 1), team('Brazil', 0), 'in', "50'"))
    diffAnnouncements(d, state, NOW)
    expect(diffAnnouncements(d, state, NOW)).toEqual([])
  })

  test('score decrease announces a disallowed goal', () => {
    const state: GoalState = new Map()
    diffAnnouncements(data(match(team('France', 1), team('Brazil', 0), 'in', "55'")), state, NOW)
    const out = diffAnnouncements(data(match(team('France', 0), team('Brazil', 0), 'in', "58'")), state, NOW)
    expect(out).toEqual(["⚽ goal disallowed — France 0-0 Brazil (58')"])
  })

  test('full time fires once for a match seen live', () => {
    const state: GoalState = new Map()
    diffAnnouncements(data(match(team('France', 2), team('Brazil', 1), 'in', "90'")), state, NOW)
    const post = data(match(team('France', 2, { winner: true }), team('Brazil', 1), 'post', 'FT'))
    expect(diffAnnouncements(post, state, NOW)).toEqual(['⚽ full time — France 2-1 Brazil'])
    expect(diffAnnouncements(post, state, NOW)).toEqual([])
  })

  test('full time on pens names the winner', () => {
    const state: GoalState = new Map()
    diffAnnouncements(data(match(team('France', 1), team('Brazil', 1), 'in', 'ET')), state, NOW)
    const post = data(match(
      team('France', 1, { shootout: 4, winner: true }),
      team('Brazil', 1, { shootout: 2 }),
      'post', 'FT-Pens',
    ))
    expect(diffAnnouncements(post, state, NOW)).toEqual(['⚽ full time — France 1-1 Brazil, France wins 4-2 on pens'])
  })

  test('a match first seen already post announces nothing — no stale results at boot', () => {
    const state: GoalState = new Map()
    const post = data(match(team('France', 2, { winner: true }), team('Brazil', 1), 'post', 'FT'))
    expect(diffAnnouncements(post, state, NOW)).toEqual([])
    expect(diffAnnouncements(post, state, NOW)).toEqual([])
  })

  test('pre matches are tracked silently — seeded for a future kickoff, announce nothing', () => {
    const state: GoalState = new Map()
    expect(diffAnnouncements(data(match(team('France', 0), team('Brazil', 0), 'pre', 'Scheduled')), state, NOW)).toEqual([])
    expect(state.size).toBe(1)
  })

  test('kickoff fires on a witnessed pre→in transition, offline chats only', () => {
    const state: GoalState = new Map()
    diffAnnouncements(data(match(team('France', 0), team('Brazil', 0), 'pre', 'Scheduled')), state, NOW)
    const out = diffAnnouncements(data(match(team('France', 0), team('Brazil', 0), 'in', "1'")), state, NOW)
    expect(out).toEqual(['⚽ kickoff — France vs Brazil'])
  })

  test('kickoff then an early goal both fire, kickoff first', () => {
    const state: GoalState = new Map()
    diffAnnouncements(data(match(team('France', 0), team('Brazil', 0), 'pre', 'Scheduled')), state, NOW)
    const out = diffAnnouncements(data(match(team('France', 1), team('Brazil', 0), 'in', "3'")), state, NOW)
    expect(out).toEqual([
      '⚽ kickoff — France vs Brazil',
      "⚽ goal — France 1-0 Brazil (3')",
    ])
  })

  test('a match joined mid-play never replays a kickoff', () => {
    const state: GoalState = new Map()
    diffAnnouncements(data(match(team('France', 0), team('Brazil', 0), 'in', "5'")), state, NOW)
    const out = diffAnnouncements(data(match(team('France', 0), team('Brazil', 0), 'in', "10'")), state, NOW)
    expect(out).toEqual([])
  })

  test('goal in stoppage that lands as post still surfaces via the FT line', () => {
    const state: GoalState = new Map()
    diffAnnouncements(data(match(team('France', 1), team('Brazil', 1), 'in', "90'+3'")), state, NOW)
    const out = diffAnnouncements(data(match(team('France', 2, { winner: true }), team('Brazil', 1), 'post', 'FT')), state, NOW)
    expect(out).toEqual(['⚽ full time — France 2-1 Brazil'])
  })

  test('scorer is named when scoring plays line up with the score', () => {
    const state: GoalState = new Map()
    const goal = (scorer: string, minute: string, extra: Partial<WcGoal> = {}): WcGoal =>
      ({ scorer, minute, team: 'Norway', ownGoal: false, penalty: false, ...extra })
    const m0 = match(team('Norway', 1), team('England', 0), 'in', "40'")
    m0.goals = [goal('Andreas Schjelderup', "36'")]
    diffAnnouncements(data(m0), state, NOW)
    const m1 = match(team('Norway', 1), team('England', 1), 'in', "46'")
    m1.goals = [goal('Andreas Schjelderup', "36'"), goal('Jude Bellingham', "45'+2'", { team: 'England' })]
    expect(diffAnnouncements(data(m1), state, NOW)).toEqual(["⚽ Jude Bellingham 45'+2' — Norway 1-1 England"])
  })

  test('pen and own-goal get tagged; two goals in one poll name both scorers', () => {
    const state: GoalState = new Map()
    const m0 = match(team('Norway', 0), team('England', 0), 'in', "10'")
    m0.goals = []
    diffAnnouncements(data(m0), state, NOW)
    const m1 = match(team('Norway', 2), team('England', 0), 'in', "30'")
    m1.goals = [
      { scorer: 'Erling Haaland', minute: "22'", team: 'Norway', ownGoal: false, penalty: true },
      { scorer: 'John Stones', minute: "29'", team: 'Norway', ownGoal: true, penalty: false },
    ]
    expect(diffAnnouncements(data(m1), state, NOW)).toEqual([
      "⚽ Erling Haaland (pen) 22', John Stones (og) 29' — Norway 2-0 England",
    ])
  })

  test('scoring plays that disagree with the score fall back to the plain line', () => {
    const state: GoalState = new Map()
    const m0 = match(team('Norway', 1), team('England', 1), 'in', 'ET')
    m0.goals = [] // shootout pollution / missing details — never trust misaligned order
    diffAnnouncements(data(m0), state, NOW)
    const m1 = match(team('Norway', 2), team('England', 1), 'in', "100'")
    m1.goals = [{ scorer: 'X', minute: "5'", team: 'Norway', ownGoal: false, penalty: false }]
    expect(diffAnnouncements(data(m1), state, NOW)).toEqual(["⚽ goal — Norway 2-1 England (100')"])
  })

  test('tracked entries older than 48h are pruned', () => {
    const state: GoalState = new Map()
    diffAnnouncements(data(match(team('France', 1), team('Brazil', 0), 'in', "10'", '2026-07-01T17:00:00Z')), state, NOW)
    expect(state.size).toBe(1)
    diffAnnouncements(data(), state, NOW)
    expect(state.size).toBe(0)
  })
})

describe('nextDelay', () => {
  test('live match → 15s', () => {
    expect(nextDelay(data(match(team('A', 0), team('B', 0), 'in', "10'")), NOW)).toBe(15_000)
  })

  test('pre match whose kickoff has passed counts as live', () => {
    const d = data(match(team('A', 0), team('B', 0), 'pre', 'Scheduled', new Date(NOW - 60_000).toISOString()))
    expect(nextDelay(d, NOW)).toBe(15_000)
  })

  test('kickoff 5min out → wait exactly until kickoff', () => {
    const d = data(match(team('A', 0), team('B', 0), 'pre', 'Scheduled', new Date(NOW + 5 * 60_000).toISOString()))
    expect(nextDelay(d, NOW)).toBe(5 * 60_000)
  })

  test('kickoff far out clamps to the idle cadence', () => {
    const d = data(match(team('A', 0), team('B', 0), 'pre', 'Scheduled', new Date(NOW + 8 * 3_600_000).toISOString()))
    expect(nextDelay(d, NOW)).toBe(10 * 60_000)
  })

  test('empty or all-finished slate goes dormant', () => {
    expect(nextDelay(data(), NOW)).toBe(6 * 3_600_000)
    expect(nextDelay(data(match(team('A', 1, { winner: true }), team('B', 0), 'post', 'FT')), NOW)).toBe(6 * 3_600_000)
  })
})
