// plain english -> control.ts Action. matchControlIntent is the free, deterministic
// layer (chat and the panel's command bar both use it); parseControlIntent adds the
// AI fallback (mod-only vocabulary, same classify call ai-directive already spends) for
// phrasing the regexes miss. this module never posts or mutates state itself — it only
// produces an Action for the caller to hand to control.ts's act().
import type { Action } from './control'
import {
  SUPPRESS_RE, SUPPRESS_ALL_RE, RESUME_RE, TRIVIA_BAN_RE, TRIVIA_UNBAN_RE,
  featureOf, parseSuppressMinutes, stripArticles, MOD_CONTROL_HINT,
} from './commands-mod'
import { parseDirective } from './ai-directive'
import { listDirectives } from './directives'
import { LOGIN_RE } from './ignore'
import type { Pace } from './raid/state'

// a question never toggles state ("is trivia paused", "why'd you stop") — same word list
// commands.ts uses ahead of the reused suppress/resume/ban regexes. "can/could/would" stay
// out on purpose: those are polite commands, not questions.
const QUESTION_RE = /^(?:when|what|why|how|where|who|is|are|was|were|does|do|did)\b/i

// verb/filler captures the ban/unban regex can swallow ("stop making trivia about me" must
// not ban "making") — same guard commands.ts applies inline before banning.
const BAN_FILLER_RE = /^(?:making|doing|playing|running|giving|more|any|some|these|those|the|this|that|it)$/i

const VIBE_DROP_RE = /^(?:drop|remove|kill|delete|undo|ditch)\s+(?:the\s+)?vibe\s*#?(\d{1,2})\b/i
const VIBE_DROP_ORD_RE = /^(?:drop|remove|kill|delete|undo|ditch)\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\s+vibe\b/i
const VIBE_CLEAR_RE = /^(?:clear|drop|remove|kill)\s+all(?:\s+the)?\s+vibes\b/i
const QUEUE_CLEAR_RE = /^(?:clear|empty|wipe|flush)\s+(?:the\s+)?(?:trivia\s+)?queue\b/i
const DEPTHS_RESET_RE = /^reset\s+the\s+(?:depths|dungeon)\b/i
const TRIVIA_SKIP_RE = /^skip\s+(?:the\s+|this\s+)?(?:question|round|trivia|quiz|one|it)\b/i
const TRIVIA_START_RE = /^(?:start|begin|launch|run)\s+(?:a\s+|another\s+|the\s+)?(?:new\s+)?(?:trivia|quiz)(?:\s+(?:round|question|game))?(?:\s+(?:about|on|for|regarding|covering)\s+([\s\S]+))?$/i
const AI_TOGGLE_QUALIFIER_RE = /\b(?:for (?:this )?channel|channel[- ]wide|completely|entirely|permanently|for good)\b/i
const SAY_RE = /^say\s+(.+)$/i

// a bare pronoun/determiner is never a real target ("ignore that", "ignore him lol",
// "don't answer me anymore") — same exclusion list DIRECTIVE_INTENT's mute prefilter
// uses in commands-mod.ts, kept in sync by hand (small, stable list).
// "to"/"for" included too — the optional "(?:\s+to)?" in IGNORE_RE can backtrack to NOT
// consuming "to", which would otherwise let it fall into the capture group itself
// ("don't respond to me" -> backtracks past "me" (excluded) and grabs "to" as the user).
const NOT_A_USER = '(?!(?:that|this|these|those|the|a|an|him|her|them|it|me|us|you|my|your|his|chat|everyone|anyone|everybody|somebody|someone|everything|all|stuff|to|for)\\b)'
const IGNORE_RE = new RegExp(`^(?:ignore|stop\\s+(?:responding|replying|answering|talking)(?:\\s+to)?|do\\s?n'?t\\s+(?:respond|reply|answer|talk)(?:\\s+to)?)\\s+@?${NOT_A_USER}([a-z0-9_]{2,25})\\b`, 'i')
const UNIGNORE_RE = new RegExp([
  `^unignore\\s+@?${NOT_A_USER}([a-z0-9_]{2,25})\\b`,
  `^stop\\s+ignoring\\s+@?${NOT_A_USER}([a-z0-9_]{2,25})\\b`,
  `^(?:you\\s+can\\s+)?talk\\s+to\\s+@?${NOT_A_USER}([a-z0-9_]{2,25})\\s+again\\b`,
].join('|'), 'i')

function matchVibeDrop(t: string): Action | null {
  const m = t.match(VIBE_DROP_RE) ?? t.match(VIBE_DROP_ORD_RE)
  if (!m) return null
  const index = parseInt(m[1], 10)
  return index >= 1 && index <= 20 ? { kind: 'vibe-drop', index } : null
}

