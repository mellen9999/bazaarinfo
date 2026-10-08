// mod "stop responding to X" — a per-channel ignore that outlives restarts. the fix for a chatter who
// keeps baiting the bot into saying something bannable: they get no replies, no trivia
// credit, and their lines never reach the ai's chat context (so they can't steer it
// through someone else's ask either). mods/broadcaster are never subject to it — the
// callers already exempt them, same as directive mutes.
//
// three lengths: timed (runs its clock), stream (the default — drops when the channel's
// stream ends, or the next one if planted offline), and forever (until a mod lifts it,
// only when a mod asks for it by name). nobody stays ignored because a mod forgot.

import * as db from './db'
import { log } from './log'

export const IGNORE_MAX_MIN = 30 * 24 * 60
export const LOGIN_RE = /^[a-z0-9_]{2,25}$/

interface Entry { by: string; createdAt: number; expiresAt: number | null; forever: boolean }
export type IgnoreLength = number | 'stream' | 'forever'
export interface IgnoredRow { login: string; by: string; minutes: number | null; forever: boolean }
const byChannel = new Map<string, Map<string, Entry>>()
let loaded = false

// lazy: chatbuf consults this on every line, including in tests that never open a db
function ensureLoaded(): void {
  if (loaded || !db.getDb()) return
  loaded = true
  try {
    for (const r of db.loadIgnores()) put(r.channel, r.login, { by: r.by, createdAt: r.created_at, expiresAt: r.expires_at, forever: r.forever === 1 })
  } catch (e) {
    log(`ignore: load failed: ${e}`)
  }
}

function put(channel: string, login: string, e: Entry): void {
  const m = byChannel.get(channel) ?? new Map<string, Entry>()
  m.set(login, e)
  byChannel.set(channel, m)
}

const norm = (s: string) => s.trim().toLowerCase().replace(/^[@#]/, '')

/** length = minutes, 'stream' or 'forever'. returns the normalized login, or null when refused. */
export function ignoreUser(channel: string, login: string, by: string, length: IgnoreLength = 'stream'): string | null {
  const ch = norm(channel)
  const who = norm(login)
  // never the broadcaster — that's not a troll, that's the channel
  if (!LOGIN_RE.test(who) || who === ch) return null
  ensureLoaded()
  const now = Date.now()
  const mins = typeof length === 'number' ? Math.min(Math.max(1, Math.round(length)), IGNORE_MAX_MIN) : null
  const e: Entry = { by, createdAt: now, expiresAt: mins === null ? null : now + mins * 60_000, forever: length === 'forever' }
  put(ch, who, e)
  try { db.saveIgnore({ channel: ch, login: who, by, created_at: now, expires_at: e.expiresAt, forever: e.forever ? 1 : 0 }) } catch (err) { log(`ignore: save failed: ${err}`) }
  return who
}

export function unignoreUser(channel: string, login: string): boolean {
  const ch = norm(channel)
  const who = norm(login)
  ensureLoaded()
  const had = byChannel.get(ch)?.delete(who) ?? false
  if (had) {
    try { db.deleteIgnore(ch, who) } catch (err) { log(`ignore: delete failed: ${err}`) }
  }
  return had
}

export function isIgnored(channel: string, login: string): boolean {
  ensureLoaded()
  const m = byChannel.get(norm(channel))
  if (!m) return false
  const who = norm(login)
  const e = m.get(who)
  if (!e) return false
  if (e.expiresAt !== null && e.expiresAt <= Date.now()) {
    unignoreUser(channel, who)
    return false
  }
  return true
}

function dropStreamScoped(ch: string, keep: (e: Entry) => boolean): string[] {
  const dropped: string[] = []
  for (const [login, e] of byChannel.get(ch) ?? []) {
    if (e.expiresAt !== null || e.forever || keep(e)) continue
    unignoreUser(ch, login)
    dropped.push(login)
  }
  if (dropped.length) log(`ignore #${ch}: stream over, lifted ${dropped.join(', ')}`)
  return dropped
}

/** the stream ended — every stream-scoped ignore on the channel is done. */
export function onStreamEnded(channel: string): string[] {
  ensureLoaded()
  return dropStreamScoped(norm(channel), () => false)
}

// a stream ended while the bot was down. stream_sessions is the record: a stream ignore is
// over once a session that was live at or after it was planted is no longer the live one.
// lastSeen is only refreshed per poll, so allow one poll of slack for an ignore planted in
// a stream's final minute.
const POLL_SLACK_MS = 2 * 60_000
/** boot sweep, once live state is known. liveStart = the channel's current stream start, if live. */
export function sweepEndedStreams(liveStart: (channel: string) => number | undefined): void {
  ensureLoaded()
  for (const ch of [...byChannel.keys()]) {
    const entries = [...(byChannel.get(ch)?.values() ?? [])].filter((e) => e.expiresAt === null && !e.forever)
    if (!entries.length) continue
    let sessions: { startedAt: number; lastSeenAt: number }[]
    try { sessions = db.getStreamSessions(ch, Math.min(...entries.map((e) => e.createdAt)) - 7 * 86_400_000) } catch (e) {
      log(`ignore: session lookup failed: ${e}`)
      continue
    }
    const cur = liveStart(ch)
    const ended = sessions.filter((s) => s.startedAt !== cur)
    dropStreamScoped(ch, (e) => !ended.some((s) => s.lastSeenAt + POLL_SLACK_MS >= e.createdAt))
  }
}

export function listIgnored(channel: string): IgnoredRow[] {
  ensureLoaded()
  const ch = norm(channel)
  const now = Date.now()
  const out: IgnoredRow[] = []
  for (const [login, e] of byChannel.get(ch) ?? []) {
    if (e.expiresAt !== null && e.expiresAt <= now) { unignoreUser(ch, login); continue }
    out.push({ login, by: e.by, minutes: e.expiresAt === null ? null : Math.max(1, Math.round((e.expiresAt - now) / 60_000)), forever: e.forever })
  }
  return out
}

export function resetIgnoresForTest(): void {
  byChannel.clear()
  loaded = false
}
