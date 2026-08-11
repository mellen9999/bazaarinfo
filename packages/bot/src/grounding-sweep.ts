// grounding coverage sweep core — proves "how does X work" resolves to REAL data for
// every term in the Bazaar vocabulary, so the model always has something true to cite.
// consumed by the regression test (coverage.test.ts) and the CLI (scripts/coverage-sweep.ts);
// callers must loadStore() first.
import { getItems, getSkills, getMonsters, getEvents, getHeroNames, getTagNames, getEnchantments } from './store'
import { extractEntities } from './ai-query'
import { DELIBERATELY_UNGLOSSARIED } from './glossary'

export interface SweepResult {
  checked: number
  perKind: Map<string, number>
  gaps: { term: string; kind: string }[]
}

export const SWEEP_KINDS = ['item', 'skill', 'monster', 'event', 'hero', 'tag', 'enchant', 'keyword'] as const

function resolves(term: string): boolean {
  const e = extractEntities(`how does ${term} work`)
  return (
    e.glossary.length > 0 ||
    e.cards.length > 0 ||
    e.monsters.length > 0 ||
    e.knowledge.length > 0 ||
    e.effects.length > 0 ||
    e.hero !== undefined ||
    e.tag !== undefined
  )
}

// mechanic keywords mined from tooltip text: the game capitalizes its keywords
// mid-sentence ("Haste", "Multicast"). require presence on many distinct cards so
// card-name fragments and flavor words don't flood the list.
const KEYWORD_MIN_CARDS = 10
export function mineTooltipKeywords(): string[] {
  const keywordCards = new Map<string, Set<string>>()
  const all = [...getItems(), ...getSkills()]
  for (const card of all) {
    for (const tip of card.Tooltips ?? []) {
      for (const m of tip.text.matchAll(/(?<!^)(?<![.!?]\s)\b([A-Z][a-z]{3,})\b/g)) {
        let set = keywordCards.get(m[1])
        if (!set) keywordCards.set(m[1], (set = new Set()))
        set.add(card.Title)
      }
    }
  }
  const titleWords = new Set(all.flatMap((c) => c.Title.split(/\s+/)))
  return [...keywordCards]
    .filter(([w, cards]) => cards.size >= KEYWORD_MIN_CARDS && !titleWords.has(w))
    .map(([w]) => w)
}

function collectTerms(): { term: string; kind: string }[] {
  const out: { term: string; kind: string }[] = []
  const add = (terms: Iterable<string>, kind: string) => {
    for (const term of new Set(terms)) {
      if (!term || term.length < 2) continue
      if (DELIBERATELY_UNGLOSSARIED.has(term.toLowerCase())) continue
      out.push({ term, kind })
    }
  }
  add(getItems().map((c) => c.Title), 'item')
  add(getSkills().map((c) => c.Title), 'skill')
  add(getMonsters().map((m) => m.Title), 'monster')
  add(getEvents().map((c) => c.Title), 'event')
  add(getHeroNames(), 'hero')
  add(getTagNames(), 'tag')
  add(getEnchantments(), 'enchant')
  add(mineTooltipKeywords(), 'keyword')
  return out
}

function tally(terms: { term: string; kind: string }[], gaps: SweepResult['gaps']): SweepResult {
  const perKind = new Map<string, number>()
  for (const t of terms) perKind.set(t.kind, (perKind.get(t.kind) ?? 0) + 1)
  return { checked: terms.length, perKind, gaps }
}

export function sweepVocabulary(): SweepResult {
  const terms = collectTerms()
  return tally(terms, terms.filter((t) => !resolves(t.term)))
}

// non-blocking variant for the live bot: same sweep, but yields the event loop
// between small slices — the fuzzy path costs real CPU on passive hardware, and a
// dump-refresh background check must never freeze chat handling.
export async function sweepVocabularyChunked(chunkSize = 40): Promise<SweepResult> {
  const terms = collectTerms()
  const gaps: SweepResult['gaps'] = []
  for (let i = 0; i < terms.length; i += chunkSize) {
    for (const t of terms.slice(i, i + chunkSize)) {
      if (!resolves(t.term)) gaps.push(t)
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  return tally(terms, gaps)
}
