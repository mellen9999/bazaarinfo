// item/monster/tag/hero lookup pipeline: arg parsing, noise-tolerant salvage, fuzzy
// relevance checks, and the trivia-standings regexes the dispatcher tests queries against.
import { formatItem, formatEnchantment, formatMonster, formatEvent, truncate, resolveTooltip, compressTooltip, TIER_ORDER } from '@bazaarinfo/shared'
import type { TierName, Monster, SkillDetail, BazaarCard } from '@bazaarinfo/shared'
import * as store from './store'
import type { CommandContext } from './commands'
import { patchNote, withSuffix, logMiss, logHit, aiOrQuip } from './commands-reply'

const TIERS = ['bronze', 'silver', 'gold', 'diamond', 'legendary']

export function capitalize(s: string): string {
  if (!s) return s
  return s[0].toUpperCase() + s.slice(1)
}

interface ParsedArgs {
  item: string
  tier?: TierName
  enchant?: string
}

export function parseArgs(words: string[]): ParsedArgs {
  const enchList = store.getEnchantments()
  const remaining = [...words]
  let tier: TierName | undefined
  let enchant: string | undefined

  // whole-phrase guard: if the ENTIRE phrase is a literal card title, never splice a
  // tier/enchant token out of it. "diamond heart" is the skill Diamond Heart — not a
  // Diamond-tier "heart" (which fuzzy-resolves to Dragon Heart: a silent wrong answer).
  // singular-tolerant so "diamond hearts" resolves too. genuine tier queries
  // ("diamond subscraper") aren't exact card titles, so they still strip normally.
  const phrase = remaining.join(' ')
  if (store.exact(phrase) || store.exact(phrase.replace(/s$/, ''))) return { item: phrase }

  // extract tier from any position (exact match wins over enchant prefix)
  const tierIdx = remaining.findIndex((w) => TIERS.includes(w.toLowerCase()))
  if (tierIdx !== -1) {
    tier = capitalize(remaining[tierIdx].toLowerCase()) as TierName
    remaining.splice(tierIdx, 1)
  }

  // extract enchantment from any position if other words remain for item
  // require exact match or prefix within 2 chars of full name to avoid "shield"→"shielded".
  // but NOT if the whole phrase is itself a real item ("heavy crossbow" = the item Heavy
  // Crossbow, not Heavy-enchanted crossbow) — ~12 items start with an enchant word.
  if (remaining.length > 1 && remaining.length <= 8 && !store.exact(remaining.join(' ')) && !store.exact(remaining.join(' ').replace(/s$/, ''))) {
    for (let i = 0; i < remaining.length; i++) {
      const lower = remaining[i].toLowerCase()
      const matches = enchList.filter((e) => e.startsWith(lower))
      if (matches.length === 1 && (lower === matches[0] || (lower.length >= 3 && lower.length >= matches[0].length * 0.8))) {
        enchant = capitalize(matches[0])
        remaining.splice(i, 1)
        break
      }
    }
  }

  return { item: remaining.join(' '), tier, enchant }
}

// --- noise-tolerant salvage ---
// chatters wrap item names in hero names, size words, and filler ("vanessa flying fish
// medium item"). when the direct lookup misses, two rescue passes run before the AI:
// 1. subphrase scan — longest contiguous word run that exact-matches a card title
// 2. noise strip — drop hero/size/filler tokens; a stripped hero name prefers that
//    hero's cards among fuzzy candidates. only fires post-miss, so real titles that
//    contain noise words ("Small Refresh", "The Boss") are never touched.
const NOISE_WORDS = new Set([
  'small', 'medium', 'large', // sizes — card output shows size anyway
  'item', 'items', 'card', 'cards', 'skill', 'skills', 'weapon', 'thing', 'thingy',
  'the', 'a', 'an', 'that', 'this', 'his', 'her', 'its', 'their',
  'or', 'whatever', 'like', 'called', 'named', 'from', 'has', 'have', 'with',
  'pls', 'plz', 'please',
])

interface Salvaged { query: string; hero?: string }

