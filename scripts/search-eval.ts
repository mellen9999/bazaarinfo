// web-search eval for the chat path. replays real logged asks through the exact request the
// bot sends when the search gate opens (system prompt + built context + SEARCH_HINT + the
// web_search tool) and prints whether the model searched, how long it took, and what it
// said. the deterministic gate has unit tests; THIS is the proof for the model-side gate —
// searches on the fact asks, none on banter, no preamble, no urls.
//
//   ssh mele "cd ~/projects/bazaarinfo && bun run scripts/search-eval.ts"
//
// needs ANTHROPIC_API_KEY (auto-loaded from .env on mele). ~15 calls, a handful of
// searches: ~$0.30 a run. isolated temp db, the bot's data is untouched.
import { initDb } from '../packages/bot/src/db'
import { loadStore } from '../packages/bot/src/store'
import { buildSystemPrompt, buildUserMessage } from '../packages/bot/src/ai-context'
import { searchEligible, finalText, SEARCH_HINT, WEB_SEARCH_TOOL, SEARCH_MAX_TOKENS, SEARCH_TIMEOUT } from '../packages/bot/src/ai-search-gate'

initDb('/tmp/bzi-search-eval.db')
await loadStore()

const API_KEY = process.env.ANTHROPIC_API_KEY
if (!API_KEY) { console.error('ANTHROPIC_API_KEY missing'); process.exit(1) }

// [ask, should the model search?] — "maybe" = either is defensible
const CASES: [string, 'yes' | 'no' | 'maybe'][] = [
  ['how many days till blizzcon?', 'yes'],
  ['what does mcginnis ult do in deadlock', 'yes'],
  ['whats the drop rate on cham rune in diablo 2?', 'yes'],
  ['do you know the story behind the song Bonehead\'s Bank Holiday from oasis?', 'yes'],
  ['what is marvel snap draft?', 'maybe'],
  ['whats the most popular diablo 2 mod at the moment?', 'yes'],
  ['what are Germans general view of people from saxony anhalt', 'maybe'],
  ['does chocolate donuts actually make you go nuts', 'no'],
  ['is fun really subjective', 'no'],
  ['how much wood would a woodchuck chuck if a woodchuck could chuck wood?', 'no'],
  ['why does the sky look blue', 'no'],
  ['who won the 2022 world cup?', 'no'],
  ['when does path of exile 2 next league start?', 'yes'],
  ['is there a familiar hero like mcginnis in overwatch?', 'maybe'],
]

const system = buildSystemPrompt()
let searches = 0
let wrong = 0
for (const [ask, want] of CASES) {
  const build = buildUserMessage(ask, { user: 'evaluser', channel: 'mellen', direct: true } as any)
  const offered = searchEligible(ask, build, 0, 0)
  if (!offered) { console.log(`GATE-CLOSED  ${ask}`); continue }
  const t0 = Date.now()
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: SEARCH_MAX_TOKENS,
      thinking: { type: 'disabled' },
      system: [{ type: 'text', text: system }],
      tools: WEB_SEARCH_TOOL,
      messages: [{ role: 'user', content: `${build.text}\n\n${SEARCH_HINT}` }],
    }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT),
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e), json: async () => null }) as Response)
  const ms = Date.now() - t0
  if (!res.ok) { console.log(`ERROR ${res.status} ${ask} — ${(await res.text()).slice(0, 120)}`); continue }
  const data = await res.json() as { content: { type: string; text?: string }[]; stop_reason: string; usage?: { server_tool_use?: { web_search_requests?: number } } }
  const n = data.usage?.server_tool_use?.web_search_requests ?? 0
  searches += n
  const text = finalText(data.content)
  const verdict = want === 'maybe' ? 'ok' : (want === 'yes') === n > 0 ? 'ok' : 'WRONG'
  if (verdict === 'WRONG') wrong++
  const urls = /https?:\/\/|www\./i.test(text) ? ' URL!' : ''
  const preamble = /^(let me|i'?ll) (look|check|search)/i.test(text) ? ' PREAMBLE!' : ''
  console.log(`${verdict.padEnd(5)} search=${n} ${String(ms).padStart(5)}ms stop=${data.stop_reason}${urls}${preamble}  ${ask}\n      -> ${text}`)
}
console.log(`\n${searches} searches, ${wrong} wrong calls`)
