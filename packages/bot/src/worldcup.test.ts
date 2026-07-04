import { afterEach, describe, expect, it } from 'bun:test'
import { __setWorldCupCacheForTest, getWorldCupLine, isWorldCupQuery, parseScoreboard } from './worldcup'
import type { WcData } from './worldcup'

// fixture trimmed from a real ESPN fifa.world scoreboard payload (2026-07-03):
// one FT, one pens shootout, one live, one scheduled
const FIXTURE = {
  events: [
    {
      date: '2026-07-03T18:00Z',
      competitions: [{
        status: { type: { state: 'post', shortDetail: 'FT-Pens' } },
        competitors: [
          { homeAway: 'home', team: { displayName: 'Australia' }, score: '1', shootoutScore: 2 },
          { homeAway: 'away', team: { displayName: 'Egypt' }, score: '1', shootoutScore: 4, winner: true },
        ],
      }],
    },
    {
      date: '2026-07-04T01:30Z',
      competitions: [{
        status: { type: { state: 'in', shortDetail: "90'+7'" } },
        competitors: [
          { homeAway: 'home', team: { displayName: 'Colombia' }, score: '1' },
          { homeAway: 'away', team: { displayName: 'Ghana' }, score: '0' },
        ],
      }],
    },
    {
      date: '2026-07-02T23:00Z',
      competitions: [{
        status: { type: { state: 'post', shortDetail: 'FT' } },
        competitors: [
          { homeAway: 'home', team: { displayName: 'Portugal' }, score: '2', winner: true },
          { homeAway: 'away', team: { displayName: 'Croatia' }, score: '1' },
        ],
      }],
    },
    {
      date: '2026-07-04T17:00Z',
      competitions: [{
        status: { type: { state: 'pre', shortDetail: 'Scheduled' } },
        competitors: [
          { homeAway: 'away', team: { displayName: 'Morocco' }, score: '0' },
          { homeAway: 'home', team: { displayName: 'United States', shortDisplayName: 'USA' }, score: '0' },
        ],
      }],
    },
  ],
}

function freshCache(ageMs = 30_000): WcData {
  const data = parseScoreboard(FIXTURE)!
  return { ...data, fetchedAt: new Date(Date.now() - ageMs).toISOString() }
}

afterEach(() => __setWorldCupCacheForTest(null))

describe('parseScoreboard', () => {
  it('extracts all four match states with scores and shootouts', () => {
    const data = parseScoreboard(FIXTURE)!
    expect(data.matches.length).toBe(4)
    const pens = data.matches[0]
    expect(pens.state).toBe('post')
    expect(pens.teams[0].shootout).toBe(2)
    expect(pens.teams[1].shootout).toBe(4)
    expect(pens.teams[1].winner).toBe(true)
    expect(data.matches[1].state).toBe('in')
  })

  it('orders home team first regardless of payload order, keeps short names', () => {
    const pre = parseScoreboard(FIXTURE)!.matches[3]
    expect(pre.teams[0].name).toBe('United States')
    expect(pre.teams[0].short).toBe('USA')
    expect(pre.teams[1].name).toBe('Morocco')
  })

  it('returns null on malformed payloads, empty data on an off day', () => {
    expect(parseScoreboard(null)).toBeNull()
    expect(parseScoreboard({ leagues: [] })).toBeNull()
    expect(parseScoreboard('garbage')).toBeNull()
    expect(parseScoreboard({ events: [] })!.matches).toEqual([])
  })

  it('skips events with missing teams or unparseable scores, keeps the rest', () => {
    const dirty = {
      events: [
        { date: '2026-07-03T18:00Z', competitions: [{ status: { type: { state: 'post' } }, competitors: [{ team: { displayName: 'Solo' }, score: '1' }] }] },
        { date: '2026-07-03T18:00Z', competitions: [{ status: { type: { state: 'post' } }, competitors: [{ team: { displayName: 'A' }, score: 'NaN' }, { team: { displayName: 'B' }, score: '1' }] }] },
        ...FIXTURE.events.slice(2, 3),
      ],
    }
    expect(parseScoreboard(dirty)!.matches.length).toBe(1)
  })
})

describe('isWorldCupQuery', () => {
  it('fires on explicit world cup / soccer phrasings without any cache', () => {
    __setWorldCupCacheForTest(null)
    expect(isWorldCupQuery('who won the world cup game')).toBe(true)
    expect(isWorldCupQuery('any soccer today')).toBe(true)
    expect(isWorldCupQuery('fifa scores?')).toBe(true)
  })

  it('fires on sporty phrases naming a team on the slate', () => {
    __setWorldCupCacheForTest(freshCache())
    expect(isWorldCupQuery('Colombia Vs Ghana Score ?')).toBe(true)
    expect(isWorldCupQuery('did portugal win')).toBe(true)
    expect(isWorldCupQuery('when does usa play')).toBe(true)
    expect(isWorldCupQuery('united states game today?')).toBe(true)
  })

  it('never fires on bazaar-shaped queries — trivia score, game items, heroes', () => {
    __setWorldCupCacheForTest(freshCache())
    expect(isWorldCupQuery("what's my trivia score")).toBe(false)
    expect(isWorldCupQuery('vanessa best build')).toBe(false)
    expect(isWorldCupQuery('gold dooley vs pyg who wins')).toBe(false)
    expect(isWorldCupQuery('fiery boomerang enchant')).toBe(false)
  })
})

describe('getWorldCupLine', () => {
  it('formats live, FT, pens, and scheduled lines with the grounding instruction', () => {
    __setWorldCupCacheForTest(freshCache())
    const line = getWorldCupLine('colombia vs ghana score?')
    expect(line).toContain('NEVER invent scores')
    expect(line).toContain('Colombia 1-0 Ghana')
    expect(line).toContain("LIVE 90'+7'")
    expect(line).toContain('Egypt wins 4-2 on pens')
    expect(line).toContain('Portugal 2-1 Croatia (FT, Portugal won)')
    expect(line).toContain('United States vs Morocco — kicks off')
    expect(line).toContain('PT')
  })

  it('returns nothing for off-topic queries, empty cache, or hard-stale cache', () => {
    __setWorldCupCacheForTest(freshCache())
    expect(getWorldCupLine('vanessa best build')).toBe('')
    __setWorldCupCacheForTest({ fetchedAt: new Date().toISOString(), matches: [] })
    expect(getWorldCupLine('world cup score')).toBe('')
    __setWorldCupCacheForTest(freshCache(49 * 60 * 60 * 1000))
    expect(getWorldCupLine('world cup score')).toBe('')
  })

  it('flags a live score as moved when the cache is older than the trust window', () => {
    __setWorldCupCacheForTest(freshCache(6 * 60_000))
    const line = getWorldCupLine('colombia score')
    expect(line).toContain('score has likely moved')
    // final results stay unflagged — they cannot go stale
    expect(line).toContain('Portugal 2-1 Croatia (FT, Portugal won)')
  })

  it('stays well under budget — terse enough to never crowd the context', () => {
    __setWorldCupCacheForTest(freshCache())
    expect(getWorldCupLine('world cup scores').length).toBeLessThan(700)
  })
})
