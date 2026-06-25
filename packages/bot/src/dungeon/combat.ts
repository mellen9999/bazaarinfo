// the fixed combat chassis. all numbers live here; AI archetype flavor never touches
// them, so every hero is equally balanced. 1v1, seeded, pure (mutates the passed hero/
// enemy and returns a structured result for the renderer).
import type { Hero, Enemy, Verb, Intent, BuffKind } from './types'
import { BUILD_STATS, SPECIAL_CHARGES } from './types'
import type { Archetype } from './ai-archetype'

export interface TurnResult {
  verb: Verb            // the resolved verb (special with no charge degrades to attack)
  heroDmg: number       // damage hero dealt to enemy
  enemyDmg: number      // damage enemy dealt to hero (post shield)
  parried: boolean      // defended a telegraphed heavy -> negated + staggered
  staggeredHit: boolean // landed a bonus hit on a staggered enemy
  special: boolean      // signature move fired
  healed: number
  shield: number        // shield gained
  enemyKilled: boolean
  heroDied: boolean
  fled: boolean
  bossPhase: boolean    // boss shifted into phase 2
  intent: Intent        // the enemy's new telegraph (meaningless if killed/died/fled)
}

export function makeHero(a: Archetype): Hero {
  const s = BUILD_STATS[a.build]
  return {
    title: a.title, blurb: a.blurb, build: a.build, specialKind: a.specialKind,
    moveName: a.moveName, moveFlavor: a.moveFlavor,
    hp: s.maxHp, maxHp: s.maxHp, atk: s.atk,
    special: SPECIAL_CHARGES, maxSpecial: SPECIAL_CHARGES, shield: 0,
  }
}

export function applyBuff(hero: Hero, buff: BuffKind): void {
  switch (buff) {
    case 'maxhp': hero.maxHp += 10; hero.hp += 10; break
    case 'atk': hero.atk += 3; break
    case 'special': hero.special += 1; hero.maxSpecial += 1; break
    case 'shield': hero.shield += 12; break
  }
}

export function restHeal(hero: Hero): number {
  const h = Math.min(hero.maxHp - hero.hp, Math.round(hero.maxHp * 0.35))
  hero.hp += h
  return h
}

function hurtHero(hero: Hero, dmg: number): number {
  let d = dmg
  if (hero.shield > 0) {
    const absorbed = Math.min(hero.shield, d)
    hero.shield -= absorbed
    d -= absorbed
  }
  hero.hp -= d
  return dmg
}

// the enemy's next telegraphed move — bosses/elites lean nastier.
export function pickIntent(enemy: Enemy, rng: () => number): Intent {
  const r = rng()
  if (enemy.isBoss) {
    if (enemy.phase >= 2) return r < 0.5 ? 'heavy' : r < 0.82 ? 'special' : 'normal'
    return r < 0.38 ? 'heavy' : r < 0.6 ? 'special' : r < 0.78 ? 'guard' : 'normal'
  }
  if (enemy.isElite) return r < 0.4 ? 'heavy' : r < 0.62 ? 'guard' : 'normal'
  return r < 0.3 ? 'heavy' : r < 0.46 ? 'guard' : 'normal'
}

