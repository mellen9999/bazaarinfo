import * as db from './db'
import { getRecent } from './chatbuf'
import { refreshVoice } from './style'
import { log } from './log'
import { readJson } from './http'

// --- re-exports (preserve public API) ---

export { sanitize, isModelRefusal, stripInputEcho, fixEmoteCase, fixEmotePunctuation, dedupeEmote, dedupeUserEmote, dedupeMention, capEmoteTotal, capRepeatedSpam, hasHallucinatedStats, EMOTE_CAP_PER_MSG } from './ai-sanitize'
export { cacheExchange, getChannelRecentResponses, getHotExchanges, getAiCooldown, getGlobalAiCooldown, recordUsage, setChannelLive, setChannelOffline, isChannelLive, getLiveChannels, getChannelGame, setChannelGame, setChannelInfos, cbRecordSuccess, cbRecordFailure, cbIsOpen, AI_VIP, AI_CHANNELS, AI_MAX_QUEUE, getRecentEmotes } from './ai-cache'
export { buildSystemPrompt, invalidatePromptCache, buildFTSQuery, buildFTSQueryLoose, GREETINGS, isLowValue, isShortResponse, STOP_WORDS, REMEMBER_RE, extractEntities, buildUserMessage, buildGameContext, buildUserContext, buildTimeline, buildRecallContext, buildChatRecall, buildChattersContext, isNoise, parseChatTimeWindow, isAboutOtherUser } from './ai-context'
export { initSummarizer, initLearner, maybeFetchTwitchInfo, maybeUpdateMemo, maybeExtractFacts } from './ai-background'

// --- local imports from sub-modules ---

import { sanitize, stripInputEcho, dedupeUserEmote, isModelRefusal, hasHallucinatedStats } from './ai-sanitize'
import { getAiCooldown, getGlobalAiCooldown, recordUsage, cbIsOpen, cbRecordSuccess, cbRecordFailure, AI_VIP, AI_CHANNELS, AI_MAX_QUEUE, cacheExchange, aiQueueDepth, acquireAiSlot, incrementQueue, decrementQueue, isOverDailyCap, isRepeatAbuse } from './ai-cache'
import { buildSystemPrompt, buildUserMessage, isLowValue, isShortResponse, GAME_TERMS } from './ai-context'
import { maybeExtractFacts, maybeUpdateMemo } from './ai-background'
import { hedged } from './ai-hedge'
import { detectFancyStyle, toFancy } from './fancy'

// strip orphan UTF-16 surrogate halves — twitch chat / 7TV emote names occasionally
// inject lone D800-DBFF or DC00-DFFF code units. anthropic's JSON parser rejects them
// with "no low surrogate in string", tripping the circuit breaker.
export function stripUnpairedSurrogates(s: string): string {
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
}

// safe JSON.stringify that scrubs orphan surrogates from every string field.
// (a bare regex after stringify can't see them — they get encoded as \uXXXX text.)
export function safeStringify(body: unknown): string {
  return JSON.stringify(body, (_k, v) => typeof v === 'string' ? stripUnpairedSurrogates(v) : v)
}

// --- constants ---

const API_KEY = process.env.ANTHROPIC_API_KEY
const CHAT_MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS_GAME = 100
const MAX_TOKENS_CHAT = 80
const MAX_TOKENS_PASTA = 200
const TIMEOUT = 7_000
const MAX_RETRIES = 3
// hedged request: prod p90 is ~3.8s, so a call still pending at 4s is in the slow tail.
// fire one identical backup and take whichever returns first — collapses the stall /
// empty-body / slow-backend tail (~10% of calls) into ~p50 at the cost of one extra small
// request on just that slow path. requests are identical + idempotent, so racing is safe.
const HEDGE_AFTER = 4_000
// don't start an attempt without at least this much of the request deadline left — a
// sub-2s window can't complete a real generation, it just burns the budget on a sure abort.
const MIN_ATTEMPT_BUDGET = 2_000

// --- hallucination detection ---

