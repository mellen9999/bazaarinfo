// remote chat history for the sync builders. local sqlite keeps a short window; heatsync holds
// the rest. callers fetch what they need ONCE, async, under one budget (prefetchHistory),
// then hand the result to the sync builders, which merge it under the local-first rule:
// remote only fills time OLDER than the oldest local row of that query.
// never throws; no key / nothing needed / everything failed = null, and callers keep their
// local answer unchanged.
import * as hs from './hslogs'
import { findChatPasta, pastaKeywords, pastaKeywordCoverage, type PastaHit } from './pasta'

export const BUDGET_MS = 1500
// headroom for the round trip, so a server-side walk ends before our own deadline
const NET_MS = 400

export interface HistoryNeed {
  pasta?: string // pasta query (only when local missed)
  before?: string // local horizon, full ISO Z: searches only scan older days (unwindowed search takes 5-6s)
  content?: string // keyword search across everyone
  user?: string // target for the user* calls
  userSearch?: string // keyword search within `user`
  userRecent?: boolean
  userRecentLimit?: number // default 10; a person dossier wants a bigger sample
  lorePastas?: string // pasta rollup query for lore bits (older bits the 30d window no longer holds)
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
  pastas?: hs.RemotePasta[]
  userOldest?: hs.LogRow[]
  profiles?: Map<string, hs.UserProfile>
  wordCount?: number
  footprint?: hs.TermFootprint
}

export interface HistRow { username: string; message: string; created_at: string }

// twitch replies: local rows store the text WITHOUT the auto "@parent " prefix, heatsync keeps
// it; and twitch's duplicate-message bypass appends invisible chars (U+E0000, U+034F, zero-width)
const INVISIBLE = /[\u{E0000}\u034F\u200B-\u200D\u2060\uFEFF]/gu
const REPLY_PREFIX = /^\s*@\w+[,:]?\s+/
/** comparison form of a chat line: one leading @login stripped, invisibles dropped, case/space folded */
export function normText(s: string): string {
  return s.replace(INVISIBLE, '').replace(REPLY_PREFIX, '').toLowerCase().replace(/\s+/g, ' ').trim()
}
const norm = normText
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

/** the api search is recency-ordered AND-match, not relevance: rank by distinct query terms hit, recency breaks ties */
export function rankByTerms(rows: hs.LogRow[], q: string): hs.LogRow[] {
  const terms = [...new Set(q.toLowerCase().split(/\s+/).filter((t) => t.length >= 3))]
  if (terms.length === 0) return rows
  const score = (r: hs.LogRow) => { const m = r.message.toLowerCase(); return terms.reduce((n, t) => n + (m.includes(t) ? 1 : 0), 0) }
  return rows.map((r, i) => ({ r, i, s: score(r) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.r)
}

/** follow next_cursor while rows are short and budget remains; empty + partial = unknown, not "none" */
async function paged(page: (cursor?: string) => Promise<hs.Envelope<hs.LogRow[]> | null>, want: number, signal: AbortSignal): Promise<hs.LogRow[] | undefined> {
  const rows: hs.LogRow[] = []
  let cursor: string | undefined
  for (let i = 0; i < 6; i++) {
    const env = await page(cursor)
    if (!env) break
    rows.push(...env.data)
    if (rows.length >= want || !env.next_cursor || signal.aborted) {
      return rows.length === 0 && env.coverage?.partial ? undefined : rows
    }
    cursor = env.next_cursor
  }
  return rows.length ? rows : undefined
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
  const t0 = Date.now()
  const left = () => Math.max(0, budgetMs - (Date.now() - t0) - NET_MS)
  const user = need.user?.toLowerCase()
  const tasks: Promise<void>[] = []
  const run = (job: () => Promise<void>) => tasks.push((async () => { try { await job() } catch {} })())

  if (need.pasta) run(async () => { const h = await remotePasta(channel, need.pasta!, signal); if (h && !closed) out.pasta = h })
  const to = need.before
  if (need.lorePastas) run(async () => {
    const e = await hs.getPastas(channel, { q: need.lorePastas, min_len: 80, limit: 20, signal })
    if (e && !closed) out.pastas = e.data
  })
  if (need.content) run(async () => {
    const e = await hs.search(channel, need.content!, { to, limit: 50, signal, budget_ms: left() })
    if (e && !closed && !(e.data.length === 0 && e.coverage?.partial)) out.content = rankByTerms(e.data, need.content!)
  })
  if (user && need.userSearch) run(async () => {
    const rows = await paged((cursor) => hs.getUserMessages(channel, user, { q: need.userSearch, to, order: 'new', limit: 50, cursor, signal, budget_ms: left() }), 20, signal)
    if (rows && !closed) out.userSearch = rankByTerms(rows, need.userSearch!)
  })
  if (user && need.userRecent) run(async () => {
    const n = need.userRecentLimit ?? 10
    const rows = await paged((cursor) => hs.getUserMessages(channel, user, { to, order: 'new', limit: Math.min(n, 100), cursor, signal, budget_ms: left() }), n, signal)
    if (rows && !closed) out.userRecent = rows
  })
  if (user && need.userOldest) run(async () => {
    const rows = await paged((cursor) => hs.getUserMessages(channel, user, { order: 'old', limit: 10, cursor, signal, budget_ms: left() }), 10, signal)
    if (rows && !closed) out.userOldest = rows
  })
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
