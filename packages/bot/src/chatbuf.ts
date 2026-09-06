import { log } from './log'

export interface ChatEntry {
  user: string
  text: string
  ts: number
  messageId?: string
  threadId?: string
  mod?: boolean // moderator/broadcaster badge on the line — rendered as a marker so the model can tell an order from a viewer's wish
  kind?: 'event' // a stream event (raid/sub/gift/announce) rendered into the transcript — user is always the '*' sentinel, never a real chatter
  tag?: string // e.g. '500 bits' | 'highlighted' | 'redeem' — rendered alongside [mod], not instead of it
}

const buffers = new Map<string, ChatEntry[]>()
const MAX_SIZE = 100
// live gift-train / other collapsible event entries, so a running total updates the SAME
// rendered line in place instead of appending a new one per subgift. cleared per-entry
// once it scrolls out of the ring (see recordEvent).
const eventCollapseMap = new Map<string, Map<string, ChatEntry>>()
const botName = (process.env.TWITCH_USERNAME ?? 'bazaarinfo').toLowerCase()

// --- session tracking ---

const SESSION_GAP = 30 * 60_000 // 30min gap = new session
const lastMessageTime = new Map<string, number>()
const sessionIds = new Map<string, number>()

export function restoreSessionId(channel: string, id: number) {
  sessionIds.set(channel, id)
}

export function restoreSummary(channel: string, summary: string) {
  if (summary) summaries.set(channel, summary)
}

// Hydrate in-memory buffer from persisted chat on startup. Without this, getRecent()
// returns [] for ~5-10 mins after restart and the bot says "chat's dead" on a live channel.
// entries must be in ASCENDING time order (oldest first). Side effects (summarizer, lesson
// extractor, session bumps) are deliberately skipped — this is just replaying history.
export function restoreChat(channel: string, entries: { username: string; message: string; created_at: string; kind?: 'event' }[]) {
  if (entries.length === 0) return
  let buf = buffers.get(channel)
  if (!buf) {
    buf = []
    buffers.set(channel, buf)
  }
  for (const e of entries) {
    const ts = new Date(e.created_at + 'Z').getTime()
    // a replayed event is history, not a live collapse target — no collapseKey, so a
    // gift train re-render after restart can't mutate a hydrated row nothing points to.
    if (e.kind === 'event') buf.push({ user: '*', text: e.message, ts, kind: 'event' })
    else buf.push({ user: e.username, text: e.message, ts })
    trim(channel, buf)
  }
  const last = buf[buf.length - 1]
  if (last) lastMessageTime.set(channel, last.ts)
}

// --- rolling summary ---

const summaries = new Map<string, string>()
const msgsSinceSummary = new Map<string, number>()
const SUMMARY_INTERVAL = 250
let summarizer: ((channel: string, recent: ChatEntry[], prev: string) => Promise<string>) | null = null
let summaryPersister: ((channel: string, sessionId: number, summary: string, msgCount: number) => void) | null = null

export function setSummaryPersister(fn: typeof summaryPersister) {
  summaryPersister = fn
}

// --- lesson extraction ---

const msgsSinceLesson = new Map<string, number>()
const LESSON_INTERVAL = 500
let lessonExtractor: ((channel: string, recent: ChatEntry[]) => Promise<void>) | null = null

export function setLessonExtractor(fn: typeof lessonExtractor) {
  lessonExtractor = fn
}

async function maybeLearnLessons(channel: string) {
  if (!lessonExtractor) return
  const count = (msgsSinceLesson.get(channel) ?? 0) + 1
  msgsSinceLesson.set(channel, count)
  if (count < LESSON_INTERVAL) return

  msgsSinceLesson.set(channel, 0)
  const buf = buffers.get(channel)
  if (!buf || buf.length < 30) return

  // fire-and-forget — filter bot messages so lessons reflect chat culture, not bot output.
  // events excluded too — "chat culture" means what people say, not a raid/gift line.
  const chatOnly = buf.slice(-80).filter((m) => m.user.toLowerCase() !== botName && m.kind !== 'event')
  lessonExtractor(channel, chatOnly).catch((e) => {
    log(`lesson error (${channel}): ${e}`)
  })
}

export function setSummarizer(fn: typeof summarizer) {
  summarizer = fn
}

export function getSummary(channel: string): string {
  return summaries.get(channel) ?? ''
}

