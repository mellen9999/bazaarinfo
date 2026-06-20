// Headless balance sim for Kripp's Bazaar Depths. Uses the REAL combat math
// (resolvePlayerAttack / resolveEnemyAttack / boonMods / generateEnemies /
// getItemBonus) to measure: solo + party win-rates, boon values, custom-class
// balance, and end-to-end full-run completion (with leveling, gear, death saves).
//
// Abilities are modeled per chassis (faithful to resolveSpell). Store is NOT
// loaded, so enemies use the generic D&D stat blocks and loot uses the D&D item
// pool (+1/+2 weapon, rings, potions) — whose bonuses getItemBonus applies
// without the cache. Names differ from prod (Bazaar skin) but the numbers match.
//
// run: bun scripts/dnd-balance.ts
import { getClassDef, maxHpFor, maxSpellSlotsFor, syntheticDef, registerClassDef } from '../packages/bot/src/dnd/classdef'
import * as combat from '../packages/bot/src/dnd/combat'
import { generateEnemies, getFloorType, enemyReward, lootDrop, bossLootDrop } from '../packages/bot/src/dnd/floor'
import { boonMods, BOONS, applyBoonOnPick } from '../packages/bot/src/dnd/boons'
import { getModifier, XP_PER_LEVEL } from '../packages/bot/src/dnd/types'
import type { Character, Enemy } from '../packages/bot/src/dnd/types'

// player skill profile — toggles what a careless vs a skilled player does
const PROFILE = { useAbilities: true, smartBoons: true, buyGear: true, usePotions: true }
const roll = (n: number, d: number) => { let s = 0; for (let i = 0; i < n; i++) s += Math.floor(Math.random() * d) + 1; return s }
const d20 = () => Math.floor(Math.random() * 20) + 1
const pct = (x: number) => `${Math.round(x * 100).toString().padStart(3)}%`

interface Res { slots: number; ki: number; rage: number; surgeUsed: boolean }
interface P { char: Character; def: ReturnType<typeof getClassDef>; res: Res; down: boolean; dead: boolean; dsucc: number; dfail: number }

function simChar(className: string, level: number, boonIds: string[]): Character {
  const def = getClassDef(className)
  const maxHp = maxHpFor(def, level, def.baseStats.con)
  const char: Character = {
    username: 'sim', channel: 'sim', class: className, level, xp: XP_PER_LEVEL[level] ?? 0,
    hp: maxHp, maxHp, gold: 0, inventory: [], statusEffects: [],
    stats: { ...def.baseStats }, spellSlots: 0, maxSpellSlots: 0,
    hitDice: 1, maxHitDice: 1, kiPoints: 0, maxKiPoints: 0,
    rageCharges: 0, rageTurnsLeft: 0, actionSurgeUsed: false,
    isDying: false, deathSuccesses: 0, deathFailures: 0,
    deaths: 0, totalKills: 0, defending: false, lastActionAt: 0, respawnAt: null,
    prestige: 0, achievements: [], boons: [], pendingBoon: [], killStreak: 0, deathsSeason: 0,
  }
  for (const b of boonIds) { char.boons.push(b); applyBoonOnPick(char, b) }
  return char
}
function startRes(def: ReturnType<typeof getClassDef>, level: number): Res {
  return { slots: maxSpellSlotsFor(def, level), ki: def.chassis === 'flurry' ? level : 0, rage: def.chassis === 'rage' ? 2 + Math.floor(level / 3) : 0, surgeUsed: false }
}
function makeP(className: string, level: number, boonIds: string[]): P {
  return { char: simChar(className, level, boonIds), def: getClassDef(className), res: startRes(getClassDef(className), level), down: false, dead: false, dsucc: 0, dfail: 0 }
}

// auto-quaff a healing potion when low
function maybePotion(p: P): void {
  if (!PROFILE.usePotions) return
  if (p.char.hp > p.char.maxHp * 0.35) return
  const i = p.char.inventory.findIndex((n) => n.toLowerCase().includes('potion'))
  if (i < 0) return
  const heal = combat.getItemBonus(p.char.inventory[i]).onUseHeal
  if (heal > 0) { p.char.hp = Math.min(p.char.maxHp, p.char.hp + heal); p.char.inventory.splice(i, 1) }
}

