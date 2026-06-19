import type { Character, WorldState, ShopItem, CombatResult, DndClass } from './types'

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
    line += ` | Event floor — !b explore to interact`
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
      line += ` | ${e.name} ${e.hp}/${e.maxHp}HP [${bar}]`
      if (e.statusEffects.length > 0) line += ` (${e.statusEffects.join(',')})`
    }
  }

  const alive = players.filter((p) => p.hp > 0)
  if (alive.length > 0) {
    const partyStr = alive.slice(0, 4).map((p) => {
      let s = `${p.username}(${p.class[0]} ${p.hp}/${p.maxHp})`
      if (p.statusEffects.length > 0) s += `[${p.statusEffects.slice(0,2).join(',')}]`
      return s
    }).join(' ')
    line += ` | Party: ${partyStr}`
  }

  line += ` | !b a [target] · !b d · !b use <item> · !b spell`
  return trunc(line)
}

export function renderCombatResult(result: CombatResult, enemyMaxHp: number): string {
  let line = `@${result.attacker} `

  if (result.krippCursed) {
    line += `suffers Kripp's Curse! The ${result.targetEnemy} heals 10HP and laughs. Classic.`
    return trunc(line)
  }
  if (result.miss) {
    line += `rolls a nat 1 — misses ${result.targetEnemy}. RNG gods look away.`
    return trunc(line)
  }

  line += `attacks ${result.targetEnemy} for ${result.damage}dmg`
  if (result.crit) line += ' [CRIT! nat 20]'
  if (result.actuallySick) line += ' — ACTUALLY SICK!'

  if (result.enemyKilled) {
    line += `. ${result.targetEnemy} DEFEATED.`
  } else {
    line += `. ${result.targetEnemy}: ${result.enemyHpAfter}/${enemyMaxHp}HP [${hpBar(result.enemyHpAfter, enemyMaxHp)}]`
  }

  if (result.statusApplied) {
    line += ` (${result.statusApplied} applied)`
  }

  return trunc(line)
}

export function renderEnemyAttacks(
  attacks: Array<{ enemy: string; target: string; damage: number; defended: boolean; killed: boolean; targetHp: number; targetMaxHp: number }>
): string {
  if (attacks.length === 0) return ''
  const parts = attacks.map((a) => {
    if (a.damage === 0) return `${a.enemy} misses @${a.target}`
    let s = `${a.enemy}→@${a.target}: -${a.damage}HP`
    if (a.defended) s += '(defended)'
    if (a.killed) {
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
  const xpNeeded = [0, 0, 100, 250, 450, 700, 1000, 1350, 1750, 2200, 2700]
  const nextXp = char.level < 10 ? (xpNeeded[char.level + 1] ?? '—') : 'MAX'
  const spell = char.spellReady ? '✓' : 'spent'
  const stars = char.prestige > 0 ? '★'.repeat(Math.min(char.prestige, 5)) : ''
  const achs = (char.achievements ?? []).length > 0
    ? ` [${char.achievements.map((a) => ACH_LABELS[a] ?? a).join('][')}]`
    : ''
  let line = `${char.username}${stars}${achs} | Lv${char.level} ${char.class} | ${char.hp}/${char.maxHp}HP | ${char.gold}g`
  if (char.inventory.length > 0) line += ` | ${char.inventory.join(', ')}`
  line += ` | XP: ${char.xp}/${nextXp} | spell:${spell} | deaths:${char.deaths}`
  if (char.statusEffects.length > 0) line += ` | ${char.statusEffects.join(',')}`
  if (char.respawnAt !== null) {
    const secs = Math.max(0, Math.ceil((char.respawnAt - Date.now()) / 1000))
    line += ` | DEAD — respawning ${secs}s or on next floor clear`
  }
  return trunc(line)
}

export function renderParty(players: Character[], world: WorldState): string {
  if (players.length === 0) return `No adventurers in the Depths. !b join <class> to enter.`
  let line = `Floor ${world.floor} S${world.season} | `
  const parts = players.slice(0, 6).map((p) => {
    const status = p.respawnAt !== null ? 'DEAD' : `${p.hp}/${p.maxHp}HP`
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

const KRIPP_DEATH_LINES = [
  'arena bracket: eliminated.',
  'classic Kripp moment.',
  'RNG gods send their regards.',
  'not as sick as expected.',
  'the NL curse claims another.',
]

export function renderDeath(username: string, killer: string, krippCursed: boolean): string {
  const quip = krippCursed
    ? "Kripp's Curse strikes again."
    : KRIPP_DEATH_LINES[Math.floor((username.charCodeAt(0) + killer.charCodeAt(0)) % KRIPP_DEATH_LINES.length)]
  return trunc(`@${username} has been slain by ${killer}. ${quip} Respawning in 1min — !b floor to spectate.`)
}

export function renderLevelUp(char: Character, newLevel: number): string {
  const CLASS_UPGRADE: Record<DndClass, string> = {
    Merchant: 'passive gold +2/floor',
    Rogue: 'poison threshold lowered to 35%',
    Tinkerer: 'overclock bonus raised to +75%',
    Brawler: 'charge stun lasts 2 batches',
    Pyromancer: 'burn ticks for 12 dmg',
    Veteran: 'adapt copies 2 effects',
  }
  return trunc(`${char.username} leveled up! Lv${newLevel} ${char.class} — +${10}HP max. ${CLASS_UPGRADE[char.class]}`)
}

export function renderJoin(char: Character): string {
  return trunc(`@${char.username} enters the Depths as a Lv1 ${char.class} (${char.maxHp}HP, 10g). !b floor to see what awaits.`)
}

export function renderClassList(): string {
  return 'classes: merchant(gold/economy) · rogue(poison/speed) · tinkerer(items/craft) · brawler(strength/charge) · pyromancer(fire/burn) · veteran(balanced) — !b join <class>'
}

export function renderSeasonComplete(season: number, floor: number): string {
  return trunc(`THE DEPTHS ARE CONQUERED! Season ${season} complete — floor ${floor} boss slain. Survivors earn Prestige ★ (+2% dmg, permanent). Season ${season + 1} begins. !b join to descend.`)
}

export function renderOfflineAnnouncement(floor: number): string {
  return `Kripp went to sleep. The Bazaar closes. The Depths open. !b join <class> to descend into floor ${floor}.`
}

export function renderOnlineAnnouncement(floor: number, survivors: number): string {
  return `Kripp is live! The Depths seal. Progress saved — floor ${floor} awaits ${survivors} survivor${survivors !== 1 ? 's' : ''}.`
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
  let line = `Depths S${season} F${floor} recap: `
  if (topKiller) line += `${topKiller[0]} led with ${topKiller[1]} kills. `
  if (deaths.length > 0) line += `Deaths: ${[...new Set(deaths)].slice(0, 3).join(', ')}. `
  if (chars.length > 0) {
    line += `Party(${chars.length}): ${chars.slice(0, 4).map((c) => `${c.username} Lv${c.level} ${c.class}`).join(', ')}`
  }
  return trunc(line)
}
