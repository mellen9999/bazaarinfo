import * as db from './db'
import { findEmote } from './emotes'

// CHANNEL LORE — the in-jokes that exist only in this chat's own history.
//
// "!trivia the tidolar crime family" used to reach the world-knowledge trivia model, which
// has never heard of tidolar, reached for the nearest real thing it knew, and asked chat
// whether a Sopranos mob shares its name with one of New York's Five Families. Nobody in
// chat could win that, and it wasn't even true. The material chat actually wanted was
// sitting in our own log: a copypasta chat has posted ~30 times since March accusing
// mellen of working with the "tricky-tidolar crime family".
//
// So: before handing a topic to a model that doesn't know it, ask the log. If the topic is
// anchored on someone/something this channel actually talks about AND the whole phrase has
// a real footprint here, we build a dossier of the bits chat has posted and generate the
// question from THAT instead.
//
// Deliberately narrow. A false positive would hijack a legitimate world topic into a
// chat-recall question, so both gates must hold, and a thin result returns null — the
// caller then runs the unchanged world-knowledge path. Measured against 40 real !trivia
// topics pulled from the log ("cthulhu mythos", "keanu reeves", "the crusades", ...):
// zero false positives. scripts/lore-probe.ts --gate re-runs that sweep.

// A bare word is a PERSON only when chat would recognise the name. Two ways to earn that:
// they just chatted, or they are a regular here. The second half is what makes
// "!trivia <name>" work for someone watching without typing right now.
//
// Kept to REGULARS deliberately. A bare name is also a world topic — "matrix", "jojos",
// "kripparrian" all came through in one minute of real chat — and a stranger with three
// messages must never hijack one of those into a quiz about themselves.
const BARE_NAME_WINDOW = '-6 hours'
const REGULAR_MSGS = 200

export function isKnownChatter(name: string, channel: string): boolean {
  try {
    if (db.userChattedSince(name, channel, BARE_NAME_WINDOW)) return true
    return (db.getUserStats(name, channel)?.chat_messages ?? 0) >= REGULAR_MSGS
  } catch {
    return false
  }
}

// words that carry no search signal — they'd match half the log and tell us nothing about
// whether a topic is channel-native.
const STOP = new Set([
  'the', 'and', 'for', 'with', 'about', 'from', 'that', 'this', 'these', 'those', 'was', 'were',
  'are', 'has', 'had', 'have', 'its', 'his', 'her', 'their', 'they', 'them', 'our', 'you', 'your',
  'who', 'what', 'when', 'where', 'why', 'how', 'all', 'any', 'some', 'more', 'most', 'not',
])

/** topic -> the words worth searching on. lowercase, punctuation stripped, stopwords dropped. */
export function contentTokens(topic: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of topic.split(/\s+/)) {
    const t = raw.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (t.length < 3 || STOP.has(t) || seen.has(t)) continue
    seen.add(t)
    out.push(t)
    if (out.length === 6) break // fts5 AND-chains get brittle past a handful of terms
  }
  return out
}

// tokens are quoted so an FTS5 operator hidden in a topic ("NOT", "*", a stray quote) is
// matched as a literal instead of steering the query.
const ftsPhrase = (tokens: string[]) => tokens.map((t) => `"${t}"`).join(' AND ')

// A lore ANCHOR is a token this channel has a real relationship with: one of its regulars,
// or one of its emotes. Without one, a phrase match is just coincidence — plenty of real
// world topics ("crime family", "cheese rolling") turn up scattered hits in a big log.
function findAnchor(tokens: string[], channel: string): string | null {
  for (const t of tokens) {
    if (findEmote(t)) return t
    if (isKnownChatter(t, channel)) return t
  }
  return null
}

// how many times chat must have POSTED the whole phrase before we call it a bit. counted
// as posts, not distinct wordings: a pasta spammed thirty times verbatim is one bit and the
// strongest lore there is, while three people happening to use the same three words is the
// weakest thing we'd still accept. three is the line between a running joke and coincidence.
const MIN_PHRASE_POSTS = 3
// a bit has to be a sentence, not a bare @mention or a one-word emote reply.
const MIN_BIT_LEN = 25
const MAX_BIT_LEN = 220
const MAX_DOSSIER_LEN = 2400

interface Bit { text: string; reps: number; topReps: number }

// chat re-posts a pasta with drifting caps and punctuation ("mellen" / "MELLEN" /
// "M E L L E N"), which SQL GROUP BY sees as three different messages. Folding them
// together is what turns "x11" into the honest "x28" — the repeat count is the single
// strongest signal of what the bit actually is, so it has to be right.
//
// The surviving wording is the one chat posted MOST, not the longest: the spaced-out
// "M E L L E N" variant is longer, and shipping it as the canonical text invites a
// question whose answer is a spelling nobody would type.
function mergeVariants(rows: { message: string; reps: number }[]): Bit[] {
  const byKey = new Map<string, Bit>()
  for (const r of rows) {
    const key = r.message.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 120)
    if (!key) continue
    const prev = byKey.get(key)
    if (prev) {
      prev.reps += r.reps
      if (r.reps > prev.topReps) {
        prev.text = r.message
        prev.topReps = r.reps
      }
    } else {
      byKey.set(key, { text: r.message, reps: r.reps, topReps: r.reps })
    }
  }
  return [...byKey.values()].sort((a, b) => b.reps - a.reps || b.text.length - a.text.length)
}

export interface LoreDossier {
  anchor: string
  text: string
}

/**
 * Assemble what this channel has actually said about a topic, or null if it isn't lore.
 *
 * Null is the common case and the safe one — the caller falls through to the normal
 * world-knowledge pipeline, so a miss here costs nothing and changes no behavior.
 */
export function buildLoreDossier(topic: string, channel: string): LoreDossier | null {
  const tokens = contentTokens(topic)
  // a single-token topic is already covered: a bare handle goes to person trivia, a bare
  // word is a world topic. lore is the multi-word phrase case ("the tidolar crime family").
  if (tokens.length < 2) return null
  const anchor = findAnchor(tokens, channel)
  if (!anchor) return null

  const phrase = ftsPhrase(tokens)
  const bits = mergeVariants(db.searchPastaFTS(channel, phrase, MIN_BIT_LEN, 1, 24))
  const posts = bits.reduce((n, b) => n + b.reps, 0)
  if (posts < MIN_PHRASE_POSTS) return null

  const foot = db.chatTermFootprint(channel, `"${anchor}"`)
  const lines: string[] = [`TERM: ${topic.trim()}`]
  if (foot.msgs > 0) {
    const since = foot.firstSeen ? `, first seen ${foot.firstSeen.slice(0, 10)}` : ''
    lines.push(`footprint: chat has posted "${anchor}" in ${foot.msgs} messages from ${foot.users} different chatters${since}`)
  }
  lines.push(`what chat has actually said (xN = how many times chat posted it):`)
  for (const b of bits.slice(0, 10)) {
    lines.push(`- x${b.reps} ${b.text.replace(/\s+/g, ' ').trim().slice(0, MAX_BIT_LEN)}`)
  }

  const text = lines.join('\n').slice(0, MAX_DOSSIER_LEN)
  return { anchor, text }
}
