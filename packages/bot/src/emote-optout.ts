// a chatter can step out of emote bits aimed at them ("I wish to opt out from non-consensual
// lick" got "wollip's still fair game until they personally file the complaint", nov 2026).
// open, not rude: the bit keeps running, it just lands on whoever asked for it instead.
// self-service only — nobody opts someone else out — and one line undoes it.
import * as db from './db'

const BIT = '(?:lick|licks|licking|licked|emote|emotes|wall|walls|bit|bits|spam|tag|tags|tagging|ping|pings|pinging)'
const OPT_OUT_RE = new RegExp(`\\bopt(?:ing)?[\\s-]*(?:me\\s+)?out\\b.*\\b${BIT}\\b|\\b${BIT}\\b.*\\bopt(?:ing)?[\\s-]*(?:me\\s+)?out\\b|\\b(?:stop|quit|no more|don'?t|do not)\\s+(?:lick|licking|tag|tagging|ping|pinging|spamming)\\s+me\\b`, 'i')
const OPT_IN_RE = /\bopt(?:ing)?[\s-]*(?:me\s+)?(?:back\s+)?in\b/i

export const OPTED_OUT_LINE = 'done, emote bits aimed at you land on whoever asked instead. "opt me back in" undoes it'
export const OPTED_IN_LINE = 'back in, emote bits can find you again'

/** the reply when the ask is the asker opting themselves out of / back into emote bits */
export function handleEmoteOptOut(args: string, user: string): string | null {
  if ((OPT_IN_RE.test(args) && new RegExp(`\\b${BIT}\\b`, 'i').test(args)) || /\bopt (?:me )?back in\b/i.test(args)) {
    db.setEmoteOptOut(user, false)
    return OPTED_IN_LINE
  }
  if (!OPT_OUT_RE.test(args)) return null
  db.setEmoteOptOut(user, true)
  return OPTED_OUT_LINE
}