async function maybeSummarize(channel: string) {
  if (!summarizer) return
  const count = (msgsSinceSummary.get(channel) ?? 0) + 1
  msgsSinceSummary.set(channel, count)
  if (count < SUMMARY_INTERVAL) return

  msgsSinceSummary.set(channel, 0)
  const buf = buffers.get(channel)
  if (!buf || buf.length < 20) return

  const prev = summaries.get(channel) ?? ''
  try {
    // filter out bot's own messages so summaries reflect chat, not the bot echoing itself
    const chatOnly = buf.slice(-50).filter((m) => m.user.toLowerCase() !== botName)
    const summary = await summarizer(channel, chatOnly, prev)
    if (summary) {
      summaries.set(channel, summary)
      if (summaryPersister) {
        const sid = sessionIds.get(channel) ?? 0
        summaryPersister(channel, sid, summary, SUMMARY_INTERVAL)
      }
    }
  } catch (e) {
    log(`summary error (${channel}): ${e}`)
  }
}

// --- conversation threads ---

export interface Thread {
  users: string[]
  topic: string
  lastMsg: number
}

export function getActiveThreads(channel: string, windowMs = 120_000): Thread[] {
  const buf = buffers.get(channel)
  if (!buf) return []

  const now = Date.now()
  const recent = buf.filter((m) => now - m.ts < windowMs && m.user.toLowerCase() !== botName && m.kind !== 'event')
  if (recent.length < 2) return []

  // track who's talking to whom via @mentions and reply proximity
  const convos = new Map<string, { users: Set<string>; msgs: string[]; last: number }>()

  for (const msg of recent) {
    const mentions = msg.text.match(/@(\w+)/g)?.map((m) => m.slice(1).toLowerCase()) ?? []

    for (const target of mentions) {
      if (target === msg.user.toLowerCase()) continue
      const key = [msg.user.toLowerCase(), target].sort().join(':')
      let convo = convos.get(key)
      if (!convo) {
        convo = { users: new Set(), msgs: [], last: 0 }
        convos.set(key, convo)
      }
      convo.users.add(msg.user)
      convo.users.add(target)
      convo.msgs.push(msg.text)
      convo.last = msg.ts
    }
  }

  // also detect consecutive exchanges between same users (no @mention needed)
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1]
    const cur = recent[i]
    if (prev.user === cur.user) continue
    if (cur.ts - prev.ts > 30_000) continue // >30s gap = probably not a convo

    const key = [prev.user.toLowerCase(), cur.user.toLowerCase()].sort().join(':')
    let convo = convos.get(key)
    if (!convo) {
      convo = { users: new Set(), msgs: [], last: 0 }
      convos.set(key, convo)
    }
    convo.users.add(prev.user)
    convo.users.add(cur.user)
    if (convo.msgs.length < 4) convo.msgs.push(cur.text)
    convo.last = cur.ts
  }

  // only return threads with 2+ exchanges
  return [...convos.values()]
    .filter((c) => c.msgs.length >= 2)
    .sort((a, b) => b.last - a.last)
    .slice(0, 3)
    .map((c) => ({
      users: [...c.users],
      topic: c.msgs.slice(-2).join(' / ').slice(0, 80),
      lastMsg: c.last,
    }))
}

// --- core ---

// drop orphan UTF-16 surrogates BEFORE storing so a single corrupt input/output
// can't keep poisoning later AI prompts (anthropic rejects them as invalid JSON).
function stripSurrogates(s: string): string {
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
}

export function record(channel: string, user: string, text: string, messageId?: string, threadId?: string, mod = false, tag?: string) {
  text = stripSurrogates(text)
  const now = Date.now()
  const last = lastMessageTime.get(channel) ?? 0
  if (last > 0 && now - last > SESSION_GAP) {
    const prev = sessionIds.get(channel) ?? 0
    sessionIds.set(channel, prev + 1)
    log(`session bump #${channel}: ${prev} -> ${prev + 1}`)
  }
  lastMessageTime.set(channel, now)

  let buf = buffers.get(channel)
  if (!buf) {
    buf = []
    buffers.set(channel, buf)
  }
  buf.push({ user, text, ts: now, messageId, threadId, ...(mod ? { mod } : {}), ...(tag ? { tag } : {}) })
  trim(channel, buf)
  maybeSummarize(channel)
  maybeLearnLessons(channel)
}