function matchTriviaStart(t: string): Action | null {
  const m = t.match(TRIVIA_START_RE)
  if (!m) return null
  const topic = m[1]?.trim().slice(0, 60)
  return topic ? { kind: 'trivia-start', topic } : { kind: 'trivia-start' }
}

// "turn the raid off" / "enable the raid game" / "stop the raid" / "start the raid" — no
// bare "resume the raid" here on purpose: RESUME_RE's "resume" is a single unanchored
// word (matches anywhere) and runs first, so it must keep meaning "resume a mod pause"
// for byte-identical behavior, never a raid-specific reinterpretation.
function matchRaidToggle(t: string): Action | null {
  if (/^(?:turn|switch)\s+(?:the\s+)?raid(?:\s+game)?\s+on\b/i.test(t)
    || /^enable\s+(?:the\s+)?raid(?:\s+game)?\b/i.test(t)
    || /^start\s+the\s+raid(?:\s+game)?\b/i.test(t)) return { kind: 'raid', on: true }
  if (/^(?:turn|switch)\s+(?:the\s+)?raid(?:\s+game)?\s+off\b/i.test(t)
    || /^disable\s+(?:the\s+)?raid(?:\s+game)?\b/i.test(t)
    || /^(?:stop|end)\s+the\s+raid(?:\s+game)?\b/i.test(t)) return { kind: 'raid', on: false }
  return null
}

// "slow the raid down" / "speed up the raid" / "raid pace fast" — a separate vocabulary
// from the on/off toggle above (pace words vs on/off words never overlap).
function matchRaidPace(t: string): Action | null {
  const pace = t.match(/^(?:set\s+)?raid\s+pace\s+(?:to\s+)?(fast|normal|slow)\b/i)
  if (pace) return { kind: 'raid-pace', pace: pace[1].toLowerCase() as Pace }
  if (/^(?:speed up|hurry up)\s+(?:the\s+)?raid\b/i.test(t) || /^(?:make\s+)?(?:the\s+)?raid\s+faster\b/i.test(t))
    return { kind: 'raid-pace', pace: 'fast' }
  if (/^slow(?:\s+down)?\s+(?:the\s+)?raid(?:\s+down)?\b/i.test(t) || /^(?:make\s+)?(?:the\s+)?raid\s+slower\b/i.test(t))
    return { kind: 'raid-pace', pace: 'slow' }
  if (/^(?:make\s+)?(?:the\s+)?raid\s+normal(?:\s+pace)?\b/i.test(t)) return { kind: 'raid-pace', pace: 'normal' }
  return null
}

// the channel-level ai on/off switch (ai-cache's AI_CHANNELS — "until restart") is a
// different, bigger lever than SUPPRESS_RE's temporary "ai" feature pause, and their
// bare verbs collide ("turn ai off" already means the temp pause and must keep meaning
// that — byte-identical). requiring an explicit qualifier keeps the two unambiguous
// instead of racing the tuned suppress regex for the same words.
function matchAiToggle(t: string): Action | null {
  if (!AI_TOGGLE_QUALIFIER_RE.test(t)) return null
  if (/^(?:turn|switch)\s+(?:the\s+)?ai\s+on\b/i.test(t) || /^enable\s+ai\b/i.test(t)) return { kind: 'ai', on: true }
  if (/^(?:turn|switch)\s+(?:the\s+)?ai\s+off\b/i.test(t) || /^disable\s+ai\b/i.test(t)) return { kind: 'ai', on: false }
  return null
}

// ignore durations run much longer than a mod pause (up to 30 days vs suppress's 180
// minutes) — parseSuppressMinutes has no day/week unit, so this is its own small parser
// rather than stretching a tuned function meant for a different scale.
function parseIgnoreMinutes(t: string): number | undefined {
  const m = t.match(/\bfor\s+(a\s+day|a\s+week|half an hour|an? hour|a bit|a while|a min(?:ute)?|(\d+)\s*(m|min(?:ute)?s?|h|hrs?|hours?|d|days?|w|weeks?))\b/i)
  if (!m) return undefined
  if (m[2]) {
    const n = parseInt(m[2], 10)
    const unit = m[3].toLowerCase()
    if (unit.startsWith('h')) return n * 60
    if (unit.startsWith('d')) return n * 60 * 24
    if (unit.startsWith('w')) return n * 60 * 24 * 7
    return n
  }
  const w = m[1].toLowerCase()
  if (w === 'a bit') return 15
  if (w === 'a while') return 45
  if (w.startsWith('a min')) return 5
  if (w === 'half an hour') return 30
  if (w === 'a day') return 60 * 24
  if (w === 'a week') return 60 * 24 * 7
  return 60 // "an hour"
}

