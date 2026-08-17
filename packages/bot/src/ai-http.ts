import { log } from './log'
import { readJson } from './http'
import { notify } from './notify'
import { acquireAiSlot } from './ai-cache'
import { recordAiSpend, recordAiSpendBySource, ptDay } from './db'
import { safeStringify } from './safe-json'

// ONE Anthropic HTTP call, shared by every non-chat call site (trivia, directives,
// background summaries, dungeon archetypes, reddit, style, emote descriptions).
// Owns the endpoint, headers, unpaired-surrogate stripping, timeout, prompt caching,
// spend + cache accounting, the concurrency semaphore, and the hard-stop breaker — so
// none of that has to be re-implemented (or forgotten) per call site.
//
// The chat path (ai.ts) keeps its own fetch: it layers hedging, per-attempt deadlines and
// retry on top, which this deliberately does not model. It shares the hard stop below.

const API_KEY = process.env.ANTHROPIC_API_KEY
const ENDPOINT = 'https://api.anthropic.com/v1/messages'
const DEFAULT_TIMEOUT = 12_000

export { stripUnpairedSurrogates, safeStringify } from './safe-json'

// --- hard stop -------------------------------------------------------------
//
// The normal circuit breaker (ai-cache) is built for a transient upstream wobble: it opens
// for 30s then re-probes. Two failures are NOT transient and re-probing them is pure waste:
//
//   400 invalid_request_error "You have reached your specified API usage limits"  (spend cap)
//   401 authentication_error                                                      (bad key)
//
// On 2026-08-16 the org hit its monthly cap and every trivia round kept firing 37 doomed
// requests. This latches for the rest of the PT day (the same day key the spend ledger uses),
// so the bot short-circuits to its deterministic paths instead. A restart re-probes once.

let hardStopDay = ''
let hardStopReason = ''

export function isHardStopped(): boolean {
  return hardStopDay !== '' && hardStopDay === ptDay()
}

export function hardStopReasonText(): string {
  return isHardStopped() ? hardStopReason : ''
}

// exported for tests — the latch is process-global by design.
export function resetHardStopForTests(): void {
  hardStopDay = ''
  hardStopReason = ''
}

// a 400 is normally OUR bug (malformed body) and must not latch; only the usage-limit
// wording does. 401 always latches — a rejected key will not start working this afternoon.
function detectHardStop(status: number, body: string): string {
  if (status === 401) return 'api key rejected (401)'
  if (status === 400 && /usage limit|credit balance|spend limit/i.test(body)) {
    return body.slice(0, 200)
  }
  return ''
}

/**
 * Report a non-OK API response. Latches the day-long stop when the status+body say the
 * failure is permanent, and does nothing otherwise. Safe to call on every error — the chat
 * path (ai.ts) runs its own fetch and calls this so both paths share one latch.
 */
export function noteHardStop(status: number, body: string): void {
  const reason = detectHardStop(status, body)
  if (!reason || isHardStopped()) return
  hardStopDay = ptDay()
  hardStopReason = reason
  log(`ai-http: HARD STOP for the rest of ${hardStopDay} — ${reason}`)
  void notify('ai-hard-stop', 'bazaarinfo: AI disabled', `${reason}\nAI paths are short-circuited until the next PT day.`, 'high')
}

// --- the call --------------------------------------------------------------

export interface AnthropicCallOpts {
  /** log prefix identifying the call site, e.g. 'ai-trivia'. */
  tag: string
  /** channel the spend is billed to in the ai_spend ledger. */
  channel: string
  model: string
  maxTokens: number
  /** the user turn: plain text, or content blocks when the call sends images. */
  content: string | object[]
  system?: string
  /**
   * Cache the system prompt. Worth it for any byte-identical prompt reused across calls
   * inside the TTL — which is every generator/verifier prompt here. Anthropic silently
   * declines to cache a prefix under ~1024 tokens, so a short system prompt just behaves
   * as if this were off; there is no penalty for asking.
   */
  cacheSystem?: boolean
  timeoutMs?: number
  /** take a concurrency slot so a wide fan-out can't starve the chat path. default true. */
  slot?: boolean
}

interface Usage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

// --- cache TTL ---
//
// Reads cost 0.1x base input under either TTL. Writes are 1.25x at the default 5 minutes
// and 2x at one hour, so the choice is purely about how often we go cold.
//
// The relevant detail is that a round fans OUT: 6 generation calls fire in parallel with a
// byte-identical system prompt, and concurrent calls cannot read each other's write, so a
// cold round pays six writes, not one. In units of the base input price for that prefix:
//
//                        cold round     warm round
//   5m TTL               6 x 1.25 = 7.5    6 x 0.1 = 0.6
//   1h TTL               6 x 2.00 = 12     6 x 0.1 = 0.6
//
//   sparse day, 20 rounds ~12 min apart, over 4h
//     5m: every round cold                        = 20 x 7.5     = 150
//     1h: ~1 write/hour, the rest warm            = 4 x 12 + 16 x 0.6 = 57.6   (2.6x better)
//   marathon, 174 rounds ~40s apart
//     5m: 1 cold + 173 warm                       = 111.3
//     1h: 1 cold + 173 warm                       = 115.8        (4% worse)
//
// So this is NOT free money: it wins big on bursty traffic with gaps and loses slightly on
// a sustained marathon, and in absolute dollars those two nearly cancel. It is chosen
// because real traffic is the bursty shape — stream gaps, ad breaks, chat moving on — and
// the 5-minute window is fragile to every one of those, which is exactly the case the
// caching docs say to use an extended TTL for.
//
// Not done: pre-warming the cache with a single max_tokens:0 call before the fan-out, which
// would cut a cold round's write from 12 units to ~2.6. It only pays on cold rounds, adds a
// sequential round trip before every fan-out, and cold rounds are either rare (marathon) or
// already costing pennies (sparse day). Revisit only if the ledger says otherwise.
//
// The bot cannot verify this parameter against the live API until the spend cap lifts, so
// it degrades itself rather than betting the whole AI surface on an untested field: if a
// request is ever rejected for the ttl, we drop back to the default TTL, retry that call,
// and stop sending it. Self-healing, no manual intervention, no silent outage.
const LONG_CACHE_TTL = '1h'
let useLongTtl = true

