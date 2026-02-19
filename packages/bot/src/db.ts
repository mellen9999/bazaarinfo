import { Database, type Statement } from 'bun:sqlite'
import { homedir } from 'os'
import { resolve } from 'path'

import { log } from './log'

const DB_PATH = resolve(homedir(), '.bazaarinfo.db')

let db: Database

type CmdType = 'item' | 'enchant' | 'mob' | 'hero' | 'skill' | 'tag' | 'day' | 'miss' | 'ai'

// --- prepared statements (initialized after migrations) ---

let stmts: {
  upsertUser: Statement
  selectUserId: Statement
  insertCommand: Statement
  incrUserCommands: Statement
  insertChat: Statement
  insertAsk: Statement
  incrUserAsks: Statement
  selectUser: Statement
  selectUserFav: Statement
  channelLeaderboard: Statement
  insertTriviaGame: Statement
  lastInsertId: Statement
  insertTriviaAnswer: Statement
  updateTriviaWin: Statement
  updateTriviaUserWin: Statement
  incrTriviaAttempt: Statement
  resetTriviaStreak: Statement
  triviaLeaderboard: Statement
  channelMessages: Statement
  userMessages: Statement
  userTopItems: Statement
  channelRegulars: Statement
  insertAlias: Statement
  deleteAlias: Statement
  selectAliases: Statement
}

