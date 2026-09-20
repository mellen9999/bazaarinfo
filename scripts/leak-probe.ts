#!/usr/bin/env bun
// ambient-context leak probe — does a fact the bot carries in EVERY prompt show up in an
// answer nobody asked it for?
//
// this exists because unit tests could not catch the defect it was written for. the stream
// title sat in the Stream line on every ask with "state it if asked, never open with it
// unprompted" attached, every test passed, and live the bot still opened an unrelated
// answer with it, quoted it at a question about a title TRACK, and handed one streamer's
// title to another (2026-09-19/20). only a real model reading the whole prompt shows that.
//
//   bun scripts/leak-probe.ts                      # every scenario, live db copy
//   bun scripts/leak-probe.ts --channel mellen
//   bun scripts/leak-probe.ts --file my-probes.txt
//
// needs ANTHROPIC_API_KEY + TWITCH_* (auto-loaded from the bot's .env by the runner).
// EVERY scenario is a real API call — a full run is a handful of cents, not free. the db is
// copied first and never written to in place; the twitch token is read from the live store
// and only ever used for a GET, never refreshed, so it cannot rotate prod's credentials.
//
// a leak is probabilistic — the model may decline to volunteer the fact on any given run.
// so an all-pass run is evidence, not proof (widen the scenario list rather than trusting
// one green), while ANY failure is real: the fact was in the prompt and it came out.
//
// ISOLATION IS THE WHOLE POINT. each scenario runs in its own process against the shared
// copy, and deletes the rows it wrote before exiting. batching them in one process makes
// the probe lie: the bot reads its own earlier replies as conversation memory and looks
// like it is still leaking when it is only remembering.
import { homedir } from 'os'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SRC = resolve(ROOT, 'packages/bot/src')