// "ignore @x" / "stop responding to x" / "don't answer x anymore" — mods only in
// practice (see commands.ts wiring); a viewer's identical phrasing still plants the
// existing chat mute-directive instead, unchanged.
function matchIgnore(t: string): Action | null {
  const m = t.match(IGNORE_RE)
  if (!m) return null
  const user = m[1].toLowerCase()
  return LOGIN_RE.test(user) ? { kind: 'ignore', user, minutes: parseIgnoreMinutes(t) } : null
}

function matchUnignore(t: string): Action | null {
  const m = t.match(UNIGNORE_RE)
  if (!m) return null
  const user = (m[1] ?? m[2] ?? m[3])?.toLowerCase()
  return user && LOGIN_RE.test(user) ? { kind: 'unignore', user } : null
}

// panel command-bar only — never reachable from chat (see control-intent wiring in
// commands.ts), so no length/content trimming beyond what control.ts's parseAction
// already enforces when the panel hands the Action off to act().
function matchSay(t: string): Action | null {
  const m = t.match(SAY_RE)
  if (!m) return null
  const text = m[1].trim().replace(/\s+in\s+chat$/i, '').replace(/^["“](.+)["”]$/s, '$1').trim()
  return text ? { kind: 'say', text: text.slice(0, 450) } : null
}

/**
 * deterministic layer only — no AI, no I/O. covers the full Action surface: the mod
 * pause/resume/topic-ban vocabulary (via commands-mod's tuned regexes, unchanged) plus
 * the newer game/ai/vibe-index/queue/depths phrasing. chat wires up only a subset of
 * this (see commands.ts) — pause/resume/topic-ban keep their own byte-identical routes
 * there; this is the canonical parser for anything else that wants full NL coverage
 * (the panel's command bar).
 */
export function matchControlIntent(text: string): Action | null {
  const t = text.trim()
  if (!t) return null
  const isQuestion = QUESTION_RE.test(t)

  if (!isQuestion) {
    const unban = t.match(TRIVIA_UNBAN_RE)
    if (unban) {
      const topic = stripArticles(unban[1])
      if (topic) return { kind: 'topic-unban', topic }
    }
    const ban = t.match(TRIVIA_BAN_RE)
    if (ban) {
      const topic = stripArticles(ban[1])
      if (topic && !BAN_FILLER_RE.test(topic)) return { kind: 'topic-ban', topic }
    }
    if (RESUME_RE.test(t)) return { kind: 'resume', feature: featureOf(t) ?? 'all' }
    const sup = t.match(SUPPRESS_RE)
    if (sup) return { kind: 'pause', feature: featureOf(sup[1]) ?? 'ai', minutes: parseSuppressMinutes(t) }
    if (SUPPRESS_ALL_RE.test(t)) return { kind: 'pause', feature: 'all', minutes: parseSuppressMinutes(t) }
  }

  return matchUnignore(t)
    ?? matchIgnore(t)
    ?? matchVibeDrop(t)
    ?? (VIBE_CLEAR_RE.test(t) ? { kind: 'vibe-clear' } : null)
    ?? (QUEUE_CLEAR_RE.test(t) ? { kind: 'queue-clear' } : null)
    ?? (DEPTHS_RESET_RE.test(t) ? { kind: 'depths-reset' } : null)
    ?? (TRIVIA_SKIP_RE.test(t) ? { kind: 'trivia-skip' } : null)
    ?? matchTriviaStart(t)
    ?? matchRaidToggle(t)
    ?? matchRaidPace(t)
    ?? matchAiToggle(t)
    ?? matchSay(t)
}

/**
 * deterministic layer, then (mod-only vocabulary) the AI classify ai-directive.ts already
 * spends for plain mod talking — reused, not duplicated: parseDirective's kind:'suppress'/
 * 'resume'/'unvibe' outputs are mapped onto the same Action union instead of teaching the
 * model a second schema for the same three concepts. skips the call entirely with no
 * control-ish words in the text (MOD_CONTROL_HINT), so a routine mod lookup never pays for
 * a classify that will just return ok:false. callers must already know `text` came from a
 * mod — this never checks a badge itself.
 */
export async function parseControlIntent(text: string, channel: string): Promise<Action | null> {
  const det = matchControlIntent(text)
  if (det) return det
  if (!MOD_CONTROL_HINT.test(text)) return null
  const parsed = await parseDirective(text, channel, true, listDirectives(channel))
  if (!parsed || !('kind' in parsed)) return null
  if (parsed.kind === 'suppress') return { kind: 'pause', feature: parsed.feature, minutes: parsed.minutes }
  if (parsed.kind === 'resume') return { kind: 'resume', feature: parsed.feature }
  if (parsed.kind !== 'unvibe') return null
  // unvibe can name several vibes ("drop the pirate thing and the spanish one") — the
  // Action union only has a single-index drop, so only the first is actionable here.
  const index = parsed.indexes[0]
  return index ? { kind: 'vibe-drop', index } : null
}
