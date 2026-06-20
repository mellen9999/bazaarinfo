// Boons — roguelike build system. On level-up a player is offered 3 perks and
// picks one (!b pick). Boons are passive modifiers aggregated in combat, turning
// the core loop from a stat-sim into a compounding build (Hades / Slay-the-Spire).
import type { Character } from './types'

export interface BoonMods {
  toHit: number          // flat bonus to the attack roll
  dmgMult: number        // multiplicative damage (1.0 = none)
  critThreshold: number  // min d20 to crit (20 = default)
  lifestealPct: number   // fraction of damage dealt healed back
  acBonus: number        // flat AC
  goldBonusPct: number   // extra gold per kill
  regenPerFloor: number  // HP healed on floor clear
  executionerPct: number // extra dmg mult vs enemies below 30% HP
  rerollFumble: boolean  // reroll a natural 1 once
}

export interface Boon {
  id: string
  name: string
  desc: string
  mods?: Partial<BoonMods>
  onPick?: (char: Character) => void
}

export const BOONS: Boon[] = [
  { id: 'berserker',  name: 'Berserker',   desc: '+20% damage',                       mods: { dmgMult: 0.20 } },
  { id: 'deadeye',    name: 'Deadeye',     desc: 'crit on 19-20',                     mods: { critThreshold: 19 } },
  { id: 'vampiric',   name: 'Vampiric',    desc: 'lifesteal 25% of damage dealt',     mods: { lifestealPct: 0.25 } },
  { id: 'ironhide',   name: 'Ironhide',    desc: '+2 AC',                             mods: { acBonus: 2 } },
  { id: 'precise',    name: 'Precise',     desc: '+2 to hit',                         mods: { toHit: 2 } },
  { id: 'looter',     name: 'Looter',      desc: '+50% gold from kills',              mods: { goldBonusPct: 0.5 } },
  { id: 'regen',      name: 'Regenerator', desc: 'heal 20 HP each floor cleared',     mods: { regenPerFloor: 20 } },
  { id: 'executioner',name: 'Executioner', desc: '+50% damage vs foes below 30% HP',  mods: { executionerPct: 0.5 } },
  { id: 'lucky',      name: 'Lucky',       desc: 'reroll a natural 1 once per attack', mods: { rerollFumble: true } },
  { id: 'titan',      name: 'Titan',       desc: '+30 max HP (and heal it now)',      onPick: (c) => { c.maxHp += 30; c.hp += 30 } },
  { id: 'glasscannon',name: 'Glass Cannon',desc: '+50% damage, -25% max HP',          mods: { dmgMult: 0.50 }, onPick: (c) => { const cut = Math.floor(c.maxHp * 0.25); c.maxHp -= cut; c.hp = Math.max(1, c.hp - cut) } },
  { id: 'battery',    name: 'Arcane Battery', desc: '+1 to your main resource (slot/ki/rage)', onPick: (c) => {
    if (c.maxSpellSlots > 0) { c.maxSpellSlots++; c.spellSlots++ }
    else if (c.maxKiPoints > 0) { c.maxKiPoints++; c.kiPoints++ }
    else c.rageCharges++
  } },
  { id: 'bulwark',    name: 'Bulwark',     desc: '+2 AC and heal 15 HP now',          mods: { acBonus: 2 }, onPick: (c) => { c.hp = Math.min(c.maxHp, c.hp + 15) } },
]

const BY_ID = new Map(BOONS.map((b) => [b.id, b]))

export function getBoon(id: string): Boon | undefined {
  return BY_ID.get(id)
}

const DEFAULT_MODS: BoonMods = {
  toHit: 0, dmgMult: 1, critThreshold: 20, lifestealPct: 0, acBonus: 0,
  goldBonusPct: 0, regenPerFloor: 0, executionerPct: 0, rerollFumble: false,
}

// aggregate all owned boons into a single mod set
export function boonMods(char: Character): BoonMods {
  const out: BoonMods = { ...DEFAULT_MODS }
  for (const id of char.boons ?? []) {
    const m = BY_ID.get(id)?.mods
    if (!m) continue
    if (m.toHit) out.toHit += m.toHit
    if (m.dmgMult) out.dmgMult += m.dmgMult
    if (m.critThreshold !== undefined) out.critThreshold = Math.min(out.critThreshold, m.critThreshold)
    if (m.lifestealPct) out.lifestealPct += m.lifestealPct
    if (m.acBonus) out.acBonus += m.acBonus
    if (m.goldBonusPct) out.goldBonusPct += m.goldBonusPct
    if (m.regenPerFloor) out.regenPerFloor += m.regenPerFloor
    if (m.executionerPct) out.executionerPct += m.executionerPct
    if (m.rerollFumble) out.rerollFumble = true
  }
  return out
}

// deterministic 3-boon offer, excluding ones the player already owns
export function rollBoonOffer(char: Character, seed: number): string[] {
  const owned = new Set(char.boons ?? [])
  const pool = BOONS.filter((b) => !owned.has(b.id)).map((b) => b.id)
  if (pool.length <= 3) return pool
  // Fisher-Yates with a seeded LCG
  let s = (seed >>> 0) || 1
  const next = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, 3)
}

export function applyBoonOnPick(char: Character, id: string): void {
  BY_ID.get(id)?.onPick?.(char)
}

// stable hash for offer seeds
export function offerSeed(username: string, level: number): number {
  let h = 2166136261
  const s = `${username}:${level}`
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

// short label for the character sheet, e.g. "Berserker,Deadeye"
export function boonLabels(char: Character): string {
  return (char.boons ?? []).map((id) => BY_ID.get(id)?.name ?? id).join(',')
}
