// The game keywords the bot glossary and the overlay both talk about, and the
// inflections players (and card text) use for them. One list, so a keyword added
// here is defined, styled and aliased everywhere instead of drifting per surface.
// Definitions stay with the bot (glossary.ts) — only names live here.

// canonical key -> label shown in output (the keyword, Title-cased)
export const KEYWORD_LABEL: Record<string, string> = {
  flying: 'Flying', poison: 'Poison', burn: 'Burn', freeze: 'Freeze', slow: 'Slow',
  haste: 'Haste', shield: 'Shield', heal: 'Heal', regen: 'Regen', crit: 'Crit',
  lifesteal: 'Lifesteal', charge: 'Charge', ammo: 'Ammo',
  reload: 'Reload', multicast: 'Multicast', damage: 'Damage',
}

// surface form (lowercase) -> canonical key. the common inflections players
// actually type, which also covers what card text prints (Frozen, Slowed, Burns…).
export const KEYWORD_ALIASES: Record<string, string> = {
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
  reloads: 'reload', reloading: 'reload',
  multicasts: 'multicast',
  damages: 'damage',
}
