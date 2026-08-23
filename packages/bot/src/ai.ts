import * as db from './db'
import { getRecent } from './chatbuf'
import { refreshVoice } from './style'
import { log } from './log'
import { readJson } from './http'

// --- re-exports (preserve public API) ---

export { sanitize, isModelRefusal, stripInputEcho, fixEmoteCase, fixEmotePunctuation, dedupeEmote, dedupeUserEmote, dedupeMention, capEmoteTotal, capRepeatedSpam, hasHallucinatedStats, EMOTE_CAP_PER_MSG } from './ai-sanitize'
export { cacheExchange, getChannelRecentResponses, getHotExchanges, getAiCooldown, getGlobalAiCooldown, recordUsage, setChannelLive, setChannelOffline, isChannelLive, getLiveChannels, getChannelGame, setChannelGame, setChannelInfos, cbRecordSuccess, cbRecordFailure, cbIsOpen, AI_VIP, AI_CHANNELS, AI_MAX_QUEUE, getRecentEmotes } from './ai-cache'
export { buildSystemPrompt, invalidatePromptCache, buildFTSQuery, buildFTSQueryLoose, GREETINGS, isLowValue, isShortResponse, STOP_WORDS, REMEMBER_RE, extractEntities, buildUserMessage, buildGameContext, buildUserContext, buildTimeline, buildRecallContext, buildChatRecall, buildChattersContext, isNoise, parseChatTimeWindow, isAboutOtherUser, formatContextSummary } from './ai-context'
export { initSummarizer, initLearner, maybeFetchTwitchInfo, maybeUpdateMemo, maybeExtractFacts } from './ai-background'

// --- local imports from sub-modules ---

import { sanitize, stripInputEcho, dedupeUserEmote, isModelRefusal, hasHallucinatedStats, ASK_COUNT_LEAK, SCOPE_DODGE, SOURCE_LIE, SCHEDULE_DENIAL } from './ai-sanitize'
import { findUngroundedStats, correctClockClaim, extractBoardLine, deniesBoardSight, findLiveTierClaims, isDashClause, monotonyStreak } from './ai-verify'
import { repairTruncation, isStub } from './ai-truncate'
import { getChannelGame, getAiCooldown, getGlobalAiCooldown, recordUsage, cbIsOpen, cbRecordSuccess, cbRecordFailure, AI_VIP, AI_CHANNELS, AI_MAX_QUEUE, cacheExchange, aiQueueDepth, acquireAiSlot, incrementQueue, decrementQueue, isOverDailyCap, isRepeatAbuse, isUserOverDailyAiCap, noteUserAiRequest, getChannelRecentResponses } from './ai-cache'
import { buildSystemPrompt, buildUserMessage, isLowValue, isShortResponse, isGameTerm, OTHER_GAME_RE, formatContextSummary } from './ai-context'
import { maybeExtractFacts, maybeUpdateMemo } from './ai-background'
import { hedged } from './ai-hedge'
import { isHardStopped, noteHardStop, hardStopResumeAt, safeStringify } from './ai-http'
import { detectFancyStyle, toFancy } from './fancy'
import { matchingDirectives } from './directives'
import { isWorldCupQuery, refreshWorldCupIfNeeded } from './worldcup'
import { isWeatherQuery, refreshWeatherIfNeeded } from './weather'
import { isHsRatingQuery, refreshHsIfNeeded } from './hs'
import { isHsCardQuery, isHearthstoneCategory, refreshHsCardsIfNeeded } from './hs-cards'
import { isGrQuery, isGuildrunCategory, refreshGuildrunIfNeeded } from './guildrun'
import { refreshBoardIfNeeded } from './board'
import { refreshHsBoardIfNeeded } from './hs-board'
import { isScheduleQuery } from './schedule'
import { resolveScheduleChannel } from './schedule-query'
import { refreshChannelTitle } from './channel-title'