function prepareStatements() {
  stmts = {
    upsertUser: db.prepare(
      `INSERT INTO users (username) VALUES (?) ON CONFLICT(username) DO UPDATE SET last_seen = datetime('now')`,
    ),
    selectUserId: db.prepare('SELECT id FROM users WHERE username = ?'),
    insertCommand: db.prepare(
      'INSERT INTO commands (user_id, channel, cmd_type, query, match_name, tier) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    incrUserCommands: db.prepare('UPDATE users SET total_commands = total_commands + 1 WHERE id = ?'),
    insertChat: db.prepare(
      'INSERT INTO chat_messages (channel, username, message) VALUES (?, ?, ?)',
    ),
    insertAsk: db.prepare(
      'INSERT INTO ask_queries (user_id, channel, query, response, tokens_used, latency_ms) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    incrUserAsks: db.prepare('UPDATE users SET ask_count = ask_count + 1 WHERE id = ?'),
    selectUser: db.prepare('SELECT * FROM users WHERE username = ?'),
    selectUserFav: db.prepare(
      `SELECT match_name, COUNT(*) as cnt FROM commands
       WHERE user_id = ? AND match_name IS NOT NULL
       GROUP BY match_name ORDER BY cnt DESC LIMIT 1`,
    ),
    channelLeaderboard: db.prepare(
      `SELECT u.username, COUNT(*) as total_commands FROM commands c
       JOIN users u ON c.user_id = u.id
       WHERE c.channel = ?
       GROUP BY c.user_id ORDER BY total_commands DESC LIMIT ?`,
    ),
    insertTriviaGame: db.prepare(
      'INSERT INTO trivia_games (channel, question_type, question_text, correct_answer) VALUES (?, ?, ?, ?)',
    ),
    lastInsertId: db.prepare('SELECT last_insert_rowid() as id'),
    insertTriviaAnswer: db.prepare(
      'INSERT INTO trivia_answers (game_id, user_id, answer_text, is_correct, answer_time_ms) VALUES (?, ?, ?, ?, ?)',
    ),
    updateTriviaWin: db.prepare(
      'UPDATE trivia_games SET winner_id = ?, answer_time_ms = ?, participant_count = ? WHERE id = ?',
    ),
    updateTriviaUserWin: db.prepare(
      `UPDATE users SET
        trivia_wins = trivia_wins + 1,
        trivia_streak = trivia_streak + 1,
        trivia_best_streak = MAX(trivia_best_streak, trivia_streak + 1),
        trivia_fastest_ms = CASE
          WHEN trivia_fastest_ms IS NULL THEN ?
          WHEN ? < trivia_fastest_ms THEN ?
          ELSE trivia_fastest_ms
        END
      WHERE id = ?`,
    ),
    incrTriviaAttempt: db.prepare('UPDATE users SET trivia_attempts = trivia_attempts + 1 WHERE id = ?'),
    resetTriviaStreak: db.prepare('UPDATE users SET trivia_streak = 0 WHERE id = ?'),
    triviaLeaderboard: db.prepare(
      `SELECT u.username, COUNT(*) as trivia_wins FROM users u
       JOIN trivia_games tg ON tg.winner_id = u.id
       WHERE tg.channel = ?
       GROUP BY u.id ORDER BY trivia_wins DESC LIMIT ?`,
    ),
    channelMessages: db.prepare(
      'SELECT message FROM chat_messages WHERE channel = ? ORDER BY created_at DESC LIMIT ?',
    ),
    userMessages: db.prepare(
      'SELECT message FROM chat_messages WHERE LOWER(username) = ? AND channel = ? ORDER BY created_at DESC LIMIT ?',
    ),
    userTopItems: db.prepare(
      `SELECT match_name, COUNT(*) as cnt FROM commands c
       JOIN users u ON c.user_id = u.id
       WHERE LOWER(u.username) = ? AND c.match_name IS NOT NULL AND c.cmd_type != 'miss'
       GROUP BY c.match_name ORDER BY cnt DESC LIMIT ?`,
    ),
    channelRegulars: db.prepare(
      `SELECT username, COUNT(*) as msgs FROM chat_messages
       WHERE channel = ? GROUP BY LOWER(username) ORDER BY msgs DESC LIMIT ?`,
    ),
    insertAlias: db.prepare('INSERT OR REPLACE INTO aliases (alias, target, added_by) VALUES (?, ?, ?)'),
    deleteAlias: db.prepare('DELETE FROM aliases WHERE alias = ?'),
    selectAliases: db.prepare('SELECT alias, target, added_by FROM aliases ORDER BY alias'),
  }
}

// --- user ID cache ---

const userIdCache = new Map<string, number>()

// --- deferred write queue ---

type WriteOp =
  | { type: 'chat'; channel: string; username: string; message: string }
  | { type: 'command'; userId: number | null; channel: string | null; cmdType: string; query: string | null; matchName: string | null; tier: string | null }
  | { type: 'ask'; userId: number | null; channel: string | null; query: string; response: string | null; tokens: number | null; latency: number | null }
  | { type: 'incr_commands'; userId: number }
  | { type: 'incr_asks'; userId: number }

const writeQueue: WriteOp[] = []
let flushTimer: Timer | null = null
const FLUSH_INTERVAL = 100 // flush every 100ms

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(flushWrites, FLUSH_INTERVAL)
}

export function flushWrites() {
  flushTimer = null
  if (writeQueue.length === 0) return
  const batch = writeQueue.splice(0)
  try {
    db.transaction(() => {
      for (const op of batch) {
        switch (op.type) {
          case 'chat':
            stmts.insertChat.run(op.channel, op.username, op.message)
            break
          case 'command':
            stmts.insertCommand.run(op.userId, op.channel, op.cmdType, op.query, op.matchName, op.tier)
            break
          case 'ask':
            stmts.insertAsk.run(op.userId, op.channel, op.query, op.response, op.tokens, op.latency)
            break
          case 'incr_commands':
            stmts.incrUserCommands.run(op.userId)
            break
          case 'incr_asks':
            stmts.incrUserAsks.run(op.userId)
            break
        }
      }
    })()
  } catch (e) {
    log(`flush error: ${e}`)
  }
}

// --- migrations ---

const migrations: (() => void)[] = [
  // migration 0: initial schema
  () => {
    db.run(`CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE COLLATE NOCASE NOT NULL,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen TEXT NOT NULL DEFAULT (datetime('now')),
      total_commands INTEGER NOT NULL DEFAULT 0,
      trivia_wins INTEGER NOT NULL DEFAULT 0,
      trivia_attempts INTEGER NOT NULL DEFAULT 0,
      trivia_streak INTEGER NOT NULL DEFAULT 0,
      trivia_best_streak INTEGER NOT NULL DEFAULT 0,
      trivia_fastest_ms INTEGER,
      ask_count INTEGER NOT NULL DEFAULT 0
    )`)

    db.run(`CREATE TABLE commands (
      id INTEGER PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      channel TEXT,
      cmd_type TEXT NOT NULL,
      query TEXT,
      match_name TEXT,
      tier TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    db.run(`CREATE INDEX idx_commands_created ON commands(created_at)`)
    db.run(`CREATE INDEX idx_commands_user ON commands(user_id)`)

    db.run(`CREATE TABLE chat_messages (
      id INTEGER PRIMARY KEY,
      channel TEXT NOT NULL,
      username TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    db.run(`CREATE INDEX idx_chat_channel_time ON chat_messages(channel, created_at)`)
    db.run(`CREATE INDEX idx_chat_username ON chat_messages(username)`)

    db.run(`CREATE TABLE trivia_games (
      id INTEGER PRIMARY KEY,
      channel TEXT NOT NULL,
      question_type INTEGER NOT NULL,
      question_text TEXT NOT NULL,
      correct_answer TEXT NOT NULL,
      winner_id INTEGER REFERENCES users(id),
      answer_time_ms INTEGER,
      participant_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)

    db.run(`CREATE TABLE trivia_answers (
      id INTEGER PRIMARY KEY,
      game_id INTEGER NOT NULL REFERENCES trivia_games(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      answer_text TEXT NOT NULL,
      is_correct INTEGER NOT NULL DEFAULT 0,
      answer_time_ms INTEGER NOT NULL
    )`)

    db.run(`CREATE TABLE ask_queries (
      id INTEGER PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      channel TEXT,
      query TEXT NOT NULL,
      context_summary TEXT,
      response TEXT,
      tokens_used INTEGER,
      latency_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)

    db.run(`CREATE TABLE daily_stats (
      date TEXT NOT NULL,
      channel TEXT NOT NULL,
      total_commands INTEGER NOT NULL DEFAULT 0,
      unique_users INTEGER NOT NULL DEFAULT 0,
      hits INTEGER NOT NULL DEFAULT 0,
      misses INTEGER NOT NULL DEFAULT 0,
      trivia_games INTEGER NOT NULL DEFAULT 0,
      ask_queries INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, channel)
    )`)
  },
  // migration 1: performance indexes
  () => {
    db.run(`CREATE INDEX idx_commands_channel ON commands(channel, user_id)`)
    db.run(`CREATE INDEX idx_trivia_channel_winner ON trivia_games(channel, winner_id)`)
    db.run(`CREATE INDEX idx_commands_hits ON commands(match_name) WHERE cmd_type != 'miss'`)
  },
  // migration 2: dynamic aliases
  () => {
    db.run(`CREATE TABLE aliases (
      alias TEXT PRIMARY KEY COLLATE NOCASE,
      target TEXT NOT NULL,
      added_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
  },
]

function runMigrations() {
  db.run(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`)
  const row = db.query('SELECT version FROM schema_version').get() as { version: number } | null
  let current = row?.version ?? -1

  if (current === -1 && !row) {
    db.run('INSERT INTO schema_version (version) VALUES (-1)')
  }

  for (let i = current + 1; i < migrations.length; i++) {
    log(`running migration ${i}...`)
    db.transaction(() => {
      migrations[i]()
      db.run('UPDATE schema_version SET version = ?', [i])
    })()
    current = i
  }

  if (current >= 0) log(`db schema at version ${current}`)
}

export function initDb(path?: string) {
  db = new Database(path ?? DB_PATH)
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA synchronous = NORMAL')
  db.run('PRAGMA busy_timeout = 5000')
  runMigrations()
  prepareStatements()
}

export function closeDb() {
  // flush pending writes before closing
  if (flushTimer) clearTimeout(flushTimer)
  flushWrites()
  db?.close()
}

export function getDb(): Database {
  return db
}

// --- helpers ---

export function getOrCreateUser(username: string): number {
  const lower = username.toLowerCase()
  const cached = userIdCache.get(lower)
  if (cached !== undefined) {
    // still upsert for last_seen, but skip the SELECT
    stmts.upsertUser.run(lower)
    return cached
  }
  stmts.upsertUser.run(lower)
  const row = stmts.selectUserId.get(lower) as { id: number }
  userIdCache.set(lower, row.id)
  return row.id
}

export function logCommand(
  ctx: { user?: string; channel?: string },
  cmdType: CmdType,
  query?: string,
  matchName?: string,
  tier?: string,
) {
  const userId = ctx.user ? getOrCreateUser(ctx.user) : null
  writeQueue.push({
    type: 'command',
    userId,
    channel: ctx.channel ?? null,
    cmdType,
    query: query ?? null,
    matchName: matchName ?? null,
    tier: tier ?? null,
  })
  if (userId) writeQueue.push({ type: 'incr_commands', userId })
  scheduleFlush()
}

export function logChat(channel: string, username: string, message: string) {
  writeQueue.push({ type: 'chat', channel, username: username.toLowerCase(), message })
  scheduleFlush()
}

export interface UserStats {
  username: string
  total_commands: number
  trivia_wins: number
  trivia_attempts: number
  trivia_streak: number
  trivia_best_streak: number
  trivia_fastest_ms: number | null
  first_seen: string
  favorite_item: string | null
}

export function getUserStats(username: string): UserStats | null {
  const user = stmts.selectUser.get(username.toLowerCase()) as (UserStats & { id: number }) | null
  if (!user) return null

  const fav = stmts.selectUserFav.get(user.id) as { match_name: string; cnt: number } | null

  return {
    username: user.username,
    total_commands: user.total_commands,
    trivia_wins: user.trivia_wins,
    trivia_attempts: user.trivia_attempts,
    trivia_streak: user.trivia_streak,
    trivia_best_streak: user.trivia_best_streak,
    trivia_fastest_ms: user.trivia_fastest_ms,
    first_seen: user.first_seen,
    favorite_item: fav?.match_name ?? null,
  }
}

export function getChannelLeaderboard(channel: string, limit = 5): { username: string; total_commands: number }[] {
  return stmts.channelLeaderboard.all(channel, limit) as { username: string; total_commands: number }[]
}


// trivia helpers
export function createTriviaGame(
  channel: string,
  questionType: number,
  questionText: string,
  correctAnswer: string,
): number {
  stmts.insertTriviaGame.run(channel, questionType, questionText, correctAnswer)
  return (stmts.lastInsertId.get() as { id: number }).id
}

export function recordTriviaAnswer(
  gameId: number,
  userId: number,
  answerText: string,
  isCorrect: boolean,
  answerTimeMs: number,
) {
  stmts.insertTriviaAnswer.run(gameId, userId, answerText, isCorrect ? 1 : 0, answerTimeMs)
}

export function recordTriviaWin(gameId: number, userId: number, answerTimeMs: number, participantCount: number) {
  stmts.updateTriviaWin.run(userId, answerTimeMs, participantCount, gameId)
  stmts.updateTriviaUserWin.run(answerTimeMs, answerTimeMs, answerTimeMs, userId)
}

export function recordTriviaAttempt(userId: number) {
  stmts.incrTriviaAttempt.run(userId)
}

export function resetTriviaStreak(userId: number) {
  stmts.resetTriviaStreak.run(userId)
}

export function getTriviaLeaderboard(channel: string, limit = 5): { username: string; trivia_wins: number }[] {
  return stmts.triviaLeaderboard.all(channel, limit) as { username: string; trivia_wins: number }[]
}

// channel chat style profile
export function getChannelMessages(channel: string, limit = 5000): string[] {
  const rows = stmts.channelMessages.all(channel, limit) as { message: string }[]
  return rows.map((r) => r.message)
}

// per-user chat messages
export function getUserMessages(username: string, channel: string, limit = 500): string[] {
  const rows = stmts.userMessages.all(username.toLowerCase(), channel, limit) as { message: string }[]
  return rows.map((r) => r.message)
}

// user's top looked-up items
export function getUserTopItems(username: string, limit = 5): string[] {
  const lower = username.toLowerCase()
  const rows = stmts.userTopItems.all(lower, limit) as { match_name: string; cnt: number }[]
  return rows.map((r) => r.match_name)
}

// channel regulars (by message count)
export function getChannelRegulars(channel: string, limit = 20): { username: string; msgs: number }[] {
  return stmts.channelRegulars.all(channel, limit) as { username: string; msgs: number }[]
}

// ai ask logging
export function logAsk(
  ctx: { user?: string; channel?: string },
  query: string,
  response: string | null,
  tokensUsed?: number,
  latencyMs?: number,
) {
  const userId = ctx.user ? getOrCreateUser(ctx.user) : null
  writeQueue.push({
    type: 'ask',
    userId,
    channel: ctx.channel ?? null,
    query,
    response,
    tokens: tokensUsed ?? null,
    latency: latencyMs ?? null,
  })
  if (userId) writeQueue.push({ type: 'incr_asks', userId })
  scheduleFlush()
}

// alias helpers
export function addAlias(alias: string, target: string, addedBy?: string) {
  stmts.insertAlias.run(alias.toLowerCase(), target, addedBy ?? null)
}

export function removeAlias(alias: string): boolean {
  const result = stmts.deleteAlias.run(alias.toLowerCase())
  return result.changes > 0
}

export function getAllAliases(): { alias: string; target: string; added_by: string | null }[] {
  return stmts.selectAliases.all() as {
    alias: string
    target: string
    added_by: string | null
  }[]
}