// resolve one turn: hero acts on `verb`, then the enemy reacts per its telegraph, then
// it telegraphs anew. mutates hero + enemy. caller handles fight-end / floor advance.
export function resolveTurn(hero: Hero, enemy: Enemy, verb: Verb, rng: () => number): TurnResult {
  // special with no charges is never a wasted turn — it degrades to a normal attack.
  if (verb === 'special' && hero.special <= 0) verb = 'attack'

  const res: TurnResult = {
    verb, heroDmg: 0, enemyDmg: 0, parried: false, staggeredHit: false, special: false,
    healed: 0, shield: 0, enemyKilled: false, heroDied: false, fled: false,
    bossPhase: false, intent: enemy.intent,
  }

  // --- flee: take a parting hit, end the fight (caller advances the floor) ---
  if (verb === 'flee') {
    res.fled = true
    res.enemyDmg = hurtHero(hero, Math.round(enemy.dmg * 0.5))
    res.heroDied = hero.hp <= 0
    return res
  }

  const enemyGuarding = enemy.intent === 'guard'
  let defended = false

  // --- hero acts ---
  if (verb === 'attack') {
    let dmg = hero.atk
    if (enemy.staggered) { dmg = Math.round(dmg * 1.5); res.staggeredHit = true; enemy.staggered = false }
    if (enemyGuarding) dmg = Math.round(dmg * 0.4) // enemy braced
    enemy.hp -= dmg; res.heroDmg = dmg
  } else if (verb === 'defend') {
    defended = true
  } else if (verb === 'special') {
    // heal at full HP would spend a permanent charge for zero effect — degrade to a normal
    // attack instead, mirroring the chargeless-special degrade at the top of this function.
    if (hero.specialKind === 'heal' && hero.hp >= hero.maxHp) {
      verb = 'attack'; res.verb = 'attack'
      let dmg = hero.atk
      if (enemy.staggered) { dmg = Math.round(dmg * 1.5); res.staggeredHit = true; enemy.staggered = false }
      if (enemyGuarding) dmg = Math.round(dmg * 0.4)
      enemy.hp -= dmg; res.heroDmg = dmg
    } else {
      hero.special -= 1; res.special = true
      switch (hero.specialKind) {
        case 'burst': {
          let dmg = Math.round(hero.atk * 2.5)
          if (enemy.staggered) { dmg = Math.round(dmg * 1.5); res.staggeredHit = true; enemy.staggered = false }
          if (enemyGuarding) dmg = Math.round(dmg * 0.5)
          enemy.hp -= dmg; res.heroDmg = dmg; break
        }
        case 'stun': {
          let dmg = hero.atk
          if (enemyGuarding) dmg = Math.round(dmg * 0.5)
          enemy.hp -= dmg; res.heroDmg = dmg
          enemy.stunned = true; break // skips its next action
        }
        case 'heal': {
          res.healed = Math.min(hero.maxHp - hero.hp, Math.round(hero.maxHp * 0.45))
          hero.hp += res.healed; break
        }
        case 'guard': {
          res.shield = Math.round(hero.maxHp * 0.6)
          hero.shield += res.shield; break
        }
      }
    }
  }

  // --- enemy killed? (boss phase-shifts instead of dying the first time) ---
  if (enemy.hp <= 0) {
    if (enemy.isBoss && enemy.phase < 2) {
      enemy.phase = 2
      enemy.hp = Math.round(enemy.maxHp / 2)
      enemy.dmg = Math.round(enemy.dmg * 1.4)
      enemy.staggered = false
      enemy.stunned = false
      res.bossPhase = true
      enemy.intent = pickIntent(enemy, rng)
      res.intent = enemy.intent
      return res
    }
    res.enemyKilled = true
    return res
  }

  // --- enemy reacts (unless stunned) ---
  if (enemy.stunned) {
    enemy.stunned = false
  } else if (enemy.intent === 'heavy') {
    if (defended) { res.parried = true; enemy.staggered = true } // parry: negate + stagger
    else res.enemyDmg = hurtHero(hero, enemy.dmg * 2)
  } else if (enemy.intent === 'normal') {
    res.enemyDmg = hurtHero(hero, defended ? Math.round(enemy.dmg * 0.4) : enemy.dmg)
  } else if (enemy.intent === 'special') {
    res.enemyDmg = hurtHero(hero, defended ? Math.round(enemy.dmg * 0.9) : Math.round(enemy.dmg * 1.5))
  } // 'guard' -> enemy braced this turn, dealt nothing

  res.heroDied = hero.hp <= 0
  if (res.heroDied) return res

  enemy.intent = pickIntent(enemy, rng)
  res.intent = enemy.intent
  return res
}
