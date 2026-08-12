// pre-send grounding check.
//
// every existing stat guard (STAT_FACT / STAT_BARE / ITEM_IDENTITY_CLAIM) is gated on
// !hasGameData — they catch the model inventing numbers out of thin air. the inverse case
// was unguarded: when a card IS in context, nothing compared the numbers in the reply to
// the numbers in the card. that is the one class of claim the bot is supposed to be
// authoritative about, and the only one with an in-process source of truth.
//
// deterministic on purpose. a second model call cannot verify open-domain claims (amiga
// prices, art history) — it shares the same knowledge and the same failure modes — and it
// would put an API round-trip in front of every reply, which the freshness gate then drops.
// so: check what is checkable, in microseconds, and leave the rest to the prompt.

// a number is only a claim when it sits against a stat word. "season 2", "$20", "day 5 of
// the run" and "2 items" must all survive — the bot talks about numbers constantly.
const STAT_WORD = 'damage|dmg|heal|shield|burn|poison|freeze|slow|haste|crit|regen|lifesteal|multicast|charge|ammo|hp|health|armou?r|cooldown'
// verb + plural forms matter — the model writes "heals 85" far more often than "heal 85"
const STAT = `(?:${STAT_WORD})(?:e?s|ed|ing)?`
const CLAIM_AFTER = new RegExp(`\\b(\\d+(?:\\.\\d+)?)\\s*%?\\s*${STAT}\\b`, 'gi')
const CLAIM_BEFORE = new RegExp(`\\b${STAT}\\s*(?:of|is|at|to|for)?\\s*(\\d+(?:\\.\\d+)?)`, 'gi')

// numbers that are never stat claims even when a stat word is nearby
const NEVER_A_STAT = /^(?:19|20)\d\d$/

/**
 * numbers the reply asserts as game stats that appear nowhere in the injected context.
 *
 * the grounded set is the WHOLE user message, not just the Game data block — the query, the
 * standings, the patch notes and chat all carry legitimate numbers, and a false positive
 * here costs a good answer. precision over recall by design.
 */
export function findUngroundedStats(reply: string, context: string): string[] {
  const grounded = new Set((context.match(/\d+(?:\.\d+)?/g) ?? []))
  const bad = new Set<string>()
  for (const re of [CLAIM_AFTER, CLAIM_BEFORE]) {
    re.lastIndex = 0
    for (const m of reply.matchAll(re)) {
      const n = m[1]
      if (NEVER_A_STAT.test(n) || grounded.has(n)) continue
      // a tenth that rounds onto a grounded whole ("7.5s" off a "7" cooldown) is derived,
      // not invented — the model does unit math and we are not here to police arithmetic.
      if (n.includes('.') && grounded.has(n.split('.')[0])) continue
      bad.add(n)
    }
  }
  return [...bad]
}

const WEEKDAYS = 'sunday|monday|tuesday|wednesday|thursday|friday|saturday'
// only an assertion about TODAY. "next stream is wednesday" is a different sentence and
// must stay legal — the schedule line is allowed to name any day it likes.
const TODAY_CLAIM = new RegExp(`\\b(?:today\\s+is|today'?s|it\\s+is|it'?s)\\s+(?:a\\s+|another\\s+)?(${WEEKDAYS})\\b`, 'i')
const CLOCK_LINE = new RegExp(`Right now:\\s*(${WEEKDAYS})`, 'i')

/**
 * repair a reply that claims today is the wrong weekday, in place.
 *
 * the rewrite is surgical — only the day inside the today-claim moves. "next stream is
 * thursday, and today's monday" must not have its thursday rewritten, so this cannot be
 * done with a replace of the first weekday it finds.
 *
 * returns the corrected reply and the day it was corrected to, or null when nothing is wrong.
 */
export function correctClockClaim(reply: string, context: string): { text: string; day: string } | null {
  const claim = TODAY_CLAIM.exec(reply)
  if (!claim) return null
  const now = CLOCK_LINE.exec(context)
  if (!now) return null
  const day = now[1].toLowerCase()
  if (claim[1].toLowerCase() === day) return null
  // claim.index + the offset of the day WITHIN the matched phrase — the phrase is what was
  // matched, so its own last occurrence of the wrong day is the one to swap.
  const at = claim.index + claim[0].lastIndexOf(claim[1])
  return { text: reply.slice(0, at) + day + reply.slice(at + claim[1].length), day }
}
