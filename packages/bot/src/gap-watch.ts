// Knowledge-gap watch.
//
// The bot already knows when it can't ground a game question — ai-build.ts gates the
// model off inventing a mechanic in that case. What it never did was TELL anyone. On
// 2026-08-06 patch 17 shipped Tempo, the glossary had no entry, and chat asked six
// times across one stream. Every answer was an honest "I don't have that" and nobody
// found out until a human read the log and noticed the bot had also turned rude.
//
// So: count ungrounded game questions by subject. When the same subject comes up
// repeatedly it isn't a one-off miss, it's a hole in the data — escalate once via the
// same ntfy path the patch pipeline uses. A single miss stays quiet; only a pattern
// is worth a phone buzz.
//
// Deliberately in-memory: this is telemetry about a live stream, a burst plays out in
// hours, and losing the counters on a deploy restart costs nothing. No migration, no
// table, no write amplification on the hot path.

import { notify } from './notify'
import { DELIBERATELY_UNGLOSSARIED } from './glossary'

const WINDOW_MS = 6 * 60 * 60 * 1000
// three separate asks about one subject with nothing to say = a real hole, not a typo
const THRESHOLD = 3
// guard against a pathological stream filling memory with junk terms
const MAX_TERMS = 500

// question scaffolding and chat filler — what's left is what they actually asked about
const STOPWORDS = new Set([
  'what', 'whats', 'when', 'where', 'which', 'who', 'whos', 'why', 'how', 'does', 'did',
  'the', 'this', 'that', 'these', 'those', 'they', 'them', 'there', 'their', 'then',
  'you', 'your', 'youre', 'yours', 'are', 'was', 'were', 'been', 'being', 'have', 'has',
  'had', 'here', 'with', 'from', 'about', 'into', 'onto', 'over', 'under', 'and', 'but',
  'for', 'not', 'can', 'cant', 'will', 'wont', 'would', 'should', 'could', 'its',
  'just', 'like', 'know', 'tell', 'say', 'said', 'get', 'got', 'make', 'made', 'work',
  'works', 'mean', 'means', 'good', 'best', 'bad', 'worth', 'much', 'many', 'more',
  'some', 'any', 'all', 'one', 'two', 'now', 'still', 'even', 'also', 'really', 'thing',
  'stuff', 'item', 'items', 'card', 'cards', 'game', 'bazaar', 'bazaarinfo', 'please',
])

interface TermState {
  hits: number[]        // timestamps inside the window
  samples: string[]     // up to 3 verbatim queries, for the alert body
  channels: Set<string>
  alerted: boolean
}

const terms = new Map<string, TermState>()

// content words only: 4+ chars so "why"/"gain" noise and emote fragments don't compete
// with the actual subject, deduped so "tempo tempo tempo" counts once per message.
export function subjectTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[a-z][a-z0-9']{3,}/g) ?? []
  return [...new Set(words.filter((w) => !STOPWORDS.has(w) && !DELIBERATELY_UNGLOSSARIED.has(w)))]
}

function prune(state: TermState, now: number): void {
  // `t <= now`, not `t < now` — several asks can land in the same millisecond and
  // dropping them would make a burst uncountable
  state.hits = state.hits.filter((t) => t <= now && now - t < WINDOW_MS)
}

/**
 * Record a game question the bot could not ground. Fires an owner alert the first time
 * a subject crosses the threshold inside the window. Never throws — a telemetry miss
 * must not cost chat an answer.
 */
export function recordGap(channel: string, query: string, now = Date.now()): void {
  try {
    for (const term of subjectTerms(query)) {
      let state = terms.get(term)
      if (!state) {
        if (terms.size >= MAX_TERMS) evictStalest(now)
        state = { hits: [], samples: [], channels: new Set(), alerted: false }
        terms.set(term, state)
      }
      prune(state, now)
      state.hits.push(now)
      state.channels.add(channel)
      if (state.samples.length < 3 && !state.samples.includes(query)) state.samples.push(query)
      if (state.hits.length >= THRESHOLD && !state.alerted) {
        state.alerted = true
        void notify(
          `gap-${term}`,
          `bazaarinfo: no answer for "${term}"`,
          [
            `asked ${state.hits.length}x in ${[...state.channels].join(', ')} with nothing to ground it.`,
            '',
            ...state.samples.map((s) => `- ${s}`),
            '',
            'if this is a real mechanic, add it to glossary.ts (or check it resolves in store).',
          ].join('\n'),
          'default',
        )
      }
    }
  } catch {}
}

// drop whichever term has gone quietest — a burst that matters keeps getting hits
function evictStalest(now: number): void {
  let oldestKey: string | undefined
  let oldest = Infinity
  for (const [key, state] of terms) {
    const last = state.hits[state.hits.length - 1] ?? 0
    if (last < oldest) { oldest = last; oldestKey = key }
  }
  if (oldestKey) terms.delete(oldestKey)
  // a full map of equally-fresh terms means the window itself is stale — clear it
  if (terms.size >= MAX_TERMS && now - oldest > WINDOW_MS) terms.clear()
}

export function resetGapWatchForTests(): void {
  terms.clear()
}

export function gapWatchSizeForTests(): number {
  return terms.size
}
