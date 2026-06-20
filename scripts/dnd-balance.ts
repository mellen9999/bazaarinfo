// Headless balance sim for Kripp's Bazaar Depths. Uses the REAL combat math
// (resolvePlayerAttack / resolveEnemyAttack / boonMods / generateEnemies) to
// measure solo win-rates per class per floor and the impact of boons.
//
// Model: basic attacks only (no spells/abilities), single player vs the floor,
// solo HP/damage scaling replicated from the engine. So it's a faithful yardstick
// for martial chassis and a LOWER BOUND for casters (whose power is their spell).
//
// run: bun scripts/dnd-balance.ts
import { getClassDef, maxHpFor, maxSpellSlotsFor } from '../packages/bot/src/dnd/classdef'
import * as combat from '../packages/bot/src/dnd/combat'
import { generateEnemies, getFloorType } from '../packages/bot/src/dnd/floor'
import { boonMods } from '../packages/bot/src/dnd/boons'
import { getModifier } from '../packages/bot/src/dnd/types'
import type { Character, Enemy } from '../packages/bot/src/dnd/types'

let RNG = () => Math.random()
const roll = (n: number, d: number) => { let s = 0; for (let i = 0; i < n; i++) s += Math.floor(RNG() * d) + 1; return s }

interface Res { slots: number; ki: number; rage: number; surgeUsed: boolean }

function startRes(def: ReturnType<typeof getClassDef>, level: number): Res {
  return {
    slots: maxSpellSlotsFor(def, level),
    ki: def.chassis === 'flurry' ? level : 0,
    rage: def.chassis === 'rage' ? 2 + Math.floor(level / 3) : 0,
    surgeUsed: false,
  }
}

// player's turn: use the chassis ability when worthwhile, else basic attack(s).
// mutates enemies + char; faithful-enough model of resolveSpell.
function playerTurn(char: Character, def: ReturnType<typeof getClassDef>, enemies: Enemy[], res: Res, seqRef: { v: number }): void {
  const alive = () => enemies.filter((e) => e.hp > 0)
  if (alive().length === 0) return
  const chassis = def.chassis
  const ls = boonMods(char).lifestealPct

  // pure-resource spells that replace the attack
  if (chassis === 'nuke' && res.slots > 0) {
    res.slots--; const dmg = roll(8, 6)
    for (const e of alive()) { e.hp = Math.max(0, e.hp - dmg); if (!e.statusEffect && e.specialAbility !== 'fire_immunity') { e.statusEffect = 'burning'; e.statusRoundsLeft = 2 } }
    return
  }
  if (chassis === 'chaos' && res.slots > 0) {
    res.slots--; const t = alive()[0]; t.hp = Math.max(0, t.hp - (roll(3, 8) + getModifier(char.stats.cha)))
    return
  }
  if (chassis === 'heal' && res.slots > 0) {
    res.slots--
    if (char.hp < char.maxHp * 0.6) char.hp = Math.min(char.maxHp, char.hp + Math.max(1, roll(1, 4) + getModifier(char.stats.wis)))
    const t = alive()[0]; if (t) t.hp = Math.max(0, t.hp - (roll(3, 6) + getModifier(char.stats.wis)))  // guiding bolt
    return
  }

  // buffs
  if (chassis === 'rage' && res.rage > 0 && char.rageTurnsLeft <= 0) { res.rage--; char.rageTurnsLeft = 3 }

  // attack count
  let attacks = 1
  if (chassis === 'surge' && !res.surgeUsed) { res.surgeUsed = true; attacks = 3 }  // action surge = 2 extra
  if (chassis === 'flurry' && res.ki > 0) { res.ki--; attacks = 3 }
  if (chassis === 'curse') attacks = char.level >= 5 ? 2 : 1  // eldritch blast beams

  for (let i = 0; i < attacks; i++) {
    const t = alive()[0]; if (!t) break
    const adv = chassis === 'sneak' || (chassis === 'surge' && char.level >= 5)  // rogue angle / fighter veteran
    const o = combat.resolvePlayerAttack(char, t, seqRef.v++, adv, false, 1)
    if (!o.hit) continue
    let dmg = o.damage
    if (chassis === 'smite' && res.slots > 0) { res.slots--; dmg += roll(o.crit ? 4 : 2, 8) }
    if (chassis === 'curse' && res.slots > 0) { res.slots--; t.statusEffect = t.statusEffect ?? 'hexed'; dmg += roll(1, 6) }
    t.hp = Math.max(0, t.hp - dmg)
    if (o.statusApplied && !t.statusEffect) { t.statusEffect = o.statusApplied; t.statusRoundsLeft = 3 }
    if (ls > 0) char.hp = Math.min(char.maxHp, char.hp + Math.max(1, Math.floor(dmg * ls)))
  }
}

