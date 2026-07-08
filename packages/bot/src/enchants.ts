// Authoritative generic definitions for The Bazaar's item enchantments.
//
// An enchantment is a permanent upgrade applied to a single item. The dump stores
// each enchant's effect PER item (Enchantments[name].tooltips), but every enchant
// has a consistent generic theme — verified here from the game's own verbatim
// tooltip text across all items (e.g. Golden = "This has double value", Radiant =
// "This is immune to Freeze, Slow and Destroy", Obsidian = "This has double Damage").
//
// This answers the bare/definitional ask ("what does fiery do", "golden enchant")
// that the parser can't: parseArgs only treats an enchant word as an enchant when
// there's ALSO an item to attach it to, so a lone enchant name fell to a fuzzy item
// miss. enchantAnswer() is the deterministic, no-API fix — gated so it NEVER steals
// an item+enchant lookup ("fiery boomerang" stays the item path).
//
// SOURCE: cache/items.json Enchantments tooltips (the game's own text). On a balance
// patch, re-derive from the dump. Only the 13 real enchants live here.

import { DEFINITIONAL_INTENT, BUILD_INTENT, COMPARISON_RE, isGlossaryTerm } from './glossary'

export const ENCHANTS: Record<string, string> = {
  golden:
    "doubles the item's Value (its sell price / gold worth). the economy enchant — no combat effect of its own.",
  heavy: 'the item also Slows an enemy item when used, and its own Slows last twice as long. it adds Slow.',
  icy: 'the item also Freezes an enemy item when used, and its own Freezes last twice as long. it adds Freeze.',
  turbo: 'the item also Hastes your items when used, and its own Hastes last twice as long. it adds Haste.',
  shielded: 'the item also grants Shield when used and has double its Shield. it adds Shield.',
  restorative: 'the item also Heals you when used. it adds Heal.',
  toxic: 'the item also applies Poison when used. it adds Poison.',
  fiery: 'the item also applies Burn when used and has double its Burn. it adds Burn.',
  shiny: 'the item gains +1 Multicast — it triggers its effect one extra time each use.',
  deadly: 'the item gains a large Crit Chance boost (often doubling it), so it crits far more often.',
  radiant: 'the item becomes immune to Freeze, Slow and Destroy — it can never be shut off.',
  obsidian: 'the item deals double Damage. the raw-damage enchant.',
  mossy: 'the item also grants Regen when used. it adds Regen.',
}

// canonical name -> Title-cased label shown in output
const LABEL: Record<string, string> = Object.fromEntries(
  Object.keys(ENCHANTS).map((k) => [k, k[0].toUpperCase() + k.slice(1)]),
)

// the query explicitly names the enchantment system — lets an enchant win over a
// same-spelled mechanic keyword ("shielded enchant" -> the enchant, not Shield).
const EXPLICIT_ENCHANT_RE = /\benchant(?:ed|ment|ments|s)?\b/i

// definitional framing + filler words stripped so the residual is JUST enchant
// name(s). if anything else survives (an item word, a build word) it's not a pure
// enchant-definition query and we bail — that's the anti-hijack guard.
const FILLER_RE =
  /\b(what'?s?|how|why|does|do|did|is|are|the|a|an|of|it|this|that|mean|means|meaning|work|works|explain|define|definition|tell|me|about|wtf|wdym|by|enchant|enchanted|enchantment|enchantments)\b/gi

function render(names: string[]): string {
  let out = names.map((n) => `${LABEL[n]}: ${ENCHANTS[n]}`).join(' | ')
  if (out.length > 460) out = out.slice(0, 457).replace(/\s+\S*$/, '') + '…'
  return out
}

// enchant names present as whole words, in canonical order, deduped
function matchedEnchants(lower: string): string[] {
  const out: string[] = []
  for (const n of Object.keys(ENCHANTS)) {
    if (new RegExp(`\\b${n}\\b`).test(lower)) out.push(n)
  }
  return out
}

// Deterministic generic-enchant answer. Fires on a bare enchant ("fiery"), a
// definitional ask ("what does fiery do", "golden enchant"), or a comparison
// ("fiery vs toxic"). Returns null when the query also carries a non-enchant word
// (an item, a build ask) so item+enchant lookups and strategy asks fall through.
export function enchantAnswer(query: string): string | null {
  const q = query.trim()
  if (!q) return null
  const lower = q.toLowerCase()
  const explicit = EXPLICIT_ENCHANT_RE.test(lower)

  // comparison: "fiery vs toxic", "compare golden and shiny"
  if (COMPARISON_RE.test(lower)) {
    const names = matchedEnchants(lower)
    return names.length >= 2 ? render(names.slice(0, 3)) : null
  }

  // build/list asks want items or the roster, not a definition ("best fiery item")
  if (BUILD_INTENT.test(lower) && !explicit) return null

  // residual after stripping framing + filler must be ONLY enchant names (1-2)
  const residual = lower.replace(FILLER_RE, ' ').replace(/[?!.,]/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (residual.length === 0 || residual.length > 2) return null
  const names: string[] = []
  for (const tok of residual) {
    if (!ENCHANTS[tok]) return null // a non-enchant token survived — not a pure enchant query
    if (!names.includes(tok)) names.push(tok)
  }
  if (names.length === 0) return null
  // overlap guard: an enchant word that's also a mechanic keyword (only "shielded")
  // stays with the glossary unless the query explicitly says "enchant".
  if (!explicit && names.some((n) => isGlossaryTerm(n))) return null
  return render(names)
}
