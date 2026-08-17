import { log } from './log'
import { readJson } from './http'
import { notify } from './notify'
import { acquireAiSlot } from './ai-cache'
import { recordAiSpend, ptDay } from './db'
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
   * Cache the system prompt. Only worth it for a byte-identical prompt reused across calls
   * within the 5-minute TTL — which is every generator/verifier prompt here. Anthropic
   * silently declines to cache a prefix under ~1024 tokens, so a short system prompt just
   * behaves as if this were off; there is no penalty for asking.
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

    const system = o.system
      ? [{ type: 'text' as const, text: o.system, ...(o.cacheSystem === false ? {} : { cache_control: { type: 'ephemeral' as const } }) }]
      : undefined

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: safeStringify({
        model: o.model,
        max_tokens: o.maxTokens,
        thinking: { type: 'disabled' },
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: o.content }],
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      // 429 bodies are noise; everything else is worth reading — and a hard stop is only
      // identifiable from the body text.
      const body = res.status === 429 ? '' : await res.text().catch(() => '')
      if (detectHardStop(res.status, body)) noteHardStop(res.status, body)
      else log(`${o.tag}: API ${res.status}${body ? ` ${body.slice(0, 200)}` : ''}`)
      return null
    }

    const parsed = await readJson<{ content?: { type: string; text?: string }[]; usage?: Usage }>(res)
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
