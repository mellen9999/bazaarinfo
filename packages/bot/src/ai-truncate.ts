// repairing a reply the model didn't finish. pure + testable on purpose: this ran inline in
// doAiCall for a long time and a gap in it shipped 3.6% of live replies cut mid-word
// ("...kripp exploding kripp mid-t"), which nothing could regression-test.
//
// two ways a reply arrives broken: it ran past the char cap, or the API stopped it on
// max_tokens. the second is the one that used to slip — a fragment that happens to land
// UNDER the cap looked like a normal short reply and shipped verbatim.

// walk back to the last clean stopping point at or under `hardCap`.
// `cutShort` = the API stopped on max_tokens, i.e. the tail is a fragment, not a choice.
export function repairTruncation(text: string, hardCap: number, cutShort: boolean): string {
  let t = text
  // a reply that lands exactly on the token ceiling but still ends on a terminator finished
  // its thought — max_tokens is not proof of damage, so don't amputate a good last word.
  const endsClean = /[.!?…)\]"”]\s*$/.test(t)
  if (t.length > hardCap || (cutShort && !endsClean)) {
    const cut = t.slice(0, hardCap)
    // thresholds are a fraction of what we actually HAVE, not of the cap. for an over-cap
    // reply the two are identical (cut is exactly hardCap long), but a max_tokens fragment
    // is shorter than the cap, and measuring against the cap there demanded a break past
    // 40% of 150 chars in an 86-char reply — unreachable, so every fragment fell through to
    // blunt amputation and kept its dangling clause.
    const ref = cut.length
    // prefer sentence-ending breaks; only fall back to comma/clause if none exist.
    // a digit before the dot is a list label ("1. dooley 2. vanessa"), not a sentence end —
    // treating it as one walked "top picks: 1. dooley 2. vanessa 3" back to just "1. dooley".
    // ...and a title/abbreviation isn't one either — breaking at "Dr. " turned a cut-off
    // bee-movie bit into "bee movie's copyrighted, and even Dr.", worse than the fragment.
    const ABBREV = /\b(?:dr|mr|mrs|ms|st|vs|jr|sr|prof|inc|etc|approx|dept|fig|no)$/i
    let sentenceBreak = -1
    for (const m of cut.matchAll(/(?<!\d)[.!?] /g)) {
      if (m[0][0] === '.' && ABBREV.test(cut.slice(0, m.index))) continue
      sentenceBreak = m.index
    }
    if (sentenceBreak > ref * 0.4) {
      t = cut.slice(0, sentenceBreak + 1).trim()
    } else {
      const clauseBreak = Math.max(cut.lastIndexOf(' — '), cut.lastIndexOf(', '))
      if (clauseBreak > ref * 0.5) {
        t = cut.slice(0, clauseBreak).trim()
      } else if (cutShort || t.length > 480) {
        // only amputate mid-thought when the model was actually cut off, or we're over the
        // hard 480-char Twitch limit. a COMPLETE slightly-over-cap one-liner ("she's the best
        // take here") keeps its last words instead of being clipped to a fragment.
        // the \s+ is required: with no space to cut at there is no partial word to drop, and
        // eating the only word would turn a short reply into nothing.
        t = cut.replace(/\s+\S*$/, '').trim()
      }
    }
  }
  // fix orphan quotes created by truncation
  if ((t.match(/"/g) || []).length % 2 !== 0) {
    const last = t.lastIndexOf('"')
    const before = t.slice(0, last).trim()
    if (before.length > 10) t = before
  }
  // fix unclosed parens created by truncation
  const openParens = (t.match(/\(/g) || []).length
  const closeParens = (t.match(/\)/g) || []).length
  if (openParens > closeParens) {
    const lastOpen = t.lastIndexOf('(')
    const before = t.slice(0, lastOpen).trim()
    if (before.length > 10) {
      t = before
    } else {
      t = t.replace(/[,\s]*$/, '') + ')'
    }
  }
  // truncation can leave a dangling list label ("...2. foo 3") — drop the orphan
  // ordinal, but only when an earlier numbered item proves it was a real list.
  if (/\b\d+[.)]\s+\S/.test(t) && /(?:\n|\s)\d+[.):]?\s*$/.test(t)) {
    t = t.replace(/(?:\n|\s)+\d+[.):]?\s*$/, '').trim()
  }
  return t
}

// did repair leave something too small to be worth sending? a one-word stub is worse than a
// retry, and the caller already has a fragment-retry hint wired up for exactly this.
export function isStub(text: string): boolean {
  return text.trim().split(/\s+/).filter(Boolean).length < 3
}
