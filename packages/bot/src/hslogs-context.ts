// remote chat history for the sync builders. local sqlite keeps a short window; heatsync holds
// the rest. callers fetch what they need ONCE, async, under one budget (prefetchHistory),
// then hand the result to the sync builders, which merge it under the local-first rule:
// remote only fills time OLDER than the oldest local row of that query.
// never throws; no key / nothing needed / everything failed = null, and callers keep their
// local answer unchanged.
import * as hs from './hslogs'
import { findChatPasta, pastaKeywords, pastaKeywordCoverage, type PastaHit } from './pasta'

export const BUDGET_MS = 1500

export interface HistoryNeed {
  pasta?: string // pasta query (only when local missed)
  content?: string // keyword search across everyone
  user?: string // target for the user* calls
  userSearch?: string // keyword search within `user`
  userRecent?: boolean
  userOldest?: boolean
  profiles?: string[] // existence / first_seen / message count
  words?: { term: string; from?: string; to?: string } // `user`'s term-count
  footprint?: string // whole-channel term footprint
}

export interface RemoteHistory {
  pasta?: PastaHit
  content?: hs.LogRow[]
  userSearch?: hs.LogRow[]
  userRecent?: hs.LogRow[]
  userOldest?: hs.LogRow[]
  profiles?: Map<string, hs.UserProfile>
  wordCount?: number
  footprint?: hs.TermFootprint
}

export interface HistRow { username: string; message: string; created_at: string }

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const rowKey = (r: { username: string; message: string }) => `${r.username.toLowerCase()}|${norm(r.message)}`

/** api iso timestamp -> the 'YYYY-MM-DD HH:MM:SS' shape local rows carry */
export function localTs(iso: string): string {
  return iso.slice(0, 19).replace('T', ' ')
}

/**
 * local rows first; remote rows only when strictly older than the oldest local row (the
 * local horizon), deduped by lowercase user + normalized text. empty local = no horizon.
 * oldestFirst: asc-ordered results (remote extras are older, so they lead).
 */
export function mergeHistory(local: HistRow[], remote: hs.LogRow[] | undefined | null, opts: { oldestFirst?: boolean } = {}): HistRow[] {
  if (!remote || remote.length === 0) return local
  let horizon = ''
  for (const r of local) if (!horizon || r.created_at < horizon) horizon = r.created_at
  const seen = new Set(local.map(rowKey))
  const extras: HistRow[] = []
  for (const r of remote) {
    if (!r || typeof r.message !== 'string' || typeof r.username !== 'string' || typeof r.timestamp !== 'string') continue
    const created_at = localTs(r.timestamp)
    if (horizon && created_at >= horizon) continue
    const row = { username: r.username, message: r.message, created_at }
    const k = rowKey(row)
    if (seen.has(k)) continue
    seen.add(k)
    extras.push(row)
  }
  if (extras.length === 0) return local
  extras.sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
  if (opts.oldestFirst) return [...extras, ...local]
  return [...local, ...extras.reverse()] // newest-first like the local reads
}

/** pasta recall off the remote rollup — same PastaHit shape the local path produces */
export function pickRemotePasta(query: string, rows: hs.RemotePasta[] | undefined | null): PastaHit | null {
  const kw = pastaKeywords(query)
  if (!rows || kw.length === 0) return null
  let best: PastaHit | null = null
  for (const p of rows) {
    if (!p || typeof p.text !== 'string' || typeof p.repeats !== 'number') continue
    const coverage = pastaKeywordCoverage(p.text, kw)
    if (coverage === 0) continue
    if (!best || coverage > best.coverage || (coverage === best.coverage && p.repeats > best.reps)) best = { message: p.text, reps: p.repeats, coverage }
  }
  return best
}

/** a local hit only counts when it matched what was asked; the "most repeated" fallback does not */
export function localPastaSatisfies(query: string, channel: string): boolean {
  const hit = findChatPasta(query, channel)
  return !!hit && (hit.coverage > 0 || pastaKeywords(query).length === 0)
}

export async function remotePasta(channel: string, query: string, signal?: AbortSignal): Promise<PastaHit | null> {
  if (!hs.hslogsEnabled()) return null
  try {
    const kw = pastaKeywords(query)
    if (kw.length === 0) return null
    const env = await hs.getPastas(channel, { q: kw.join(' '), limit: 10, signal: signal ?? AbortSignal.timeout(BUDGET_MS) })
    return pickRemotePasta(query, env?.data)
  } catch {
    return null
  }
}

/**
 * run only the needed remote calls in parallel under one total budget. partial results are
 * kept; calls still running at the deadline are aborted and dropped.
 */
export async function prefetchHistory(channel: string, need: HistoryNeed, budgetMs = BUDGET_MS): Promise<RemoteHistory | null> {
  if (!hs.hslogsEnabled()) return null
  const ctl = new AbortController()
  const out: RemoteHistory = {}
  let closed = false
  const signal = ctl.signal
  const user = need.user?.toLowerCase()
  const tasks: Promise<void>[] = []
  const run = (job: () => Promise<void>) => tasks.push((async () => { try { await job() } catch {} })())

  if (need.pasta) run(async () => { const h = await remotePasta(channel, need.pasta!, signal); if (h && !closed) out.pasta = h })
  if (need.content) run(async () => { const e = await hs.search(channel, need.content!, { limit: 20, signal }); if (e && !closed) out.content = e.data })
  if (user && need.userSearch) run(async () => { const e = await hs.search(channel, need.userSearch!, { user, limit: 8, signal }); if (e && !closed) out.userSearch = e.data })
  if (user && need.userRecent) run(async () => { const e = await hs.getUserMessages(channel, user, { order: 'new', limit: 10, signal }); if (e && !closed) out.userRecent = e.data })
  if (user && need.userOldest) run(async () => { const e = await hs.getUserMessages(channel, user, { order: 'old', limit: 10, signal }); if (e && !closed) out.userOldest = e.data })
  if (user && need.words) run(async () => {
    const c = await hs.getTermCount(channel, user, need.words!.term, { from: need.words!.from, to: need.words!.to, signal })
    if (c && !closed) out.wordCount = c.data.count
  })
  for (const raw of need.profiles ?? []) {
    const u = raw.toLowerCase()
    run(async () => {
      const p = await hs.getUserProfile(channel, u, signal)
      if (p && !closed) (out.profiles ??= new Map()).set(u, p)
    })
  }
  if (need.footprint) run(async () => { const f = await hs.getTermFootprint(channel, need.footprint!, signal); if (f && !closed) out.footprint = f.data })
  if (tasks.length === 0) return null

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((r) => { timer = setTimeout(r, budgetMs) })
  await Promise.race([Promise.all(tasks), deadline])
  clearTimeout(timer)
  closed = true
  ctl.abort()
  return Object.keys(out).length > 0 ? { ...out } : null
}
