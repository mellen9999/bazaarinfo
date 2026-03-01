import { log } from './log'

export interface ChatEntry {
  user: string
  text: string
  ts: number
}

const buffers = new Map<string, ChatEntry[]>()
const MAX_SIZE = 100

// --- session tracking ---

const SESSION_GAP = 30 * 60_000 // 30min gap = new session
const lastMessageTime = new Map<string, number>()
const sessionIds = new Map<string, number>()

export function getSessionId(channel: string): number {
  return sessionIds.get(channel) ?? 0
}

export function restoreSessionId(channel: string, id: number) {
  sessionIds.set(channel, id)
}

export function restoreSummary(channel: string, summary: string) {
  if (summary) summaries.set(channel, summary)
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

  // fire-and-forget
  lessonExtractor(channel, buf.slice(-80)).catch((e) => {
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
    const summary = await summarizer(channel, buf.slice(-50), prev)
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
  const recent = buf.filter((m) => now - m.ts < windowMs)
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

export function record(channel: string, user: string, text: string) {
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
  buf.push({ user, text, ts: now })
  if (buf.length > MAX_SIZE) buf.shift()
  maybeSummarize(channel)
  maybeLearnLessons(channel)
}

export function cleanupChannel(channel: string) {
  buffers.delete(channel)
  lastMessageTime.delete(channel)
  sessionIds.delete(channel)
  summaries.delete(channel)
  msgsSinceSummary.delete(channel)
  msgsSinceLesson.delete(channel)
}

export function getRecent(channel: string, count: number): ChatEntry[] {
  const buf = buffers.get(channel)
  if (!buf) return []
  return buf.slice(-count)
}
