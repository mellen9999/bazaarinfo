// renders twitch's own enforcement (timeout/ban/clear/delete) into a chat-transcript
// line. pure — no db, no network. never includes the deleted text itself (that would
// just re-publish what a mod took down); the raw text lives only in IrcClearMsg, and
// this file never reads that field.
import type { IrcClearChat, IrcClearMsg } from './twitch'

export function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.round(sec / 60)} min`
  return `${Math.round(sec / 3600)}h`
}

export interface RenderedModeration {
  text: string
  collapseKey?: string
}

// clearmsg collapse — same shape as stream-events.ts gift trains: a deletion spree from
// one login re-renders in place with a running count instead of stacking N chat lines.
const DELETE_WINDOW_MS = 10 * 60_000
const DELETE_CAP = 500

interface DeleteEntry {
  count: number
  startedAt: number
}

const deletes = new Map<string, DeleteEntry>()

function evictDeletes(now: number) {
  if (deletes.size <= DELETE_CAP) return
  for (const [k, e] of deletes) {
    if (now - e.startedAt > DELETE_WINDOW_MS) deletes.delete(k)
  }
  if (deletes.size <= DELETE_CAP) return
  // still over cap (pathological) — drop the oldest until back under
  const byAge = [...deletes.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)
  for (const [k] of byAge) {
    if (deletes.size <= DELETE_CAP) break
    deletes.delete(k)
  }
}

export function renderModeration(m: IrcClearChat | IrcClearMsg, botName: string): RenderedModeration | null {
  const bot = botName.toLowerCase()

  if (m.type === 'clearchat') {
    // no login = the whole chat was wiped, not a specific person — never a bot-punishment case
    if (!m.login) return { text: '* chat was cleared by a mod' }
    // the bot's own punishment never renders — index.ts owns whatever signal that is
    if (m.login.toLowerCase() === bot) return null
    return m.durationSec !== undefined
      ? { text: `* ${m.login} was timed out for ${formatDuration(m.durationSec)}` }
      : { text: `* ${m.login} was banned` }
  }

  // clearmsg
  if (m.login.toLowerCase() === bot) return null
  const now = Date.now()
  const key = `${m.channel}:del:${m.login}`
  let entry = deletes.get(key)
  if (!entry || now - entry.startedAt > DELETE_WINDOW_MS) {
    entry = { count: 0, startedAt: now }
    deletes.set(key, entry)
  }
  entry.count += 1
  evictDeletes(now)
  return {
    text: entry.count === 1
      ? `* a mod deleted ${m.login}'s message`
      : `* a mod deleted ${entry.count} of ${m.login}'s messages`,
    collapseKey: key,
  }
}

// active-timeout memory. twitch sends no unban over IRC either way, so a permanent ban
// must not become a forever-mute in our own bookkeeping — cap it at 24h same as a long
// timeout would expire.
const BAN_CAP_MS = 24 * 60 * 60_000
const timeouts = new Map<string, number>() // `${channel}:${login}` -> until (epoch ms)

export function noteTimeout(channel: string, login: string, durationSec: number | undefined, now = Date.now()) {
  const until = durationSec !== undefined ? now + durationSec * 1000 : now + BAN_CAP_MS
  timeouts.set(`${channel.toLowerCase()}:${login.toLowerCase()}`, until)
}

export function isTimedOut(channel: string, login: string, now = Date.now()): boolean {
  const key = `${channel.toLowerCase()}:${login.toLowerCase()}`
  const until = timeouts.get(key)
  if (until === undefined) return false
  if (until <= now) {
    timeouts.delete(key) // expired — remove lazily rather than sweep on a timer
    return false
  }
  return true
}

// deleted-message ring: "was this id removed" without keeping the removed text anywhere.
const DELETED_CAP = 500
const deletedIds: string[] = []
const deletedIdSet = new Set<string>()

export function noteDeletedMessage(id: string) {
  if (deletedIdSet.has(id)) return
  deletedIdSet.add(id)
  deletedIds.push(id)
  if (deletedIds.length > DELETED_CAP) {
    const evicted = deletedIds.shift()
    if (evicted) deletedIdSet.delete(evicted)
  }
}

// no id (eventsub-path asks carry none) is never "deleted" — an absent id must fail open,
// not get confused with the sentinel of an actually-removed message.
export function wasDeleted(id: string | undefined): boolean {
  return id !== undefined && deletedIdSet.has(id)
}

// sent-line memory: say() can truncate/reprefix (e.g. "response @user") before a line hits
// the wire, so a CLEARMSG's `text` — the literal wire text twitch quotes back — doesn't
// string-match what got recorded into chatbuf/ask_queries. maps the actual wire text back
// to the stored one so a mod deleting OUR line still finds the right row to purge.
// FIFO capped (not windowed — a mod can delete a bot line long after it was sent).
const SENT_LINE_CAP = 500
interface SentEntry { channel: string; wire: string; stored: string }
const sentLines = new Map<string, SentEntry>()
const sentLineOrder: SentEntry[] = []

function sentKey(channel: string, wire: string): string {
  return `${channel.toLowerCase()}\n${wire}`
}

export function noteSentLine(channel: string, wire: string, stored: string) {
  const key = sentKey(channel, wire)
  const existing = sentLines.get(key)
  if (existing) {
    const idx = sentLineOrder.indexOf(existing)
    if (idx >= 0) sentLineOrder.splice(idx, 1)
  }
  const entry: SentEntry = { channel: channel.toLowerCase(), wire, stored }
  sentLines.set(key, entry)
  sentLineOrder.push(entry)
  if (sentLineOrder.length > SENT_LINE_CAP) {
    const evicted = sentLineOrder.shift()
    if (evicted) sentLines.delete(sentKey(evicted.channel, evicted.wire))
  }
}

export function storedLineFor(channel: string, wire: string): string | undefined {
  const exact = sentLines.get(sentKey(channel, wire))
  if (exact) return exact.stored
  // say() truncates with a trailing '...' — the wire text twitch quotes back is a strict
  // prefix of what we actually stored, not an exact match. newest-first so a same-prefix
  // collision resolves to the most recent send.
  if (!wire.endsWith('...')) return undefined
  const prefix = wire.slice(0, -3)
  const ch = channel.toLowerCase()
  for (let i = sentLineOrder.length - 1; i >= 0; i--) {
    const e = sentLineOrder[i]
    if (e.channel === ch && e.stored.startsWith(prefix)) return e.stored
  }
  return undefined
}

export function __resetModerationForTest() {
  deletes.clear()
  timeouts.clear()
  deletedIds.length = 0
  deletedIdSet.clear()
  sentLines.clear()
  sentLineOrder.length = 0
}
