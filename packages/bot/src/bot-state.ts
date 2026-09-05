// Live bot-state introspection. Anyone can plainly ask what the bot is currently
// doing ("why are you talking like a pirate", "who's muted", "why no trivia", "are
// you broken") and the AI answers from THIS snapshot instead of guessing. PURE READ:
// gathers state from directives/suppress/trivia/dungeon/ai health and renders a terse
// prompt block. Injected into the required tail of the user message (ai-build) only
// when the query smells like a state question — zero prompt cost otherwise.
//
// HARD RULE: the snapshot must NEVER carry a live round's answer or accepted list —
// a state ask mid-round would leak it straight into an AI reply (see the
// trivia-answer-leak incident). activeRoundInfo exposes question/time/guesses only.
//
// commands.ts owns extra state (topic queue, topic bans) but importing it here would
// cycle (commands → ai-build → bot-state → commands), so those register themselves
// via registerStateProvider at module init — same injection pattern as the trivia
// live-game resolver.

import { listDirectives } from './directives'
import { listSuppressions } from './suppress'
import { activeRoundInfo } from './trivia'
import { statusLine as dungeonStatusLine } from './dungeon'

// queries about the bot's own current behavior/state. broad on purpose — a false
// positive just injects a short block the model ignores; a false negative means an
// ungrounded guess about live state.
export const SELF_STATE_RE = new RegExp([
  // "what are you doing / up to", "whats going on with you"
  /\bwhat(?:'?s| are| is)? (?:you|u) (?:doing|up to|on|playing at)\b/.source,
  /\bwhat(?:'?s| is)? (?:going on|happening|active|running|paused|muted|banned|queued)\b/.source,
  // "why are you / aren't you / won't you / did you stop|skip|ignore..."
  /\bwhy (?:are|aren'?t|won'?t|don'?t|do|did|didn'?t|is|isn'?t)? ?(?:you|u|the bot|it)\b/.source,
  /\bwhy (?:so )?(?:quiet|silent|slow|weird|mean|dead)\b/.source,
  /\bwhy no (?:trivia|answers?|repl(?:y|ies)|response)\b/.source,
  // "are you ok/muted/paused/broken/alive/working/ignoring"
  /\b(?:are|r) (?:you|u) (?:ok(?:ay)?|muted|paused|broken|down|alive|working|stuck|ignoring|mad|asleep|sleeping|on)\b/.source,
  // "who's muted", "who muted bob", "who planted that"
  /\bwho(?:'?s| is| are)? (?:muted|paused|banned)\b/.source,
  /\bwho (?:muted|paused|banned|planted|silenced)\b/.source,
  // vibes / directives / pauses / state by name
  /\b(?:current|active|any) (?:vibes?|directives?|pauses?|mutes?|bans?|state|status)\b/.source,
  /\bbot (?:status|state)\b/.source,
  /\bwhat (?:vibes?|directives?|pauses?|mutes?|bans?)\b/.source,
  // "still doing X?", "can you talk again", "when are you back"
  /\bstill (?:paused|muted|quiet|banned|off|down)\b/.source,
  /\bwhen (?:are|r) (?:you|u) back\b/.source,
].join('|'), 'i')

// extra per-channel state lines owned by other modules (topic queue, topic bans…).
// each provider returns a finished line or '' when it has nothing to say.
const providers: ((channel: string) => string)[] = []
export function registerStateProvider(fn: (channel: string) => string): void {
  providers.push(fn)
}

const CAP = 700 // hard byte-ish cap on the whole block — state is a garnish, not the meal

export function botStateReport(channel: string): string {
  const lines: string[] = []

  // trivia round — question/time/guess count only; the answer is radioactive here
  const round = activeRoundInfo(channel)
  if (round) lines.push(`trivia: round LIVE — "${round.question.slice(0, 90)}" (${round.secondsLeft}s left, ${round.guesses} guess${round.guesses === 1 ? '' : 'es'} so far)`)

  // vibes + mutes (numbered — the same order a mod's "stop doing X" removal targets)
  const vibes = listDirectives(channel)
  if (vibes.length) {
    const now = Date.now()
    const vl = vibes.map((d, i) => {
      const mins = Math.max(1, Math.round((d.expiresAt - now) / 60_000))
      if (d.mute) return `${i + 1}. mute @${d.targetUser} (by ${d.planter}, ${mins}m left)`
      const scope = d.targetUser ? ` for @${d.targetUser}` : d.trigger.length ? ` on ${d.trigger.join('/')}` : ''
      return `${i + 1}. "${d.instruction}"${scope} (by ${d.planter}, ${mins}m left)`
    })
    lines.push(`vibes: ${vl.join(' · ')}`)
  }

  // mod pauses
  const sups = listSuppressions(channel)
  if (sups.length) lines.push(`mod pauses: ${sups.map((s) => `${s.feature} (${s.minutes}m left, by ${s.by})`).join(' · ')}`)

  // registered extras (topic queue, topic bans)
  for (const p of providers) {
    try {
      const l = p(channel)
      if (l) lines.push(l)
    } catch { /* a provider must never take the report down */ }
  }

  // depths — statusLine is already terse and render-safe
  try {
    const d = dungeonStatusLine(channel)
    if (d && !/lie silent/i.test(d)) lines.push(`depths: ${d.slice(0, 120)}`)
  } catch { /* offline-only feature; never fatal */ }

  // deliberately NO ai-health lines: hard-stop / circuit-open / channel-cap all kill
  // the very AI call this block would ride in, so such a line could never render.

  if (lines.length === 0) {
    return `\n[BOT STATE] nothing special active right now: no vibes, no mutes, no mod pauses, no live trivia round, ai healthy. if asked what you're up to, say so plainly.`
  }
  let body = lines.join('\n')
  if (body.length > CAP) body = body.slice(0, CAP)
  return `\n[BOT STATE] live snapshot — answer state questions from THIS, plainly and honestly; never invent state that isn't listed, never dunk on whoever planted/paused something, and NEVER reveal or hint a live trivia answer:\n${body}`
}

export function resetProvidersForTest(): void {
  providers.length = 0
}
