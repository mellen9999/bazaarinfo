#!/usr/bin/env bun
// quality report — what chat actually received, measured against the guards that shipped.
//
// every number the voice and accuracy work was based on came from a throwaway script. this
// is that script, kept: the claims in docs/response-tests.md are only worth anything if
// anyone can re-run them. it imports the REAL guard functions rather than re-implementing
// them, so the report can never drift from what the bot enforces.
//
//   bun scripts/quality-report.ts                    # live db, last 2500 replies
//   bun scripts/quality-report.ts --limit 500
//   bun scripts/quality-report.ts --json dump.json   # exported rows, for running off-box
//   bun scripts/quality-report.ts --since '2026-08-12 19:00'   # only replies after a deploy
//
// --since is what makes this answer "did the change work?". without it the window is
// whatever traffic happens to be newest, which on a quiet day is entirely pre-deploy.
//
// exit code is 1 if any tracked rate regressed past its baseline, so it can gate a push.

import { Database } from 'bun:sqlite'
import { homedir } from 'node:os'
import { isDashClause, monotonyStreak, findUngroundedStats, deniesBoardSight } from '../packages/bot/src/ai-verify'
import { OTHER_GAME_RE } from '../packages/bot/src/ai-context'

interface Row { query: string; response: string; latency_ms: number | null }

// baselines measured 2026-08-12, before the streak-breaker shipped. beating them is the
// point; drifting past them means something regressed.
const BASELINE = {
  dashClause: 43.0,
  inRunOf3: 24.5,
  meanRate: 0.8,
  brushRate: 0.8,
}

const args = process.argv.slice(2)
const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const limit = Number(arg('--limit') ?? 2500)
const jsonPath = arg('--json')
const since = arg('--since')

let rows: Row[]
if (jsonPath) {
  rows = await Bun.file(jsonPath).json()
} else {
  const dbPath = arg('--db') ?? `${homedir()}/.bazaarinfo.db`
  const db = new Database(dbPath, { readonly: true })
  rows = db.query(
    `SELECT query, response, latency_ms FROM ask_queries
     WHERE response IS NOT NULL AND length(response) > 0
       AND (? IS NULL OR created_at >= ?)
     ORDER BY created_at DESC LIMIT ?`,
  ).all(since ?? null, since ?? null, limit) as Row[]
  db.close()
}

if (rows.length === 0) {
  console.log(since ? `no replies logged since ${since} yet — nothing to measure` : 'no replies logged yet — nothing to measure')
  process.exit(0)
}

// chat order, oldest first: streaks only mean anything in sequence
const chrono = [...rows].reverse()
const R = chrono.map((r) => r.response)
const n = R.length
const rate = (k: number) => (k / n) * 100
const fmt = (v: number) => `${v.toFixed(1)}%`

// --- rhythm ---
const dashClause = R.filter(isDashClause).length
const emdash = R.filter((r) => /—/.test(r)).length
const short = R.filter((r) => r.length < 45).length

const runs: number[] = []
let cur = 0
for (const r of R) {
  if (isDashClause(r)) cur++
  else { if (cur) runs.push(cur); cur = 0 }
}
if (cur) runs.push(cur)
const inRunOf3 = runs.filter((s) => s >= 3).reduce((a, b) => a + b, 0)
const longestRun = runs.length ? Math.max(...runs) : 0

// how often the shipped streak-breaker would engage on this sample
let nudged = 0
const recent: string[] = []
for (const r of R) {
  if (monotonyStreak(recent) >= 2) nudged++
  recent.push(r)
  if (recent.length > 12) recent.shift()
}

// --- repetition: the same five words twice is a coincidence, four times is a tic ---
const grams = new Map<string, number>()
for (const r of R) {
  const w = r.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter(Boolean)
  const seen = new Set<string>()
  for (let i = 0; i + 5 <= w.length; i++) {
    const g = w.slice(i, i + 5).join(' ')
    if (!seen.has(g)) { seen.add(g); grams.set(g, (grams.get(g) ?? 0) + 1) }
  }
}
const tics = [...grams].filter(([, c]) => c >= 4).sort((a, b) => b[1] - a[1]).slice(0, 8)

// --- tone. the bar is "punch at nobody", so these should stay near zero ---
const MEAN = /\b(?:bold strategy|that's on you|skill issue|cope\b|maybe (?:try|learn|read)|you'?re the one who|imagine (?:asking|thinking)|good luck with that|not my problem|figure it out)\b/i
const BRUSHOFF = /\b(?:no (?:clue|idea|data|read)|nothing (?:on|for) (?:that|you)|beats me|ask (?:someone|chat)\b)/i
const mean = R.filter((r) => MEAN.test(r))
const brush = R.filter((r) => BRUSHOFF.test(r))
const blind = R.filter(deniesBoardSight).length