// data-ref → verb (within 30 chars after) OR verb → data-ref (within 40 chars after)
// catches both "the data shows X" and "X is in the data pull alongside Y"
const FAKE_DATA_PATTERN = /\b(game data|the data|the db|the database|the wiki|the tooltip|in my data|in the data|the data pull|in the data pull)\b.{0,30}\b(has|says?|shows?|contains?|literally|includes|lists|reads?|exactly|hints?|points? to|under|tagged|listed|labeled|marked|categor\w*)\b|\b(has|says?|shows?|reads?|listed|tagged|appears?|found|showed up|popped up|just (showed|popped|appeared))\b.{0,40}\b(in (?:the )?(?:game )?data(?: pull)?|in the (?:db|database|wiki|tooltip))\b|\b(based on|according to|looking at)\s+(the|my)\s+(data|records|stats|search|database)\b|\bitems?\s+tagged\b|\btagged\s+(as|in)\s+["“]?\w/i

function hasFabricatedDataRef(text: string, hasGameData: boolean): boolean {
  return !hasGameData && FAKE_DATA_PATTERN.test(text)
}

// --- interfaces ---

export interface AiContext {
  user?: string
  channel?: string
  privileged?: boolean
  isMod?: boolean
  mention?: boolean
  direct?: boolean
}

export interface AiResult { text: string; mentions: string[] }

const AI_MAX_QUERY_LEN = 200

// --- main entry ---

export async function aiRespond(query: string, ctx: AiContext): Promise<AiResult | null> {
  if (!API_KEY) return null
  if (isLowValue(query)) return null
  if (query.length > AI_MAX_QUERY_LEN) query = query.slice(0, AI_MAX_QUERY_LEN)
  if (!ctx.user || !ctx.channel) return null
  if (!AI_CHANNELS.has(ctx.channel.toLowerCase())) return null
  if (cbIsOpen()) return { text: 'brain is rebooting, try again in a sec', mentions: [] }

  const isVip = AI_VIP.has(ctx.user.toLowerCase())
  const isGame = GAME_TERMS.test(query)

  // per-channel daily token cap (disabled by default; the Anthropic console $/mo wall is
  // the real ceiling). if ever re-enabled, a DIRECT ask gets an honest tapped-out line —
  // never the transient "hit me again" glitch, which lies and invites a doomed retry.
  // passive/background lines stay silent.
  if (!isVip && isOverDailyCap(ctx.channel)) {
    log(`ai: daily cap hit for ${ctx.channel}, dropping`)
    return ctx.direct ? { text: 'tapped out my daily brain budget — back tomorrow', mentions: [] } : null
  }
  // repeat-query abuse — silent drop (VIP exempt). continuation asks ("continue",
  // "keep going", "more"…) are LEGITIMATELY repeated — each one extends the story with
  // new content — so they're exempt; otherwise the 3rd "continue" reads as spam and the
  // bot bails on an active bit.
  const isContinue = /^(continue|keep going|go on|carry on|more\b|next\b|finish( it)?|expand|extend|again\b|and then|then what)/i.test(query.trim())
  if (!isVip && !isContinue && isRepeatAbuse(ctx.user, query)) {
    log(`ai: repeat abuse from ${ctx.user}, dropping`)
    return null
  }

  const cd = getAiCooldown(ctx.user, ctx.channel)
  if (cd > 0) return { text: `${cd}s`, mentions: [] }
  if (!ctx.direct && !isGame && !isVip && getGlobalAiCooldown(ctx.channel) > 0) return null

  if (aiQueueDepth >= AI_MAX_QUEUE && !isVip) {
    log('ai: queue full, dropping')
    return null
  }
  incrementQueue()
  const release = await acquireAiSlot()

  try {
    const result = await doAiCall(query, ctx as AiContext & { user: string; channel: string })
    if (result?.text) recordUsage(ctx.user, isGame, ctx.channel)
    return result
  } finally {
    decrementQueue()
    release()
  }
}

// --- API call + retry + sanitize + background triggers ---

async function doAiCall(query: string, ctx: AiContext & { user: string; channel: string }): Promise<AiResult | null> {
  // fire-and-forget voice refresh (background, non-blocking)
  refreshVoice(ctx.channel).catch(() => {})

  const { text: userMessage, hasGameData, isPasta, isCreative, isContinuation, isRememberReq } = buildUserMessage(query, ctx)
  const systemPrompt = buildSystemPrompt()
  const baseMaxTokens = isCreative ? MAX_TOKENS_PASTA : hasGameData ? MAX_TOKENS_GAME : MAX_TOKENS_CHAT
  // extended thinking + best-of-2 dropped — added ~2-3s of latency for marginal quality gain.
  // sonnet 4.6 is strong enough creative-cold; if quality regresses, reintroduce selectively.
  // fancy fonts: the model writes PLAIN ASCII (cheap, ~1s) and we transcode to the
  // requested unicode font in code (see fancy.ts). hand-typed fancy glyphs are
  // 3-5 tokens each — generating them directly cost ~800 tokens and 10-12s, and
  // truncated mid-word ("Dearly beloved" bug). transcoding is instant and exact.
  const fancyStyle = isCreative ? detectFancyStyle(query) : null
  const effectiveMaxTokens = baseMaxTokens

  // when a fancy font is requested, force ascii output so transcoding has clean
  // input — otherwise the model emits its own (expensive, inconsistent) glyphs.
  const fancyDirective = fancyStyle
    ? `${userMessage}\n\n[Write the reply in PLAIN ASCII letters and digits only — no unicode, fancy, or special characters. A fancy font is applied automatically afterward, so do not stylize it yourself.]`
    : userMessage
  const messages: unknown[] = [{ role: 'user', content: fancyDirective }]
  const start = Date.now()
  // in a busy chat a reply older than this has scrolled off-screen and is just
  // holding a concurrency slot hostage (esp. during 429 backoff sleeps), starving
  // everyone else's request. fail fast so the queue drains instead of clogging.
  const REQUEST_DEADLINE = 12_000

  type ApiData = {
    content: { type: string; text?: string }[]
    stop_reason: string
    usage?: { input_tokens: number; output_tokens: number }
  }

  type ApiResult = { status: number; data?: ApiData }
  const isUsable = (r: ApiResult) => r.status === 200 && !!r.data

  async function fetchOnce(body: unknown, timeoutMs: number, extSignal?: AbortSignal): Promise<ApiResult> {
    // caller (hedge) can abort the loser via extSignal; distinguish that from a real
    // timeout so a cancelled-but-fine attempt doesn't log a spurious "timed out".
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    const onExt = () => controller.abort()
    extSignal?.addEventListener('abort', onExt)
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY!,
          'anthropic-version': '2023-06-01',
        },
        body: safeStringify(body),
        signal: controller.signal,
      })
      if (!res.ok) {
        const errBody = res.status === 429 ? '' : await res.text().catch(() => '')
        if (errBody) log(`ai: API ${res.status} ${errBody}`)
        return { status: res.status }
      }
      const parsed = await readJson<ApiData>(res)
      // 200 with an empty/truncated body — upstream dropped mid-stream. surface as
      // a synthetic 503 so the retry loop treats it like a transient error instead
      // of throwing "Unexpected end of JSON input" and silently dropping the reply.
      if (parsed.empty || !parsed.data) {
        log('ai: empty/malformed 200 body — retrying as transient')
        return { status: 503 }
      }
      // record spend here — every dispatched request that returns a 200 body is billed
      // by Anthropic, including hedge losers and retry attempts that are later discarded.
      // recording at the winner-only site (post-sanitize) misses those tokens and makes
      // the daily cap trip late. logAsk stays at the winner site (per-final-reply).
      try {
        const u = parsed.data.usage
        if (u) db.recordAiSpend(ctx.channel, u.input_tokens ?? 0, u.output_tokens ?? 0)
      } catch {}
      return { status: 200, data: parsed.data }
    } catch (e) {
      // externally aborted (hedge winner already returned) — silently drop, not a failure.
      if ((e as Error)?.name === 'AbortError' && !timedOut) return { status: 0 }
      // a stalled/timed-out attempt is transient — surface as 503 so the retry loop
      // tries again fast instead of bailing to the outer catch and returning null
      // (which leaves the user with no answer after a full timeout wait).
      if ((e as Error)?.name === 'AbortError') {
        log('ai: attempt timed out — retrying as transient')
        return { status: 503 }
      }
      throw e
    } finally {
      clearTimeout(timer)
      extSignal?.removeEventListener('abort', onExt)
    }
  }

  const fetchHedged = (body: unknown, timeoutMs: number): Promise<ApiResult> =>
    hedged((signal) => fetchOnce(body, timeoutMs, signal), {
      hedgeAfterMs: HEDGE_AFTER,
      // need a head start + a meaningful backup window, else just run one attempt
      enabled: timeoutMs > HEDGE_AFTER + MIN_ATTEMPT_BUDGET,
      usable: isUsable,
      fallback: { status: 0 },
    })

  try {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // deadline hit = upstream is slow/stuck. count it toward the circuit breaker
      // (a silently-uncounted slow failure would keep the breaker from tripping).
      // budget the per-attempt timeout to what's LEFT of the deadline so a late attempt
      // can't overrun it (previously only checked at attempt start → 7s attempts started
      // near the line ran to ~18s; now the whole request stays within REQUEST_DEADLINE).
      const remaining = REQUEST_DEADLINE - (Date.now() - start)
      if (remaining < MIN_ATTEMPT_BUDGET) { log('ai: request deadline exceeded'); cbRecordFailure(); break }
      const model = CHAT_MODEL
      const baseTemp = isCreative ? 0.95 : hasGameData ? 0.5 : 0.75
      const body = {
        model,
        max_tokens: effectiveMaxTokens,
        temperature: Math.min(1.0, baseTemp + attempt * 0.1),
        system: [{ type: 'text' as const, text: systemPrompt, cache_control: { type: 'ephemeral' as const } }],
        messages,
      }

      const single = await fetchHedged(body, Math.min(TIMEOUT, remaining))
      // 429 (rate limited) and 503 (empty/truncated body) are both transient — retry.
      if ((single.status === 429 || single.status === 503) && attempt < MAX_RETRIES - 1) {
        const delay = (single.status === 503 ? 1_000 : 3_000) * (attempt + 1)
        log(`ai: ${single.status}, retrying in ${delay / 1000}s (attempt ${attempt + 1})`)
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      if (single.status !== 200 || !single.data) { cbRecordFailure(); return null }
      const data: ApiData = single.data
      const latency = Date.now() - start

      const textBlock = data.content?.find((b) => b.type === 'text')
      if (!textBlock?.text) return null

      // build known-user set for fake @mention stripping
      const knownUsers = new Set<string>()
      for (const entry of getRecent(ctx.channel, 30)) knownUsers.add(entry.user.toLowerCase())
      knownUsers.add(ctx.user.toLowerCase())
      // names the asker explicitly @'d in their request are real references — keep them
      for (const m of query.matchAll(/@(\w+)/g)) knownUsers.add(m[1].toLowerCase())

      // isRealUser falls back to the channel chat log for anyone outside the recent window
      const result = sanitize(textBlock.text, ctx.user, ctx.isMod, knownUsers, data.stop_reason === 'max_tokens', (n) => db.userHasChatted(n, ctx.channel))
      // strip injection echo (model parroting user's injected instructions)
      result.text = stripInputEcho(result.text, query)
      // strip per-user signature emote repetition — but NOT for creative writing, where an
      // emote can be a recurring character/noun ("Crowge watched from the corner…") and
      // stripping it leaves grammatically broken fragments ("the watched from the corner").
      if (!isCreative) result.text = dedupeUserEmote(result.text, ctx.user, ctx.channel)
      // reject hallucinated game stats when no game data was provided. unambiguous
      // Bazaar stat claims (keyword/tier/+X/+Y) are rejected even in creative/banter —
      // a roleplay reply that invents "+60 haste at gold tier" is still misinformation.
      // an other-game query (a game term matched but no Bazaar entity resolved) is allowed
      // real numbers — the prompt promises "full nerd mode" for other games; only Bazaar
      // tooltip notation stays blocked. without this the bot silently refused PoE/D2/WoW Qs.
      const isOtherGame = !hasGameData && GAME_TERMS.test(query)
      if (!hasGameData && hasHallucinatedStats(result.text, isCreative, isOtherGame)) {
        log(`ai: hallucinated stats without game data, retrying (attempt ${attempt + 1})`)
        if (attempt < MAX_RETRIES - 1) {
          messages.push({ role: 'assistant', content: textBlock.text })
          messages.push({ role: 'user', content: 'You invented specific game numbers without data. Answer without citing specific damage/HP/percentage values.' })
          continue
        }
        log('ai: hallucinated stats retries exhausted — returning null for clean fallback')
        return null
      }
      // reject fabricated data references ("the data has", "tagged as" etc) when no game data present
      if (hasFabricatedDataRef(result.text, hasGameData)) {
        log(`ai: fabricated data reference, retrying (attempt ${attempt + 1})`)
        if (attempt < MAX_RETRIES - 1) {
          messages.push({ role: 'assistant', content: textBlock.text })
          messages.push({ role: 'user', content: 'You claimed data/db contains something it doesnt. No "Game data:" section was provided. Answer without referencing game data or search results.' })
          continue
        }
        log('ai: fabricated data ref retries exhausted — returning null for clean fallback')
        return null
      }
      // enforce length caps in code
      const isShort = isShortResponse(query)
      const hardCap = isCreative ? 400 : hasGameData ? 250 : isRememberReq ? 120 : isShort ? 60 : 150
      if (result.text.length > hardCap) {
        const cut = result.text.slice(0, hardCap)
        // prefer sentence-ending breaks; only fall back to comma/clause if none exist
        const sentenceBreak = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
        if (sentenceBreak > hardCap * 0.4) {
          result.text = cut.slice(0, sentenceBreak + 1).trim()
        } else {
          const clauseBreak = Math.max(cut.lastIndexOf(' — '), cut.lastIndexOf(', '))
          if (clauseBreak > hardCap * 0.5) {
            result.text = cut.slice(0, clauseBreak).trim()
          } else if (data.stop_reason === 'max_tokens' || result.text.length > 480) {
            // only amputate mid-thought when the model was actually cut off, or we're over
            // the hard 480-char Twitch limit. a COMPLETE slightly-over-cap one-liner ("she's
            // the best take here") keeps its last words instead of being clipped to a fragment.
            result.text = cut.replace(/\s+\S*$/, '').trim()
          }
        }
      }
      // fix orphan quotes created by truncation
      if ((result.text.match(/"/g) || []).length % 2 !== 0) {
        const last = result.text.lastIndexOf('"')
        const before = result.text.slice(0, last).trim()
        if (before.length > 10) result.text = before
      }
      // fix unclosed parens created by truncation
      const openParens = (result.text.match(/\(/g) || []).length
      const closeParens = (result.text.match(/\)/g) || []).length
      if (openParens > closeParens) {
        const lastOpen = result.text.lastIndexOf('(')
        const before = result.text.slice(0, lastOpen).trim()
        if (before.length > 10) {
          result.text = before
        } else {
          result.text = result.text.replace(/[,\s]*$/, '') + ')'
        }
      }
      // truncation can leave a dangling list label ("...2. foo 3") — drop the orphan
      // ordinal, but only when an earlier numbered item proves it was a real list.
      if (/\b\d+[.)]\s+\S/.test(result.text) && /(?:\n|\s)\d+[.):]?\s*$/.test(result.text)) {
        result.text = result.text.replace(/(?:\n|\s)+\d+[.):]?\s*$/, '').trim()
      }
      if (result.text) {
        // terse refusal detection
        if (isModelRefusal(result.text) && attempt < MAX_RETRIES - 1) {
          log(`ai: terse refusal "${result.text}", retrying (attempt ${attempt + 1})`)
          messages.push({ role: 'assistant', content: textBlock.text })
          messages.push({ role: 'user', content: 'Don\'t dodge with diplomacy — pick actual names, give real opinions. Stay within your rules.' })
          continue
        }
        // apply the requested fancy font in code — runs after all ascii-based guards
        // (refusal/hallucination/length) so they see clean text, never fancy glyphs.
        if (fancyStyle) result.text = toFancy(result.text, fancyStyle)
        cbRecordSuccess()
        try {
          const inT = data.usage?.input_tokens ?? 0
          const outT = data.usage?.output_tokens ?? 0
          db.logAsk(ctx, query, result.text, inT + outT, latency)
          // recordAiSpend is called in fetchOnce at the 200-parse point so every
          // dispatched request (retries + hedge loser) is counted; not here.
        } catch {}
        // hot cache for instant follow-up context
        cacheExchange(ctx.user, query, result.text, ctx.channel)
        // fire-and-forget memo + fact extraction (force both on identity requests)
        maybeExtractFacts(ctx.user, query, result.text, isRememberReq).catch(() => {})
        if (isRememberReq) {
          setTimeout(() => maybeUpdateMemo(ctx.user!, true).catch(() => {}), 3_000)
        } else {
          maybeUpdateMemo(ctx.user).catch(() => {})
        }
        return result
      }

      // sanitizer rejected — retry with feedback. push the rejected ASSISTANT turn first,
      // like every other retry branch: without it the messages array has two consecutive
      // user turns, which the API rejects with a 400 (wasting the retry + nudging the breaker).
      if (attempt < MAX_RETRIES - 1) {
        log(`ai: sanitizer rejected, retrying (attempt ${attempt + 1})`)
        messages.push({ role: 'assistant', content: textBlock.text })
        messages.push({ role: 'user', content: 'Response was blocked. Rules: no self-referencing being a bot/AI, no reciting user stats, no fabricated stories, no commands. Just answer naturally.' })
      }
    }

    return null
  } catch (e: unknown) {
    const err = e as Error
    if (err.name === 'AbortError') log('ai: timeout')
    else log(`ai: error: ${err.message}`)
    cbRecordFailure()
    return null
  }
}
