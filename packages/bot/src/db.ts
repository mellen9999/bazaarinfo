import { Database } from 'bun:sqlite'
import { homedir } from 'os'
import { resolve } from 'path'
import { existsSync, readFileSync, renameSync } from 'fs'
import { log } from './log'

const DB_PATH = resolve(homedir(), '.bazaarinfo.db')

let db: Database

type CmdType = 'item' | 'enchant' | 'mob' | 'hero' | 'skill' | 'tag' | 'day' | 'quest' | 'ai' | 'miss'

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

function migrateOldLogs() {
  const hitsPath = resolve(homedir(), '.bazaarinfo-hits.log')
  const missesPath = resolve(homedir(), '.bazaarinfo-misses.log')

  const insertCmd = db.prepare(
    'INSERT INTO commands (user_id, channel, cmd_type, query, match_name, tier, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )

  if (existsSync(hitsPath)) {
    try {
      const lines = readFileSync(hitsPath, 'utf-8').split('\n').filter(Boolean)
      let imported = 0
      db.transaction(() => {
        for (const line of lines) {
          const ts = line.match(/^(\S+)/)?.[1]
          const type = line.match(/type:(\S+)/)?.[1]
          const q = line.match(/q:(\S+)/)?.[1]
          const match = line.match(/match:(\S+)/)?.[1]
          const tier = line.match(/tier:(\S+)/)?.[1]
          const user = line.match(/user:(\S+)/)?.[1]
          const ch = line.match(/ch:(\S+)/)?.[1]
          const userId = user ? getOrCreateUser(user) : null
          insertCmd.run(userId, ch ?? null, type ?? 'item', q ?? null, match ?? null, tier ?? null, ts ?? new Date().toISOString())
          imported++
        }
      })()
      renameSync(hitsPath, hitsPath + '.migrated')
      log(`migrated ${imported} hit log entries`)
    } catch (e) {
      log(`hit log migration error: ${e}`)
    }
  }

  if (existsSync(missesPath)) {
    try {
      const lines = readFileSync(missesPath, 'utf-8').split('\n').filter(Boolean)
      let imported = 0
      db.transaction(() => {
        for (const line of lines) {
          const ts = line.match(/^(\S+)/)?.[1]
          const rest = line.slice(ts?.length ?? 0).trim()
          const user = rest.match(/user:(\S+)/)?.[1]
          const ch = rest.match(/ch:(\S+)/)?.[1]
          const query = rest.replace(/user:\S+/g, '').replace(/ch:\S+/g, '').trim()
          const userId = user ? getOrCreateUser(user) : null
          insertCmd.run(userId, ch ?? null, 'miss', query || null, null, null, ts ?? new Date().toISOString())
          imported++
        }
      })()
      renameSync(missesPath, missesPath + '.migrated')
      log(`migrated ${imported} miss log entries`)
    } catch (e) {
      log(`miss log migration error: ${e}`)
    }
  }
}

export function initDb(path?: string) {
  db = new Database(path ?? DB_PATH)
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA busy_timeout = 5000')
  runMigrations()
  if (!path) migrateOldLogs()
}

export function closeDb() {
  db?.close()
}

export function getDb(): Database {
  return db
}

// --- helpers ---

export function getOrCreateUser(username: string): number {
  const lower = username.toLowerCase()
  db.run(
    `INSERT INTO users (username) VALUES (?) ON CONFLICT(username) DO UPDATE SET last_seen = datetime('now')`,
    [lower],
  )
  const row = db.query('SELECT id FROM users WHERE username = ?').get(lower) as { id: number }
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
  db.run(
    'INSERT INTO commands (user_id, channel, cmd_type, query, match_name, tier) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, ctx.channel ?? null, cmdType, query ?? null, matchName ?? null, tier ?? null],
  )
  if (userId) {
    db.run('UPDATE users SET total_commands = total_commands + 1 WHERE id = ?', [userId])
  }
}

export function logChat(channel: string, username: string, message: string) {
  db.run(
    'INSERT INTO chat_messages (channel, username, message) VALUES (?, ?, ?)',
    [channel, username.toLowerCase(), message],
  )
}

export function logAsk(
  ctx: { user?: string; channel?: string },
  query: string,
  contextSummary: string,
  response: string,
  tokensUsed: number,
  latencyMs: number,
) {
  const userId = ctx.user ? getOrCreateUser(ctx.user) : null
  db.run(
    'INSERT INTO ask_queries (user_id, channel, query, context_summary, response, tokens_used, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [userId, ctx.channel ?? null, query, contextSummary, response, tokensUsed, latencyMs],
  )
  if (userId) {
    db.run('UPDATE users SET ask_count = ask_count + 1 WHERE id = ?', [userId])
  }
}

export function getRecentChat(channel: string, limit = 20): { username: string; message: string; created_at: string }[] {
  return db.query(
    'SELECT username, message, created_at FROM chat_messages WHERE channel = ? ORDER BY id DESC LIMIT ?',
  ).all(channel, limit) as { username: string; message: string; created_at: string }[]
}

export function getUserHistory(username: string, limit = 10): { channel: string; message: string; created_at: string }[] {
  return db.query(
    'SELECT channel, message, created_at FROM chat_messages WHERE username = ? ORDER BY id DESC LIMIT ?',
  ).all(username.toLowerCase(), limit) as { channel: string; message: string; created_at: string }[]
}

export interface UserStats {
  username: string
  total_commands: number
  trivia_wins: number
  trivia_attempts: number
  trivia_streak: number
  trivia_best_streak: number
  trivia_fastest_ms: number | null
  ask_count: number
  first_seen: string
  favorite_item: string | null
}

export function getUserStats(username: string): UserStats | null {
  const user = db.query(
    'SELECT * FROM users WHERE username = ?',
  ).get(username.toLowerCase()) as (UserStats & { id: number }) | null
  if (!user) return null

  const fav = db.query(
    `SELECT match_name, COUNT(*) as cnt FROM commands
     WHERE user_id = ? AND match_name IS NOT NULL
     GROUP BY match_name ORDER BY cnt DESC LIMIT 1`,
  ).get(user.id) as { match_name: string; cnt: number } | null

  return {
    username: user.username,
    total_commands: user.total_commands,
    trivia_wins: user.trivia_wins,
    trivia_attempts: user.trivia_attempts,
    trivia_streak: user.trivia_streak,
    trivia_best_streak: user.trivia_best_streak,
    trivia_fastest_ms: user.trivia_fastest_ms,
    ask_count: user.ask_count,
    first_seen: user.first_seen,
    favorite_item: fav?.match_name ?? null,
  }
}

export function getChannelLeaderboard(channel: string, limit = 5): { username: string; total_commands: number }[] {
  return db.query(
    `SELECT u.username, COUNT(*) as total_commands FROM commands c
     JOIN users u ON c.user_id = u.id
     WHERE c.channel = ?
     GROUP BY c.user_id ORDER BY total_commands DESC LIMIT ?`,
  ).all(channel, limit) as { username: string; total_commands: number }[]
}

export function getPopularItems(limit = 10): { match_name: string; cnt: number }[] {
  return db.query(
    `SELECT match_name, COUNT(*) as cnt FROM commands
     WHERE match_name IS NOT NULL AND cmd_type != 'miss'
     GROUP BY match_name ORDER BY cnt DESC LIMIT ?`,
  ).all(limit) as { match_name: string; cnt: number }[]
}

// trivia helpers
export function createTriviaGame(
  channel: string,
  questionType: number,
  questionText: string,
  correctAnswer: string,
): number {
  db.run(
    'INSERT INTO trivia_games (channel, question_type, question_text, correct_answer) VALUES (?, ?, ?, ?)',
    [channel, questionType, questionText, correctAnswer],
  )
  return (db.query('SELECT last_insert_rowid() as id').get() as { id: number }).id
}

export function recordTriviaAnswer(
  gameId: number,
  userId: number,
  answerText: string,
  isCorrect: boolean,
  answerTimeMs: number,
) {
  db.run(
    'INSERT INTO trivia_answers (game_id, user_id, answer_text, is_correct, answer_time_ms) VALUES (?, ?, ?, ?, ?)',
    [gameId, userId, answerText, isCorrect ? 1 : 0, answerTimeMs],
  )
}

export function recordTriviaWin(gameId: number, userId: number, answerTimeMs: number, participantCount: number) {
  db.run(
    'UPDATE trivia_games SET winner_id = ?, answer_time_ms = ?, participant_count = ? WHERE id = ?',
    [userId, answerTimeMs, participantCount, gameId],
  )
  db.run(
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
    [answerTimeMs, answerTimeMs, answerTimeMs, userId],
  )
}

export function recordTriviaAttempt(userId: number) {
  db.run('UPDATE users SET trivia_attempts = trivia_attempts + 1 WHERE id = ?', [userId])
}

export function resetTriviaStreak(userId: number) {
  db.run('UPDATE users SET trivia_streak = 0 WHERE id = ?', [userId])
}

export function getTriviaLeaderboard(channel: string, limit = 5): { username: string; trivia_wins: number }[] {
  return db.query(
    `SELECT u.username, u.trivia_wins FROM users u
     JOIN trivia_games tg ON tg.winner_id = u.id
     WHERE tg.channel = ? AND u.trivia_wins > 0
     GROUP BY u.id ORDER BY u.trivia_wins DESC LIMIT ?`,
  ).all(channel, limit) as { username: string; trivia_wins: number }[]
}

// daily rollup + retention
export function rollupDailyStats() {
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const dateStr = yesterday.toISOString().slice(0, 10)

  db.run(`INSERT OR REPLACE INTO daily_stats (date, channel, total_commands, unique_users, hits, misses, trivia_games, ask_queries)
    SELECT
      date(created_at) as date,
      channel,
      COUNT(*) as total_commands,
      COUNT(DISTINCT user_id) as unique_users,
      SUM(CASE WHEN cmd_type != 'miss' THEN 1 ELSE 0 END) as hits,
      SUM(CASE WHEN cmd_type = 'miss' THEN 1 ELSE 0 END) as misses,
      0 as trivia_games,
      0 as ask_queries
    FROM commands
    WHERE date(created_at) = ?
    GROUP BY date(created_at), channel`,
  [dateStr])

  // trivia count
  db.run(`UPDATE daily_stats SET trivia_games = (
    SELECT COUNT(*) FROM trivia_games WHERE date(started_at) = daily_stats.date AND trivia_games.channel = daily_stats.channel
  ) WHERE date = ?`, [dateStr])

  // ask count
  db.run(`UPDATE daily_stats SET ask_queries = (
    SELECT COUNT(*) FROM ask_queries WHERE date(created_at) = daily_stats.date AND ask_queries.channel = daily_stats.channel
  ) WHERE date = ?`, [dateStr])
}

export function cleanOldData() {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 90)
  const cutoffStr = cutoff.toISOString()

  db.run('DELETE FROM commands WHERE created_at < ?', [cutoffStr])
  db.run('DELETE FROM chat_messages WHERE created_at < ?', [cutoffStr])
  db.run('DELETE FROM trivia_answers WHERE game_id IN (SELECT id FROM trivia_games WHERE started_at < ?)', [cutoffStr])
  db.run('DELETE FROM trivia_games WHERE started_at < ?', [cutoffStr])
  db.run('DELETE FROM ask_queries WHERE created_at < ?', [cutoffStr])
  log('cleaned data older than 90 days')
}
