import { Database, type Statement } from 'bun:sqlite'
import { homedir } from 'os'
import { resolve } from 'path'

import { log } from './log'

const DB_PATH = resolve(homedir(), '.bazaarinfo.db')

let db: Database

export type CmdType = 'item' | 'enchant' | 'enchants' | 'mob' | 'hero' | 'skill' | 'tag' | 'day' | 'miss' | 'ai'

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
  insertSummary: Statement
  latestSummaries: Statement
  sessionSummaries: Statement
  maxSessionId: Statement
  searchFTS: Statement
  searchFTSByUser: Statement
  recentAsks: Statement
  searchAskFTS: Statement
  selectMemo: Statement
  upsertMemo: Statement
  recentAsksForMemo: Statement
  insertUserFact: Statement
  getUserFacts: Statement
  countUserFacts: Statement
  getCachedTwitchUser: Statement
  setCachedTwitchUser: Statement
  getCachedFollowage: Statement
  setCachedFollowage: Statement
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
      `SELECT LOWER(username) as username, COUNT(*) as msgs FROM chat_messages
       WHERE channel = ? GROUP BY LOWER(username) ORDER BY msgs DESC LIMIT ?`,
    ),
    insertAlias: db.prepare('INSERT OR REPLACE INTO aliases (alias, target, added_by) VALUES (?, ?, ?)'),
    deleteAlias: db.prepare('DELETE FROM aliases WHERE alias = ?'),
    selectAliases: db.prepare('SELECT alias, target, added_by FROM aliases ORDER BY alias'),
    insertSummary: db.prepare(
      'INSERT INTO chat_summaries (channel, session_id, summary, msg_count) VALUES (?, ?, ?, ?)',
    ),
    latestSummaries: db.prepare(
      'SELECT summary, created_at FROM chat_summaries WHERE channel = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    ),
    sessionSummaries: db.prepare(
      'SELECT summary, created_at FROM chat_summaries WHERE channel = ? AND session_id = ? ORDER BY created_at ASC',
    ),
    maxSessionId: db.prepare(
      'SELECT MAX(session_id) as max_id FROM chat_summaries WHERE channel = ?',
    ),
    searchFTS: db.prepare(
      `SELECT cm.username, cm.message, cm.created_at FROM chat_fts f
       JOIN chat_messages cm ON cm.id = f.rowid
       WHERE f.message MATCH ? AND cm.channel = ?
       ORDER BY cm.created_at DESC LIMIT ?`,
    ),
    searchFTSByUser: db.prepare(
      `SELECT cm.username, cm.message, cm.created_at FROM chat_fts f
       JOIN chat_messages cm ON cm.id = f.rowid
       WHERE f.message MATCH ? AND cm.channel = ? AND LOWER(cm.username) = ?
       ORDER BY cm.created_at DESC LIMIT ?`,
    ),
    recentAsks: db.prepare(
      `SELECT query, response, created_at FROM ask_queries
       WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    ),
    searchAskFTS: db.prepare(
      `SELECT u.username, aq.query, aq.response, aq.created_at
       FROM ask_fts f
       JOIN ask_queries aq ON aq.id = f.rowid
       LEFT JOIN users u ON aq.user_id = u.id
       WHERE ask_fts MATCH ? AND aq.channel = ?
       ORDER BY aq.created_at DESC LIMIT ?`,
    ),
    selectMemo: db.prepare('SELECT memo, ask_count_at FROM user_memos WHERE username = ?'),
    upsertMemo: db.prepare(
      `INSERT INTO user_memos (username, memo, ask_count_at, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(username) DO UPDATE SET memo = excluded.memo, ask_count_at = excluded.ask_count_at, updated_at = datetime('now')`,
    ),
    recentAsksForMemo: db.prepare(
      `SELECT aq.query, aq.response FROM ask_queries aq
       WHERE aq.user_id = ? AND aq.response IS NOT NULL
       ORDER BY aq.created_at DESC LIMIT ?`,
    ),
    insertUserFact: db.prepare('INSERT INTO user_facts (username, fact) VALUES (?, ?)'),
    getUserFacts: db.prepare('SELECT fact FROM user_facts WHERE LOWER(username) = ? ORDER BY created_at DESC LIMIT ?'),
    countUserFacts: db.prepare('SELECT COUNT(*) as cnt FROM user_facts WHERE LOWER(username) = ?'),
    getCachedTwitchUser: db.prepare('SELECT twitch_id, display_name, account_created_at, cached_at FROM twitch_users WHERE username = ?'),
    setCachedTwitchUser: db.prepare(
      `INSERT INTO twitch_users (username, twitch_id, display_name, account_created_at, cached_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(username) DO UPDATE SET twitch_id = excluded.twitch_id, display_name = excluded.display_name, account_created_at = excluded.account_created_at, cached_at = datetime('now')`,
    ),
    getCachedFollowage: db.prepare('SELECT followed_at, cached_at FROM channel_follows WHERE username = ? AND channel = ?'),
    setCachedFollowage: db.prepare(
      `INSERT INTO channel_follows (username, channel, followed_at, cached_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(username, channel) DO UPDATE SET followed_at = excluded.followed_at, cached_at = datetime('now')`,
    ),
  }
}

// --- user ID cache ---

const userIdCache = new Map<string, { id: number; lastUpsert: number }>()
const USER_CACHE_MAX = 10_000

// --- deferred write queue ---

type WriteOp =
  | { type: 'chat'; channel: string; username: string; message: string }
  | { type: 'command'; userId: number | null; channel: string | null; cmdType: string; query: string | null; matchName: string | null; tier: string | null }
  | { type: 'ask'; userId: number | null; channel: string | null; query: string; response: string | null; tokens: number | null; latency: number | null }
  | { type: 'incr_commands'; userId: number }
  | { type: 'incr_asks'; userId: number }
  | { type: 'summary'; channel: string; sessionId: number; summary: string; msgCount: number }
  | { type: 'user_fact'; username: string; fact: string }

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
          case 'summary':
            stmts.insertSummary.run(op.channel, op.sessionId, op.summary, op.msgCount)
            break
          case 'user_fact':
            stmts.insertUserFact.run(op.username, op.fact)
            break
        }
      }
    })()
  } catch (e) {
    log(`flush error (batch of ${batch.length}): ${e}`)
    // retry individually — salvage what we can
    for (const op of batch) {
      try {
        switch (op.type) {
          case 'chat': stmts.insertChat.run(op.channel, op.username, op.message); break
          case 'command': stmts.insertCommand.run(op.userId, op.channel, op.cmdType, op.query, op.matchName, op.tier); break
          case 'ask': stmts.insertAsk.run(op.userId, op.channel, op.query, op.response, op.tokens, op.latency); break
          case 'incr_commands': stmts.incrUserCommands.run(op.userId); break
          case 'incr_asks': stmts.incrUserAsks.run(op.userId); break
          case 'summary': stmts.insertSummary.run(op.channel, op.sessionId, op.summary, op.msgCount); break
          case 'user_fact': stmts.insertUserFact.run(op.username, op.fact); break
        }
      } catch (e2) {
        log(`flush retry failed (${op.type}): ${e2}`)
      }
    }
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
  // migration 3: chat summaries + FTS
  () => {
    db.run(`CREATE TABLE chat_summaries (
      id INTEGER PRIMARY KEY,
      channel TEXT NOT NULL,
      session_id INTEGER NOT NULL,
      summary TEXT NOT NULL,
      msg_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    db.run(`CREATE INDEX idx_summaries_channel_session ON chat_summaries(channel, session_id)`)
    db.run(`CREATE INDEX idx_summaries_channel_time ON chat_summaries(channel, created_at DESC)`)

    // FTS5 content-external — no storage duplication
    db.run(`CREATE VIRTUAL TABLE chat_fts USING fts5(message, content='chat_messages', content_rowid='id')`)
    // backfill existing messages
    db.run(`INSERT INTO chat_fts(rowid, message) SELECT id, message FROM chat_messages`)
    // auto-sync triggers
    db.run(`CREATE TRIGGER chat_fts_insert AFTER INSERT ON chat_messages BEGIN
      INSERT INTO chat_fts(rowid, message) VALUES (new.id, new.message);
    END`)
    db.run(`CREATE TRIGGER chat_fts_delete AFTER DELETE ON chat_messages BEGIN
      INSERT INTO chat_fts(chat_fts, rowid, message) VALUES ('delete', old.id, old.message);
    END`)
  },
  // migration 4: index for ask_queries user lookups
  () => {
    db.run(`CREATE INDEX idx_ask_user ON ask_queries(user_id, created_at DESC)`)
  },
  // migration 5: FTS on ask_queries for contextual recall
  () => {
    db.run(`CREATE VIRTUAL TABLE ask_fts USING fts5(query, response, content='ask_queries', content_rowid='id')`)
    db.run(`INSERT INTO ask_fts(rowid, query, response) SELECT id, query, COALESCE(response, '') FROM ask_queries`)
    db.run(`CREATE TRIGGER ask_fts_insert AFTER INSERT ON ask_queries BEGIN
      INSERT INTO ask_fts(rowid, query, response) VALUES (new.id, new.query, COALESCE(new.response, ''));
    END`)
    db.run(`CREATE TRIGGER ask_fts_delete AFTER DELETE ON ask_queries BEGIN
      INSERT INTO ask_fts(ask_fts, rowid, query, response) VALUES ('delete', old.id, old.query, COALESCE(old.response, ''));
    END`)
  },
  // migration 6: per-user AI memory memos
  () => {
    db.run(`CREATE TABLE user_memos (
      username TEXT PRIMARY KEY COLLATE NOCASE,
      memo TEXT NOT NULL,
      ask_count_at INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
  },
  // migration 7: per-user extracted facts (long-term memory)
  () => {
    db.run(`CREATE TABLE user_facts (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE,
      fact TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    db.run(`CREATE INDEX idx_user_facts_username ON user_facts(LOWER(username))`)

    db.run(`CREATE VIRTUAL TABLE user_facts_fts USING fts5(
      fact, content='user_facts', content_rowid='id'
    )`)
    db.run(`CREATE TRIGGER user_facts_fts_insert AFTER INSERT ON user_facts BEGIN
      INSERT INTO user_facts_fts(rowid, fact) VALUES (new.id, new.fact);
    END`)
    db.run(`CREATE TRIGGER user_facts_fts_delete AFTER DELETE ON user_facts BEGIN
      INSERT INTO user_facts_fts(user_facts_fts, rowid, fact)
        VALUES ('delete', old.id, old.fact);
    END`)
  },
  // migration 8: twitch user cache (account age, display name)
  () => {
    db.run(`CREATE TABLE twitch_users (
      username TEXT PRIMARY KEY COLLATE NOCASE,
      twitch_id TEXT NOT NULL,
      display_name TEXT,
      account_created_at TEXT,
      cached_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
  },
  // migration 9: channel followage cache
  () => {
    db.run(`CREATE TABLE channel_follows (
      username TEXT NOT NULL COLLATE NOCASE,
      channel TEXT NOT NULL COLLATE NOCASE,
      followed_at TEXT,
      cached_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (username, channel)
    )`)
  },
  // migration 10: fix chat_messages index to use LOWER(username) for case-insensitive lookups
  () => {
    db.run(`DROP INDEX IF EXISTS idx_chat_username`)
    db.run(`CREATE INDEX idx_chat_username ON chat_messages(LOWER(username))`)
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
  db.run('PRAGMA foreign_keys = ON')
  runMigrations()
  prepareStatements()
  userIdCache.clear()
}

export function pruneOldChats(days = 30) {
  try {
    const result = db.run(
      `DELETE FROM chat_messages WHERE created_at < datetime('now', ?)`,
      [`-${days} days`],
    )
    if (result.changes > 0) log(`pruned ${result.changes} chat messages older than ${days}d`)
  } catch (e) {
    log(`prune error: ${e}`)
  }
}

export function closeDb() {
  // flush pending writes before closing
  if (flushTimer) clearTimeout(flushTimer)
  flushWrites()
  db?.close()
}

// test-only — direct db access for backdating rows in tests
export function getDb(): Database {
  return db
}

// --- helpers ---

const UPSERT_THROTTLE = 60_000 // skip last_seen update if <60s since last

export function getOrCreateUser(username: string): number {
  const lower = username.toLowerCase()
  const cached = userIdCache.get(lower)
  const now = Date.now()
  if (cached !== undefined) {
    // throttle last_seen upsert — skip if recently updated
    if (now - cached.lastUpsert < UPSERT_THROTTLE) return cached.id
    stmts.upsertUser.run(lower)
    cached.lastUpsert = now
    return cached.id
  }
  stmts.upsertUser.run(lower)
  const row = stmts.selectUserId.get(lower) as { id: number }
  if (userIdCache.size >= USER_CACHE_MAX) {
    // evict oldest entry
    const first = userIdCache.keys().next().value!
    userIdCache.delete(first)
  }
  userIdCache.set(lower, { id: row.id, lastUpsert: now })
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
  ask_count: number
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
    ask_count: user.ask_count ?? 0,
    trivia_wins: user.trivia_wins,
    trivia_attempts: user.trivia_attempts,
    trivia_streak: user.trivia_streak,
    trivia_best_streak: user.trivia_best_streak,
    trivia_fastest_ms: user.trivia_fastest_ms,
    first_seen: user.first_seen,
    favorite_item: fav?.match_name ?? null,
  }
}

export function formatAccountAge(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime()
  if (isNaN(ms) || ms < 0) return 'unknown'
  const days = Math.floor(ms / 86_400_000)
  if (days < 30) return `${days}d old`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo old`
  const years = Math.floor(months / 12)
  const rem = months % 12
  return rem > 0 ? `${years}y${rem}mo old` : `${years}y old`
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

// --- chat summary helpers ---

export function logSummary(channel: string, sessionId: number, summary: string, msgCount: number) {
  writeQueue.push({ type: 'summary', channel, sessionId, summary, msgCount })
  scheduleFlush()
}

export interface SummaryRow { summary: string; created_at: string }

export function getLatestSummaries(channel: string, limit = 5): SummaryRow[] {
  return stmts.latestSummaries.all(channel, limit) as SummaryRow[]
}

export function getSessionSummaries(channel: string, sessionId: number): SummaryRow[] {
  return stmts.sessionSummaries.all(channel, sessionId) as SummaryRow[]
}

export function getMaxSessionId(channel: string): number {
  const row = stmts.maxSessionId.get(channel) as { max_id: number | null } | null
  return row?.max_id ?? 0
}

export interface FTSResult { username: string; message: string; created_at: string }

export function searchChatFTS(channel: string, query: string, limit = 10, username?: string): FTSResult[] {
  try {
    if (username) {
      return stmts.searchFTSByUser.all(query, channel, username.toLowerCase(), limit) as FTSResult[]
    }
    return stmts.searchFTS.all(query, channel, limit) as FTSResult[]
  } catch {
    return []
  }
}

// recent AI interactions for a user
export interface AskRow { query: string; response: string | null; created_at: string }

export function getRecentAsks(username: string, limit = 5): AskRow[] {
  const user = stmts.selectUser.get(username.toLowerCase()) as { id: number } | null
  if (!user) return []
  return stmts.recentAsks.all(user.id, limit) as AskRow[]
}

// search prior AI exchanges by topic (FTS)
export interface AskFTSResult { username: string; query: string; response: string | null; created_at: string }

export function searchAskFTS(channel: string, ftsQuery: string, limit = 5): AskFTSResult[] {
  try {
    return stmts.searchAskFTS.all(ftsQuery, channel, limit) as AskFTSResult[]
  } catch {
    return []
  }
}

// --- user memo helpers ---

export interface MemoRow { memo: string; ask_count_at: number }

export function getUserMemo(username: string): MemoRow | null {
  return stmts.selectMemo.get(username.toLowerCase()) as MemoRow | null
}

export function upsertUserMemo(username: string, memo: string, askCount: number) {
  stmts.upsertMemo.run(username.toLowerCase(), memo, askCount)
}

export function getAsksForMemo(username: string, limit = 15): { query: string; response: string }[] {
  const user = stmts.selectUser.get(username.toLowerCase()) as { id: number } | null
  if (!user) return []
  return stmts.recentAsksForMemo.all(user.id, limit) as { query: string; response: string }[]
}

export function getUserAskCount(username: string): number {
  const user = stmts.selectUser.get(username.toLowerCase()) as { ask_count: number } | null
  return user?.ask_count ?? 0
}

export function getBotStats(): { totalUsers: number; totalCommands: number; totalAsks: number; todayCommands: number; todayAsks: number; uniqueToday: number } {
  const totals = db.query(
    `SELECT COUNT(*) as users, SUM(total_commands) as cmds, SUM(ask_count) as asks FROM users`,
  ).get() as { users: number; cmds: number; asks: number }
  const today = db.query(
    `SELECT COUNT(*) as cmds FROM commands WHERE created_at >= date('now')`,
  ).get() as { cmds: number }
  const todayAsks = db.query(
    `SELECT COUNT(*) as asks FROM ask_queries WHERE created_at >= date('now')`,
  ).get() as { asks: number }
  const uniqueToday = db.query(
    `SELECT COUNT(DISTINCT user_id) as users FROM commands WHERE created_at >= date('now')`,
  ).get() as { users: number }
  return {
    totalUsers: totals.users ?? 0,
    totalCommands: totals.cmds ?? 0,
    totalAsks: totals.asks ?? 0,
    todayCommands: today.cmds ?? 0,
    todayAsks: todayAsks.asks ?? 0,
    uniqueToday: uniqueToday.users ?? 0,
  }
}

// --- user facts helpers ---

export function insertUserFact(username: string, fact: string): void {
  writeQueue.push({ type: 'user_fact', username: username.toLowerCase(), fact })
  scheduleFlush()
}

export function getUserFacts(username: string, limit = 10): string[] {
  const rows = stmts.getUserFacts.all(username.toLowerCase(), limit) as { fact: string }[]
  return rows.map(r => r.fact)
}

export function getUserFactCount(username: string): number {
  const row = stmts.countUserFacts.get(username.toLowerCase()) as { cnt: number }
  return row.cnt
}

// --- twitch user cache helpers ---

export interface CachedTwitchUser {
  twitch_id: string
  display_name: string | null
  account_created_at: string | null
  cached_at: string
}

const TWITCH_USER_TTL = 7 * 86_400_000 // 7 days
const FOLLOWAGE_TTL = 86_400_000 // 1 day

export function getCachedTwitchUser(username: string): CachedTwitchUser | null {
  const row = stmts.getCachedTwitchUser.get(username.toLowerCase()) as CachedTwitchUser | null
  if (!row) return null
  if (Date.now() - new Date(row.cached_at + 'Z').getTime() > TWITCH_USER_TTL) return null
  return row
}

export function setCachedTwitchUser(username: string, twitchId: string, displayName: string | null, accountCreatedAt: string | null) {
  stmts.setCachedTwitchUser.run(username.toLowerCase(), twitchId, displayName, accountCreatedAt)
}

export interface CachedFollowage {
  followed_at: string | null
  cached_at: string
}

export function getCachedFollowage(username: string, channel: string): CachedFollowage | null {
  const row = stmts.getCachedFollowage.get(username.toLowerCase(), channel.toLowerCase()) as CachedFollowage | null
  if (!row) return null
  if (Date.now() - new Date(row.cached_at + 'Z').getTime() > FOLLOWAGE_TTL) return null
  return row
}

export function setCachedFollowage(username: string, channel: string, followedAt: string | null) {
  stmts.setCachedFollowage.run(username.toLowerCase(), channel.toLowerCase(), followedAt)
}

export function pruneOldSummaries(days = 30) {
  try {
    const result = db.run(
      `DELETE FROM chat_summaries WHERE created_at < datetime('now', ?)`,
      [`-${days} days`],
    )
    if (result.changes > 0) log(`pruned ${result.changes} chat summaries older than ${days}d`)
  } catch (e) {
    log(`summary prune error: ${e}`)
  }
}
