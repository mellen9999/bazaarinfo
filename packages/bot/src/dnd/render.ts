import type { Character, WorldState, ShopItem, CombatResult } from './types'
import { getClassDef, charAC, joinActionFor, levelUpBonusFor } from './classdef'

const MAX_LEN = 480

function trunc(s: string, max = MAX_LEN): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

export function hpBar(hp: number, maxHp: number): string {
  const ratio = maxHp > 0 ? Math.max(0, hp) / maxHp : 0
  const filled = Math.round(ratio * 8)
  return '#'.repeat(filled) + '.'.repeat(8 - filled)
}

export function hpPct(hp: number, maxHp: number): string {
  return `${hp}/${maxHp}`
}

export function renderFloor(world: WorldState, players: Character[]): string {
  const typeLabel = world.encounterType === 'boss' ? 'BOSS' : world.encounterType.toUpperCase()
  let line = `Floor ${world.floor} [${typeLabel}]`

  if (world.encounterType === 'shop') {
    line += ` | Shop open — !b buy 1-4 to purchase, !b move to continue`
    return trunc(line)
  }

  if (world.encounterType === 'event') {
    line += ` | Event floor — !b explore to investigate`
    return trunc(line)
  }

  if (world.floorCleared) {
    line += ` | CLEARED — !b move to descend`
    return trunc(line)
  }

  const livingEnemies = world.enemies.filter((e) => e.hp > 0)
  if (livingEnemies.length > 0) {
    for (const e of livingEnemies) {
      const bar = hpBar(e.hp, e.maxHp)
      line += ` | ${e.name} [AC${e.ac}] ${e.hp}/${e.maxHp}HP [${bar}]`
      if (e.statusEffect) line += ` (${e.statusEffect})`
    }
  }

  const alive = players.filter((p) => p.hp > 0 && !p.isDying)
  const dying = players.filter((p) => p.isDying)
  if (alive.length > 0) {
    const partyStr = alive.slice(0, 4).map((p) => {
      let s = `${p.username}(${p.class[0]} ${p.hp}/${p.maxHp})`
      if (p.statusEffects.length > 0) s += `[${p.statusEffects.slice(0, 2).join(',')}]`
      return s
    }).join(' ')
    line += ` | Party: ${partyStr}`
  }
  if (dying.length > 0) {
    line += ` | DYING: ${dying.map((p) => `${p.username}(${p.deathSuccesses}✓${p.deathFailures}✗)`).join(' ')}`
  }

  line += ` | !b a [target] · !b d · !b spell · !b rest`
  return trunc(line)
}

export function renderCombatResult(result: CombatResult): string {
  let line = `@${result.attacker} `

  if (result.fumble) {
    line += `rolls d20: 1 — CRITICAL FUMBLE! ${result.weaponName} slips. ${result.targetEnemy} grins.`
    return trunc(line)
  }
  if (!result.hit) {
    line += `rolls d20: ${result.d20Roll} + ${result.attackTotal - result.d20Roll} = ${result.attackTotal} vs ${result.targetEnemy} AC ${result.targetAC} — MISS!`
    return trunc(line)
  }

  line += `rolls d20: ${result.d20Roll}`
  if (result.crit) line += ' [NAT 20!]'
  line += ` + ${result.attackTotal - result.d20Roll} = ${result.attackTotal} vs AC ${result.targetAC} — HIT!`
  line += ` ${result.weaponName}: ${result.damageDiceStr} = ${result.damage} dmg.`
  if (result.actuallySick) line += ' ACTUALLY SICK!'

  if (result.enemyKilled) {
    line += ` ${result.targetEnemy}: DEFEATED!`
  } else {
    line += ` ${result.targetEnemy}: ${result.enemyHpAfter}/${result.enemyMaxHp}HP [${hpBar(result.enemyHpAfter, result.enemyMaxHp)}]`
  }

  if (result.statusApplied) line += ` (${result.statusApplied})`

  return trunc(line)
}