const arg = (flag: string, fallback: string): string => {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const CHANNEL = arg('--channel', 'nl_kripp')
const PROBE_FILE = arg('--file', resolve(HERE, 'leak-probes.txt'))

// --- scenarios -------------------------------------------------------------------------
// "query :: expectation[,expectation]". expectations:
//   -ambient   the reply must mention NO ambient stream fact (title/game/viewers/uptime)
//   +title     the reply must quote the live channel title — the ask it IS the answer to
// blank lines and # comments are ignored.
export interface Scenario { query: string; expects: string[] }

export function parseScenarios(text: string): Scenario[] {
  const out: Scenario[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const [q, e] = line.split('::')
    if (!q?.trim()) continue
    out.push({ query: q.trim(), expects: (e ?? '-ambient').split(',').map((s) => s.trim()).filter(Boolean) })
  }
  return out
}

// a fact's distinctive words — short ones ("the", "is") would match anything, so they go.
export function factWords(value: string | null | undefined): string[] {
  return (value ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 4)
}

export function mentions(reply: string, words: string[]): boolean {
  const r = reply.toLowerCase()
  return words.some((w) => r.includes(w))
}

// --- child: one scenario, one process --------------------------------------------------
// import.meta.main keeps the pure matchers above importable (leak-probe.test.ts) without
// the import firing a probe run — a test suite must never spend money or hit the network.
if (import.meta.main && process.env.LEAK_PROBE_ONE) {
  const tokens = await Bun.file(resolve(homedir(), '.bazaarinfo-tokens.json')).json().catch(() => null)
  const { __setTokensForTest } = await import(resolve(SRC, 'auth.ts'))
  // deliberately NOT ensureValidToken — that refreshes, and a refresh rotates the token the
  // live bot is holding. a stale token here just means the title lookup fails, which the
  // parent reports honestly.
  if (tokens) __setTokensForTest(tokens)

  const db = await import(resolve(SRC, 'db.ts'))
  db.initDb(process.env.LEAK_PROBE_DB)
  const { loadStore } = await import(resolve(SRC, 'store.ts'))
  await loadStore()
  const { refreshChannelTitle, getCachedChannelTitle } = await import(resolve(SRC, 'channel-title.ts'))
  const { markLiveStateKnown, getStreamInfo, getChannelGame, isChannelLive } = await import(resolve(SRC, 'ai-cache.ts'))
  const { aiRespond } = await import(resolve(SRC, 'ai.ts'))

  const ch = process.env.LEAK_PROBE_CHANNEL!
  markLiveStateKnown()
  await refreshChannelTitle(ch).catch(() => {})
  const info = getStreamInfo(ch)
  const title = getCachedChannelTitle(ch) ?? info?.title ?? null

  // every ambient stream fact in one bag: whichever of these turns up in a reply to a
  // question that asked for none of them is the leak.
  const ambient = [
    ...factWords(title),
    ...factWords(getChannelGame(ch)),
    ...(isChannelLive(ch) && typeof info?.viewers === 'number' ? [String(info.viewers)] : []),
  ]

  const before = db.getDb().query('SELECT COALESCE(MAX(id), 0) AS id FROM ask_queries').get() as { id: number }
  const beforeRecent = db.getDb().query('SELECT COALESCE(MAX(rowid), 0) AS id FROM channel_recent_responses').get() as { id: number }
  let reply = '(null)'
  try {
    const r = await aiRespond(process.env.LEAK_PROBE_ONE, { user: 'leakprobe', channel: ch, direct: true } as never)
    reply = r?.text ?? '(null)'
  } finally {
    // leave the copy exactly as found — the next scenario must not see this one's answer
    try {
      db.getDb().run('DELETE FROM ask_queries WHERE id > ?', [before.id])
      db.getDb().run('DELETE FROM channel_recent_responses WHERE rowid > ?', [beforeRecent.id])
    } catch {}
  }
  console.log(`__RESULT__${JSON.stringify({ reply, ambient, title })}`)
  process.exit(0)
}

// --- parent ----------------------------------------------------------------------------
if (import.meta.main && !process.env.LEAK_PROBE_ONE) {
  const scenarios = parseScenarios(await Bun.file(PROBE_FILE).text())
  if (scenarios.length === 0) {
    console.error(`no scenarios in ${PROBE_FILE}`)
    process.exit(2)
  }

  const copy = `/tmp/bzi-leak-probe-${process.pid}.db`
  const live = process.env.LEAK_PROBE_SOURCE_DB ?? resolve(homedir(), '.bazaarinfo.db')
  // .backup, not cp — the live db is in WAL mode and a plain copy can catch a torn page
  const dump = Bun.spawnSync(['sqlite3', `file:${live}?mode=ro`, `.backup '${copy}'`])
  if (dump.exitCode !== 0) {
    console.error(`could not copy ${live}: ${dump.stderr.toString()}`)
    process.exit(2)
  }

  console.log(`leak probe — #${CHANNEL}, ${scenarios.length} scenarios, real api calls\n`)
  let failed = 0
  for (const s of scenarios) {
    const child = Bun.spawnSync(['bun', 'run', resolve(HERE, 'leak-probe.ts')], {
      env: { ...process.env, LEAK_PROBE_ONE: s.query, LEAK_PROBE_DB: copy, LEAK_PROBE_CHANNEL: CHANNEL },
      stderr: 'pipe',
    })
    const out = child.stdout.toString().split('\n').find((l) => l.startsWith('__RESULT__'))
    if (!out) {
      console.log(`ERROR  ${s.query}\n       ${child.stderr.toString().trim().split('\n').slice(-2).join(' ')}`)
      failed++
      continue
    }
    const { reply, ambient, title } = JSON.parse(out.slice('__RESULT__'.length)) as
      { reply: string; ambient: string[]; title: string | null }

    const problems: string[] = []
    for (const expect of s.expects) {
      if (expect === '-ambient' && mentions(reply, ambient)) {
        problems.push(`leaked an ambient fact (${ambient.filter((w) => reply.toLowerCase().includes(w)).join(', ')})`)
      }
      if (expect === '+title') {
        if (!title) problems.push('no title available to quote — check the twitch token')
        else if (!mentions(reply, factWords(title))) problems.push('did not quote the live title')
      }
    }
    if (problems.length) failed++
    console.log(`${problems.length ? 'FAIL' : 'pass'}   ${s.query}`)
    console.log(`       -> ${reply}`)
    for (const p of problems) console.log(`       !! ${p}`)
  }

  try { await Bun.file(copy).delete() } catch {}
  for (const suffix of ['-wal', '-shm']) { try { await Bun.file(copy + suffix).delete() } catch {} }

  console.log(`\n${scenarios.length - failed}/${scenarios.length} pass`)
  process.exit(failed > 0 ? 1 : 0)
}