// one player's turn: chassis ability when worthwhile, else basic attack(s)
function playerTurn(p: P, enemies: Enemy[], party: P[]): void {
  const char = p.char, def = p.def, res = p.res
  const alive = () => enemies.filter((e) => e.hp > 0)
  if (alive().length === 0) return
  const chassis = def.chassis
  const ls = boonMods(char).lifestealPct

  if (!PROFILE.useAbilities) {  // careless player: never uses !b spell — basic attacks only
    const t = alive()[0]
    const o = combat.resolvePlayerAttack(char, t, Math.floor(Math.random() * 1e9), chassis === 'sneak', false, 1)
    if (o.hit) { t.hp = Math.max(0, t.hp - o.damage); if (o.statusApplied && !t.statusEffect) { t.statusEffect = o.statusApplied; t.statusRoundsLeft = 3 } if (ls > 0) char.hp = Math.min(char.maxHp, char.hp + Math.max(1, Math.floor(o.damage * ls))) }
    return
  }

  if (chassis === 'nuke' && res.slots > 0) {
    res.slots--; const dmg = roll(8, 6)
    for (const e of alive()) { e.hp = Math.max(0, e.hp - dmg); if (!e.statusEffect && e.specialAbility !== 'fire_immunity') { e.statusEffect = 'burning'; e.statusRoundsLeft = 2 } }
    return
  }
  if (chassis === 'chaos' && res.slots > 0) { res.slots--; const t = alive()[0]; t.hp = Math.max(0, t.hp - (roll(3, 8) + getModifier(char.stats.cha))); return }
  if (chassis === 'heal' && res.slots > 0) {
    res.slots--
    // revive/heal the lowest-HP ally (incl. down), then guiding-bolt a foe
    const allies = party.filter((q) => !q.dead)
    const tgt = allies.reduce((a, b) => (a.char.hp < b.char.hp ? a : b), p)
    const amt = Math.max(1, roll(2, 4) + getModifier(char.stats.wis))
    tgt.char.hp = Math.min(tgt.char.maxHp, Math.max(tgt.char.hp, 0) + amt)
    if (tgt.char.hp > 0) { tgt.down = false; tgt.dsucc = 0; tgt.dfail = 0 }
    const f = alive()[0]; if (f) f.hp = Math.max(0, f.hp - (roll(3, 6) + getModifier(char.stats.wis)))
    return
  }
  if (chassis === 'rage' && res.rage > 0 && char.rageTurnsLeft <= 0) { res.rage--; char.rageTurnsLeft = 3 }

  let attacks = 1
  if (chassis === 'surge' && !res.surgeUsed) { res.surgeUsed = true; attacks = 3 }
  if (chassis === 'flurry' && res.ki > 0) { res.ki--; attacks = 3 }
  if (chassis === 'curse') attacks = char.level >= 9 ? 3 : 2
  const adv = chassis === 'sneak' || (chassis === 'surge' && char.level >= 5)

  let seq = (Math.floor(Math.random() * 1e9))
  for (let i = 0; i < attacks; i++) {
    const t = alive()[0]; if (!t) break
    const o = combat.resolvePlayerAttack(char, t, seq++, adv, false, 1)
    if (!o.hit) continue
    let dmg = o.damage
    if (chassis === 'smite' && res.slots > 0) { res.slots--; dmg += roll(o.crit ? 4 : 2, 8) }
    if (chassis === 'curse' && res.slots > 0 && i === 0) { res.slots--; t.statusEffect = t.statusEffect ?? 'hexed' }
    t.hp = Math.max(0, t.hp - dmg)
    if (o.statusApplied && !t.statusEffect) { t.statusEffect = o.statusApplied; t.statusRoundsLeft = 3 }
    if (ls > 0) char.hp = Math.min(char.maxHp, char.hp + Math.max(1, Math.floor(dmg * ls)))
  }
}

