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
    db.flushWrites()

    const stats = db.getUserStats('alice')
    expect(stats).toBeTruthy()
    expect(stats!.total_commands).toBe(2)
  })

  it('returns null for unknown user stats', () => {
    const stats = db.getUserStats('nobody')
    expect(stats).toBeNull()
  })

  it('gets user stats with favorite item', () => {
    db.logCommand({ user: 'alice' }, 'item', 'boom', 'Boomerang')
    db.logCommand({ user: 'alice' }, 'item', 'boom', 'Boomerang')
    db.logCommand({ user: 'alice' }, 'item', 'shield', 'Shield')
    db.flushWrites()

    const stats = db.getUserStats('alice')
    expect(stats!.favorite_item).toBe('Boomerang')
  })

  it('channel leaderboard works', () => {
    db.logCommand({ user: 'alice', channel: 'test' }, 'item', 'a', 'A')
    db.logCommand({ user: 'alice', channel: 'test' }, 'item', 'b', 'B')
    db.logCommand({ user: 'bob', channel: 'test' }, 'item', 'c', 'C')
    db.flushWrites()

    const leaders = db.getChannelLeaderboard('test', 5)
    expect(leaders.length).toBe(2)
    expect(leaders[0].username).toBe('alice')
    expect(leaders[0].total_commands).toBe(2)
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

  // --- chat summaries ---

  it('logs and retrieves summaries', () => {
    db.logSummary('test', 1, 'chat about boomerangs', 200)
    db.logSummary('test', 1, 'moved to shields discussion', 200)
    db.flushWrites()

    const rows = db.getLatestSummaries('test', 5)
    expect(rows.length).toBe(2)
    expect(rows[0].summary).toBe('moved to shields discussion')
    expect(rows[1].summary).toBe('chat about boomerangs')
  })

  it('getSessionSummaries filters by session', () => {
    db.logSummary('test', 1, 'session 1 stuff', 200)
    db.logSummary('test', 2, 'session 2 stuff', 200)
    db.flushWrites()

    const s1 = db.getSessionSummaries('test', 1)
    expect(s1.length).toBe(1)
    expect(s1[0].summary).toBe('session 1 stuff')

    const s2 = db.getSessionSummaries('test', 2)
    expect(s2.length).toBe(1)
    expect(s2[0].summary).toBe('session 2 stuff')
  })

  it('getMaxSessionId returns highest session', () => {
    expect(db.getMaxSessionId('test')).toBe(0)

    db.logSummary('test', 3, 'summary', 200)
    db.logSummary('test', 5, 'summary', 200)
    db.flushWrites()

    expect(db.getMaxSessionId('test')).toBe(5)
  })

  // --- FTS ---

  it('FTS search finds chat messages', () => {
    db.logChat('test', 'alice', 'boomerang is overpowered')
    db.logChat('test', 'bob', 'shield build is better')
    db.logChat('test', 'alice', 'boomerang scales with crit')
    db.flushWrites()

    const hits = db.searchChatFTS('test', 'boomerang')
    expect(hits.length).toBe(2)
    expect(hits[0].username).toBe('alice')
  })

  it('FTS search filters by username', () => {
    db.logChat('test', 'alice', 'boomerang rush')
    db.logChat('test', 'bob', 'boomerang is fine')
    db.flushWrites()

    const hits = db.searchChatFTS('test', 'boomerang', 10, 'alice')
    expect(hits.length).toBe(1)
    expect(hits[0].username).toBe('alice')
  })

  it('FTS search filters by channel', () => {
    db.logChat('chan1', 'alice', 'boomerang')
    db.logChat('chan2', 'bob', 'boomerang')
    db.flushWrites()

    const hits = db.searchChatFTS('chan1', 'boomerang')
    expect(hits.length).toBe(1)
    expect(hits[0].username).toBe('alice')
  })

  it('pruneOldSummaries removes old entries', () => {
    db.logSummary('test', 1, 'old summary', 200)
    db.flushWrites()

    // manually backdate the row
    db.getDb().run(`UPDATE chat_summaries SET created_at = datetime('now', '-60 days')`)

    db.logSummary('test', 1, 'new summary', 200)
    db.flushWrites()

    db.pruneOldSummaries(30)

    const rows = db.getLatestSummaries('test', 10)
    expect(rows.length).toBe(1)
    expect(rows[0].summary).toBe('new summary')
  })
})
