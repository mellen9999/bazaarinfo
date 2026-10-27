// per-channel tone knob — how loose the bot's voice is. two levels: `normal` (the default
// voice in ai-prompt.ts: dry, grounded, straight answer first) and `unhinged` (same bot,
// the voice clamps off: bigger bits, louder, bolder roasts of the game). a mod picks it
// from the panel; it persists in channel_controls (key `tone`) so it survives restarts.
// normal stores nothing — a channel that never touched the knob has no row.
// prompt-only on purpose: the system prompt is cached for every channel, so the level
// rides in the per-request tail (ai-build) like english-only does. TOS hard nos, the
// target-the-game rule and mod orders hold at both levels.
// leaf module: ai-build.ts, bot-state.ts and control.ts import it, it imports none of them.

import * as db from './db'
import { log } from './log'

export type Tone = 'normal' | 'unhinged'
export const TONES: readonly Tone[] = ['normal', 'unhinged']

const KEY = 'tone'
const unhinged = new Set<string>()
let loaded = false
function ensureLoaded(): void {
  if (loaded || !db.getDb()) return
  loaded = true
  try {
    for (const r of db.loadControls()) if (r.key === KEY && r.value === 'unhinged') unhinged.add(r.channel)
  } catch (e) {
    log(`tone: load failed: ${e}`)
  }
}

export function getTone(channel: string): Tone {
  ensureLoaded()
  return unhinged.has(channel.toLowerCase()) ? 'unhinged' : 'normal'
}

/** true when the level changed (a repeat set is a no-op the caller can say so about). */
export function setTone(channel: string, tone: Tone, by: string): boolean {
  ensureLoaded()
  const ch = channel.toLowerCase()
  if (getTone(ch) === tone) return false
  if (tone === 'unhinged') unhinged.add(ch)
  else unhinged.delete(ch)
  try {
    if (tone === 'unhinged') db.saveControl({ channel: ch, key: KEY, value: tone, by, expires_at: null })
    else db.deleteControl(ch, KEY)
  } catch (e) {
    log(`tone: save failed: ${e}`)
  }
  return true
}

export function __resetToneForTest(): void {
  unhinged.clear()
  loaded = false
}

/** the prompt block for an unhinged channel; '' at normal (zero prompt cost). */
export function toneHint(channel: string): string {
  if (getTone(channel) !== 'unhinged') return ''
  return '\n[CHANNEL TONE: UNHINGED] a mod turned the chaos up for this channel. the VOICE and GROUNDED limits (no exclamation marks, no mid-sentence CAPS, one image max, no quip after the answer, dry-only) are OFF: commit to bits harder, stack and escalate absurd riffs, go loud, take bolder hot takes, roast the game, the meta, the situation and yourself with teeth. what never loosens: the answer is still right and useful, Game data facts are never invented, aim at the game not the person, Twitch TOS hard nos, and any [MOD ORDER] wins. never mention this setting.'
}