// resolve one floor fight; mutates party (hp/down/dead persist). returns win + xp earned.
function fight(party: P[], floor: number, season: number): { win: boolean; xp: number } {
  const n = party.length
  const boss = getFloorType(floor) === 'boss'
  const hpScale = n === 1 ? (boss ? 0.40 : 0.55) : n === 2 ? (boss ? 0.68 : 0.82) : 1.0
  const dmgScale = n === 1 ? (boss ? 0.45 : 0.62) : n === 2 ? (boss ? 0.75 : 0.88) : 1.0
  const enemies: Enemy[] = generateEnemies(season, floor).map((e) => { const hp = Math.max(10, Math.floor(e.hp * hpScale)); return { ...e, hp, maxHp: hp } })
  let xp = 0
  const xpFor = (e: Enemy) => enemyReward(e, floor).xp  // real reward (boss xpValue now sane)
  const startHp = enemies.map((e) => e.hp)

  for (let round = 0; round < 80; round++) {
    if (enemies.every((e) => e.hp <= 0)) { enemies.forEach((e, i) => { if (startHp[i] > 0) xp += xpFor(e) }); return { win: true, xp } }
    // players act
    for (const p of party) { if (p.down || p.dead || p.char.hp <= 0) continue; maybePotion(p); playerTurn(p, enemies, party) }
    // enrage
    for (const e of enemies) if (e.isBoss && e.hp > 0 && !e.enraged && e.hp <= e.maxHp * 0.5) { e.enraged = true; e.damageMod += Math.ceil(e.damageMod * 0.5) + 2; e.multiattack += 1 }
    // status ticks
    for (const e of enemies) if (e.hp > 0 && e.statusEffect) { e.hp = Math.max(0, e.hp - combat.singleStatusTick(e.statusEffect)); if (e.statusRoundsLeft !== undefined && --e.statusRoundsLeft <= 0) delete e.statusEffect }
    for (const p of party) if (p.char.rageTurnsLeft > 0) p.char.rageTurnsLeft--
    // enemies attack
    for (const e of enemies) {
      if (e.hp <= 0) continue
      for (let a = 0; a < (e.multiattack ?? 1); a++) {
        const standing = party.filter((p) => !p.down && !p.dead && p.char.hp > 0)
        const downed = party.filter((p) => p.down && !p.dead)
        const tgt = standing.length ? standing[Math.floor(Math.random() * standing.length)] : downed[0]
        if (!tgt) break
        let seq = Math.floor(Math.random() * 1e9)
        const r = combat.resolveEnemyAttack(e, tgt.char, seq, dmgScale)
        if (r.hit) {
          if (tgt.down) { tgt.dfail += r.crit ? 2 : 1 }  // hitting the downed
          else {
            const raging = tgt.def.chassis === 'rage' && tgt.char.rageTurnsLeft > 0
            tgt.char.hp -= raging ? Math.max(1, Math.floor(r.damage / 2)) : r.damage
            if (tgt.char.hp <= 0) { tgt.char.hp = 0; tgt.down = true; tgt.dsucc = 0; tgt.dfail = 0 }
          }
          if (tgt.dfail >= 3) { tgt.dead = true; tgt.down = false }
        }
      }
    }
    // death saves
    for (const p of party) {
      if (!p.down || p.dead) continue
      const r = d20()
      if (r === 20) { p.down = false; p.char.hp = 1 }
      else if (r >= 10) { if (++p.dsucc >= 3) { /* stable, stays at 0 hp, out unless healed */ } }
      else if (++p.dfail >= 3) { p.dead = true; p.down = false }
    }
    if (party.every((p) => p.dead || (p.down && p.dsucc >= 3))) return { win: false, xp }  // wiped or all stable-but-down
    if (party.every((p) => p.down || p.dead)) {
      // nobody can act; let saves play out a few rounds for a nat-20 comeback
      if (party.every((p) => p.dead)) return { win: false, xp }
    }
  }
  return { win: false, xp }
}

function winRate(party: () => P[], floor: number, runs = 400): number {
  let w = 0
  for (let i = 0; i < runs; i++) if (fight(party(), floor, 1 + (i % 7)).win) w++
  return w / runs
}

const CLASSES = ['Barbarian', 'Fighter', 'Paladin', 'Rogue', 'Monk', 'Cleric', 'Warlock', 'Wizard', 'Sorcerer']
const COMBAT_FLOORS = [1, 2, 7, 8]
const BOSS_FLOORS = [6, 10]
const KIT = ['ironhide', 'bulwark', 'berserker', 'vampiric']

// ============================================================ 1. solo curve
console.log('=== 1. solo win% (level=floor, no boons) — real combat/boss floors ===')
console.log('class'.padEnd(11) + [...COMBAT_FLOORS, ...BOSS_FLOORS].map((f) => `f${f}${BOSS_FLOORS.includes(f) ? '*' : ''}`.padStart(6)).join(''))
for (const c of CLASSES) {
  const row = [...COMBAT_FLOORS, ...BOSS_FLOORS].map((f) => pct(winRate(() => [makeP(c, Math.min(f, 10), [])], f, 300)).padStart(6)).join('')
  console.log(c.padEnd(11) + row)
}

