// Class definitions — the bridge between "any string is a class" and a real,
// balanced 5e chassis. Builtins are the 9 canonical classes; custom classes are
// AI-generated (or deterministically synthesized) defs bound to one of 9 proven
// mechanical chassis. Pure module: depends only on ./types. Persistence lives in
// ./db (db -> classdef), generation orchestration in ./ai-dm (ai-dm -> classdef).
import {
  CLASS_BASE_STATS, CLASS_HIT_DIE, CLASS_ATK_STAT, CLASS_WEAPON, CLASS_SAVE_PROFS,
  BUILTIN_AC_ARCHETYPE, acFromArchetype, getModifier,
} from './types'
import type { AbilityScores, AcArchetype } from './types'

// The 9 mechanical backbones. Each drives resolveSpell, passives and resources.
export type Chassis = 'rage' | 'surge' | 'smite' | 'sneak' | 'nuke' | 'heal' | 'chaos' | 'flurry' | 'curse'
export const CHASSIS_LIST: Chassis[] = ['rage', 'surge', 'smite', 'sneak', 'nuke', 'heal', 'chaos', 'flurry', 'curse']

export interface ClassDef {
  name: string                                   // display name (exactly as typed, sanitized)
  chassis: Chassis                               // mechanical backbone
  baseStats: AbilityScores
  hitDie: number                                 // 6 | 8 | 10 | 12
  atkStat: keyof AbilityScores
  weapon: { name: string; die: number; count: number }
  acArchetype: AcArchetype
  saveProfs: [keyof AbilityScores, keyof AbilityScores]
  signature: string                              // bespoke !b spell ability name
  role: string                                   // one-line flavor role (welcome narration)
  desc: string                                   // short stat/ability summary (!b join)
  builtin: boolean
}

const BUILTIN_CHASSIS: Record<string, Chassis> = {
  Barbarian: 'rage', Fighter: 'surge', Paladin: 'smite', Rogue: 'sneak',
  Wizard: 'nuke', Cleric: 'heal', Sorcerer: 'chaos', Monk: 'flurry', Warlock: 'curse',
}

const BUILTIN_SIGNATURE: Record<Chassis, string> = {
  rage: 'Rage', surge: 'Action Surge', smite: 'Divine Smite', sneak: 'Shadowstrike',
  nuke: 'Fireball', heal: 'Healing Word', chaos: 'Chaos Bolt', flurry: 'Flurry of Blows',
  curse: 'Hex + Eldritch Blast',
}

const BUILTIN_ROLE: Record<Chassis, string> = {
  rage: 'raging front-liner who enters berserker fury for bonus damage and resistance',
  surge: 'martial champion with Action Surge for devastating double attacks',
  smite: 'divine warrior who channels spell slots into radiant smite damage',
  sneak: 'cunning striker with automatic Sneak Attack extra damage dice',
  nuke: 'arcane scholar who devastates groups with Fireball',
  heal: 'divine healer who keeps the party standing with Healing Word',
  chaos: 'wild mage whose Chaos Bolt channels unpredictable magical power',
  flurry: 'disciplined martial artist spending ki for Flurry of Blows',
  curse: 'eldritch pactbinder who curses foes and blasts with dark energy',
}

const BUILTIN_DESC: Record<Chassis, string> = {
  rage: 'd12 HP, Rage (+2dmg + resistance), Greataxe 1d12',
  surge: 'd10 HP, Action Surge (double attack), Longsword 1d8',
  smite: 'd10 HP, Divine Smite (slot→+2d8 radiant on hit), Longsword 1d8',
  sneak: 'd8 HP, Sneak Attack (auto +Xd6), Rapier 1d8 (finesse)',
  nuke: 'd6 HP, Fireball (8d6 AoE fire), Fire Bolt cantrip 1d10',
  heal: 'd8 HP, Healing Word (bonus heal ally), Sacred Flame 1d8 radiant',
  chaos: 'd6 HP, Wild Magic (2d8 chaos + surge), Chaos Bolt 2d8',
  flurry: 'd8 HP, Flurry of Blows (ki→2 extra strikes), Unarmed 1d6',
  curse: 'd8 HP, Hex+Eldritch Blast (curse+1d10 force), 1/short rest',
}

// spell slots a chassis grants at level 1 (0 = uses a non-slot resource or passive)
export function spellSlotsLv1ForChassis(c: Chassis): number {
  switch (c) {
    case 'smite': case 'nuke': case 'heal': case 'chaos': return 2
    case 'curse': return 1
    default: return 0
  }
}

