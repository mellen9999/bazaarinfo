import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { log } from './log'

// live FIFA World Cup scores from ESPN's public scoreboard JSON (no key, no auth).
// mirrors the patch.ts fail-soft contract: every export returns ''/null on any
// failure — the bot never crashes or hallucinates a score because ESPN hiccuped.
// dormant outside tournaments: no events in window → no injection, no chat noise.

const CACHE_PATH = resolve(import.meta.dir, '../../../cache/worldcup.json')
const UA = 'BazaarInfo/1.0 (Twitch bot; github.com/mellen9999/bazaarinfo)'
const API = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard'
const LIVE_TTL_MS = 60_000 // a live score older than a minute is a wrong score
const IDLE_TTL_MS = 10 * 60_000
const HARD_STALE_MS = 48 * 60 * 60 * 1000
const LIVE_TRUST_MS = 5 * 60_000 // past this, tell the model the live score has likely moved
const MAX_MATCHES = 12

export interface WcTeam {
  name: string
  short: string // ESPN shortDisplayName — "USA" for United States; usually equals name
  score: number
  shootout: number | null
  winner: boolean
}

export interface WcMatch {
  date: string // kickoff, ISO UTC
  state: 'pre' | 'in' | 'post'
  detail: string // ESPN shortDetail: "FT", "FT-Pens", "AET", "HT", "90'+7'", "Scheduled"
  teams: [WcTeam, WcTeam] // home first when ESPN marks homeAway
}

export interface WcData {
  fetchedAt: string
  matches: WcMatch[]
}

// --- query classification ---

const WC_TOPIC_RE = /\b(world\s*cup|soccer|futbol|f[uú]tbol|fifa)\b/i
// gated behind a team-name match, so generic words like "game"/"today" are safe here —
// a bazaar query never names a world cup team
const SPORTY_RE = /\b(scores?|match(?:es)?|games?|today|tonight|vs\.?|versus|play(?:s|ing|ed)?|won|win(?:s|ning)?|lost|los(?:es|ing)|kick\s*-?off|finals?|semi\s*-?finals?|quarter\s*-?finals?|penalt\w*|shoot\s*-?out|goals?|group\s+stage|round\s+of\s+(?:16|32)|knockouts?|extra\s+time)\b/i

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function mentionsTeam(query: string, data: WcData | null): boolean {
  if (!data) return false
  for (const m of data.matches) {
    for (const t of m.teams) {
      for (const label of t.short === t.name ? [t.name] : [t.name, t.short]) {
        if (label.length >= 3 && new RegExp(`\\b${escapeRe(label)}\\b`, 'i').test(query)) return true
      }
    }
  }
  return false
}

// true when the query is about the world cup — either explicitly, or a sporty phrase
// naming a team on the current slate ("colombia vs ghana score?"). used both to gate
// the on-demand refresh (ai.ts) and the context injection (ai-build.ts), so a bazaar
// query like "what's my trivia score" never drags soccer data into the prompt.
export function isWorldCupQuery(query: string): boolean {
  return WC_TOPIC_RE.test(query) || (SPORTY_RE.test(query) && mentionsTeam(query, getCache()))
}

// --- parse ---

// pure parser over ESPN scoreboard JSON — used by fetchWorldCup and tests; no network.
// an empty-but-well-formed events list is valid (off day) and cached, so we don't
// refetch on every query; only a malformed payload returns null.
export function parseScoreboard(raw: unknown): WcData | null {
  try {
    const events = (raw as { events?: unknown })?.events
    if (!Array.isArray(events)) return null
    const matches: WcMatch[] = []
    for (const e of events) {
      const c = e?.competitions?.[0]
      const st = c?.status?.type
      const comps: unknown[] = c?.competitors
      if (!st?.state || !Array.isArray(comps) || comps.length !== 2) continue
      if (typeof e?.date !== 'string') continue
      const ordered = [...comps].sort((a: any, b: any) =>
        (a?.homeAway === 'home' ? 0 : 1) - (b?.homeAway === 'home' ? 0 : 1))
      const teams = ordered.map((t: any) => ({
        name: String(t?.team?.displayName ?? '').trim(),
        short: String(t?.team?.shortDisplayName ?? t?.team?.displayName ?? '').trim(),
        score: Number(t?.score ?? 0),
        shootout: t?.shootoutScore == null ? null : Number(t.shootoutScore),
        winner: t?.winner === true,
      }))
      if (teams.some((t) => !t.name || !Number.isFinite(t.score))) continue
      const state = st.state === 'pre' || st.state === 'post' ? st.state : 'in'
      matches.push({ date: e.date, state, detail: String(st.shortDetail ?? '').trim(), teams: [teams[0], teams[1]] })
      if (matches.length >= MAX_MATCHES) break
    }
    return { fetchedAt: new Date().toISOString(), matches }
  } catch {
    return null
  }
}