function cacheControl() {
  return useLongTtl
    ? { type: 'ephemeral' as const, ttl: LONG_CACHE_TTL }
    : { type: 'ephemeral' as const }
}

// true when a 400 is complaining about the cache_control/ttl field specifically, rather
// than about our actual request content.
function isTtlRejection(status: number, body: string): boolean {
  return status === 400 && /ttl|cache_control/i.test(body)
}

/**
 * Returns the model's first text block, or null on any error/timeout/refusal/empty body.
 * Never throws — every call site here wants a clean miss path, not an exception.
 */
export async function anthropicCall(o: AnthropicCallOpts): Promise<string | null> {
  if (!API_KEY) return null
  if (isHardStopped()) return null

  const release = o.slot === false ? null : await acquireAiSlot()
  // the timeout starts AFTER the slot is held — a queued call must not burn its budget
  // waiting in line and then time out the instant it gets to run.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? DEFAULT_TIMEOUT)
  try {
    // re-check: the latch may have tripped while this call sat in the slot queue, which is
    // exactly the fan-out case (18 verify calls queued behind one that just discovered the
    // cap). without this the whole wave still fires.
    if (isHardStopped()) return null

    const send = () => {
      const system = o.system
        ? [{ type: 'text' as const, text: o.system, ...(o.cacheSystem === false ? {} : { cache_control: cacheControl() }) }]
        : undefined
      return fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY!, 'anthropic-version': '2023-06-01' },
        body: safeStringify({
          model: o.model,
          max_tokens: o.maxTokens,
          thinking: { type: 'disabled' },
          ...(system ? { system } : {}),
          messages: [{ role: 'user', content: o.content }],
        }),
        signal: controller.signal,
      })
    }

    let res = await send()

    if (!res.ok) {
      // 429 bodies are noise; everything else is worth reading — and both a hard stop and
      // a ttl rejection are only identifiable from the body text.
      let body = res.status === 429 ? '' : await res.text().catch(() => '')
      // the long TTL is the one request field we could not verify against the live API.
      // if it is what upstream objects to, drop it permanently and retry this call once.
      if (useLongTtl && isTtlRejection(res.status, body)) {
        useLongTtl = false
        log(`${o.tag}: API rejected the ${LONG_CACHE_TTL} cache ttl — falling back to the default and retrying`)
        res = await send()
        if (!res.ok) body = res.status === 429 ? '' : await res.text().catch(() => '')
      }
      if (!res.ok) {
        if (detectHardStop(res.status, body)) noteHardStop(res.status, body)
        else log(`${o.tag}: API ${res.status}${body ? ` ${body.slice(0, 200)}` : ''}`)
        return null
      }
    }

    const parsed = await readJson<{ content?: { type: string; text?: string }[]; usage?: Usage; stop_reason?: string }>(res)
    // every dispatched request that returns a 200 body is billed, so record before
    // inspecting the content — a truncated or empty body still costs money.
    const u = parsed.data?.usage
    if (u) {
      recordAiSpend(
        o.channel,
        u.input_tokens ?? 0,
        u.output_tokens ?? 0,
        u.cache_read_input_tokens ?? 0,
        u.cache_creation_input_tokens ?? 0,
      )
      // per-subsystem ledger. the aug 2026 blowout took a log-mining session to pin on
      // one code path; this makes "where did the money go" a query instead of a hunt.
      recordAiSpendBySource(
        o.tag,
        u.input_tokens ?? 0,
        u.output_tokens ?? 0,
        u.cache_read_input_tokens ?? 0,
        u.cache_creation_input_tokens ?? 0,
      )
    }

    // A response cut off at max_tokens is a PAID call that produced nothing usable: the
    // JSON never closes, so the parser rejects it and the caller reads that as a refusal
    // rather than as "we starved it". Surfacing it is what makes the ceilings tunable
    // from evidence instead of guesswork.
    if (parsed.data?.stop_reason === 'max_tokens') {
      log(`${o.tag}: TRUNCATED at max_tokens=${o.maxTokens} — the response was cut off and will not parse`)
    }
    return parsed.data?.content?.find((b) => b.type === 'text')?.text ?? null
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') log(`${o.tag}: call timed out`)
    else log(`${o.tag}: ${(e as Error)?.message ?? e}`)
    return null
  } finally {
    clearTimeout(timer)
    release?.()
  }
}