export function salvageQuery(query: string): Salvaged | null {
  const words = query.split(/\s+/).map((w) => w.replace(/[?!.,]+$/, '')).filter(Boolean)
  if (words.length < 2) return null
  // pass 1: longest exact-title subphrase (singular-tolerant, skips the full phrase —
  // the caller already tried it)
  for (let len = words.length - 1; len >= 1; len--) {
    for (let start = 0; start + len <= words.length; start++) {
      const gram = words.slice(start, start + len).join(' ')
      if (store.exact(gram) || store.exact(gram.replace(/s$/, ''))) return { query: gram }
    }
  }
  // pass 2: strip hero + noise tokens ("stelle item beam" → "beam" scoped to Stelle)
  let hero: string | undefined
  const kept: string[] = []
  for (const w of words) {
    const h = store.findExactHero(w.replace(/'s$/, ''))
    if (h) { hero = h; continue }
    if (NOISE_WORDS.has(w.toLowerCase())) continue
    kept.push(w)
  }
  if (kept.length === words.length) return null // nothing stripped, no new signal
  return { query: kept.join(' '), hero }
}
export function resolveSkills(monster: Monster): Map<string, SkillDetail> {
  const details = new Map<string, SkillDetail>()
  if (!monster.MonsterMetadata?.skills) return details
  for (const s of monster.MonsterMetadata.skills) {
    if (details.has(s.title)) continue
    const card = store.findCard(s.title)
    if (!card || !card.Tooltips.length) continue
    const tooltip = card.Tooltips.map((t) =>
      compressTooltip(resolveTooltip(t.text, card.TooltipReplacements, s.tier as TierName)),
    ).join('; ')
    details.set(s.title, { name: s.title, tooltip })
  }
  return details
}
export function validateTier(card: { Tiers: TierName[] }, tier?: TierName): { tier: TierName | undefined; note: string | null } {
  if (!tier) return { tier: undefined, note: null }
  if (card.Tiers.includes(tier)) return { tier, note: null }
  // find highest available tier
  const available = TIER_ORDER.filter((t) => card.Tiers.includes(t))
  const highest = available[available.length - 1]
  if (highest) return { tier: highest, note: `max tier is ${highest}` }
  return { tier: undefined, note: null }
}

// "who won the trivia?", "did tidolar win the quiz?", "trivia leaderboard" — interrogative
// questions about trivia RESULTS, answered from the DB (never the AI, which invents winners).
// scoped so a topic request like "trivia about winning" is NOT matched (no who/did, and
// "trivia about" != "trivia leaderboard").
// present-tense win|winning intentionally omitted — "who's winning" means current standings
// (handled by BARE_STANDINGS_RE), not who won the last round.
export const TRIVIA_RESULT_RE = /\bwho\b[^?]*\b(won|winner)\b[^?]*\b(trivia|quiz|round|last\s*one)\b|\b(trivia|quiz)\s+(leaderboard|standings|scores?|rankings?|top)\b|\bdid\b[^?]*\bwin\b[^?]*\b(trivia|quiz|round)\b/i

// trailing-trivia guard: phrases that end in "trivia"/"quiz" but are NOT a topic-first
// round request — questions ("who won trivia"), control verbs ("stop the trivia"),
// preference statements ("i love trivia"). anchored interrogatives so real titles
// survive ("life is strange trivia", "how to train your dragon trivia").
export const TRAILING_TRIVIA_BAIL = /[?]|^(?:who|whose|what|when|where|why|which|did|does|do|is|are|was|were|can|could|should|would|will|how(?!\s+to\b))\b|\b(?:won|winner|stop|end|cancel|skip|pause|start|begin|make|create|run|generate|gen|give|gimme|wanna|want|spam|hate|no|not)\b|\b(?:i|we|u|you|they)\s+(?:love|like|need)\b/i
// of a matched result-question, which ones want the standings table vs the last winner.
export const TRIVIA_STANDINGS_RE = /\b(leaderboard|standings|scores?|rankings?|top)\b/i
// a whole-query standings ask, answered from the exact trivia table (free, no AI). anchored
// so only a bare command matches — a conversational mention falls through to the AI, which
// is itself grounded with the standings data (ai-build STANDINGS_RE) so it answers too.
export const BARE_STANDINGS_RE = /^(?:the\s+|trivia\s+|quiz\s+|show\s+(?:me\s+)?(?:the\s+)?)?(?:leaderboard|leaderboards|standings|scoreboard|rankings?)\??$|^who(?:'?s|\s+is|\s+are)?\s+(?:winning|leading|in\s+(?:the\s+)?lead|on\s+top|first|ahead)(?:\s+(?:the\s+|in\s+|at\s+)?(?:trivia|quiz))?\??$|^who(?:\s+has|\s+got|'s\s+got)\s+(?:the\s+)?(?:most|highest|best|top)\s+(?:wins?|points?|scores?)\??$|^(?:points?|scores?|wins?)\s+leader(?:board)?\??$|^lead(?:er|ing)\s+in\s+(?:points?|wins?|scores?)\??$|^how\s+many\s+(?:trivia\s+|my\s+)?(?:wins?|points?|scores?)\s+(?:(?:do|have|got)\s+)?i\b.*$|^(?:do\s+i\s+have\s+)?(?:more|fewer|higher|better)\s+(?:trivia\s+)?(?:wins?|points?|scores?)\s+than\s+@\w+\??$/i

// non-anchored standings clause — for compound queries ("what does burn do and who's winning")
// where BARE_STANDINGS_RE (anchored) doesn't match but a standings intent is still present.
export const EMBEDDED_STANDINGS_RE = /\b(leaderboard|standings|scoreboard|rankings?|who(?:'?s|\s+is)?\s+(?:winning|leading|on top)|most\s+wins|most\s+points)\b/i

// minimal levenshtein for single-token typo matching (standings keyword proximity check)
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const la = a.length, lb = b.length
  if (la === 0) return lb
  if (lb === 0) return la
  const row = Array.from({ length: lb + 1 }, (_, i) => i)
  for (let i = 1; i <= la; i++) {
    let prev = i
    for (let j = 1; j <= lb; j++) {
      const cur = a[i - 1] === b[j - 1] ? row[j - 1] : Math.min(row[j - 1], row[j], prev) + 1
      row[j - 1] = prev
      prev = cur
    }
    row[lb] = prev
  }
  return row[lb]
}

// did-you-mean for a missed `!b tag <x>` — suggests real tag names (prefix or small edit
// distance), reusing the levenshtein above. falls through to AI when nothing's close.
export function suggestTags(query: string, limit = 3): string[] {
  const q = query.toLowerCase()
  return store.getTagNames()
    .map((t) => ({ t, d: levenshtein(q, t.toLowerCase()) }))
    .filter((x) => x.t.toLowerCase().startsWith(q) || x.d <= Math.min(2, Math.ceil(x.t.length / 3)))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((x) => x.t)
}

const STANDINGS_WORDS = ['leaderboard', 'leaderboards', 'standings', 'scoreboard', 'rankings']
// returns true if q is a single-token typo (edit dist <=1) of a standings keyword
export function isStandingsTypo(q: string): boolean {
  if (q.includes(' ')) return false
  const clean = q.toLowerCase().replace(/\?+$/, '')
  return STANDINGS_WORDS.some((k) => levenshtein(clean, k) <= 1)
}

// strip conversational prefixes so "what is birdge" → "birdge"
// "how about" / "what about" excluded — they're continuations, not direct lookups
const QUESTION_PREFIX = /^(?:what(?:'?s | is | are )|tell me about |show me |look up |find me |can you (?:find |look up |show ))/i

function stripQuestionPrefix(s: string): string {
  const stripped = s.replace(QUESTION_PREFIX, '')
  // only strip if something meaningful remains
  return stripped.length >= 2 ? stripped : s
}

// shared hero-pool reply ("[Vanessa] item, item, …") used by the `hero <name>` subcommand
// and by itemLookup's bare-hero routing.
export function heroPoolReply(heroName: string, items: BazaarCard[], suffix: string): string {
  // lead with the total count — the list truncates to ~40 of 130+ titles with a bare "...",
  // which reads as a complete pool; the count supplies the missing scale.
  const noun = items.length === 1 ? 'item' : 'items'
  return withSuffix(truncate(`[${heroName}] ${items.length} ${noun}: ${items.map((i) => i.Title).join(', ')}`), suffix)
}

// a bazaar item name is often a plain english word (toaster, cannon, anchor, crane, lighter).
// titleOverlaps: does query-word `w` correspond to any word of `title` (exact or substring,
// so "pinkbirdge" matches "birdge")?
function titleOverlaps(title: string, w: string): boolean {
  const tws = title.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s\-]+/)
  return tws.some((tw) => tw.length >= 3 && (w === tw || (w.length >= 3 && (w.includes(tw) || tw.includes(w)))))
}
// true when `title` is merely MENTIONED in `qw`, not the subject of the query: 2+ substantive
// words remain once the title's own words, hero names, and known filler (sizes/"item"/articles)
// are removed. keeps sentences that happen to contain an item name ("tips for sterilising
// fingers using a toaster") out of the deterministic lookup so the AI answers what was asked.
// filler-wrapped lookups ("vanessa flying fish medium item") leave nothing over and still resolve.
function isIncidentalMention(title: string, qw: string[]): boolean {
  return qw.filter((w) => w.length >= 3 && !NOISE_WORDS.has(w) && !store.findExactHero(w) && !titleOverlaps(title, w)).length >= 2
}

export async function itemLookup(cleanArgs: string, ctx: CommandContext, suffix: string): Promise<string | null> {
  const stripped = stripQuestionPrefix(cleanArgs)
  const words = stripped.split(/\s+/)
  const { item: query, tier, enchant } = parseArgs(words)

  if (!query) return null

  const queryWords = query.toLowerCase().split(/\s+/)

  if (enchant) {
    // prefer cards that actually have the requested enchant — disambiguates
    // skill/item collisions like "depth charge" (skill) vs "Elemental Depth Charge" (item)
    const exact = store.exact(query)
    const candidates = exact ? [exact, ...store.search(query, 5)] : store.search(query, 5)
    const card = candidates.find((c) => c.Enchantments[enchant]) ?? candidates[0]
    // a fuzzy match whose item name is just mentioned in a sentence ("a golden toaster would
    // be nice") isn't an enchant lookup — let the AI answer. an exact item name still wins.
    if (card && !exact && isIncidentalMention(card.Title, queryWords)) return null
    if (!card) {
      logMiss(query, ctx)
      const s = store.suggest(query, 3)
      return s.length
        ? withSuffix(`no item found for ${query} — did you mean: ${s.join(', ')}?`, suffix)
        : aiOrQuip(`${query} ${enchant}`, ctx, suffix)
    }
    const ev = validateTier(card, tier)
    logHit('enchant', query, `${card.Title}+${enchant}`, ctx, ev.tier)
    const enchantResult = formatEnchantment(card, enchant, ev.tier)
    return withSuffix(ev.note ? `${enchantResult} (${ev.note})` : enchantResult, suffix)
  }

  // items first (exact then fuzzy) — !b mob exists for explicit monster lookups
  const exactCard = store.exact(query)
  const card = exactCard ?? store.search(query, 1)[0]

  // a bare hero name beats a mere fuzzy item match: "dooley"/"vanessa"/"pyg" mean the hero's
  // whole pool, not a card that just shares the stem ("Dooley's Scarf"). only when there's no
  // EXACT item and the query exactly IS a hero name/alias, so item queries aren't hijacked.
  if (!exactCard) {
    const hero = store.findExactHero(query)
    if (hero) {
      const heroItems = store.byHero(hero)
      if (heroItems.length > 0) {
        logHit('hero', query, `${heroItems.length} items`, ctx)
        return heroPoolReply(hero, heroItems, suffix)
      }
    }
  }

  // reject fuzzy matches where the query doesn't meaningfully overlap with the title
  const isRelevantMatch = (title: string, isExact: boolean, qw: string[] = queryWords) => {
    if (isExact) return true
    // split CamelCase/PascalCase into words (LavaRoller → lava, roller)
    const titleWords = title.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s\-]+/)
    // single-word query: must appear as substring in title (enrage ≠ Leverage Momentum).
    // short queries (<=4 chars like "new") are too ambiguous for mid-word substring matching
    // ("new" ⊂ "Renewal") — require a word prefix so they fall through to the AI instead.
    if (qw.length === 1) {
      const q = qw[0]
      if (q.length <= 4) return titleWords.some((tw) => tw.startsWith(q) || q.startsWith(tw))
      return titleWords.some((tw) => tw.includes(q) || q.includes(tw))
    }
    // multi-word: a title word must overlap a query word, AND the item must not be a mere
    // incidental mention in a sentence (see isIncidentalMention).
    if (!qw.some((w) => titleOverlaps(title, w))) return false
    return !isIncidentalMention(title, qw)
  }

  if (card && isRelevantMatch(card.Title, !!exactCard)) {
    const v = validateTier(card, tier)
    logHit('item', query, card.Title, ctx, v.tier)
    const result = formatItem(card, v.tier, patchNote(card.Title))
    return withSuffix(v.note ? `${result} (${v.note})` : result, suffix)
  }

  const monster = store.findMonster(query)
  if (monster && isRelevantMatch(monster.Title, false)) {
    logHit('mob', query, monster.Title, ctx)
    return withSuffix(formatMonster(monster, resolveSkills(monster), patchNote(monster.Title)), suffix)
  }

  // exact event-encounter name ("!b bjorn") — lowest priority, so an item or monster
  // of the same name still wins. recognizes the encounter instead of falling to an
  // ungrounded AI guess. effect text isn't in the dump, so formatEvent points to bazaardb.
  const event = store.findEventExact(query)
  if (event) {
    logHit('event', query, event.Title, ctx)
    return withSuffix(formatEvent(event, patchNote(event.Title)), suffix)
  }

  // item + monster both missed — salvage the query: strip hero/size/filler wrapping
  // ("vanessa flying fish medium item" → "flying fish") and retry before giving up
  const salvaged = salvageQuery(query)
  if (salvaged) {
    if (!salvaged.query && salvaged.hero) {
      // nothing left but a hero ("vanessa items") → the hero's pool
      const heroItems = store.byHero(salvaged.hero)
      if (heroItems.length > 0) {
        logHit('hero', query, `${heroItems.length} items`, ctx)
        return heroPoolReply(salvaged.hero, heroItems, suffix)
      }
    } else if (salvaged.query) {
      const sExact = store.exact(salvaged.query)
      const candidates = sExact ? [sExact] : store.search(salvaged.query, 5)
      const heroCard = salvaged.hero ? candidates.find((c) => c.Heroes.includes(salvaged.hero!)) : undefined
      const sCard = heroCard ?? candidates[0]
      const sWords = salvaged.query.toLowerCase().split(/\s+/)
      // guard against salvage pulling a lone common-word item out of a real sentence: check
      // the incidental test against the ORIGINAL query, not the stripped-down salvaged form.
      if (sCard && isRelevantMatch(sCard.Title, !!sExact, sWords) && !isIncidentalMention(sCard.Title, queryWords)) {
        const v = validateTier(sCard, tier)
        logHit('item', query, sCard.Title, ctx, v.tier)
        const result = formatItem(sCard, v.tier, patchNote(sCard.Title))
        return withSuffix(v.note ? `${result} (${v.note})` : result, suffix)
      }
      const sMonster = store.findMonster(salvaged.query)
      if (sMonster && isRelevantMatch(sMonster.Title, false, sWords) && !isIncidentalMention(sMonster.Title, queryWords)) {
        logHit('mob', query, sMonster.Title, ctx)
        return withSuffix(formatMonster(sMonster, resolveSkills(sMonster), patchNote(sMonster.Title)), suffix)
      }
    }
  }

  // a loose hero-name match (typo/prefix/alias) still answers
  // with that hero's pool rather than deflecting to "no item found".
  const looseHero = store.findHeroName(query)
  if (looseHero) {
    const heroItems = store.byHero(query)
    if (heroItems.length > 0) {
      logHit('hero', query, `${heroItems.length} items`, ctx)
      return heroPoolReply(looseHero, heroItems, suffix)
    }
  }

  logMiss(query, ctx)

  // a mention-mode ask skips the fuzzy "did you mean" deflection — go straight to the AI,
  // which can read the reply/thread context a bare item-name guess can't.
  if (queryWords.length <= 2 && !ctx.mention) {
    const suggestions = store.suggest(query, 3)
    if (suggestions.length > 0) {
      return withSuffix(`no item found for ${query} — did you mean: ${suggestions.join(', ')}?`, suffix)
    }
  }
  // no item match — fall through to AI fallback in bazaarinfo()
  return null
}