export function isSpellChassis(c: Chassis): boolean {
  return spellSlotsLv1ForChassis(c) > 0
}

function buildBuiltin(name: string): ClassDef {
  const chassis = BUILTIN_CHASSIS[name]
  return {
    name,
    chassis,
    baseStats: { ...CLASS_BASE_STATS[name] },
    hitDie: CLASS_HIT_DIE[name],
    atkStat: CLASS_ATK_STAT[name],
    weapon: { ...CLASS_WEAPON[name] },
    acArchetype: BUILTIN_AC_ARCHETYPE[name],
    saveProfs: [...CLASS_SAVE_PROFS[name]],
    signature: BUILTIN_SIGNATURE[chassis],
    role: BUILTIN_ROLE[chassis],
    desc: BUILTIN_DESC[chassis],
    builtin: true,
  }
}

export const BUILTIN_DEFS: Record<string, ClassDef> = Object.fromEntries(
  Object.keys(BUILTIN_CHASSIS).map((n) => [n, buildBuiltin(n)]),
)

// mechanical template a chassis defaults to (= its founding builtin) — used to
// fill any field the AI omits or returns invalid, and to seed synthetic classes.
const CHASSIS_TEMPLATE: Record<Chassis, ClassDef> = Object.fromEntries(
  CHASSIS_LIST.map((c) => [c, BUILTIN_DEFS[Object.keys(BUILTIN_CHASSIS).find((n) => BUILTIN_CHASSIS[n] === c)!]]),
) as Record<Chassis, ClassDef>

// --- registry: custom defs by normalized name (loaded from db on startup) ---
const registry = new Map<string, ClassDef>()

export function normClassName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim()
}

export function registerClassDef(def: ClassDef): void {
  registry.set(normClassName(def.name), def)
}

export function hasClassDef(name: string): boolean {
  const norm = normClassName(name)
  return registry.has(norm) || matchBuiltin(name) !== null
}

// builtin lookup: exact name, or unambiguous >=3-char prefix (keeps barb/rogue/wiz shorthands)
export function matchBuiltin(name: string): ClassDef | null {
  const arg = name.toLowerCase().trim()
  if (!arg) return null
  const names = Object.keys(BUILTIN_DEFS)
  const exact = names.find((n) => n.toLowerCase() === arg)
  if (exact) return BUILTIN_DEFS[exact]
  if (arg.length >= 3) {
    const pref = names.filter((n) => n.toLowerCase().startsWith(arg))
    if (pref.length === 1) return BUILTIN_DEFS[pref[0]]
  }
  return null
}

// sync resolver — never throws, never returns null. Engine hot paths rely on this.
// builtin -> registered custom -> deterministic synthetic fallback.
export function getClassDef(name: string): ClassDef {
  const builtin = matchBuiltin(name)
  if (builtin) return builtin
  const reg = registry.get(normClassName(name))
  if (reg) return reg
  return syntheticDef(name)
}

export function chassisOf(charOrName: string | { class: string }): Chassis {
  return getClassDef(typeof charOrName === 'string' ? charOrName : charOrName.class).chassis
}

export function charAC(char: { class: string; stats: AbilityScores }, itemAcBonus = 0): number {
  return acFromArchetype(getClassDef(char.class).acArchetype, char.stats, itemAcBonus)
}

export function maxHpFor(def: ClassDef, level: number, conScore: number): number {
  const conMod = getModifier(conScore)
  if (level <= 1) return def.hitDie + conMod
  return def.hitDie + conMod + (level - 1) * (Math.floor(def.hitDie / 2) + 1 + conMod)
}

export function maxSpellSlotsFor(def: ClassDef, level: number): number {
  const base = spellSlotsLv1ForChassis(def.chassis)
  if (base === 0) return 0
  if (def.chassis === 'curse') return Math.min(4, 2 + Math.floor(level / 4))
  return Math.min(10, base + Math.floor((level - 1) / 2))
}

// --- player-facing copy, single-sourced so builtin + custom read identically ---
export function spellHintFor(def: ClassDef): string {
  switch (def.chassis) {
    case 'rage':   return `${def.signature} (enter fury, +dmg+resistance)`
    case 'surge':  return `${def.signature} (attack twice)`
    case 'smite':  return `${def.signature} (slot → radiant burst)`
    case 'sneak':  return `attack — Sneak Attack auto triggers`
    case 'nuke':   return `${def.signature} (8d6 to all enemies)`
    case 'heal':   return `${def.signature} (restore ally HP)`
    case 'chaos':  return `${def.signature} (chaos damage + surge)`
    case 'flurry': return `${def.signature} (ki → 2 extra strikes)`
    case 'curse':  return `${def.signature} (curse + force bolt)`
  }
}

