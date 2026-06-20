// Authoritative keyword/mechanic definitions for The Bazaar.
//
// The bazaardb.gg dump has only items/skills/monsters — no glossary. So a keyword
// question ("what is flying", "how does poison work") matched no real answer and
// either fuzzy-hit an item (the structured "!b what is flying" -> "Flying Pig" bug)
// or fell to the model, which invented mechanics (it once claimed Flying gives
// "+25/50% damage/burn/poison/shield/heal/regen" — false, called out live).
//
// These defs are the single source of truth, used two ways: injected into the AI
// prompt as authoritative game data, AND returned verbatim as a deterministic
// answer by glossaryAnswer() (no API call). So they're written clean + user-facing.
//
// SOURCE: official wiki thebazaar.wiki.gg (Flying also confirmed in-game + gamerblurb).
// Only verified mechanics live here. Non-keywords (Lethal, Value) are deliberately
// ABSENT so the guard refuses them instead of guessing. On a balance patch, fix the
// line here. Game-term capitalization (Freeze, Shield, Poison…) is intentional.

export const GLOSSARY: Record<string, string> = {
  flying:
    'a state an item can enter (not a skill or passive). flying items are affected by Freeze and Slow for half as long. it gives no damage/burn/poison/shield/heal/regen bonus on its own.',
  poison:
    'deals damage equal to the Poison amount once per second; bypasses Shield and hits Health directly. reduced by Regen and by healing (a heal removes Poison = 5% of the heal); Lifesteal does not remove it.',
  burn:
    'deals damage twice per second, losing 1 each tick. Shield halves Burn damage taken; a heal removes Burn = 5% of the heal (Lifesteal does not).',
  freeze: "stops a target item's cooldown from charging for X seconds; can stack on an item.",
  slow: "doubles an affected item's cooldown (it charges at half speed) for X seconds; only hits items with a cooldown.",
  haste: "doubles an affected item's charge speed for X seconds; only hits items with a cooldown.",
  shield: 'blocks Damage 1-for-1, and blocks Burn at half value, but does not block Poison.',
  heal: 'restores Health (capped at max Health) and removes Poison and Burn each = 5% of the amount healed.',
  regen:
    'Regeneration — heals you by the Regen amount once per second (can crit) and reduces incoming Poison by its amount before Poison hits.',
  crit: 'a critical hit doubles (2x) the affected effect — works on Damage, Poison, Heal, Regen, Shield, or Burn.',
  lifesteal:
    'deals Damage and heals you for an equal amount; unlike a normal heal it does not remove Poison or Burn.',
  charge: "instantly cuts X seconds off an item's current cooldown — a one-time speed-up, not a permanent reduction.",
  cooldown: 'the time an item needs between uses.',
  ammo: 'how many times an item can be used before it runs out; Reload restores spent Ammo.',
  reload: 'restores Ammo — "Reload X" restores X Ammo, plain Reload restores all.',
  multicast: "triggers an item's active effect multiple times on a single use (usually x2).",
  damage: 'hits the opponent for the amount, removing Shield first then Health; only items with Damage can gain Lifesteal.',
  sandstorm:
    "sudden-death: when a fight's timer runs out a Sandstorm starts dealing escalating damage to both players to force the fight to end.",
}

// surface form (lowercase, word-boundary) -> canonical glossary key. base forms +
// the common inflections players actually type. enrage/enraged/rage route to the
// Karnok KNOWLEDGE entry instead (hero-level), so they're intentionally not here.
const ALIASES: Record<string, string> = {
  fly: 'flying', flies: 'flying', flight: 'flying',
  poisoned: 'poison', poisons: 'poison',
  burned: 'burn', burning: 'burn', burns: 'burn',
  frozen: 'freeze', freezes: 'freeze', freezing: 'freeze',
  slowed: 'slow', slows: 'slow', slowing: 'slow',
  hasted: 'haste', hastes: 'haste',
  shields: 'shield', shielded: 'shield',
  heals: 'heal', healing: 'heal',
  regeneration: 'regen', regenerate: 'regen', regenerating: 'regen',
  critical: 'crit', crits: 'crit', critting: 'crit',
  lifesteals: 'lifesteal', lifesteel: 'lifesteal',
  charges: 'charge', charging: 'charge', charged: 'charge',
  cooldowns: 'cooldown',
  reloads: 'reload', reloading: 'reload',
  multicasts: 'multicast',
  damages: 'damage',
  sandstorms: 'sandstorm',
}