export function renderEnemyAttacks(
  attacks: Array<{ enemy: string; target: string; d20Roll?: number; attackTotal?: number; targetAC?: number; damage: number; defended: boolean; killed: boolean; targetHp: number; targetMaxHp: number; isDying?: boolean }>
): string {
  if (attacks.length === 0) return ''
  const parts = attacks.map((a) => {
    if (a.damage === 0) return `${a.enemy} misses @${a.target}`
    let s = `${a.enemy}→@${a.target}`
    if (a.d20Roll) s += ` [d20:${a.d20Roll}+${(a.attackTotal ?? 0) - a.d20Roll}]`
    s += `: -${a.damage}HP`
    if (a.defended) s += '(defended)'
    if (a.isDying) {
      s += ' DYING! (make death saves)'
    } else if (a.killed) {
      s += ' DEAD'
    } else {
      s += ` (${a.targetHp}/${a.targetMaxHp})`
    }
    return s
  })
  return trunc(parts.join(' | '))
}

export function renderFloorClear(
  floor: number,
  loot: Array<{ username: string; item?: string; gold: number }>,
  levelUps: Array<{ username: string; level: number }>
): string {
  let line = `Floor ${floor} cleared! `
  if (loot.length > 0) {
    const parts = loot.map((l) => {
      const items = []
      if (l.item) items.push(l.item)
      if (l.gold > 0) items.push(`${l.gold}g`)
      return items.length > 0 ? `${l.username}→${items.join('+')}` : null
    }).filter(Boolean)
    if (parts.length > 0) line += `Loot: ${parts.join(' ')}. `
  }
  if (levelUps.length > 0) {
    line += `Level up: ${levelUps.map((l) => `${l.username} Lv${l.level}`).join(', ')}! `
  }
  line += `!b move to descend.`
  return trunc(line)
}

const ACH_LABELS: Record<string, string> = {
  boss: 'bossslayer', vegan: 'vegansaint', veteran: 'veteran',
}

export function renderCharacter(char: Character): string {
  const xpTable = [0, 0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000]
  const nextXp = char.level < 10 ? (xpTable[char.level + 1] ?? '—') : 'MAX'
  const stars = char.prestige > 0 ? '★'.repeat(Math.min(char.prestige, 5)) : ''
  const achs = (char.achievements ?? []).length > 0
    ? ` [${char.achievements.map((a) => ACH_LABELS[a] ?? a).join('][')}]`
    : ''

  // class-specific resource display (driven by mechanical chassis)
  const chassis = getClassDef(char.class).chassis
  let resources = ''
  if (char.spellSlots > 0 || char.maxSpellSlots > 0) resources += ` slots:${char.spellSlots}/${char.maxSpellSlots}`
  if (chassis === 'flurry' && char.maxKiPoints > 0) resources += ` ki:${char.kiPoints}/${char.maxKiPoints}`
  if (chassis === 'rage') resources += ` rage:${char.rageCharges}`
  if (chassis === 'surge') resources += char.actionSurgeUsed ? ` surge:spent` : ` surge:ready`
  resources += ` hd:${char.hitDice}/${char.maxHitDice}`

  const ac = charAC(char)
  let line = `${char.username}${stars}${achs} | Lv${char.level} ${char.class} | ${char.hp}/${char.maxHp}HP AC${ac} | ${char.gold}g`
  if (char.inventory.length > 0) line += ` | ${char.inventory.join(', ')}`
  line += ` | XP:${char.xp}/${nextXp}${resources} | deaths:${char.deaths}`
  if (char.statusEffects.length > 0) line += ` | ${char.statusEffects.join(',')}`
  if (char.isDying) {
    line += ` | DYING — saves:${char.deathSuccesses}✓${char.deathFailures}✗`
  } else if (char.respawnAt !== null) {
    const secs = Math.max(0, Math.ceil((char.respawnAt - Date.now()) / 1000))
    line += ` | DEAD — respawning ${secs}s`
  }
  return trunc(line)
}

export function renderParty(players: Character[], world: WorldState): string {
  if (players.length === 0) return `No adventurers in the dungeon. !b join <class> to enter.`
  let line = `Floor ${world.floor} S${world.season} | `
  const parts = players.slice(0, 6).map((p) => {
    const status = p.isDying ? 'DYING' : p.respawnAt !== null ? 'DEAD' : `${p.hp}/${p.maxHp}HP`
    const stars = (p.prestige ?? 0) > 0 ? '★'.repeat(Math.min(p.prestige, 3)) : ''
    return `${p.username}${stars}(Lv${p.level} ${p.class[0]} ${status})`
  })
  line += parts.join(' | ')
  if (players.length > 6) line += ` +${players.length - 6} more`
  return trunc(line)
}