// CLEARMSG: a mod deleted one specific line. Drop it from the live ring too, or the model
// keeps reading it in "Recent chat" for up to MAX_SIZE more messages after sqlite already
// forgot it existed.
export function removeMessage(channel: string, messageId: string): boolean {
  const buf = buffers.get(channel)
  if (!buf) return false
  const i = buf.findIndex((m) => m.messageId === messageId)
  if (i === -1) return false
  buf.splice(i, 1)
  return true
}

// CLEARCHAT on one user (timeout/ban): every line they have in the ring right now must go —
// same "what a mod removes must vanish" rule as sqlite. Bot lines are untouched (user is
// never the removed login), and event entries (user '*') can't collide with a real login.
export function removeUser(channel: string, login: string): number {
  const buf = buffers.get(channel)
  if (!buf) return 0
  const lower = login.toLowerCase()
  const before = buf.length
  const kept = buf.filter((m) => m.user.toLowerCase() !== lower)
  buffers.set(channel, kept)
  return before - kept.length
}

// a mod deleted the BOT's own reply — pull it from the ring so a later recall/pasta pass
// can't quote it back into chat right after a mod cleaned it up. Newest first: the message
// that just got clearmsg'd is far more likely to be near the end of the ring than the start.
export function removeBotLine(channel: string, text: string): boolean {
  const buf = buffers.get(channel)
  if (!buf) return false
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i].user.toLowerCase() === botName && buf[i].text === text) {
      buf.splice(i, 1)
      return true
    }
  }
  return false
}

// CLEARCHAT with no target user: mod cleared the WHOLE channel. Empties the ring and its
// collapse map — but nothing else. Contrast cleanupChannel (part-time/disconnect): session
// id, summaries, and the lesson/summary tick counters are the bot's own memory of the
// channel, not what chat can see, so a mod's "clear chat" click must leave them alone.
export function clearRing(channel: string) {
  buffers.set(channel, [])
  eventCollapseMap.delete(channel)
}

// the one eviction path for every push: a collapse key must die with its ring entry, or a
// later gift from the same gifter would rewrite a line nobody can see any more.
function trim(channel: string, buf: ChatEntry[]) {
  while (buf.length > MAX_SIZE) {
    const dropped = buf.shift()
    if (dropped?.kind !== 'event') continue
    const chanMap = eventCollapseMap.get(channel)
    if (!chanMap) continue
    for (const [k, v] of chanMap) {
      if (v === dropped) { chanMap.delete(k); break }
    }
  }
}

// A stream event (raid/sub/gift/announce) rendered into the transcript as a sentinel-user
// line, so the model reads it inline with "Recent chat" without any prompt-text change.
// Deliberately skips the session bump / summarizer+lesson tick counters that record() does —
// an event is not a chat message and must not look like renewed chat activity by itself.
// collapseKey lets a running total (a gift train) update the SAME line in place instead of
// appending a new one per subgift.
export function recordEvent(channel: string, text: string, collapseKey?: string) {
  text = stripSurrogates(text)
  let buf = buffers.get(channel)
  if (!buf) {
    buf = []
    buffers.set(channel, buf)
  }
  if (collapseKey) {
    const existing = eventCollapseMap.get(channel)?.get(collapseKey)
    if (existing) {
      existing.text = text
      return
    }
  }
  const entry: ChatEntry = { user: '*', text, ts: Date.now(), kind: 'event' }
  buf.push(entry)
  trim(channel, buf)
  if (collapseKey) {
    let chanMap = eventCollapseMap.get(channel)
    if (!chanMap) { chanMap = new Map(); eventCollapseMap.set(channel, chanMap) }
    chanMap.set(collapseKey, entry)
  }
}

/** Get all messages in a thread by thread root message ID */
export function getThread(channel: string, threadId: string): ChatEntry[] {
  const buf = buffers.get(channel)
  if (!buf) return []
  return buf.filter((m) => m.threadId === threadId || m.messageId === threadId)
}

export function cleanupChannel(channel: string) {
  buffers.delete(channel)
  lastMessageTime.delete(channel)
  sessionIds.delete(channel)
  summaries.delete(channel)
  msgsSinceSummary.delete(channel)
  msgsSinceLesson.delete(channel)
  eventCollapseMap.delete(channel)
}

export function getRecent(channel: string, count: number): ChatEntry[] {
  const buf = buffers.get(channel)
  if (!buf) return []
  return buf.slice(-count)
}
