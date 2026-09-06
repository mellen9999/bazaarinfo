// shared reply helpers used by every commands-*.ts module — AI call wrapper, message
// truncation, no-match/busy quips, and hit/miss logging. a pure leaf: never imports a
// runtime value from commands.ts or any other commands-*.ts file.
import * as db from './db'
import type { CmdType } from './db'
import type { CommandContext } from './commands'
import { isSuppressed, suppressNotice } from './suppress'
import { aiRespond, dedupeEmote, dedupeMention, fixEmoteCase, fixEmotePunctuation, capEmoteTotal, capRepeatedSpam } from './ai'
import { log } from './log'
import { OVERLAY, isOverlayFresh, getCardChange } from './patch-notes'

const MAX_LEN = 480

// the dump carries current stats but never deltas, and on patch day it hasn't even
// absorbed the new numbers — so a changed card gets its patch line appended. exact-title
// match only, and it goes quiet once the overlay ages out.
export function patchNote(title: string): string | undefined {
  if (!isOverlayFresh()) return undefined
  const change = getCardChange(title)
  return change ? `${OVERLAY.version}: ${change.text}` : undefined
}

const NO_MATCH_LINES = [
  (q: string) => `"${q}" isn't a thing... yet. petition to add it tho`,
  (q: string) => `searched the entire bazaar for "${q}", found only dust`,
  (q: string) => `"${q}"? the bazaar keeper squints and shakes his head`,
  (q: string) => `legend says "${q}" was removed in the great patch of '25`,
  (q: string) => `"${q}" sounds made up but honestly so does half this game`,
  (q: string) => `i asked every merchant about "${q}". they laughed at me`,
  (q: string) => `"${q}" not found. have you tried turning the bazaar off and on`,
  (q: string) => `the ancient scrolls contain no record of "${q}"`,
]
let noMatchIdx = 0
// "roast a random chatter", "cook someone (not me)" — the asker volunteers a BYSTANDER.
// Whoever gets picked never opted in, and the bot went at them three times in one stream,
// twice using their own logged asks as the punchline. Named targets are left alone: naming
// someone is a chat-culture opt-in and this bot stays open. Only the unnamed pick is
// redirected, and redirected rather than refused — chat asked for a roast, so they get a
// real one, aimed at the person who actually asked for it.
const BYSTANDER_ROAST_RE = /\b(roast|cook|flame|destroy|dunk on|insult|make fun of|clown on|drag)\b[^.?!]{0,20}\b(random|some(?:one|body)|any(?:one|body)|a chatter|another chatter|other chatters?|a viewer|a user|chat)\b/i
export function steerBystanderRoast(query: string): string {
  if (!BYSTANDER_ROAST_RE.test(query)) return query
  return `${query} [ROAST TARGET: do NOT pick an uninvolved chatter — they never opted in. Turn it on the ASKER instead (they asked for it) or on yourself/the meta, and actually land it. Never use anyone's logged history or ask-count as the punchline.]`
}

// an item lookup is a NAME — a few words, no question, no ask for an opinion. only those
// deserve the "searched the bazaar, found only dust" miss line; anything else that reaches
// the AI fallback is conversation, where that quip is the banned no-bazaar-data dodge.
const CONVERSATIONAL_RE = /\?|\b(who|what|when|where|why|how|which|is|are|do|does|did|can|could|should|would|will|thoughts|opinion|think|explain|tell|say|make|write|help)\b/i
export function looksLikeItemQuery(query: string): boolean {
  const words = query.trim().split(/\s+/).filter(Boolean)
  return words.length > 0 && words.length <= 4 && !CONVERSATIONAL_RE.test(query)
}

export function noMatchMsg(query: string): string {
  const q = query.slice(0, 30)
  const msg = NO_MATCH_LINES[noMatchIdx % NO_MATCH_LINES.length](q)
  noMatchIdx++
  return msg
}

// transient-AI-miss fallback for creative/conversational asks — keeps the "answer
// every !b" contract when the model times out or exhausts retries. these stay HONEST
// (it's upstream latency, not the bot "glitching") and DON'T beg an instant retry — an
// "ask again now" line during a slowdown just amplifies the load that caused the miss.
const AI_BUSY_LINES = [
  'ai servers are lagging rn, give it a few seconds',
  'upstream hiccup on that one, try again in a bit',
  'brain server is crawling right now, one sec',
  'merchant fumbled the scroll — slow servers, ask again shortly',
]
let aiBusyIdx = 0
export function aiBusyLine(): string {
  return AI_BUSY_LINES[aiBusyIdx++ % AI_BUSY_LINES.length]
}

