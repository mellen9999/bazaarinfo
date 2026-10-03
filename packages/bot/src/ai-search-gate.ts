import { isLowValue, isShortResponse, OTHER_GAME_RE } from './ai-query'
import type { UserMessageResult } from './ai-build'

// the bot's one way to CHECK a fact instead of stating memory: anthropic's server-side web
// search, offered to the chat model on asks that are knowledge-shaped and have no data
// section behind them. two gates — this file decides whether to OFFER the tool; the model
// decides whether to USE it (SEARCH_HINT). live 2026-09-07 without it: a deadlock hero's
// ult given a stun it doesn't have, blizzcon 2026 "has no date", an oasis b-side on the
// wrong album — all confident, all from memory.
//
// cost shape: a search bills ~$0.01 plus a few k input tokens of results, so a searched ask
// is ~10x a plain one. the deterministic gate keeps banter/opinion/kripp asks (most of chat)
// off the tool entirely, a per-day cap bounds the worst day, and an in-flight cap keeps a
// 45s tool turn from parking the AI slots.

export const WEB_SEARCH_DAILY_CAP = Math.max(0, Number(process.env.WEB_SEARCH_DAILY_CAP ?? 25) || 0)
export const MAX_INFLIGHT_SEARCHES = 2
// searches round-trip the web via code execution; 30s timed out live (ai-trivia.ts), 45s holds.
export const SEARCH_TIMEOUT = 45_000
// a tool turn spends output tokens on the query too; the reply itself is still hard-capped.
export const SEARCH_MAX_TOKENS = 220
export const WEB_SEARCH_TOOL = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 1 }]

// positive rule only. the old hint listed what NOT to search ("never for opinions, banter,
// chat...") and the model narrated its choice back to chat — "no need to search, this is
// just banter", 11 times in three weeks. the gate below keeps those asks off the tool in
// code, so the list is gone rather than reworded; SEARCH_TALK backstops the rest.
export const SEARCH_HINT =
  'WEB SEARCH: you can search once, for a verifiable real-world or other-game fact you are not certain of (dates, events, patch/ability details, stats, names). Answer in your own words, one line, no urls or site names; you may say you looked it up. Never comment on whether you searched.'

// the model talking about its own search decision ("no need to search", "doesn't need a
// search", "a second search", "web search fixes"). only checked when the tool was offered
// on that ask, so "use the search bar on bazaardb" in an ordinary answer is never touched.
export const SEARCH_TALK = /\b(?:no|not|didn'?t|did not|doesn'?t|does not|don'?t|do not|without)\s+(?:(?:need(?:s|ed)?|require[sd]?)\s+(?:to\s+|a\s+|any\s+|another\s+)?)?(?:(?:force|run|do)\s+(?:a\s+)?)?(?:second\s+|web\s+)?search(?:es|ing)?\b|\bsearch(?:es)?\s+(?:needed|required|necessary|fixes|won'?t)\b|\b(?:second|another|extra)\s+search\b|\bweb\s+search\b/i

// last-attempt fallback: drop the clause that talks about searching and keep the answer.
// returns '' when nothing worth sending is left (the caller treats that as a miss).
export function stripSearchTalk(text: string): string {
  // split keeping the separators (odd indexes) so the surviving clauses keep their punctuation
  const parts = text.split(/((?<=[.!?])\s+|\s+[-—–]\s+|;\s+|,\s+(?=(?:this|that|it|just|so|but)\b))/i)
  let out = ''
  for (let i = 0; i < parts.length; i += 2) {
    if (SEARCH_TALK.test(parts[i])) continue
    out += parts[i] + (parts[i + 1] ?? '')
  }
  const kept = out.trim().replace(/[,;—–-]+$/, '').trim()
  return kept.length >= 15 ? kept : ''
}
// the search attempt died (timeout, pause, upstream): the plain retry must not quietly
// answer from memory — that is the exact failure the tool exists to fix.
export const SEARCH_FAILED_HINT = 'Your search did not complete. Answer only what you are certain of, or say you could not verify it.'