// ============================================================ 2. party scaling
console.log('\n=== 2. party scaling: win% by party size (level 6, no boons, mid+boss) ===')
console.log('size'.padEnd(11) + 'f7'.padStart(7) + 'f8'.padStart(7) + 'f6boss'.padStart(8) + 'f10boss'.padStart(9))
for (const size of [1, 2, 3]) {
  const mk = () => Array.from({ length: size }, () => makeP('Fighter', 6, []))
  console.log(`${size}p Fighter`.padEnd(11) + pct(winRate(mk, 7, 300)).padStart(7) + pct(winRate(mk, 8, 300)).padStart(7) + pct(winRate(mk, 6, 300)).padStart(8) + pct(winRate(mk, 10, 300)).padStart(9))
}
for (const size of [1, 2, 3]) {
  const mk = () => ['Fighter', 'Cleric', 'Wizard'].slice(0, size).map((c) => makeP(c, 6, []))
  console.log(`${size}p mixed`.padEnd(11) + pct(winRate(mk, 7, 300)).padStart(7) + pct(winRate(mk, 8, 300)).padStart(7) + pct(winRate(mk, 6, 300)).padStart(8) + pct(winRate(mk, 10, 300)).padStart(9))
}

// ============================================================ 3. boon matrix
console.log('\n=== 3. boon value: win% delta vs baseline (avg over Fighter/Barb/Rogue/Cleric, L8 vs f8 + L10 vs f10boss) ===')
const boonClasses = ['Fighter', 'Barbarian', 'Rogue', 'Cleric']
function avgWin(boon: string[], floor: number, level: number): number {
  let s = 0
  for (const c of boonClasses) s += winRate(() => [makeP(c, level, boon)], floor, 250)
  return s / boonClasses.length
}
const base8 = avgWin([], 8, 8), base10 = avgWin([], 10, 10)
console.log(`baseline           f8:${pct(base8)}  f10boss:${pct(base10)}`)
const ranked = BOONS.map((b) => ({ name: b.name, d8: avgWin([b.id], 8, 8) - base8, d10: avgWin([b.id], 10, 10) - base10 }))
  .sort((a, b) => (b.d8 + b.d10) - (a.d8 + a.d10))
for (const r of ranked) console.log(`${r.name.padEnd(16)} f8:${(r.d8 >= 0 ? '+' : '') + Math.round(r.d8 * 100)}%`.padEnd(30) + `f10boss:${(r.d10 >= 0 ? '+' : '') + Math.round(r.d10 * 100)}%`)

// ============================================================ 4. custom class distribution
console.log('\n=== 4. custom (synthetic) class balance: win% distribution vs builtins ===')
const SAMPLE = 60
const names = Array.from({ length: SAMPLE }, (_, i) => `customclass ${i} ${['fury', 'doom', 'blast', 'shadow', 'holy', 'wild'][i % 6]}`)
for (const n of names) registerClassDef(syntheticDef(n))
function dist(floor: number, level: number): { min: number; med: number; max: number; mean: number } {
  const rates = names.map((n) => winRate(() => [makeP(n, level, [])], floor, 120)).sort((a, b) => a - b)
  return { min: rates[0], med: rates[Math.floor(rates.length / 2)], max: rates[rates.length - 1], mean: rates.reduce((a, b) => a + b, 0) / rates.length }
}
for (const [label, f, lv] of [['f2 combat', 2, 2], ['f7 combat', 7, 7], ['f8 combat', 8, 8]] as [string, number, number][]) {
  const d = dist(f, lv)
  console.log(`${label.padEnd(11)} min ${pct(d.min)}  median ${pct(d.med)}  mean ${pct(d.mean)}  max ${pct(d.max)}  (${SAMPLE} synthetic classes)`)
}

// ============================================================ 5. full-run completion
console.log('\n=== 5. full-run: solo floors 1→10 with leveling + gear + death saves (500 runs) ===')
const BOON_PRIORITY = ['bulwark', 'ironhide', 'titan', 'vampiric', 'berserker', 'regen', 'precise', 'deadeye', 'glasscannon', 'executioner', 'battery', 'looter']

function levelUp(p: P): void {
  while (p.char.level < 10 && p.char.xp >= (XP_PER_LEVEL[p.char.level + 1] ?? Infinity)) {
    p.char.level++
    const conMod = getModifier(p.char.stats.con)
    const hpGain = Math.floor(p.def.hitDie / 2) + 1 + conMod
    p.char.maxHp += hpGain; p.char.hp += hpGain
    // pick a boon — skilled: survival priority; careless: random
    const avail = PROFILE.smartBoons
      ? [BOON_PRIORITY.find((b) => !p.char.boons.includes(b))].filter(Boolean) as string[]
      : BOONS.map((b) => b.id).filter((b) => !p.char.boons.includes(b))
    const pick = PROFILE.smartBoons ? avail[0] : avail[Math.floor(Math.random() * avail.length)]
    if (pick) { p.char.boons.push(pick); applyBoonOnPick(p.char, pick) }
    p.res = startRes(p.def, p.char.level)
  }
}

