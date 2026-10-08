// shadow mode (HEATSYNC_LOGS_SHADOW=1): fire the remote call beside the local read, log a
// compact diff, change nothing. never awaited, never throws, rate-limited.
import * as hs from './hslogs'
import { log } from './log'

const MIN_GAP_MS = 5_000
const WINDOW_MS = 60_000
const WINDOW_MAX = 20

const last = new Map<string, number>()
let stamps: number[] = []

export function resetShadow(): void { last.clear(); stamps = [] }

function allow(kind: string): boolean {
  if (process.env.HEATSYNC_LOGS_SHADOW !== '1' || !hs.hslogsEnabled()) return false
  const now = Date.now()
  if (now - (last.get(kind) ?? 0) < MIN_GAP_MS) return false
  stamps = stamps.filter((t) => now - t < WINDOW_MS)
  if (stamps.length >= WINDOW_MAX) return false
  last.set(kind, now)
  stamps.push(now)
  return true
}

function run(kind: string, job: () => Promise<string | null>): void {
  if (!allow(kind)) return
  void (async () => {
    try {
      const line = await job()
      if (line) log(`hslogs-shadow: ${kind} ${line}`)
      else log(`hslogs-shadow: ${kind} remote=null`)
    } catch {}
  })()
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const rowKey = (r: { username: string; message: string }) => `${r.username.toLowerCase()}|${norm(r.message)}`

// local rows carry no message_id, so overlap is by user+text
function rowDiff(local: { username: string; message: string }[], remote: hs.LogRow[]): string {
  const lk = new Set(local.map(rowKey))
  const rk = new Set(remote.map(rowKey))
  let both = 0
  for (const k of lk) if (rk.has(k)) both++
  return `local=${lk.size} remote=${rk.size} both=${both} onlyLocal=${lk.size - both}`
}

/** keyword/user recall: local FTS rows vs remote search */
export function shadowRecall(channel: string, q: string, user: string | undefined, local: { username: string; message: string }[]): void {
  const text = q.replace(/["()*]|\b(?:OR|AND|NOT)\b/g, ' ').replace(/\s+/g, ' ').trim()
  if (!text) return
  run('recall', async () => {
    const env = await hs.search(channel, text, { user, limit: 20 })
    return env ? `${rowDiff(local, env.data)} partial=${env.coverage.partial}` : null
  })
}

/** pasta lookup: did the remote rollup find the pasta local picked? */
export function shadowPasta(channel: string, q: string, local: { message: string; reps: number } | null): void {
  run('pasta', async () => {
    const env = await hs.getPastas(channel, { q, limit: 5 })
    if (!env) return null
    const top = env.data[0]
    const match = !!local && !!top && norm(top.sample).slice(0, 80) === norm(local.message).slice(0, 80)
    return `local=${local ? local.reps : 'none'} remote=${top ? top.n : 'none'} sameTop=${match} n=${env.data.length}`
  })
}

/** person profile: local count/first-seen vs remote */
export function shadowProfile(channel: string, user: string, local: { messages: number; firstSeen: string } | null): void {
  run('profile', async () => {
    const env = await hs.getUserProfile(channel, user)
    if (!env) return null
    const p = env.data
    return `local=${local?.messages ?? 'none'}@${local?.firstSeen.slice(0, 10) ?? '-'} remote=${p.exists ? p.count : 'none'}@${p.first_day ?? '-'}`
  })
}