// a question: leading interrogative or auxiliary, a question mark, or "tell me about".
export const QUESTION_RE = /^\s*(?:who|whats?|who'?s|when|where|why|how|which|is|are|does|do|did|can|will|should|would|was|were)\b|\?|\b(?:tell me about|explain)\b/i
// "what 9+10" — a question, not a fact to look up.
export const ARITHMETIC_RE = /^\s*(?:what'?s?|whats)?\s*[\d\s+\-*/x×÷().^%]+\??\s*$/i
// subjects the web knows nothing about: this chat, the streamer, the bot's own systems.
// first/second-person words are deliberately NOT here — "which hero would you recommend in
// deadlock" is the motivating case, and "you" is in it.
export const NOT_SEARCHABLE_RE = /\b(chat|kripp\w*|krip|mellen|streams?|board|build|shirt|schedule|trivia|leaderboard|points|miss(?:ed)?|memos?)\b/i
// asking the bot for a take ("what's your favorite song", "how would you rate X"): no fact
// to look up. only applied when no other game is named — "which hero would you recommend
// in deadlock" is the case the tool exists for.
export const OPINION_RE = /\b(?:your|you)\b[^?]{0,40}\b(?:favou?rite|opinion|rate|rating|prefer|think of)\b|\bwould you\b|\bdo you (?:think|like|prefer)\b|\bhow would you rate\b/i
// a context section that already grounds the answer — the tool would only compete with it.
// ambient sections (the live board, the on-stream game's dossier) are NOT here: they ride
// along on every ask during a stream and say nothing about a real-world fact.
export const GROUNDING_SECTIONS: ReadonlySet<string> = new Set([
  'weather', 'shirt', 'schedule', 'worldCup', 'hs', 'hsCards', 'hsBoard', 'guildrun', 'grNews',
  'patch', 'patchNotes', 'triviaRef', 'triviaStandings', 'self', 'gameBlock',
])
// when the ask NAMES another game, only data about that game (or the bot) grounds it. the
// bazaar block and the streamer sections still fire on incidental words — "cham rune" hit a
// bazaar item, "when does the poe2 league start" hit the stream schedule — and would close
// the gate on exactly the asks it exists for.
const OTHER_GAME_GROUNDING: ReadonlySet<string> = new Set([
  'hs', 'hsCards', 'hsBoard', 'guildrun', 'grNews', 'triviaRef', 'triviaStandings', 'self',
])
// "the story behind the song" / "the history of X" reads as creative to the pasta detector,
// but it is a fact ask about a real thing — the oasis b-side fabrication was one of these.
const KNOWLEDGE_STORY_RE = /\b(story|history|origin|meaning|lore)\s+(behind|of)\b/i

type Build = Pick<UserMessageResult, 'hasGameData' | 'isPasta' | 'isCreative' | 'isContinuation' | 'isRememberReq' | 'contextSections'>

/**
 * Should this ask be offered the web search tool? Pure: capacity is passed in.
 * A named other game bypasses the subject exclusion — it is the clearest search case.
 */
export function searchEligible(query: string, build: Build, inFlight: number, searchesToday: number): boolean {
  if (WEB_SEARCH_DAILY_CAP === 0) return false
  if (searchesToday >= WEB_SEARCH_DAILY_CAP || inFlight >= MAX_INFLIGHT_SEARCHES) return false
  if (build.isPasta || build.isContinuation || build.isRememberReq) return false
  if (build.isCreative && !KNOWLEDGE_STORY_RE.test(query)) return false
  if (isLowValue(query) || isShortResponse(query)) return false
  if (!QUESTION_RE.test(query) || ARITHMETIC_RE.test(query)) return false
  // "why?" / "so 2.5D?" — a reaction, not a fact ask. three words is the floor ("what is aion2?")
  if (query.trim().split(/\s+/).length < 3) return false
  const otherGame = OTHER_GAME_RE.test(query)
  if (!otherGame && OPINION_RE.test(query)) return false
  if (build.hasGameData && !otherGame) return false
  const grounding = otherGame ? OTHER_GAME_GROUNDING : GROUNDING_SECTIONS
  if (build.contextSections.some((s) => grounding.has(s.name))) return false
  if (NOT_SEARCHABLE_RE.test(query) && !otherGame) return false
  return true
}

/**
 * The reply text of a response. A tool turn interleaves preamble text ("let me check"),
 * the server tool call and its result, then the answer — only text AFTER the last tool
 * block is the answer. A plain turn is just its text block(s). '' when nothing usable
 * (a pause_turn mid-search).
 */
export function finalText(content: { type: string; text?: string }[] | undefined): string {
  if (!content?.length) return ''
  let lastTool = -1
  content.forEach((b, i) => {
    if (b.type === 'server_tool_use' || b.type === 'web_search_tool_result') lastTool = i
  })
  return content
    .slice(lastTool + 1)
    .filter((b) => b.type === 'text' && b.text?.trim())
    .map((b) => b.text!.trim())
    .join(' ')
}
