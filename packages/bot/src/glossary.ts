// Authoritative keyword/mechanic definitions for The Bazaar.
//
// The bazaardb.gg dump has only items/skills/monsters — no glossary. So a keyword
// question ("what does flying do", "how does poison work") matched no real answer
// and fell to the model, which invented mechanics (it once claimed Flying gives
// "+25/50% damage/burn/poison/shield/heal/regen" — 100% false, called out live).
// These defs are injected as authoritative Game data so the bot states the real rule.
//
// SOURCE: official wiki thebazaar.wiki.gg (Flying also confirmed in-game + gamerblurb).
// Only verified mechanics live here. Keywords that aren't real (Lethal, Value) are
// deliberately ABSENT so the definitional guard refuses them instead of guessing.
// Keep each one line, tooltip-tight. On a balance patch, fix the line here.

export const GLOSSARY: Record<string, string> = {
  flying:
    'a STATE an item can enter (not a skill or passive). Flying items are affected by Freeze and Slow for half as long. It grants NO damage/burn/poison/shield/heal/regen bonus on its own.',
  poison:
    'deals damage equal to the Poison amount once per second; bypasses Shield, hits Health directly. Reduced by Regen and by healing (a heal removes Poison = 5% of the heal); Lifesteal does not remove it.',
  burn:
    'deals damage twice per second, losing 1 each tick. Shield halves Burn damage taken; a heal removes Burn = 5% of the heal (Lifesteal does not).',
  freeze: "stops a target item's cooldown from charging for X seconds; can stack on an item.",
  slow: "doubles an affected item's cooldown (charges at half speed) for X seconds; only hits items with a cooldown.",
  haste: "doubles an affected item's charge speed for X seconds; only hits items with a cooldown.",
  shield: 'blocks Damage 1-for-1, and blocks Burn at half value, but does NOT block Poison.',
  heal: 'restores Health (capped at Max Health) and removes Poison and Burn each = 5% of the amount healed.',
  regen:
    'Regeneration — heals you by the Regen amount once per second (can crit) and reduces incoming Poison by its amount before Poison hits.',
  crit: 'a critical hit doubles (2x) the affected effect — works on Damage, Poison, Heal, Regen, Shield, or Burn.',
  lifesteal:
    'deals Damage and heals you for an equal amount; unlike a normal heal it does NOT remove Poison or Burn.',
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
  lifesteal: 'lifesteal', lifesteals: 'lifesteal',
  charges: 'charge', charging: 'charge', charged: 'charge',
  cooldowns: 'cooldown',
  reloads: 'reload', reloading: 'reload',
  multicasts: 'multicast',
  damages: 'damage',
  sandstorms: 'sandstorm',
}

// canonical key -> label shown in the prompt (the keyword, Title-cased)
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
