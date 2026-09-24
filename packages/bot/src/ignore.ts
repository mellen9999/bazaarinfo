// mod "stop responding to X" — a persistent per-channel ignore. the fix for a chatter who
// keeps baiting the bot into saying something bannable: they get no replies, no trivia
// credit, and their lines never reach the ai's chat context (so they can't steer it
// through someone else's ask either). mods/broadcaster are never subject to it — the
// callers already exempt them, same as directive mutes.

import * as db from './db'
import { log } from './log'

export const IGNORE_MAX_MIN = 30 * 24 * 60
export const LOGIN_RE = /^[a-z0-9_]{2,25}$/

interface Entry { by: string; createdAt: number; expiresAt: number | null }
const byChannel = new Map<string, Map<string, Entry>>()
let loaded = false

// lazy: chatbuf consults this on every line, including in tests that never open a db
function ensureLoaded(): void {
  if (loaded || !db.getDb()) return
  loaded = true
  try {
    for (const r of db.loadIgnores()) put(r.channel, r.login, { by: r.by, createdAt: r.created_at, expiresAt: r.expires_at })
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

/** minutes undefined = until lifted. returns the normalized login, or null when refused. */
export function ignoreUser(channel: string, login: string, by: string, minutes?: number): string | null {
  const ch = norm(channel)
  const who = norm(login)
  // never the broadcaster — that's not a troll, that's the channel
  if (!LOGIN_RE.test(who) || who === ch) return null
  ensureLoaded()
  const now = Date.now()
  const mins = minutes === undefined ? null : Math.min(Math.max(1, Math.round(minutes)), IGNORE_MAX_MIN)
  const e: Entry = { by, createdAt: now, expiresAt: mins === null ? null : now + mins * 60_000 }
  put(ch, who, e)
  try { db.saveIgnore({ channel: ch, login: who, by, created_at: now, expires_at: e.expiresAt }) } catch (err) { log(`ignore: save failed: ${err}`) }
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

export function listIgnored(channel: string): { login: string; by: string; minutes: number | null }[] {
  ensureLoaded()
  const ch = norm(channel)
  const now = Date.now()
  const out: { login: string; by: string; minutes: number | null }[] = []
  for (const [login, e] of byChannel.get(ch) ?? []) {
    if (e.expiresAt !== null && e.expiresAt <= now) { unignoreUser(ch, login); continue }
    out.push({ login, by: e.by, minutes: e.expiresAt === null ? null : Math.max(1, Math.round((e.expiresAt - now) / 60_000)) })
  }
  return out
}

export function resetIgnoresForTest(): void {
  byChannel.clear()
  loaded = false
}