export function joinActionFor(def: ClassDef): string {
  if (def.chassis === 'sneak') return 'Sneak Attack is automatic on !b a'
  return `!b spell for ${def.signature}`
}

export function levelUpBonusFor(chassis: Chassis, newLevel: number): string {
  switch (chassis) {
    case 'rage':   return 'Rage damage +1'
    case 'surge':  return 'Action Surge refreshed'
    case 'smite':  return '+1 spell slot'
    case 'sneak':  return `Sneak Attack now ${Math.ceil(newLevel / 2)}d6`
    case 'nuke':   return '+1 spell slot, Fireball grows'
    case 'heal':   return '+1 spell slot, Healing Word +2'
    case 'chaos':  return '+1 spell slot, Wild Magic surge chance +5%'
    case 'flurry': return '+1 ki point'
    case 'curse':  return '+1 spell slot'
  }
}

// --- validation / clamping (bulletproof: AI output is never trusted) ---
const STATS: (keyof AbilityScores)[] = ['str', 'dex', 'con', 'int', 'wis', 'cha']
const HIT_DICE = [6, 8, 10, 12]
const WEAPON_DICE = [4, 6, 8, 10, 12]
const AC_ARCHETYPES: AcArchetype[] = ['unarmored', 'mail', 'plate', 'light', 'mage', 'monk', 'default']
const STAT_SUM_CAP = 79  // highest builtin (Rogue) — customs can't exceed the best builtin