function simChar(className: string, level: number, boonIds: string[]): Character {
  const def = getClassDef(className)
  const maxHp = maxHpFor(def, level, def.baseStats.con)
  return {
    username: 'sim', channel: 'sim', class: className, level, xp: 0,
    hp: maxHp, maxHp, gold: 0, inventory: [], statusEffects: [],
    stats: { ...def.baseStats }, spellSlots: 0, maxSpellSlots: 0,
    hitDice: 1, maxHitDice: 1, kiPoints: 0, maxKiPoints: 0,
    rageCharges: 0, rageTurnsLeft: 0, actionSurgeUsed: false,
    isDying: false, deathSuccesses: 0, deathFailures: 0,
    deaths: 0, totalKills: 0, defending: false, lastActionAt: 0, respawnAt: null,
    prestige: 0, achievements: [], boons: boonIds, pendingBoon: [], killStreak: 0,
  }
}

// one solo run vs a floor; returns true on clear, false on death/timeout
function simRun(className: string, level: number, boonIds: string[], floor: number, season: number, seed: number): boolean {
  const char = simChar(className, level, boonIds)
  const boss = getFloorType(floor) === 'boss'
  const hpScale = boss ? 0.40 : 0.55   // mirror engine solo scaling
  const dmgScale = boss ? 0.45 : 0.62
  const enemies: Enemy[] = generateEnemies(season, floor).map((e) => {
    const hp = Math.max(10, Math.floor(e.hp * hpScale))
    return { ...e, hp, maxHp: hp }
  })
  const def = getClassDef(className)
  const res = startRes(def, level)
  const seqRef = { v: seed >>> 0 }

  for (let round = 0; round < 60; round++) {
    if (enemies.every((e) => e.hp <= 0)) return true
    playerTurn(char, def, enemies, res, seqRef)
    // boss enrage
    for (const e of enemies) {
      if (e.isBoss && e.hp > 0 && !e.enraged && e.hp <= e.maxHp * 0.5) {
        e.enraged = true; e.damageMod += Math.ceil(e.damageMod * 0.5) + 2; e.multiattack += 1
      }
    }
    // status ticks
    for (const e of enemies) {
      if (e.hp > 0 && e.statusEffect) {
        e.hp = Math.max(0, e.hp - combat.singleStatusTick(e.statusEffect))
        if (e.statusRoundsLeft !== undefined && --e.statusRoundsLeft <= 0) delete e.statusEffect
      }
    }
    if (char.rageTurnsLeft > 0) char.rageTurnsLeft--
    // enemies counterattack
    for (const e of enemies) {
      if (e.hp <= 0) continue
      for (let a = 0; a < (e.multiattack ?? 1); a++) {
        const r = combat.resolveEnemyAttack(e, char, seqRef.v++, dmgScale)
        if (r.hit) {
          const raging = def.chassis === 'rage' && char.rageTurnsLeft > 0
          char.hp -= raging ? Math.max(1, Math.floor(r.damage / 2)) : r.damage
        }
      }
    }
    if (char.hp <= 0) return false  // conservative: ignore death saves
  }
  return false
}

function winRate(className: string, level: number, boonIds: string[], floor: number, runs = 500): number {
  let wins = 0
  for (let i = 0; i < runs; i++) if (simRun(className, level, boonIds, floor, 1 + (i % 7), i * 2654435761)) wins++
  return wins / runs
}

const CLASSES = ['Barbarian', 'Fighter', 'Paladin', 'Rogue', 'Monk', 'Cleric', 'Warlock', 'Wizard', 'Sorcerer']
const pct = (x: number) => `${Math.round(x * 100).toString().padStart(3)}%`

console.log('=== solo win% by class × floor (level = floor, no boons; basic attacks only) ===')
console.log('class'.padEnd(11) + CLASSES.length ? '' : '')
const header = 'floor'.padEnd(11) + Array.from({ length: 10 }, (_, i) => `f${i + 1}`.padStart(5)).join('')
console.log(header)
for (const c of CLASSES) {
  const row = Array.from({ length: 10 }, (_, i) => pct(winRate(c, Math.min(i + 1, 10), [], i + 1, 300))).join('')
  console.log(c.padEnd(11) + row)
}

console.log('\n=== developed character (level 10 + 4 boons) vs bosses & the f8 wall ===')
const kit = ['ironhide', 'bulwark', 'berserker', 'vampiric']
console.log('class'.padEnd(11) + 'f6boss'.padStart(8) + 'f8'.padStart(8) + 'f10boss'.padStart(9))
for (const c of CLASSES) {
  console.log(c.padEnd(11) + pct(winRate(c, 10, kit, 6, 400)).padStart(8) + pct(winRate(c, 10, kit, 8, 400)).padStart(8) + pct(winRate(c, 10, kit, 10, 400)).padStart(9))
}

console.log('\n=== single-boon value: Fighter L8 vs floor 8 combat (400 runs) ===')
const boonSets: [string, string[]][] = [
  ['none', []], ['titan', ['titan']], ['glasscannon', ['glasscannon']],
  ['berserker', ['berserker']], ['deadeye', ['deadeye']], ['precise', ['precise']],
  ['vampiric', ['vampiric']], ['ironhide', ['ironhide']], ['bulwark', ['bulwark']],
  ['executioner', ['executioner']], ['looter', ['looter']], ['regen', ['regen']],
]
for (const [label, b] of boonSets) console.log(label.padEnd(14) + pct(winRate('Fighter', 8, b, 8, 500)))