// strip orphan UTF-16 surrogate halves — twitch chat / 7TV emote names occasionally
// inject lone D800-DBFF or DC00-DFFF code units. anthropic's JSON parser rejects them
// with "no low surrogate in string", tripping the circuit breaker. defined in ai-http so
// every call site gets the protection; re-exported here to keep this module's public API.
export { stripUnpairedSurrogates, safeStringify } from './ai-http'

// --- constants ---

// exported so commands.ts can exempt continuations from the 30s dedup window.
// single source of truth — never duplicate this regex.
export const CONTINUE_RE = /^(continue|keep going|go on|carry on|more\b|next\b|finish( it)?|expand|extend|again\b|and then|then what)/i

const API_KEY = process.env.ANTHROPIC_API_KEY
const CHAT_MODEL = 'claude-sonnet-5'

// circuit-breaker-open lines — the breaker trips during the exact high-load window where
// many users hit !b at once, and Twitch silently drops a bot's identical consecutive lines.
// a single constant would leave most concurrent askers with dead air, so rotate an honest,
// non-retry-nagging pool (mirrors AI_BUSY_LINES in commands.ts) to dodge the dup filter.
const CB_OPEN_LINES = [
  'brain is rebooting, give it a sec',
  'upstream ai is down rn, back in a moment',
  'ai server hiccup — recovering, try shortly',
  'merchant dropped the scroll, servers catching up',
]
let cbOpenIdx = 0
// a hard stop is NOT a hiccup — the key is rejected or the org's spend ceiling is reached,
// and it lasts until the next PT day. saying "back in a moment" would be a lie, and going
// silent would read as the bot ignoring people. same rotation trick for the dup filter.
const HARD_STOP_LINES = [
  'my ai brain is offline for today — commands and lookups still work',
  'out of ai budget til tomorrow, but the lookups are all still live',
  'no ai answers today (budget), everything else works fine',
  'ai is capped for the day — item/day/monster lookups still good',
]
let hardStopIdx = 0
// the monthly console wall latches for DAYS ("You will regain access on 2026-09-01") —
// "til tomorrow" is a lie for over a week of that. when the API stated a resume time
// further out than the next day, say that date instead of the same-day lines.
const HS_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
function hardStopLine(): string {
  const resume = hardStopResumeAt()
  if (resume - Date.now() > 36 * 3_600_000) {
    const d = new Date(resume)
    const when = `${HS_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
    const lines = [
      `ai answers are on hold til ${when} (budget) — lookups still work`,
      `out of ai budget til ${when}, everything else still live`,
      `no ai til ${when} — item/day/monster lookups still good`,
      `ai brain offline til ${when} (monthly budget), commands still work`,
    ]
    return lines[hardStopIdx++ % lines.length]
  }
  return HARD_STOP_LINES[hardStopIdx++ % HARD_STOP_LINES.length]
}
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
  // What the user actually TYPED, when `query` is something we built for the model
  // (the bare-!b nudge, an identity prompt, a steering suffix). Everything that gets
  // replayed to the model later — the ask log, the hot exchange cache, fact extraction —
  // must record this, not our scaffolding. Otherwise "Previously chatted about" tells the
  // model the user once said "answer bluntly and accurately — unanswered chat question
  // from X", and it reads as an instruction they gave.
  displayQuery?: string
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
  // checked before the breaker: a hard stop is permanent for the day, so there is nothing
  // to probe and every request would be a doomed round trip.
  if (isHardStopped()) return { text: hardStopLine(), mentions: [] }
  if (cbIsOpen()) return { text: CB_OPEN_LINES[cbOpenIdx++ % CB_OPEN_LINES.length], mentions: [] }

  const isVip = AI_VIP.has(ctx.user.toLowerCase())
  const isGame = isGameTerm(query)

  // per-channel daily token cap (disabled by default; the Anthropic console $/mo wall is
  // the real ceiling). if ever re-enabled, a DIRECT ask gets an honest tapped-out line —
  // never the transient "hit me again" glitch, which lies and invites a doomed retry.
  // passive/background lines stay silent.
  if (!isVip && isOverDailyCap(ctx.channel)) {
    log(`ai: daily cap hit for ${ctx.channel}, dropping`)
    return ctx.direct ? { text: 'tapped out my daily brain budget — back tomorrow', mentions: [] } : null
  }
  // per-user daily budget — a spam loop from one account dies here, long before the
  // channel cap or the console wall. honest line for a direct ask, silence for passive.
  if (!isVip && isUserOverDailyAiCap(ctx.user)) {
    log(`ai: user daily ai cap hit for ${ctx.user}, dropping`)
    try { db.logAskMiss(ctx, ctx.displayQuery ?? query, 'user_daily_cap') } catch {}
    return ctx.direct ? { text: `that's all the ai you get today — lookups still work, fresh budget tomorrow`, mentions: [] } : null
  }
  // repeat-query abuse — silent drop (VIP exempt). continuation asks ("continue",
  // "keep going", "more"…) are LEGITIMATELY repeated — each one extends the story with
  // new content — so they're exempt; otherwise the 3rd "continue" reads as spam and the
  // bot bails on an active bit.
  const isContinue = CONTINUE_RE.test(query.trim())
  if (!isVip && !isContinue && isRepeatAbuse(ctx.user, query)) {
    log(`ai: repeat abuse from ${ctx.user}, dropping`)
    try { db.logAskMiss(ctx, ctx.displayQuery ?? query, 'repeat_abuse') } catch {}
    return null
  }

  const cd = getAiCooldown(ctx.user, ctx.channel)
  if (cd > 0) return { text: `${cd}s`, mentions: [] }
  if (!ctx.direct && !isGame && !isVip && getGlobalAiCooldown(ctx.channel) > 0) return null

  if (aiQueueDepth >= AI_MAX_QUEUE && !isVip) {
    log('ai: queue full, dropping')
    try { db.logAskMiss(ctx, ctx.displayQuery ?? query, 'queue_full') } catch {}
    return null
  }
  // bill the request at commit point — every attempt from here costs real tokens whether
  // or not a reply lands, so the counter must not depend on success.
  noteUserAiRequest(ctx.user)
  incrementQueue()
  // measure the slot-wait — the ONE latency term nothing else records. the AI call time lands
  // in ask_queries; inbound delay is logged at the handler; this closes the gap so a slow reply
  // can be attributed precisely (queue backpressure vs slow upstream vs late inbound) instead of
  // inferred. threshold-gated + "lat:" tagged so it's a cheap grep, no per-reply spam.
  const slotStart = Date.now()
  const release = await acquireAiSlot()
  const slotWaitMs = Date.now() - slotStart

  try {
    const callStart = Date.now()
    const result = await doAiCall(query, ctx as AiContext & { user: string; channel: string })
    const callMs = Date.now() - callStart
    if (slotWaitMs > 1000 || callMs > 6000) {
      log(`lat: ai #${ctx.channel} slotWait=${slotWaitMs}ms call=${callMs}ms qDepth=${aiQueueDepth}`)
    }
    if (result?.text) recordUsage(ctx.user, isGame, ctx.channel)
    return result
  } finally {
    decrementQueue()
    release()
  }
}