const MAX_RETRIES = 12  // real game: die → respawn (half HP) → floor resets for solo

function fullRun(className: string, season: number): { cleared: boolean; deathFloor: number; level: number; deaths: number; arrive6: number; arrive10: number } {
  const p = makeP(className, 1, [])
  let totalDeaths = 0, arrive6 = 0, arrive10 = 0
  for (let floor = 1; floor <= 10; floor++) {
    const type = getFloorType(floor)
    if (floor === 6) arrive6 = p.char.level
    if (floor === 10) arrive10 = p.char.level
    if (type === 'combat' || type === 'boss') {
      let won = false
      for (let attempt = 0; attempt <= MAX_RETRIES && !won; attempt++) {
        p.res = startRes(p.def, p.char.level)
        p.down = false; p.dead = false; p.dsucc = 0; p.dfail = 0
        if (p.char.hp <= 0) p.char.hp = Math.max(1, Math.floor(p.char.maxHp / 2))  // respawn HP
        const { win, xp } = fight([p], floor, season)
        if (win) { won = true; p.char.xp += xp; levelUp(p) }
        else { totalDeaths++; p.char.hp = 0; p.char.gold = Math.floor(p.char.gold * 0.6) }  // death stakes: lose 40% gold
      }
      if (!won) return { cleared: false, deathFloor: floor, level: p.char.level, deaths: totalDeaths, arrive6, arrive10 }
      p.char.hp = Math.min(p.char.maxHp, (p.char.hp <= 0 ? 1 : p.char.hp) + (type === 'boss' ? 0 : 15) + boonMods(p.char).regenPerFloor)
      const drop = type === 'boss' ? bossLootDrop(season, floor) : lootDrop(season, floor, 0)
      if (drop && p.char.inventory.length < 6) p.char.inventory.push(drop)
    } else if (type === 'shop') {
      p.char.gold += 30
      if (PROFILE.buyGear && p.char.gold >= 200 && !p.char.inventory.includes('+1 Weapon')) { p.char.gold -= 200; if (p.char.inventory.length < 6) p.char.inventory.push('+1 Weapon') }
    } else {
      if (floor === 9) p.char.hp = p.char.maxHp
      else p.char.hp = Math.min(p.char.maxHp, p.char.hp + Math.floor(p.char.maxHp * 0.5))
    }
  }
  return { cleared: true, deathFloor: 0, level: p.char.level, deaths: totalDeaths, arrive6, arrive10 }
}

console.log('class'.padEnd(11) + 'clear%'.padStart(7) + ' avgDeaths  arriveL6  arriveL10  death-floor histogram')
for (const c of CLASSES) {
  const deaths = new Array(11).fill(0); let cleared = 0, deathSum = 0, a6 = 0, a10 = 0, a10n = 0
  const RUNS = 400
  for (let i = 0; i < RUNS; i++) {
    const r = fullRun(c, 1 + (i % 7))
    deathSum += r.deaths; a6 += r.arrive6
    if (r.arrive10) { a10 += r.arrive10; a10n++ }
    if (r.cleared) cleared++; else deaths[r.deathFloor]++
  }
  const hist = deaths.slice(1).map((d) => Math.round((d / RUNS) * 99).toString().padStart(2)).join(' ')
  console.log(c.padEnd(11) + pct(cleared / RUNS).padStart(7) + (deathSum / RUNS).toFixed(1).padStart(9) + (a6 / RUNS).toFixed(1).padStart(10) + (a10n ? (a10 / a10n).toFixed(1) : '-').padStart(11) + '  ' + hist)
}

// ============================================================ 6. skill gradient
console.log('\n=== 6. does misplay get punished? full-run completion by player skill ===')
function runProfile(label: string): void {
  let row = label.padEnd(26)
  for (const c of ['Fighter', 'Wizard', 'Barbarian']) {
    let cleared = 0, deathSum = 0
    const RUNS = 400
    for (let i = 0; i < RUNS; i++) { const r = fullRun(c, 1 + (i % 7)); if (r.cleared) cleared++; deathSum += r.deaths }
    row += `${c} ${pct(cleared / RUNS)} (${(deathSum / RUNS).toFixed(1)}d)`.padEnd(22)
  }
  console.log(row)
}
PROFILE.useAbilities = true; PROFILE.smartBoons = true; PROFILE.buyGear = true; PROFILE.usePotions = true
runProfile('skilled (all)')
PROFILE.smartBoons = false
runProfile('random boons')
PROFILE.usePotions = false; PROFILE.buyGear = false
runProfile('no potions/gear')
PROFILE.useAbilities = false
runProfile('careless (no !b spell)')