function sanitizeText(s: unknown, max: number): string {
  if (typeof s !== 'string') return ''
  return s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

export function sanitizeDisplayName(raw: string): string {
  return sanitizeText(raw, 32)
}

function clampStats(raw: unknown, fallback: AbilityScores): AbilityScores {
  const r = (raw ?? {}) as Record<string, unknown>
  const out: AbilityScores = { ...fallback }
  for (const k of STATS) {
    const v = Number(r[k])
    out[k] = Number.isFinite(v) ? Math.max(8, Math.min(17, Math.round(v))) : fallback[k]
  }
  // shave the highest stat until total is within budget — keeps customs balanced
  let guard = 0
  while (STATS.reduce((s, k) => s + out[k], 0) > STAT_SUM_CAP && guard++ < 60) {
    const hi = STATS.reduce((a, b) => (out[b] > out[a] ? b : a), STATS[0])
    out[hi] = Math.max(8, out[hi] - 1)
  }
  return out
}

// deterministic 32-bit hash of a string (xfnv1a-ish) — same name → same class
function hashName(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const CHASSIS_ROLE_WORD: Record<Chassis, string> = {
  rage: 'berserker', surge: 'warrior', smite: 'crusader', sneak: 'assassin', nuke: 'battlemage',
  heal: 'cleric', chaos: 'wild mage', flurry: 'martial artist', curse: 'warlock',
}

// chassis-themed signature nouns — paired with a word lifted from the class name
const CHASSIS_SIG_NOUNS: Record<Chassis, string[]> = {
  rage: ['Smash', 'Rampage', 'Frenzy', 'Slam'],
  surge: ['Barrage', 'Blitz', 'Onslaught', 'Combo'],
  smite: ['Judgment', 'Wrath', 'Reckoning', 'Verdict'],
  sneak: ['Ambush', 'Backstab', 'Gambit', 'Strike'],
  nuke: ['Tornado', 'Eruption', 'Storm', 'Nova'],
  heal: ['Blessing', 'Renewal', 'Mend', 'Grace'],
  chaos: ['Maelstrom', 'Surge', 'Frenzy', 'Roulette'],
  flurry: ['Flurry', 'Barrage', 'Combo', 'Cyclone'],
  curse: ['Hex', 'Bane', 'Curse', 'Doom'],
}
const SYNTH_WEAPONS = ['Fang', 'Cleaver', 'Scepter', 'Shiv', 'Brand', 'Maul', 'Talon', 'Lash', 'Censer', 'Sigil']
const SIG_STOPWORDS = new Set(['the', 'of', 'a', 'an', 'and', 'to', 'my', 'your', 'is', 'with'])

// lift the most distinctive word from a class name (for name-derived signatures)
function salientWord(name: string, seed: number): string {
  const words = name.split(/\s+/).map((w) => w.replace(/[^A-Za-z]/g, '')).filter(Boolean)
  const meaty = words.filter((w) => w.length >= 3 && !SIG_STOPWORDS.has(w.toLowerCase()))
  const pool = meaty.length ? meaty : words
  if (!pool.length) return 'Mystic'
  const maxLen = Math.max(...pool.map((w) => w.length))
  const longest = pool.filter((w) => w.length === maxLen)
  const w = longest[seed % longest.length].slice(0, 14)
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
}

// deterministic, AI-free class. Always playable — the bulletproof floor.
export function syntheticDef(rawName: string): ClassDef {
  const name = sanitizeDisplayName(rawName) || 'Adventurer'
  const seed = hashName(normClassName(name))
  const chassis = CHASSIS_LIST[seed % CHASSIS_LIST.length]
  const tmpl = CHASSIS_TEMPLATE[chassis]
  // jitter the template stats deterministically, then clamp/budget
  const jitter: AbilityScores = { ...tmpl.baseStats }
  STATS.forEach((k, i) => {
    const d = ((seed >>> (i * 3)) % 5) - 2  // -2..+2
    jitter[k] = tmpl.baseStats[k] + d
  })
  const word = salientWord(name, seed)                          // e.g. "Butthole" / "Buttjuice"
  const nouns = CHASSIS_SIG_NOUNS[chassis]
  const sig = `${word} ${nouns[(seed >>> 8) % nouns.length]}`     // e.g. "Butthole Tornado"
  const weaponName = `${word}'s ${SYNTH_WEAPONS[(seed >>> 12) % 10]}`
  return {
    name,
    chassis,
    baseStats: clampStats(jitter, tmpl.baseStats),
    hitDie: tmpl.hitDie,
    atkStat: tmpl.atkStat,
    weapon: { name: weaponName, die: tmpl.weapon.die, count: tmpl.weapon.count },
    acArchetype: tmpl.acArchetype,
    saveProfs: [...tmpl.saveProfs],
    signature: sig,
    role: `a battle-scarred ${CHASSIS_ROLE_WORD[chassis]} who fights with ${sig}`,
    desc: `d${tmpl.hitDie} HP, ${sig} (${chassis}), ${weaponName}`,
    builtin: false,
  }
}

// validate + clamp raw AI output into a safe ClassDef, falling back per-field to
// the chassis template (or the deterministic synthetic) for anything invalid.
export function buildClassDef(rawName: string, raw: Record<string, unknown>): ClassDef {
  const synth = syntheticDef(rawName)
  const chassis: Chassis = CHASSIS_LIST.includes(raw.chassis as Chassis) ? (raw.chassis as Chassis) : synth.chassis
  const tmpl = CHASSIS_TEMPLATE[chassis]

  const atkStat = STATS.includes(raw.atkStat as keyof AbilityScores) ? (raw.atkStat as keyof AbilityScores) : tmpl.atkStat
  const hitDie = HIT_DICE.includes(Number(raw.hitDie)) ? Number(raw.hitDie) : tmpl.hitDie
  const acArchetype = AC_ARCHETYPES.includes(raw.acArchetype as AcArchetype) ? (raw.acArchetype as AcArchetype) : tmpl.acArchetype

  const w = (raw.weapon ?? {}) as Record<string, unknown>
  let weaponDie = WEAPON_DICE.includes(Number(w.die)) ? Number(w.die) : tmpl.weapon.die
  let weaponCount = Number(w.count) === 2 ? 2 : 1
  if (weaponCount === 2 && weaponDie > 8) weaponDie = 8  // cap multi-hit weapons
  const weaponName = sanitizeText(w.name, 24) || tmpl.weapon.name

  return {
    name: synth.name,
    chassis,
    baseStats: clampStats(raw.baseStats, tmpl.baseStats),
    hitDie,
    atkStat,
    weapon: { name: weaponName, die: weaponDie, count: weaponCount },
    acArchetype,
    saveProfs: [...tmpl.saveProfs],  // saves derive from chassis, not AI
    signature: sanitizeText(raw.signature, 24) || synth.signature,
    role: sanitizeText(raw.role, 90) || synth.role,
    desc: sanitizeText(raw.desc, 90) || synth.desc,
    builtin: false,
  }
}
