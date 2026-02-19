import { log } from './log'

export interface ChatEntry {
  user: string
  text: string
  ts: number
}

const buffers = new Map<string, ChatEntry[]>()
const MAX_SIZE = 100

// --- rolling summary ---

const summaries = new Map<string, string>()
const msgsSinceSummary = new Map<string, number>()
const SUMMARY_INTERVAL = 50
let summarizer: ((channel: string, recent: ChatEntry[], prev: string) => Promise<string>) | null = null

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
    if (summary) summaries.set(channel, summary)
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
  let buf = buffers.get(channel)
  if (!buf) {
    buf = []
    buffers.set(channel, buf)
  }
  buf.push({ user, text, ts: Date.now() })
  if (buf.length > MAX_SIZE) buf.shift()
  maybeSummarize(channel)
}

export function getRecent(channel: string, count: number): ChatEntry[] {
  const buf = buffers.get(channel)
  if (!buf) return []
  return buf.slice(-count)
}