// canonical key -> label shown in output (the keyword, Title-cased)
const LABEL: Record<string, string> = {
  flying: 'Flying', poison: 'Poison', burn: 'Burn', freeze: 'Freeze', slow: 'Slow',
  haste: 'Haste', shield: 'Shield', heal: 'Heal', regen: 'Regen', crit: 'Crit',
  lifesteal: 'Lifesteal', charge: 'Charge', cooldown: 'Cooldown', ammo: 'Ammo',
  reload: 'Reload', multicast: 'Multicast', damage: 'Damage', sandstorm: 'Sandstorm',
}

// full surface->canonical index, built once: every base key maps to itself, plus aliases.
const SURFACE: Record<string, string> = (() => {
  const m: Record<string, string> = {}
  for (const k of Object.keys(GLOSSARY)) m[k] = k
  for (const [surface, canon] of Object.entries(ALIASES)) m[surface] = canon
  return m
})()

// Return authoritative definition lines for any glossary keyword present in the
// query (deduped by canonical key, capped). Empty when none match. The CALLER
// gates on definitional intent — we don't want "best damage build" to dump the
// Damage rule, only "what does damage do".
export function lookupKeywords(query: string, max = 4): string[] {
  const q = query.toLowerCase()
  const hits: string[] = []
  const seen = new Set<string>()
  for (const [surface, canon] of Object.entries(SURFACE)) {
    if (seen.has(canon)) continue
    if (new RegExp(`\\b${surface}\\b`).test(q)) {
      seen.add(canon)
      hits.push(`${LABEL[canon]}: ${GLOSSARY[canon]}`)
      if (hits.length >= max) break
    }
  }
  return hits
}

// Does the query ask what a thing IS / DOES / how it works? Gates glossary
// injection and the no-invent-mechanic guard. Also treats a bare keyword-only
// query ("flying", "poison?") as definitional.
export const DEFINITIONAL_INTENT =
  /\b(what(?:'s| is| are| does| do)?|how (?:does|do|to)|explain|define|definition of|meaning of|wtf is|wdym by|tell me about)\b/i

// build/list/comparison words — a query with these wants items or strategy, not a
// keyword definition ("what is the best flying item" -> list, not the Flying rule).
const BUILD_INTENT =
  /\b(best|worst|good|bad|meta|tier|build|recommend|synerg\w*|combo|counter|better|strongest|weakest|viable|worth|op|broken|items?|skills?)\b/i

// True when the query is exactly one glossary keyword (no extra words). Used so
// "!b flying" answers the mechanic, but "flying items" / "best flying" do not.
export function isBareKeyword(query: string): boolean {
  const tokens = query.trim().toLowerCase().replace(/[?!.]+$/, '').split(/\s+/).filter(Boolean)
  return tokens.length === 1 && !!SURFACE[tokens[0]]
}

// Deterministic keyword-definition answer for the structured "!b" path — no API
// call, always correct. Fires on a definitional ask ("what is flying") or a bare
// keyword ("flying"), but NOT on a build/list ask ("best flying item"). Returns
// null when it's not a keyword-definition query. Caller still gives an exact item
// name priority for a bare query (so an item literally named like a keyword wins).
export function glossaryAnswer(query: string): string | null {
  const q = query.trim()
  const bare = isBareKeyword(q)
  if (!bare) {
    if (!DEFINITIONAL_INTENT.test(q)) return null
    if (BUILD_INTENT.test(q)) return null
  }
  const hits = lookupKeywords(q, 3)
  if (hits.length === 0) return null
  let out = hits.join(' | ')
  if (out.length > 460) out = out.slice(0, 457).replace(/\s+\S*$/, '') + '…'
  return out
}