export function renderShop(items: ShopItem[], playerGold: number, floor: number): string {
  const itemList = items.map((it, i) => `${i + 1}.${it.name}(${it.price}g)`).join(' ')
  return trunc(`SHOP (Floor ${floor}) | ${itemList} | You have ${playerGold}g | !b buy 1-4 | !b move to skip`)
}

const DEATH_QUIPS = [
  'the dungeon claims another soul.',
  'fortune was not on their side.',
  'the dice gods are merciless.',
  'a valiant effort, cut short.',
  'even heroes fall.',
]

export function renderDeath(username: string, killer: string): string {
  const quip = DEATH_QUIPS[(username.charCodeAt(0) + killer.charCodeAt(0)) % DEATH_QUIPS.length]
  return trunc(`@${username} has been slain by ${killer}. ${quip} Respawning in 1min — !b floor to spectate.`)
}

export function renderDeathSave(username: string, roll: number, successes: number, failures: number, stable: boolean, revived: boolean): string {
  if (revived) return `@${username} rolls death save: NAT 20 — REVIVED at 1HP! Back from the brink!`
  if (stable) return `@${username} rolls death save: ${roll} — stable. Holding on. An ally can !b stabilize @${username} to confirm.`
  const outcome = roll >= 10 ? `SUCCESS (${successes}/3)` : `FAILURE (${failures}/3)`
  const hint = failures >= 2 ? ' — one more failure means death!' : failures >= 1 ? '' : ''
  return trunc(`@${username} rolls death save: d20 → ${roll} — ${outcome}${hint}. !b stabilize @${username} to help.`)
}

export function renderLevelUp(char: Character, newLevel: number): string {
  const bonus = levelUpBonusFor(getClassDef(char.class).chassis, newLevel)
  return trunc(`${char.username} levels up! Lv${newLevel} ${char.class} — +HP max. ${bonus}`)
}

export function renderJoin(char: Character): string {
  const def = getClassDef(char.class)
  return trunc(`@${char.username} enters as Lv1 ${char.class} (${char.maxHp}HP, AC${charAC(char)}, 10g). ${joinActionFor(def)}. !b floor to see what awaits.`)
}

export function renderClassList(): string {
  return 'classes: barbarian · fighter · paladin · rogue · wizard · cleric · sorcerer · monk · warlock — or !b join <anything> to forge your own custom class'
}

export function renderSeasonComplete(season: number, floor: number): string {
  return trunc(`THE DUNGEON IS CONQUERED! Season ${season} complete — floor ${floor} boss slain. Survivors earn Prestige ★ (+2% dmg, permanent). Season ${season + 1} begins. !b join to descend.`)
}

export function renderOfflineAnnouncement(floor: number): string {
  return `Stream offline. The dungeon stirs. !b join <class> to descend into floor ${floor}.`
}

export function renderOnlineAnnouncement(floor: number, survivors: number): string {
  return `Stream is live! The dungeon holds — floor ${floor} awaits ${survivors} survivor${survivors !== 1 ? 's' : ''}.`
}

export function renderRecap(
  channel: string,
  floor: number,
  season: number,
  logs: Array<{ username: string; action: string; target: string | null; result: string | null }>,
  chars: Character[],
): string {
  const kills = new Map<string, number>()
  const deaths: string[] = []
  for (const l of logs) {
    if (l.action === 'kill') kills.set(l.username, (kills.get(l.username) ?? 0) + 1)
    if (l.action === 'death') deaths.push(l.username)
  }
  const topKiller = [...kills.entries()].sort((a, b) => b[1] - a[1])[0]
  let line = `Dungeon S${season} F${floor} recap: `
  if (topKiller) line += `${topKiller[0]} led with ${topKiller[1]} kills. `
  if (deaths.length > 0) line += `Deaths: ${[...new Set(deaths)].slice(0, 3).join(', ')}. `
  if (chars.length > 0) {
    line += `Party(${chars.length}): ${chars.slice(0, 4).map((c) => `${c.username} Lv${c.level} ${c.class}`).join(', ')}`
  }
  return trunc(line)
}
