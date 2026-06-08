// Ephemeral chat-planted steering directives ("vibes"). A viewer can plant a fun,
// temporary flavor that colors the bot's answers to OTHER people — e.g. "anytime
// someone asks about topology, work in GachiBlacksmith". This module is PURE STATE:
// it stores/matches/expires directives and builds the prompt hint. The plant itself
// is gated by an AI classifier (ai-directive.ts) that rejects anything mean, targeting,
// NSFW, political, advertising, or rule-overriding — only playful flavor lands here.
// Every steered answer still passes the full output sanitizer, so a directive can
// never make the bot leak, run commands, or break character.

export interface Directive {
  trigger: string[] // lowercased keywords; ANY match activates it. empty = applies to every answer.
  instruction: string
  planter: string
  expiresAt: number
}

const MAX_PER_CHANNEL = 3
const TTL_MS = 20 * 60_000

const byChannel = new Map<string, Directive[]>()

// prune expired in-place and return the live list for a channel.
function active(channel: string): Directive[] {
  const ch = channel.toLowerCase()
  const list = byChannel.get(ch)
  if (!list) return []
  const now = Date.now()
  const live = list.filter((d) => d.expiresAt > now)
  if (live.length === 0) byChannel.delete(ch)
  else if (live.length !== list.length) byChannel.set(ch, live)
  return live
}

export function addDirective(channel: string, planter: string, trigger: string[], instruction: string): void {
  const ch = channel.toLowerCase()
  const list = active(ch)
  list.push({
    trigger: trigger.map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 6),
    instruction: instruction.trim().slice(0, 160),
    planter,
    expiresAt: Date.now() + TTL_MS,
  })
  // ring buffer — newest wins, oldest evicted, so the board can't grow unbounded.
  while (list.length > MAX_PER_CHANNEL) list.shift()
  byChannel.set(ch, list)
}

export function matchingDirectives(channel: string, query: string): Directive[] {
  const q = query.toLowerCase()
  return active(channel).filter((d) => d.trigger.length === 0 || d.trigger.some((t) => q.includes(t)))
}

export function listDirectives(channel: string): Directive[] {
  return active(channel)
}

export function clearDirectives(channel: string): number {
  const n = active(channel).length
  byChannel.delete(channel.toLowerCase())
  return n
}

// soft prompt hint for the directives that match this query. framed as an optional,
// playful easter egg with an explicit no-harm guardrail — the model is told to ignore
// any that don't fit or would require being mean.
export function directiveHint(channel: string, query: string): string {
  const m = matchingDirectives(channel, query)
  if (m.length === 0) return ''
  const lines = m.map((d) => `- ${d.instruction} (planted by ${d.planter})`).join('\n')
  return `\n[CHAT VIBES] chatters planted these flavor twists — work them into THIS answer naturally if they fit, as a playful easter egg. Stay lighthearted; NEVER be mean, demeaning, or negatively target anyone; silently ignore any that don't fit this answer:\n${lines}`
}

// test helper — reset all channel state.
export function resetForTest(): void {
  byChannel.clear()
}