// AI off for a PERMANENT reason, as opposed to the transient misses above. Never claims an
// outage and never asks for a retry that cannot work — it just says the true thing and
// names what still answers, so chat doesn't read the bot as dead.
export const AI_OFF_LINE = 'ai is off in this channel — item lookups and trivia still work'

/** shared AI call + post-processing (dedup emotes/mentions, append missing @mentions) */
export async function tryAiRespond(query: string, ctx: CommandContext, mentions: string[] = [], displayQuery?: string): Promise<string | null> {
  // mod pause on AI answers — one throttled honest line, then silence. single gate
  // covers every AI answer path (bare !b, threads, conversational, lookup fallback).
  if (ctx.channel && isSuppressed(ctx.channel, 'ai')) return suppressNotice(ctx.channel)
  let result: Awaited<ReturnType<typeof aiRespond>> = null
  try { result = await aiRespond(query, { ...ctx, direct: true, displayQuery }) } catch (e) { log(`ai: call failed: ${e}`) }
  if (!result?.text) return null
  // creative writing may use an emote as a recurring character/noun — skip channel-recent
  // emote dedup there so we don't gut the prose ("Crowge watched" → "the watched"). the
  // 5-emote total cap (capEmoteTotal) still applies to CACHED channel emotes; uncached
  // emote-shaped tokens are separately clipped to 5 copies by capRepeatedSpam — the two
  // budgets are independent by design (an uncached token isn't provably an emote).
  const isCreativeQ = /\b(continue|extend|expand|write|make|create|story|pasta|copypasta|poem|rant|monologue|lore|saga|fanfic|narrative|haiku|sonnet|ballad|rap|song|roast|joke|bit|scene)\b/i.test(query)
  const deduped = isCreativeQ ? result.text : dedupeEmote(result.text, ctx.channel)
  let response = dedupeMention(capRepeatedSpam(capEmoteTotal(fixEmotePunctuation(fixEmoteCase(deduped, ctx.channel), ctx.channel), ctx.channel)), ctx.channel, ctx.user)
  if (mentions.length > 0) {
    const lower = response.toLowerCase()
    const missing = mentions.map((m) => m.toLowerCase()).filter((m) => !lower.includes(m))
    if (missing.length > 0) response = withSuffix(response, ` ${missing.join(' ')}`)
  }
  return response
}

export function withSuffix(text: string, suffix: string): string {
  const combined = text + suffix
  // measure by code points — fancy-font glyphs are surrogate pairs (2 utf-16 units
  // but 1 twitch char), so .length would over-count and truncate them at half length.
  if ([...combined].length <= MAX_LEN) return combined
  // trim text to make room for suffix
  const budget = MAX_LEN - [...suffix].length
  if (budget <= 0) return [...text].slice(0, MAX_LEN).join('')
  const cut = [...text].slice(0, budget).join('')
  const lastBreak = Math.max(cut.lastIndexOf(' | '), cut.lastIndexOf(' '))
  const trimmed = lastBreak > budget * 0.5 ? cut.slice(0, lastBreak) + '...' : [...cut].slice(0, budget - 3).join('') + '...'
  return trimmed + suffix
}

export function logMiss(query: string, ctx: CommandContext) {
  try { db.logCommand(ctx, 'miss', query) } catch {}
}

export function logHit(type: CmdType, query: string, match: string, ctx: CommandContext, tier?: string) {
  try { db.logCommand(ctx, type, query, match, tier) } catch {}
}

// --- !b AI fallback cooldown: per-user ---
// disabled — kripp chat needs every query answered; irc rate-limit + ai concurrency cap it naturally
export const B_FALLBACK_CD = 0
export const bFallbackCooldowns = new Map<string, number>()

export function getBFallbackCooldown(user?: string): number {
  if (!user) return 0
  const last = bFallbackCooldowns.get(user.toLowerCase())
  if (!last) return 0
  const elapsed = Date.now() - last
  return elapsed >= B_FALLBACK_CD ? 0 : Math.ceil((B_FALLBACK_CD - elapsed) / 1000)
}

// structured subcommand miss → always answer: AI if available, else quippy noMatch line
export async function aiOrQuip(query: string, ctx: CommandContext, suffix: string): Promise<string | null> {
  if (getBFallbackCooldown(ctx.user) === 0) {
    const response = await tryAiRespond(query, ctx)
    if (response) {
      if (ctx.user) bFallbackCooldowns.set(ctx.user.toLowerCase(), Date.now())
      try { db.logCommand(ctx, 'ai', query, 'fallback') } catch {}
      return response
    }
  }
  // mod ai-pause: the notice/silence, never a quip that pretends it was a lookup miss
  if (ctx.channel && isSuppressed(ctx.channel, 'ai')) return suppressNotice(ctx.channel)
  return withSuffix(noMatchMsg(query), suffix)
}