// --- accuracy: stat numbers with no source. needs the store, so it is best-effort ---
let ungrounded = 0
let statChecked = 0
try {
  const { loadStore } = await import('../packages/bot/src/store')
  const { initDb } = await import('../packages/bot/src/db')
  initDb()
  await loadStore()
  const { buildUserMessage } = await import('../packages/bot/src/ai-build')
  for (const r of chrono) {
    const built = buildUserMessage(r.query, { user: 'report', channel: 'nl_kripp' } as never)
    // mirror the runtime exemptions exactly — a pasta invents numbers on purpose and an
    // other-game answer carries that game's real ones
    if (!built.hasGameData || built.isCreative || OTHER_GAME_RE.test(r.query)) continue
    statChecked++
    if (findUngroundedStats(r.response, built.text).length) ungrounded++
  }
} catch (e) {
  console.log(`(stat grounding skipped: ${(e as Error).message})`)
}

// --- latency ---
const lat = chrono.map((r) => r.latency_ms ?? 0).filter(Boolean).sort((a, b) => a - b)
const p = (q: number) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * q))] : 0

const worse = (now: number, base: number) => now > base + 2 // 2pt slack for sample noise
const mark = (now: number, base: number) => worse(now, base) ? ' REGRESSED' : ''

console.log(`\nbazaarinfo quality — ${n} replies${since ? ` since ${since}` : ''}\n`)
console.log('rhythm            now      baseline')
console.log(`  clause — clause  ${fmt(rate(dashClause)).padStart(6)}   ${fmt(BASELINE.dashClause)}${mark(rate(dashClause), BASELINE.dashClause)}`)
console.log(`  in a run of 3+   ${fmt(rate(inRunOf3)).padStart(6)}   ${fmt(BASELINE.inRunOf3)}${mark(rate(inRunOf3), BASELINE.inRunOf3)}`)
console.log(`  any em-dash      ${fmt(rate(emdash)).padStart(6)}`)
console.log(`  under 45 chars   ${fmt(rate(short)).padStart(6)}`)
console.log(`  longest run      ${String(longestRun).padStart(6)}   (17 was the worst seen)`)
console.log(`  streak-breaker   ${fmt(rate(nudged)).padStart(6)}   of replies would be nudged`)

console.log('\ntone')
console.log(`  punch at asker   ${fmt(rate(mean.length)).padStart(6)}   ${fmt(BASELINE.meanRate)}${mark(rate(mean.length), BASELINE.meanRate)}`)
console.log(`  brush-off        ${fmt(rate(brush.length)).padStart(6)}   ${fmt(BASELINE.brushRate)}${mark(rate(brush.length), BASELINE.brushRate)}`)
console.log(`  "i can't see"    ${String(blind).padStart(6)}   (only correct with no board in context)`)

console.log('\naccuracy')
console.log(`  game replies     ${String(statChecked).padStart(6)}`)
// not zero-tolerance: replaying the corpus showed a residual ~0.5% of real-world numbers
// in game-flavoured replies (a pokemon crit count, a joke "9000 damage"). the gate is the
// rate, so a genuine grounding regression still trips it.
const ungroundedRate = statChecked ? (ungrounded / statChecked) * 100 : 0
console.log(`  ungrounded stat  ${String(ungrounded).padStart(6)}   ${fmt(ungroundedRate)} of them (gate: 1.0%)`)

console.log('\nlatency  p50/p90/p99   ' + `${p(0.5)}ms / ${p(0.9)}ms / ${p(0.99)}ms`)

if (tics.length) {
  console.log('\nrepeated phrases (4+ replies)')
  for (const [g, c] of tics) console.log(`  ${String(c).padStart(3)}x  ${g}`)
}

const regressed = worse(rate(dashClause), BASELINE.dashClause)
  || worse(rate(inRunOf3), BASELINE.inRunOf3)
  || worse(rate(mean.length), BASELINE.meanRate)
  || worse(rate(brush.length), BASELINE.brushRate)
  || ungroundedRate > 1.0
console.log(regressed ? '\nsomething regressed past its baseline\n' : '\nall tracked rates at or under baseline\n')
process.exit(regressed ? 1 : 0)
