// bare-!b builder: turns an unadorned '!b' into a real ai query — answer an
// unanswered chat question if there is one, else a varied nudge anchored on recent chat.
import { getRecent } from './chatbuf'
import { isGameActive } from './trivia'

// --- bare !b → AI contextual response ---
// Priority: (1) answer any unanswered question in recent chat; (2) varied nudge anchored on real chat.
// Hard contract: NEVER emit the legacy "!b <item> [tier] ... bazaardb.gg" usage string.

export const BARE_B_NUDGES = [
  'pick one specific chatter or moment from recent chat and react in one sentence',
  'observation about whats happening in chat right now — one concrete sentence, no meta',
  'one-liner take on the current convo — fresh angle, dont repeat yourself',
  'shout out a chatter by name with a real reason from their recent message',
  'ask chat a sharp question based on what someone just said',
  'short hot take on the topic chat is on right now',
  'pick a real line from recent chat and riff on it — quote or paraphrase briefly',
  'two-word reaction to the vibe in chat',
  'if you know the asker (their memory/facts/fav item), greet them with a warm callback to their vibe — one sentence; if you dont, just react to the room',
] as const

const BARE_B_TAIL = '. dont react to "!b" itself.'
const BARE_B_QUERY_BUDGET = 195 // AI_MAX_QUERY_LEN is 200 in ai.ts; stay under
const BARE_B_MSG_MAX = 60       // per-message cap inside the snippet/question
const QUESTION_RE = /\?\s*$|^(who|what|when|where|why|how|does|do|is|are|am|can|could|should|would|will|did|has|have)\b/i

function clip(s: string, n: number): string { return s.length <= n ? s : s.slice(0, n) }

function recentEligible(channel: string): { user: string; text: string }[] {
  try {
    const botName = (process.env.TWITCH_USERNAME ?? 'bazaarinfo').toLowerCase()
    return getRecent(channel, 15)
      .filter((m) =>
        m.kind !== 'event' &&
        m.user.toLowerCase() !== botName &&
        !/^!\w/.test(m.text.trim()) &&
        m.text.trim().length > 3,
      )
      .map((m) => ({ user: m.user, text: m.text.replace(/\s+/g, ' ').trim() }))
  } catch {
    return []
  }
}

export function findUnansweredQuestion(channel: string): { user: string; text: string } | null {
  const recent = recentEligible(channel)
  for (let i = recent.length - 1; i >= 0; i--) {
    const msg = recent[i]
    if (msg.text.length < 6) continue
    if (!QUESTION_RE.test(msg.text)) continue
    // unanswered = no substantive reply (>15 chars) by a different user after.
    // spoiler-deflections ("no spoilers", "im trying to guess") aren't answers — skip them.
    const replied = recent.slice(i + 1).some((later) =>
      later.user.toLowerCase() !== msg.user.toLowerCase() &&
      later.text.length > 15 &&
      !SPOILER_SENSITIVE_RE.test(later.text),
    )
    if (!replied) return msg
  }
  return null
}

// Spoiler-sensitive signals: chat is explicitly avoiding direct answers
// (trivia/guess bit active, or "no spoilers" / "dont tell" / "im trying to guess" phrases).
const SPOILER_SENSITIVE_RE = /\b(no spoiler|dont spoil|don'?t spoil|without spoil|spoiler[- ]?free|dont tell|don'?t tell|trying to (?:guess|figure|remember)|im guessing|let me guess|guess (?:what|who|the)|hint (?:only|please|pls)|riddle me)\b/i

function spoilerSensitive(channel: string): boolean {
  try {
    if (isGameActive(channel)) return true
  } catch {}
  const recent = recentEligible(channel)
  return recent.some((m) => SPOILER_SENSITIVE_RE.test(m.text))
}

export function buildBareBQuery(channel?: string): string {
  if (channel) {
    const q = findUnansweredQuestion(channel)
    if (q) {
      const text = clip(q.text, BARE_B_MSG_MAX)
      const guised = spoilerSensitive(channel)
      const style = guised
        ? 'give a guised hint that points toward the answer without spoiling it'
        : 'answer bluntly and accurately'
      const ask = `${style} — unanswered chat question from ${q.user}: "${text}". use bazaar game data if relevant. dont react to "!b" itself.`
      return clip(ask, BARE_B_QUERY_BUDGET)
    }
  }
  const nudge = BARE_B_NUDGES[Math.floor(Math.random() * BARE_B_NUDGES.length)]
  let body: string = nudge
  if (channel) {
    const recent = recentEligible(channel).slice(-3)
    if (recent.length > 0) {
      const snippet = recent.map((m) => `${m.user}: ${clip(m.text, BARE_B_MSG_MAX)}`).join(' / ')
      body = `${nudge}. anchor: ${snippet}`
    }
  }
  const headBudget = BARE_B_QUERY_BUDGET - BARE_B_TAIL.length
  return clip(body, headBudget) + BARE_B_TAIL
}