// --- API call + retry + sanitize + background triggers ---

async function doAiCall(query: string, ctx: AiContext & { user: string; channel: string }): Promise<AiResult | null> {
  // never let scaffolding we wrote get recorded as something the user said
  const loggedQuery = ctx.displayQuery ?? query
  // every non-success exit from here on is a genuine ask that got NO reply — record why,
  // so `SELECT COUNT(*) FROM ask_misses WHERE reason = ...` replaces silence with a signal.
  const miss = (reason: string): null => {
    try { db.logAskMiss(ctx, loggedQuery, reason) } catch {}
    return null
  }
  // fire-and-forget voice refresh (background, non-blocking)
  refreshVoice(ctx.channel).catch(() => {})

  // world cup queries: refresh the scoreboard BEFORE building context so a live score
  // answer reflects the pitch. TTL-gated no-op when fresh; fail-soft, never throws.
  if (isWorldCupQuery(query)) await refreshWorldCupIfNeeded()

  // weather queries: geocode + fetch live conditions BEFORE building context, same
  // contract as world cup — TTL-gated no-op when fresh; fail-soft, never throws.
  if (isWeatherQuery(query)) await refreshWeatherIfNeeded(query)

  // BG leaderboard: deliberately NOT awaited — a full sweep is ~70 requests, so this turn
  // answers from the cached board (refreshed at most every 6h) while a stale one reloads
  // in the background. a rating hours old is right; a reply seconds late is not.
  if (isHsRatingQuery(query)) refreshHsIfNeeded()

  // BG card data: same not-awaited contract, and more so — the dump is ~10MB. this turn
  // answers from the cached cards (refreshed daily) while a stale set reloads behind it.
  if (isHsCardQuery(query)) refreshHsCardsIfNeeded()

  // guildrun data: same contract. refresh on a guildrun-shaped ask OR whenever the
  // channel is streaming it — during a guildrun stream a bare hero name is the trigger,
  // and by then the cache must already be warm.
  if (isGrQuery(query) || isGuildrunCategory(getChannelGame(ctx.channel))) refreshGuildrunIfNeeded()

  // schedule asks: prefetch the target channel's title BEFORE building context — a
  // streamer-stated plan in the title ("NEXT STREAM WEDNESDAY") overrides the stats.
  // TTL-cached, fail-soft, never throws.
  if (isScheduleQuery(query)) {
    await refreshChannelTitle(resolveScheduleChannel(query, ctx.channel)).catch(() => {})
  }

  // live board: pull the latest companion frame from the EBS BEFORE building context —
  // unconditional, because the board is ambient context for ANY message (a joke about
  // the streamer's Bubble Gum stack needs the data even when nobody asked about the
  // board). localhost hop, 10s cache, fail-soft, never throws.
  await refreshBoardIfNeeded(ctx.channel)

  // the battlegrounds equivalent, gated on the channel actually being on Hearthstone:
  // there is no board to fetch during a Bazaar stream, and this is a round-trip per
  // message. same localhost hop, same 10s cache, same fail-soft contract.
  if (isHearthstoneCategory(getChannelGame(ctx.channel)) || isHsCardQuery(query)) {
    await refreshHsBoardIfNeeded(ctx.channel)
  }

  const { text: userMessage, hasGameData, isPasta, isCreative, isContinuation, isRememberReq, hasStats, contextSections } = buildUserMessage(query, ctx)
  // compact "section:chars,section:chars" record of what the model actually saw —
  // names and sizes only, never content (see formatContextSummary in ai-build.ts).
  const contextSummary = formatContextSummary(contextSections)
  const systemPrompt = buildSystemPrompt()
  const baseMaxTokens = isCreative ? MAX_TOKENS_PASTA : hasGameData ? MAX_TOKENS_GAME : MAX_TOKENS_CHAT
  // extended thinking + best-of-2 dropped — added ~2-3s of latency for marginal quality gain.
  // sonnet 4.6 is strong enough creative-cold; if quality regresses, reintroduce selectively.
  // fancy fonts: the model writes PLAIN ASCII (cheap, ~1s) and we transcode to the
  // requested unicode font in code (see fancy.ts). hand-typed fancy glyphs are
  // 3-5 tokens each — generating them directly cost ~800 tokens and 10-12s, and
  // truncated mid-word ("Dearly beloved" bug). transcoding is instant and exact.
  const fancyStyle = isCreative ? detectFancyStyle(query) : null
  // an active steer twist ("say dude after every word") inflates tokens-per-word; on the
  // 80-token chat budget that meant generations cut to 1-3 words. headroom, not a new tier.
  const steerActive = ctx.channel && ctx.user ? matchingDirectives(ctx.channel, query, ctx.user).length > 0 : false
  // a per-word steer roughly doubles tokens-per-idea, and the flat +40 still left 61% of
  // steered replies cut mid-word in production. scale the ceiling instead of nudging it —
  // max_tokens is a ceiling, not a charge, so an ordinary-length reply costs exactly the
  // same. capped at the pasta budget so a steer can't buy itself a wall of text.
  const effectiveMaxTokens = steerActive && !isCreative ? Math.min(baseMaxTokens * 2, MAX_TOKENS_PASTA) : baseMaxTokens

  // when a fancy font is requested, force ascii output so transcoding has clean
  // input — otherwise the model emits its own (expensive, inconsistent) glyphs.
  const fancyDirective = fancyStyle
    ? `${userMessage}\n\n[Write the reply in PLAIN ASCII letters and digits only — no unicode, fancy, or special characters. A fancy font is applied automatically afterward, so do not stylize it yourself.]`
    : userMessage
  const messages: unknown[] = [{ role: 'user', content: fancyDirective }]
  const start = Date.now()
  // hard cap on one request's total time. this is THE latency lever: when Anthropic is slow,
  // all AI_MAX_CONCURRENT slots sit at this deadline and a queue builds — every queued request
  // then waits (deadline × queue_pos / concurrency) for a slot, which is what inflates a reply's
  // age to 40-140s and used to get it dropped. cutting 12s → 9s frees a stuck slot 25% sooner so
  // the queue drains faster and downstream waits shrink. safe: successful replies are ~p90 3.6s,
  // so 9s still lets a legit slow-but-real generation finish while shedding stalls faster.
  const REQUEST_DEADLINE = 9_000

  type ApiData = {
    content: { type: string; text?: string }[]
    stop_reason: string
    // input_tokens is the UNCACHED remainder only — the cached span is reported
    // separately. total prompt = input + cache_creation + cache_read.
    usage?: {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
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
        // a rejected key or an exhausted spend ceiling is permanent for the day — latch it
        // so the retry loop, the hedge, and every other AI path stop firing doomed requests.
        noteHardStop(res.status, errBody)
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
        // cache accounting, per dispatched request (hedge losers included — two
        // concurrent calls can't read each other's write, so a hedge shows as two
        // creations). read>0 = the system prompt hit; creation>0 = cold write.
        const u = parsed.data.usage
        const cw = u?.cache_creation_input_tokens ?? 0
        const cr = u?.cache_read_input_tokens ?? 0
        if (u) db.recordAiSpend(ctx.channel, u.input_tokens ?? 0, u.output_tokens ?? 0, cr, cw)
        if (cw || cr) log(`ai: cache read=${cr} write=${cw} uncached=${u?.input_tokens ?? 0}`)
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

  // the style backstop below is allowed exactly one call, ever — correctness retries must
  // never lose a budget slot to punctuation.
  let styleRetried = false
  try {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // deadline hit = upstream is slow/stuck. count it toward the circuit breaker
      // (a silently-uncounted slow failure would keep the breaker from tripping).
      // budget the per-attempt timeout to what's LEFT of the deadline so a late attempt
      // can't overrun it (previously only checked at attempt start → 7s attempts started
      // near the line ran to ~18s; now the whole request stays within REQUEST_DEADLINE).
      const remaining = REQUEST_DEADLINE - (Date.now() - start)
      if (remaining < MIN_ATTEMPT_BUDGET) { log('ai: request deadline exceeded'); cbRecordFailure(); return miss('deadline') }
      const model = CHAT_MODEL
      // sonnet 5 rejects non-default temperature; thinking off keeps chat replies snappy
      // (omitting it would run adaptive thinking by default). variety comes from the default
      // temp (1.0) + per-attempt prompt, not a sampling knob.
      const body = {
        model,
        max_tokens: effectiveMaxTokens,
        thinking: { type: 'disabled' as const },
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
      if (single.status !== 200 || !single.data) {
        cbRecordFailure()
        const reason = single.status === 429 ? 'rate_limited' : single.status === 503 ? 'upstream_unavailable' : single.status === 0 ? 'no_response' : 'api_error'
        return miss(reason)
      }
      const data: ApiData = single.data
      const latency = Date.now() - start

      const textBlock = data.content?.find((b) => b.type === 'text')
      if (!textBlock?.text) return miss('empty_response')

      // build known-user set for fake @mention stripping
      const knownUsers = new Set<string>()
      for (const entry of getRecent(ctx.channel, 30)) knownUsers.add(entry.user.toLowerCase())
      knownUsers.add(ctx.user.toLowerCase())
      // names the asker explicitly @'d in their request are real references — keep them
      for (const m of query.matchAll(/@(\w+)/g)) knownUsers.add(m[1].toLowerCase())

      // isRealUser falls back to the channel chat log for anyone outside the recent window
      const result = sanitize(textBlock.text, ctx.user, ctx.isMod, knownUsers, data.stop_reason === 'max_tokens', (n) => db.userHasChatted(n, ctx.channel), hasStats)
      // strip injection echo (model parroting user's injected instructions)
      result.text = stripInputEcho(result.text, query)
      // strip per-user signature emote repetition — but NOT for creative writing, where an
      // emote can be a recurring character/noun ("Crowge watched from the corner…") and
      // stripping it leaves grammatically broken fragments ("the watched from the corner").
      if (!isCreative) result.text = dedupeUserEmote(result.text, ctx.user, ctx.channel)
      // reject hallucinated game stats when no game data was provided. unambiguous
      // Bazaar stat claims (keyword/tier/+X/+Y) are rejected even in creative/banter —
      // a roleplay reply that invents "+60 haste at gold tier" is still misinformation.
      // an other-game query is allowed real numbers — the prompt promises "full nerd mode"
      // for other games; only Bazaar tooltip notation stays blocked. requires the query to
      // NAME another title (OTHER_GAME_RE): inferring other-game from entity-resolution
      // failure waived the stat guards for pure-Bazaar questions whose terms just are not
      // entities ("do relics trigger on drones").
      const isOtherGame = !hasGameData && OTHER_GAME_RE.test(query)
      if (!hasGameData && hasHallucinatedStats(result.text, isCreative, isOtherGame)) {
        log(`ai: hallucinated stats without game data, retrying (attempt ${attempt + 1})`)
        if (attempt < MAX_RETRIES - 1) {
          messages.push({ role: 'assistant', content: textBlock.text })
          messages.push({ role: 'user', content: 'You invented specific game numbers without data. Answer without citing specific damage/HP/percentage values.' })
          continue
        }
        log('ai: hallucinated stats retries exhausted — returning null for clean fallback')
        return miss('hallucination_blocked')
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
        return miss('fabricated_data_blocked')
      }
      // the inverse of the guard above: game data IS present, so every stat number in the
      // reply has a source of truth to be checked against. a number that appears nowhere in
      // the context was invented on top of real data, which is the most convincing kind of
      // wrong. exhausting the retries drops to the deterministic card formatter, which is
      // never wrong — a correct card beats a confident sentence.
      // same two exemptions the no-data stat guard above already makes, for the same reasons:
      // a copypasta invents numbers on purpose ("day 1,847 of watching kripp"), and a question
      // about another game gets real numbers from that game. replaying the guard over 679
      // logged game replies found both, and nothing else — without these it would have retried
      // a pasta and a pokémon answer, then dropped them.
      if (hasGameData && !isCreative && !OTHER_GAME_RE.test(query)) {
        const ungrounded = findUngroundedStats(result.text, userMessage)
        if (ungrounded.length > 0) {
          log(`ai: ungrounded stat ${ungrounded.join('/')} against injected data, retrying (attempt ${attempt + 1})`)
          if (attempt < MAX_RETRIES - 1) {
            messages.push({ role: 'assistant', content: textBlock.text })
            messages.push({ role: 'user', content: `You wrote ${ungrounded.join(' and ')}, which is not in the Game data section. Use only numbers that appear there, or drop the number and answer in words.` })
            continue
          }
          log('ai: ungrounded stat retries exhausted — returning null for clean fallback')
          return miss('ungrounded_stat_blocked')
        }
      }
      // the bot can see the live board whenever the overlay companion is feeding frames, and
      // chat treats it as another viewer. two failures to catch, both only possible when a
      // board actually reached the model: telling chat it's blind while holding the board,
      // and pinning a tier/enchant to a board card — the frames carry names and nothing else,
      // so a confident "his skirt is gold" is invention wearing the costume of observation.
      const seenBoard = extractBoardLine(userMessage)
      if (seenBoard) {
        if (deniesBoardSight(result.text)) {
          log(`ai: denied board sight while holding a live board, retrying (attempt ${attempt + 1})`)
          if (attempt < MAX_RETRIES - 1) {
            messages.push({ role: 'assistant', content: textBlock.text })
            messages.push({ role: 'user', content: 'You DO have the live board this time — the "Live board" section lists what is on it right now. Answer from it like any viewer watching the stream. Card names only; you still do not know tiers or enchantments.' })
            continue
          }
          return miss('board_sight_denial_blocked')
        }
        const tierClaims = findLiveTierClaims(result.text, seenBoard)
        if (tierClaims.length > 0 && !hasGameData) {
          log(`ai: tier claim on live board card ${tierClaims.join('/')}, retrying (attempt ${attempt + 1})`)
          if (attempt < MAX_RETRIES - 1) {
            messages.push({ role: 'assistant', content: textBlock.text })
            messages.push({ role: 'user', content: `You gave ${tierClaims.join(' and ')} a tier or enchantment. The board only reports card names — nobody told you the tier. Say it without one.` })
            continue
          }
          return miss('tier_claim_blocked')
        }
      }
      // punctuation-streak backstop. the SHAPE nudge in the context handles most of this for
      // free; this catches the times the model writes its fourth identical clause—clause in a
      // row anyway. style is not correctness: it costs ONE extra call and never rejects the
      // answer, because a repetitive true reply still beats no reply.
      if (!styleRetried && attempt < MAX_RETRIES - 1 && isDashClause(result.text)
        && monotonyStreak(getChannelRecentResponses(ctx.channel)) >= 2) {
        styleRetried = true
        log('ai: third clause—clause in a row, asking for a different shape')
        messages.push({ role: 'assistant', content: textBlock.text })
        messages.push({ role: 'user', content: 'Same content, different shape: your last few replies all used "<clause> — <clause>". Rewrite this one without an em-dash — a plain sentence, a fragment, or a question. Keep the voice.' })
        continue
      }
      // a weekday claim is checkable against the clock line in context, so never ship a
      // wrong one — correct it in place rather than spending a retry on it.
      const dayFix = correctClockClaim(result.text, userMessage)
      if (dayFix) {
        log(`ai: corrected a wrong weekday claim to ${dayFix.day}`)
        result.text = dayFix.text
      }
      // enforce length caps in code
      const isShort = isShortResponse(query)
      const hardCap = isCreative ? 400 : hasGameData ? 250 : isRememberReq ? 120 : isShort ? 60 : 150
      // repair a reply the model didn't finish. the max_tokens case is the one that used to
      // slip: a fragment landing UNDER the cap skipped every branch and shipped verbatim.
      const cutShort = data.stop_reason === 'max_tokens'
      const beforeRepair = result.text
      result.text = repairTruncation(result.text, hardCap, cutShort)
      // this repair is the one thing in the pipeline that DELETES words from a good reply
      // if it misfires, so every trim it makes is greppable. "trim:" tagged, only on change.
      if (result.text !== beforeRepair) {
        log(`trim: ${cutShort ? 'max_tokens' : 'over_cap'} ${beforeRepair.length}->${result.text.length} tail=${JSON.stringify(beforeRepair.slice(result.text.length).slice(0, 24))}`)
      }
      // repair can only trim, never invent — if a hard cut left a one-word stub there is
      // nothing to salvage, so spend a retry rather than ship "for".
      if (cutShort && isStub(result.text) && attempt < MAX_RETRIES - 1) {
        log(`ai: reply cut to a stub "${result.text}", retrying (attempt ${attempt + 1})`)
        messages.push({ role: 'assistant', content: textBlock.text })
        messages.push({ role: 'user', content: 'Your reply was cut off to a fragment. Say the whole thing in fewer words — one complete sentence that finishes its thought.' })
        continue
      }
      if (result.text) {
        // terse refusal detection. the soft "everyone is special" dodge only counts when the
        // user actually asked to rank/pick — otherwise it's warm banter we must not discard.
        const askedToRank = /\bwho'?s? (your|the) (favorite|favourite|best|top)\b|favorite (chatter|person|user|viewer)|\b(rank|pick|choose|name)\b.{0,20}\b(favorite|favourite|chatter|user|viewer|people|us)\b/i.test(query)
        if (isModelRefusal(result.text, askedToRank) && attempt < MAX_RETRIES - 1) {
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
          db.logAsk(ctx, loggedQuery, result.text, inT + outT, latency, contextSummary)
          // recordAiSpend is called in fetchOnce at the 200-parse point so every
          // dispatched request (retries + hedge loser) is counted; not here.
        } catch {}
        // hot cache for instant follow-up context
        cacheExchange(ctx.user, loggedQuery, result.text, ctx.channel)
        // fire-and-forget memo + fact extraction (force both on identity requests)
        maybeExtractFacts(ctx.user, loggedQuery, result.text, isRememberReq).catch(() => {})
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
        // name WHY when we can. the generic hint left the model guessing, so the two
        // failures that keep recurring (dunking on repeat askers, dodging on scope)
        // often came back a second time in a slightly different wording.
        const hint = data.stop_reason === 'max_tokens' && textBlock.text.length < 40
          ? 'Your reply was cut off to a fragment. Answer in ONE short complete sentence, nothing else.'
          : ASK_COUNT_LEAK.test(textBlock.text)
          ? 'Blocked: you counted their asks or history back at them. A gap in what you know is YOUR gap, never their fault for asking again. Answer the question with no reference to how many times they have asked or how long they have been here.'
          : SCOPE_DODGE.test(textBlock.text)
            ? 'Blocked: you dodged on scope. You answer anything chat asks, other games included, in full detail. Drop the "wrong lobby"/"im just a bazaar bot" framing and actually answer.'
            : SOURCE_LIE.test(textBlock.text)
              ? 'Blocked: you denied a source you actually read. You DO read r/PlayTheBazaar for community buzz. Own it. If no buzz was provided in context, say you have nothing from the sub today — never that you do not read it.'
              : SCHEDULE_DENIAL.test(textBlock.text)
                ? 'Blocked: you denied tracking stream schedules. You DO track this channel\'s stream schedule and can predict the next stream. If a "Stream schedule" line is in your context, relay it; if not, tell them to ask "when is the next stream" — never deny the capability.'
                : 'Response was blocked. Rules: no self-referencing being a bot/AI, no reciting user stats, no fabricated stories, no commands. Just answer naturally.'
        log(`ai: sanitizer rejected, retrying (attempt ${attempt + 1})`)
        messages.push({ role: 'assistant', content: textBlock.text })
        messages.push({ role: 'user', content: hint })
      }
    }

    // loop exhausted every attempt without a return above — every other exit (429/503,
    // deadline, content guards) already returns its own reason, so reaching here means the
    // sanitizer rejected the reply again on the final attempt with no retry left to spend.
    return miss('sanitizer_blocked')
  } catch (e: unknown) {
    const err = e as Error
    const isTimeout = err.name === 'AbortError'
    if (isTimeout) log('ai: timeout')
    else log(`ai: error: ${err.message}`)
    cbRecordFailure()
    return miss(isTimeout ? 'timeout' : 'error')
  }
}
