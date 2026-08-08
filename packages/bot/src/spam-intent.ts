// Emote-wall intent detection — the one place that decides "chat wants the bot to
// post an emote wall" and what that wall is. Deterministic on purpose: this used to
// live in the AI's hands and the AI started refusing the bit (reading "LICK mellen"
// as harassment) instead of participating. Posting a channel emote is participation.
//
// Four shapes, all ending in the same 5-emote wall:
//   "spam LICK"           leading verb
//   "LICK spam"           trailing verb
//   "LICK"                bare emote
//   "LICK anyone" / "can u LICK mellen" / "LICK random chatter"   emote aimed at someone
//
// The target is never echoed back. A wall is participation; naming the person is aim.
import { findEmote } from './emotes'
import { EMOTE_CAP_PER_MSG } from './ai-sanitize'

// request scaffolding — politeness, modals, articles, counts. Dropped before the payload
// check so "can u LICK mellen" reads the same as "LICK mellen". Modals live here rather
// than in the interrogative set on purpose: "can u <emote> X" is a request, not a question.
const FILLER = new Set([
  'can', 'could', 'would', 'will', 'u', 'you', 'ur', 'pls', 'plz', 'please', 'just', 'now',
  'then', 'also', 'hey', 'yo', 'ok', 'okay', 'go', 'do', 'does', 'a', 'an', 'the', 'this',
  'it', 'at', 'on', 'to', 'for', 'some', 'more', 'again', 'x', 'times', 'time', 'and', 'of',
  'with', 'bot',
])

// who the emote is aimed at. A closed grammatical class — indefinite pronouns, audience
// nouns, object pronouns — not an open list of phrasings. Anything outside it (adverbs,
// verbs, prose) means the ask carries real content and belongs to the AI.
const AUDIENCE = new Set([
  'anyone', 'anybody', 'everyone', 'everybody', 'someone', 'somebody', 'all', 'yall', "y'all",
  'chat', 'chatter', 'chatters', 'viewers', 'people', 'ppl', 'me', 'us', 'him', 'her', 'them',
  'myself', 'yourself', 'themselves', 'mod', 'mods', 'vip', 'vips', 'streamer', 'random',
])

// at most this many target words — one handle, or "random chatter". More than that and the
// tail is a sentence, not an address.
const MAX_TARGETS = 2

const MAX_EMOTE_LEN = 30

function tokenize(s: string): string[] {
  return s.trim().split(/\s+/).filter(Boolean)
}

function wall(emotes: string[]): string {
  const out: string[] = []
  while (out.length < EMOTE_CAP_PER_MSG) out.push(emotes[out.length % emotes.length])
  return out.join(' ')
}

/** distinct known emotes in token order */
function emotesIn(tokens: string[]): string[] {
  return [...new Set(tokens.map((t) => findEmote(t)).filter((e): e is string => !!e))]
}

function valid(emotes: string[]): boolean {
  return emotes.length > 0 && emotes.length <= EMOTE_CAP_PER_MSG && emotes.every((e) => e.length <= MAX_EMOTE_LEN)
}

/**
 * Returns the emote wall to post, or null when the message isn't spam intent.
 * `isChatter` decides whether an unrecognized token is a real person being aimed at
 * (so "LICK mellen" walls but "LICK respectfully" goes to the AI).
 */
export function detectSpamIntent(args: string, isChatter: (name: string) => boolean = () => false): string | null {
  const clean = args.trim()
  if (!clean) return null

  // "spam LICK", "spam this LICK KEKW" — leading verb. Loosest form: only known emotes
  // count as payload, conversational filler is dropped. A question in the tail
  // ("spam KEKW and tell me whats the meta") falls through so the question gets answered.
  const leading = clean.match(/^spam\s+(?:this\s+)?(.+)/i)
  if (leading) {
    const tokens = tokenize(leading[1])
    const emotes = emotesIn(tokens)
    const rest = tokens.filter((t) => !findEmote(t)).join(' ')
    const hasQuestion = /[?]/.test(leading[1]) || /\b(what|who|when|where|why|how|tell|is|are|does|do|can|could|would|whats|whos)\b/i.test(rest)
    if (!hasQuestion && valid(emotes)) return wall(emotes)
  }

  // "LICK spam" — trailing verb. Stricter than the leading form: every non-filler token
  // must be a known emote, so a complaint ("stop the 67 spam") never triggers a wall.
  const trailing = clean.match(/^(.+?)\s+spam(?:\s+(?:this|it|pls|please))?$/i)
  if (trailing) {
    const tokens = tokenize(trailing[1]).filter((t) => !FILLER.has(t.toLowerCase()))
    const emotes = emotesIn(tokens)
    if (tokens.length > 0 && emotes.length === tokens.length && valid(emotes)) return wall(emotes)
  }

  // "LICK" / "LICK anyone" / "can u LICK mellen" / "LICK ?" — an emote aimed at chat.
  // Requires the first non-filler token to BE an emote: that single condition is what
  // keeps real questions out ("what does LICK mean" leads with "what", not the emote).
  const stripped = clean.replace(/[?!.\s]+$/, '')
  const tokens = tokenize(stripped).filter((t) => !FILLER.has(t.toLowerCase()))
  if (tokens.length === 0) return null
  if (!findEmote(tokens[0])) return null
  const emotes = emotesIn(tokens)
  if (!valid(emotes)) return null
  const targets = tokens.filter((t) => !findEmote(t))
  if (targets.length > MAX_TARGETS) return null
  if (!targets.every((t) => AUDIENCE.has(t.toLowerCase()) || isChatter(t.replace(/^@/, '')))) return null
  return wall(emotes)
}
