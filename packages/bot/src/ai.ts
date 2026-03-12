import * as db from './db'
import { getRecent } from './chatbuf'
import { refreshVoice } from './style'
import { log } from './log'

// --- re-exports (preserve public API) ---

export { sanitize, isModelRefusal, stripInputEcho, fixEmoteCase, dedupeEmote, dedupeUserEmote, dedupeMention } from './ai-sanitize'
export { cacheExchange, getChannelRecentResponses, getHotExchanges, getAiCooldown, getGlobalAiCooldown, recordUsage, setChannelLive, setChannelOffline, isChannelLive, getLiveChannels, getChannelGame, setChannelGame, setChannelInfos, cbRecordSuccess, cbRecordFailure, cbIsOpen, AI_VIP, AI_CHANNELS, AI_MAX_QUEUE, getRecentEmotes } from './ai-cache'
export { buildSystemPrompt, invalidatePromptCache, buildFTSQuery, buildFTSQueryLoose, GREETINGS, isLowValue, isShortResponse, STOP_WORDS, REMEMBER_RE, extractEntities, buildUserMessage, buildGameContext, buildUserContext, buildTimeline, buildRecallContext, buildChatRecall, buildChattersContext, isNoise, parseChatTimeWindow, isAboutOtherUser } from './ai-context'
export { initSummarizer, initLearner, maybeFetchTwitchInfo, maybeUpdateMemo, maybeExtractFacts } from './ai-background'

// --- local imports from sub-modules ---

import { sanitize, stripInputEcho, dedupeUserEmote, isModelRefusal } from './ai-sanitize'
import { getAiCooldown, getGlobalAiCooldown, recordUsage, cbIsOpen, cbRecordSuccess, cbRecordFailure, AI_VIP, AI_CHANNELS, AI_MAX_QUEUE, cacheExchange, aiLock, aiQueueDepth, setAiLock, incrementQueue, decrementQueue } from './ai-cache'
import { buildSystemPrompt, buildUserMessage, isLowValue, isShortResponse, GAME_TERMS } from './ai-context'
import { maybeExtractFacts, maybeUpdateMemo } from './ai-background'

// --- constants ---

const API_KEY = process.env.ANTHROPIC_API_KEY
const CHAT_MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS_GAME = 100
const MAX_TOKENS_CHAT = 80
const MAX_TOKENS_PASTA = 200
const TIMEOUT = 15_000
const MAX_RETRIES = 3

// --- hallucination detection ---

const STAT_PATTERN = /\b(\d{2,})\s*(damage|poison|burn|shield|heal|hp|health|crit|gold|regen|haste|freeze|slow)\b|\b(deals?|gains?|grants?|gives?|adds?|stacks?|does)\s+\+?\d{2,}\b|\+\d+%?\s*(damage|crit|shield|hp|heal|poison|burn)\b/i

function hasHallucinatedStats(text: string): boolean {
  return STAT_PATTERN.test(text)
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

  const cd = getAiCooldown(ctx.user, ctx.channel)
  if (cd > 0) return null
  if (!ctx.direct && !isGame && !isVip && getGlobalAiCooldown(ctx.channel) > 0) return null

  if (aiQueueDepth >= AI_MAX_QUEUE && !isVip) {
    log('ai: queue full, dropping')
    return null
  }
  incrementQueue()

  let release!: () => void
  const prev = aiLock
  setAiLock(new Promise((r) => release = r))
  await prev

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
  const maxTokens = isCreative ? MAX_TOKENS_PASTA : hasGameData ? MAX_TOKENS_GAME : MAX_TOKENS_CHAT

  const messages: unknown[] = [{ role: 'user', content: userMessage }]
  const start = Date.now()

  try {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const model = CHAT_MODEL
      const baseTemp = isCreative ? 0.95 : hasGameData ? 0.5 : 0.75
      const body = {
        model,
        max_tokens: maxTokens,
        temperature: Math.min(1.0, baseTemp + attempt * 0.1),
        system: [{ type: 'text' as const, text: systemPrompt, cache_control: { type: 'ephemeral' as const } }],
        messages,
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT)

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer))

      if (!res.ok) {
        if (res.status === 429 && attempt < MAX_RETRIES - 1) {
          const delay = 3_000 * (attempt + 1)
          log(`ai: 429, retrying in ${delay / 1000}s (attempt ${attempt + 1})`)
          await new Promise((r) => setTimeout(r, delay))
          continue
        }
        log(`ai: API ${res.status} ${await res.text().catch(() => '')}`)
        cbRecordFailure()
        return null
      }

      const data = await res.json() as {
        content: { type: string; text?: string }[]
        stop_reason: string
        usage?: { input_tokens: number; output_tokens: number }
      }
      const latency = Date.now() - start

      const textBlock = data.content?.find((b) => b.type === 'text')
      if (!textBlock?.text) return null

      // build known-user set for fake @mention stripping
      const knownUsers = new Set<string>()
      for (const entry of getRecent(ctx.channel, 30)) knownUsers.add(entry.user.toLowerCase())
      knownUsers.add(ctx.user.toLowerCase())

      const result = sanitize(textBlock.text, ctx.user, ctx.isMod, knownUsers)
      // strip injection echo (model parroting user's injected instructions)
      result.text = stripInputEcho(result.text, query)
      // strip per-user signature emote repetition
      result.text = dedupeUserEmote(result.text, ctx.user, ctx.channel)
      // reject hallucinated game stats when no game data was provided (creative gets a pass)
      if (!hasGameData && !isCreative && hasHallucinatedStats(result.text)) {
        log(`ai: hallucinated stats without game data, retrying (attempt ${attempt + 1})`)
        if (attempt < MAX_RETRIES - 1) {
          messages.push({ role: 'assistant', content: data.content })
          messages.push({ role: 'user', content: 'You invented specific game numbers without data. Answer without citing specific damage/HP/percentage values.' })
          continue
        }
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
          } else {
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
      if (result.text) {
        // terse refusal detection
        if (isModelRefusal(result.text) && attempt < MAX_RETRIES - 1) {
          log(`ai: terse refusal "${result.text}", retrying (attempt ${attempt + 1})`)
          messages.push({ role: 'assistant', content: data.content })
          messages.push({ role: 'user', content: 'Answer the question directly. Be brief, be opinionated. No refusals.' })
          continue
        }
        cbRecordSuccess()
        try {
          const tokens = (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0)
          db.logAsk(ctx, query, result.text, tokens, latency)
        } catch {}
        log(`ai: responded in ${latency}ms`)
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

      // sanitizer rejected — retry with feedback
      if (attempt < MAX_RETRIES - 1) {
        log(`ai: sanitizer rejected, retrying (attempt ${attempt + 1})`)
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
