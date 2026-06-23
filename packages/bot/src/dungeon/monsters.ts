// dress the fixed combat chassis with real Bazaar monsters, scaled to small legible
// HP/damage per floor (NOT the raw Bazaar health, which is huge). pure + seeded.
import * as store from '../store'
import type { Enemy, Intent } from './types'
import { FLOORS } from './types'

// per-floor tuning: floors 1-4 ramp, floor 5 is the boss. tuned so a balanced hero
// (32hp / 8atk / 3 specials) can clear 1-4 with good play; the boss is a wall.
const FLOOR_STATS: { hp: number; dmg: number }[] = [
  { hp: 16, dmg: 4 },   // 1
  { hp: 22, dmg: 6 },   // 2
  { hp: 30, dmg: 8 },   // 3
  { hp: 40, dmg: 10 },  // 4
  { hp: 88, dmg: 12 },  // 5 boss (two phases of 44)
]
const ELITE_HP_MULT = 1.5
const ELITE_DMG_MULT = 1.3

function pickName(floor: number, rng: () => number, boss: boolean): string {
  const day = Math.min(10, Math.max(1, floor * 2))
  let pool = store.monstersByDay(day)
  for (let d = day; pool.length === 0 && d >= 1; d--) pool = store.monstersByDay(d)
  if (pool.length === 0) return boss ? 'the Warden of the Depths' : 'a lurking horror'
  if (boss) {
    return [...pool].sort((a, b) => (b.MonsterMetadata?.health ?? 0) - (a.MonsterMetadata?.health ?? 0))[0].Title
  }
  return pool[Math.floor(rng() * pool.length)].Title
}

export function makeEnemy(floor: number, rng: () => number, opts: { boss?: boolean; elite?: boolean } = {}): Enemy {
  const boss = !!opts.boss
  const elite = !!opts.elite
  const base = FLOOR_STATS[Math.min(FLOORS, Math.max(1, floor)) - 1]
  let hp = base.hp
  let dmg = base.dmg
  if (elite) {
    hp = Math.round(hp * ELITE_HP_MULT)
    dmg = Math.round(dmg * ELITE_DMG_MULT)
  }
  return {
    name: pickName(floor, rng, boss),
    hp,
    maxHp: hp,
    dmg,
    intent: boss && rng() < 0.4 ? 'heavy' : 'normal', // never a turn-1 unreadable spike on trash
    staggered: false,
    stunned: false,
    isElite: elite,
    isBoss: boss,
    phase: boss ? 1 : 0,
  }
}
