// Copypasta recall — find the pasta chat is asking for, and decide whether we trust the
// hit enough to post it verbatim without the model.
//
// A leaf module by design: it depends only on db, so both ai-build (prompt path) and
// commands (deterministic path) can use it without an import cycle.
import * as db from './db'
import { STOP_WORDS } from './ai-query'

// --- pasta recall: recite an EXISTING chat pasta verbatim (not generate a new one) ---
const PASTA_NOUN_RE = /\b(copypasta|pasta|bit|rant|meme)\b/i
// unambiguous "reproduce the existing thing" verbs — always recall
const STRONG_RECALL_RE = /\b(remind|recite|repost|re-?post|reread|re-?read|recall|again|read (?:it|that|the).{0,12}back|bring (?:it|that) back)\b/i
// "generate something new" verbs — veto recall (unless a strong-recall verb is also present)
const CREATE_VERB_RE = /\b(write|make|create|generate|come up with|new|another|original|about)\b/i
// definite reference to an existing pasta ("the whammy pasta", "that copypasta", "chat's rant")
const DEF_PASTA_RE = /\b(?:the|that|this|our|your|his|her|their|chat'?s|kripp'?s)(?:\s+\w+){0,4}\s+(?:copypasta|pasta|bit|rant|meme)\b/i
// scaffolding words stripped before keyword search so only the pasta's distinctive terms remain
const PASTA_SCAFFOLD = new Set([
  'remind','reminds','reminder','recite','repost','reread','recall','recalls','again','back','bring',
  'copypasta','copypastas','pasta','pastas','bit','rant','meme','memes','line','thing',
  'please','can','you','your','yall','yous','give','gimme','tell','show','post','say','said','read',
  'whats','what','wheres','where','does','did','how','the','that','this','our','his','her','their',
  'chats','chat','remember','remembers','just','wtf','was','were','one','from','earlier','before',
  'yesterday','today','stream','someone','somebody','people','everyone','used','use','type','typed',
])

export function isPastaRecall(query: string): boolean {
  if (!PASTA_NOUN_RE.test(query)) return false
  if (STRONG_RECALL_RE.test(query)) return true      // remind/recite/repost/again → recall
  if (CREATE_VERB_RE.test(query)) return false        // write/make/new/about → fresh generation
  return DEF_PASTA_RE.test(query)                      // "give us the pasta" → recall existing
}

function pastaKeywordCoverage(message: string, kw: string[]): number {
  const lower = message.toLowerCase()
  return kw.reduce((n, w) => (lower.includes(w) ? n + 1 : n), 0)
}

// Pull the actual chat pasta the user is asking for.
//
// Two things went wrong here and they compounded. FTS ordered by bm25 could never surface
// a pasta at all — bm25 penalises long documents, so a 43-char chat line sharing a keyword
// beat the 494-char pasta chat had posted 316 times. Then sorting purely by repeats
// surfaced the auto-posted ad announcements instead ("Shop on Amazon", 2831 reps). So
// candidates now come from a pasta-shaped query (repeated AND long, which excludes the
// short ads) and keyword coverage picks between them.
export interface PastaHit { message: string; reps: number; coverage: number }

export function findChatPasta(query: string, channel: string): PastaHit | null {
  const kw = pastaKeywords(query)
  if (kw.length > 0) {
    try {
      const ftsQ = kw.map((w) => `"${w}"`).join(' OR ')
      const cands = db.searchPastaFTS(channel, ftsQ)
        .map((c) => ({ ...c, coverage: pastaKeywordCoverage(c.message, kw) }))
        .filter((c) => c.coverage > 0)
      if (cands.length > 0) {
        // relevance first — reps/length already gated pasta-ness, so the remaining job is
        // picking WHICH pasta was asked for, not whether it is one.
        cands.sort((a, b) => b.coverage - a.coverage || b.reps - a.reps || b.message.length - a.message.length)
        return cands[0]
      }
    } catch {}
  }
  // no keyword hit — fall back to whatever chat repeats most ("what was that pasta?")
  try {
    const rep = db.findRepeatedMessages(channel, null, 3, 180, 5)
    if (rep.length > 0) return { message: rep[0].message, reps: 3, coverage: 0 }
  } catch {}
  return null
}

function pastaKeywords(query: string): string[] {
  return query.toLowerCase().split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ''))
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !PASTA_SCAFFOLD.has(w))
    .slice(0, 6)
}

/** the pasta text as it should be posted — normalised whitespace, length-capped */
export function pastaText(hit: PastaHit): string {
  return hit.message.replace(/\s+/g, ' ').trim().slice(0, 460)
}

// A hit we trust enough to post verbatim without the model in the loop. The model kept
// "reciting" pastas by substituting words with the kripp emote ("Subscribe kripp Kripp's
// kripp for kripp daily kripp..."), so a confident hit skips it entirely.
export function isConfidentPasta(hit: PastaHit): boolean {
  return hit.coverage >= 2 && hit.reps >= 3
}


