import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { unlinkSync } from 'fs'
import { resolve } from 'path'
import { tmpdir } from 'os'

// dynamic import to avoid mock.module conflicts from other test files
const db = await import('./db')

let dbPath: string

function cleanPath(p: string) {
  try { unlinkSync(p) } catch {}
  try { unlinkSync(p + '-wal') } catch {}
  try { unlinkSync(p + '-shm') } catch {}
}

describe('db', () => {
  beforeEach(() => {
    dbPath = resolve(tmpdir(), `.bazaarinfo-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    db.initDb(dbPath)
  })

  afterEach(() => {
    try { db.closeDb() } catch {}
    cleanPath(dbPath)
  })

  it('initializes without error', () => {
    expect(db.getDb()).toBeTruthy()
  })

  it('creates and retrieves users', () => {
    const id1 = db.getOrCreateUser('TestUser')
    const id2 = db.getOrCreateUser('testuser')
    expect(id1).toBe(id2)
  })

  it('logs commands and increments user total', () => {
    db.logCommand({ user: 'alice', channel: 'bob' }, 'item', 'boomerang', 'Boomerang', 'Gold')
    db.logCommand({ user: 'alice', channel: 'bob' }, 'miss', 'xyzfake')

    const stats = db.getUserStats('alice')
    expect(stats).toBeTruthy()
    expect(stats!.total_commands).toBe(2)
  })

  it('logs and retrieves chat messages', () => {
    db.logChat('testchannel', 'alice', 'hello world')
    db.logChat('testchannel', 'bob', 'hi alice')
    db.logChat('testchannel', 'alice', 'how are you')

    const recent = db.getRecentChat('testchannel', 10)
    expect(recent.length).toBe(3)
    expect(recent[0].message).toBe('how are you')
  })

  it('gets user history', () => {
    db.logChat('ch1', 'alice', 'msg1')
    db.logChat('ch2', 'alice', 'msg2')
    db.logChat('ch1', 'bob', 'msg3')

    const history = db.getUserHistory('alice', 10)
    expect(history.length).toBe(2)
  })

  it('returns null for unknown user stats', () => {
    const stats = db.getUserStats('nobody')
    expect(stats).toBeNull()
  })

  it('gets user stats with favorite item', () => {
    db.logCommand({ user: 'alice' }, 'item', 'boom', 'Boomerang')
    db.logCommand({ user: 'alice' }, 'item', 'boom', 'Boomerang')
    db.logCommand({ user: 'alice' }, 'item', 'shield', 'Shield')

    const stats = db.getUserStats('alice')
    expect(stats!.favorite_item).toBe('Boomerang')
  })

  it('channel leaderboard works', () => {
    db.logCommand({ user: 'alice', channel: 'test' }, 'item', 'a', 'A')
    db.logCommand({ user: 'alice', channel: 'test' }, 'item', 'b', 'B')
    db.logCommand({ user: 'bob', channel: 'test' }, 'item', 'c', 'C')

    const leaders = db.getChannelLeaderboard('test', 5)
    expect(leaders.length).toBe(2)
    expect(leaders[0].username).toBe('alice')
    expect(leaders[0].total_commands).toBe(2)
  })

  it('popular items works', () => {
    db.logCommand({ user: 'a' }, 'item', 'q', 'Boomerang')
    db.logCommand({ user: 'b' }, 'item', 'q', 'Boomerang')
    db.logCommand({ user: 'c' }, 'item', 'q', 'Shield')
    db.logCommand({ user: 'd' }, 'miss', 'xyz')

    const popular = db.getPopularItems(5)
    expect(popular[0].match_name).toBe('Boomerang')
    expect(popular[0].cnt).toBe(2)
  })

  it('trivia lifecycle works', () => {
    const gameId = db.createTriviaGame('test', 1, 'Which item?', 'Boomerang')
    expect(gameId).toBeGreaterThan(0)

    const userId = db.getOrCreateUser('winner')
    db.recordTriviaAttempt(userId)
    db.recordTriviaAnswer(gameId, userId, 'Boomerang', true, 5000)
    db.recordTriviaWin(gameId, userId, 5000, 3)

    const stats = db.getUserStats('winner')
    expect(stats!.trivia_wins).toBe(1)
    expect(stats!.trivia_attempts).toBe(1)
    expect(stats!.trivia_fastest_ms).toBe(5000)
  })

  it('trivia streak tracking', () => {
    const userId = db.getOrCreateUser('streaker')

    for (let i = 0; i < 3; i++) {
      const gid = db.createTriviaGame('test', 1, 'q', 'a')
      db.recordTriviaWin(gid, userId, 1000, 1)
    }

    let stats = db.getUserStats('streaker')
    expect(stats!.trivia_streak).toBe(3)
    expect(stats!.trivia_best_streak).toBe(3)

    db.resetTriviaStreak(userId)
    stats = db.getUserStats('streaker')
    expect(stats!.trivia_streak).toBe(0)
    expect(stats!.trivia_best_streak).toBe(3)
  })

  it('ask logging works', () => {
    db.logAsk({ user: 'alice', channel: 'test' }, 'what is', 'ctx', 'response', 100, 500)

    const stats = db.getUserStats('alice')
    expect(stats!.ask_count).toBe(1)
  })

  it('trivia leaderboard works', () => {
    const u1 = db.getOrCreateUser('winner1')
    const u2 = db.getOrCreateUser('winner2')

    const g1 = db.createTriviaGame('test', 1, 'q1', 'a1')
    db.recordTriviaWin(g1, u1, 1000, 1)
    const g2 = db.createTriviaGame('test', 1, 'q2', 'a2')
    db.recordTriviaWin(g2, u1, 1000, 1)
    const g3 = db.createTriviaGame('test', 1, 'q3', 'a3')
    db.recordTriviaWin(g3, u2, 1000, 1)

    const leaders = db.getTriviaLeaderboard('test', 5)
    expect(leaders.length).toBe(2)
    expect(leaders[0].username).toBe('winner1')
    expect(leaders[0].trivia_wins).toBe(2)
  })
})