// --- cache ---

let mem: WcData | null = null
let memLoaded = false

function getCache(): WcData | null {
  if (!memLoaded) {
    memLoaded = true
    try {
      if (existsSync(CACHE_PATH)) {
        const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as WcData
        if (raw?.fetchedAt && Array.isArray(raw.matches)) mem = raw
      }
    } catch {}
  }
  return mem
}

export function __setWorldCupCacheForTest(data: WcData | null) {
  mem = data
  memLoaded = true
}

// --- fetch + refresh ---

// window: yesterday → +2 days UTC, so "who won last night" and "when do they play"
// both land in one request. returns null on any failure — never throws.
export async function fetchWorldCup(): Promise<WcData | null> {
  try {
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '')
    const res = await fetch(`${API}?dates=${day(-1)}-${day(2)}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return null
    const data = parseScoreboard(await res.json())
    if (!data) {
      log('worldcup: parse failed — ESPN payload shape may have changed')
      return null
    }
    mem = data
    memLoaded = true
    try {
      writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2))
    } catch (e) {
      log(`worldcup: cache write failed: ${e}`)
    }
    return data
  } catch {
    return null
  }
}

let inflight: Promise<unknown> | null = null

// awaited in doAiCall before context build so a score answer reflects the pitch, not
// a stale cache. TTL 60s while a match is live (or a scheduled kickoff has passed),
// 10min otherwise; concurrent callers share one request. never throws.
export async function refreshWorldCupIfNeeded(): Promise<void> {
  const data = getCache()
  if (data) {
    const age = Date.now() - new Date(data.fetchedAt).getTime()
    const liveish = data.matches.some(
      (m) => m.state === 'in' || (m.state === 'pre' && new Date(m.date).getTime() <= Date.now()),
    )
    if (age < (liveish ? LIVE_TTL_MS : IDLE_TTL_MS)) return
  }
  if (!inflight) inflight = fetchWorldCup().finally(() => { inflight = null })
  await inflight
}

// --- format ---

const PT_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' })
const PT_TIME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })

function ageStr(ms: number): string {
  return ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))}s ago` : `${Math.round(ms / 60_000)}m ago`
}

function resultTag(m: WcMatch): string {
  const [a, b] = m.teams
  if (a.shootout != null && b.shootout != null) {
    const w = a.shootout > b.shootout ? a : b
    const l = w === a ? b : a
    return `FT, ${w.name} wins ${w.shootout}-${l.shootout} on pens`
  }
  const winner = m.teams.find((t) => t.winner)
  const aet = /aet/i.test(m.detail) ? 'AET' : 'FT'
  return winner ? `${aet}, ${winner.name} won` : `${aet}, draw`
}

// the injected context section — '' unless the query is world-cup-shaped and the
// cache is usable. the instruction rides inside the line (like patchLine) so the
// system prompt stays untouched and under its size guard.
export function getWorldCupLine(query: string, now = Date.now()): string {
  const data = getCache()
  if (!data || data.matches.length === 0) return ''
  const age = now - new Date(data.fetchedAt).getTime()
  if (!Number.isFinite(age) || age > HARD_STALE_MS) return ''
  if (!isWorldCupQuery(query)) return ''

  const lines: string[] = []
  for (const m of data.matches) {
    const [a, b] = m.teams
    const day = PT_DAY.format(new Date(m.date))
    if (m.state === 'pre') {
      lines.push(`${a.name} vs ${b.name} — kicks off ${PT_TIME.format(new Date(m.date))} PT`)
    } else if (m.state === 'in') {
      const stale = age > LIVE_TRUST_MS ? `, as of ${ageStr(age)} — score has likely moved, say so` : ''
      lines.push(`${day}: ${a.name} ${a.score}-${b.score} ${b.name} (LIVE ${m.detail}${stale})`)
    } else {
      lines.push(`${day}: ${a.name} ${a.score}-${b.score} ${b.name} (${resultTag(m)})`)
    }
  }
  return `\nFIFA World Cup scoreboard (REAL, from ESPN as of ${ageStr(age)} — answer soccer/world cup questions from THIS ONLY; a match or team not listed here is one you don't have data on, say so, NEVER invent scores or fixtures. times are PT):\n${lines.join('\n')}`
}
