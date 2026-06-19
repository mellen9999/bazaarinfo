import * as db from './db'
import * as combat from './combat'
import * as floor from './floor'
import * as render from './render'
import * as aiDm from './ai-dm'
import { log } from '../log'
import type { Character, WorldState, DndClass, Enemy } from './types'

type SayFn = (channel: string, msg: string) => void
let say: SayFn = () => {}
export function setSay(fn: SayFn) { say = fn }

let isLiveFn: (ch: string) => boolean = () => true
export function setIsLive(fn: (ch: string) => boolean) { isLiveFn = fn }

export function isLive(channel: string): boolean { return isLiveFn(channel.toLowerCase()) }

// --- rate limiting ---
const ACTION_COOLDOWN = 5_000
const lastAction = new Map<string, number>()

function checkCooldown(username: string, channel: string): boolean {
  const key = `${username.toLowerCase()}:${channel.toLowerCase()}`
  const now = Date.now()
  const last = lastAction.get(key) ?? 0
  if (now - last < ACTION_COOLDOWN) return false
  lastAction.set(key, now)
  return true
}

// how long a player must be AFK before enemies ignore them in combat
const COMBAT_ACTIVE_MS = 5 * 60 * 1000
const RESPAWN_MS = 60_000

// --- action queue + debounce ---
interface QueuedAction {
  username: string
  action: 'attack' | 'defend' | 'spell'
  target: string | null
  spellOverride?: 'shadowstrike' | 'charge' | 'overclock' | 'inferno' | 'liquidate' | 'adapt'
}

const queues = new Map<string, QueuedAction[]>()
const debounceTimers = new Map<string, Timer>()
const processing = new Set<string>()

function enqueue(channel: string, action: QueuedAction) {
  const q = queues.get(channel) ?? []
  q.push(action)
  queues.set(channel, q)

  const existing = debounceTimers.get(channel)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    debounceTimers.delete(channel)
    processQueue(channel).catch((e) => log(`dnd: processQueue error: ${e}`))
  }, 500)
  debounceTimers.set(channel, timer)
}

async function processQueue(channel: string) {
  if (processing.has(channel)) return
  processing.add(channel)
  try {
    const actions = queues.get(channel) ?? []
    queues.delete(channel)
    if (actions.length === 0) return

    const world = db.getWorld(channel)
    if (!world || !world.enabled || world.floorCleared) return
    if (world.encounterType !== 'combat' && world.encounterType !== 'boss') return

    const resultLines: string[] = []
    const levelUpLines: string[] = []

    for (const action of actions) {
      const char = db.getCharacter(action.username, channel)
      if (!char || char.hp <= 0 || char.respawnAt !== null) continue

      const livingEnemies = world.enemies.filter((e) => e.hp > 0)
      if (livingEnemies.length === 0) break

      if (action.action === 'defend') {
        // mark defending — handled on enemy counterattack
        char.defending = true
        char.lastActionAt = Date.now()
        db.upsertCharacter(char)
        resultLines.push(`@${action.username} takes a defensive stance.`)
        continue
      }

      if (action.action === 'spell') {
        const spellResult = resolveSpell(char, world, channel)
        if (spellResult.message) resultLines.push(spellResult.message)
        if (spellResult.levelUp) levelUpLines.push(spellResult.levelUp)
        db.upsertWorld(world)
        continue
      }

      // attack
      const targetEnemy = action.target
        ? world.enemies.find((e) => e.hp > 0 && e.name.toLowerCase().includes(action.target!.toLowerCase()))
        : livingEnemies[0]

      if (!targetEnemy) continue

      const seq = db.nextSequence(channel)
      // prestige bonus: +2% damage per prestige level
      const prestigeBonus = 1 + (char.prestige ?? 0) * 0.02
      const outcome = combat.resolvePlayerAttack(char, targetEnemy, seq, world.nlLifted, action.spellOverride, prestigeBonus)

      let damage = outcome.damage
      if (outcome.krippCursed) {
        // enemy heals 10
        targetEnemy.hp = Math.min(targetEnemy.maxHp, targetEnemy.hp + 10)
      } else if (!outcome.miss) {
        targetEnemy.hp = Math.max(0, targetEnemy.hp - damage)
        if (outcome.statusApplied && !targetEnemy.statusEffects.includes(outcome.statusApplied)) {
          targetEnemy.statusEffects.push(outcome.statusApplied)
        }
      }

      const killed = targetEnemy.hp <= 0
      const result: import('./types').CombatResult = {
        attacker: action.username,
        targetEnemy: targetEnemy.name,
        damage,
        crit: outcome.crit,
        miss: outcome.miss,
        krippCursed: outcome.krippCursed,
        actuallySick: outcome.actuallySick,
        statusApplied: outcome.statusApplied,
        enemyKilled: killed,
        enemyHpAfter: targetEnemy.hp,
      }

      resultLines.push(render.renderCombatResult(result, targetEnemy.maxHp))

      if (killed) {
        const reward = floor.enemyReward(targetEnemy, world.floor)
        // give gold + xp
        char.gold += reward.gold
        char.totalKills++
        // Rogue: steal extra gold on kill
        if (char.class === 'Rogue') char.gold += Math.floor(reward.gold * 0.5)
        // Merchant: passive +2g per kill
        if (char.class === 'Merchant') char.gold += 2
        // boss achievement
        if (targetEnemy.isBoss) db.grantAchievement(action.username, channel, 'boss')

        char.lastActionAt = Date.now()
        db.upsertCharacter(char)

        const { newLevel, leveledUp } = db.addCharacterXp(action.username, channel, reward.xp + combat.CLASS_XP_PER_KILL[char.class])
        if (leveledUp) {
          const updatedChar = db.getCharacter(action.username, channel)
          if (updatedChar) levelUpLines.push(render.renderLevelUp(updatedChar, newLevel))
        }

        // loot drop
        const drop = targetEnemy.isBoss
          ? floor.bossLootDrop(world.season, world.floor)
          : floor.lootDrop(world.season, world.floor, world.enemies.indexOf(targetEnemy))

        if (drop && char.inventory.length < 6) {
          char.inventory.push(drop)
          db.upsertCharacter(char)
          resultLines.push(`@${action.username} found [${drop}]!${outcome.actuallySick ? ' ACTUALLY SICK — bonus drop!' : ''}`)
          if (outcome.actuallySick) {
            char.gold += reward.gold * 2
            db.upsertCharacter(char)
          }
        }

        db.logDndAction(channel, action.username, 'kill', targetEnemy.name, `${damage}dmg`)
      } else {
        char.lastActionAt = Date.now()
        db.upsertCharacter(char)
      }
    }

    // process status ticks on enemies
    for (const enemy of world.enemies.filter((e) => e.hp > 0)) {
      const tick = combat.statusTickDamage(enemy.statusEffects as import('./types').StatusEffect[])
      if (tick > 0) {
        enemy.hp = Math.max(0, enemy.hp - tick)
        // remove freeze after tick
        enemy.statusEffects = enemy.statusEffects.filter((s) => s !== 'freeze')
      }
    }

    db.upsertWorld(world)

    // post player action results
    const combined = resultLines.join(' | ')
    if (combined) say(channel, combined.slice(0, 480))
    for (const lu of levelUpLines) say(channel, lu)

    // check all enemies dead
    const allDead = world.enemies.every((e) => e.hp <= 0)
    if (allDead) {
      await handleFloorClear(channel, world)
      return
    }

    // enemy counterattacks
    await resolveEnemyCounterattacks(channel, world)
  } finally {
    processing.delete(channel)
  }
}

async function resolveEnemyCounterattacks(channel: string, world: WorldState) {
  const freshWorld = db.getWorld(channel)
  if (!freshWorld) return
  const livingEnemies = freshWorld.enemies.filter((e) => e.hp > 0)
  if (livingEnemies.length === 0) return

  // only target players who acted in the last 5 min — AFK players are ignored by enemies
  const now = Date.now()
  const targets = db.getActivePlayers(channel).filter((p) =>
    p.hp > 0 && p.respawnAt === null && (now - p.lastActionAt) < COMBAT_ACTIVE_MS
  )
  if (targets.length === 0) return // all AFK — enemies wait

  // scale enemy damage by party size
  const partySize = Math.max(1, targets.length)
  const damageScale = partySize === 1 ? 0.75 : partySize === 2 ? 0.90 : 1.0

  const attacks: Array<{ enemy: string; target: string; damage: number; defended: boolean; killed: boolean; targetHp: number; targetMaxHp: number }> = []

  for (const enemy of livingEnemies) {
    if (enemy.stunned) {
      enemy.stunned = false
      continue
    }
    // pick random target
    const target = targets[Math.floor((Date.now() % 999983) % targets.length)]
    if (!target) continue

    const seq = db.nextSequence(channel)
    const { damage, miss } = combat.resolveEnemyAttack(enemy, target, freshWorld.floor, seq, freshWorld.nlLifted, damageScale)

    if (miss || damage === 0) {
      attacks.push({ enemy: enemy.name, target: target.username, damage: 0, defended: false, killed: false, targetHp: target.hp, targetMaxHp: target.maxHp })
      continue
    }

    const newHp = db.damageCharacter(target.username, channel, damage)
    const killed = newHp <= 0

    attacks.push({
      enemy: enemy.name,
      target: target.username,
      damage,
      defended: target.defending,
      killed,
      targetHp: newHp,
      targetMaxHp: target.maxHp,
    })

    if (killed) {
      db.killCharacter(target.username, channel, Date.now() + RESPAWN_MS)
      scheduleRespawn(target.username, channel, RESPAWN_MS)
      db.logDndAction(channel, target.username, 'death', enemy.name)

      // async death flavor
      aiDm.narrateDeath(target.username, enemy.name, freshWorld.floor).then((flavor) => {
        if (flavor) say(channel, render.renderDeath(target.username, enemy.name, false) + ' ' + flavor.slice(0, 100))
        else say(channel, render.renderDeath(target.username, enemy.name, false))
      }).catch(() => {
        say(channel, render.renderDeath(target.username, enemy.name, false))
      })
    }
  }

  // reset defending flags
  for (const p of targets) {
    if (p.defending) {
      p.defending = false
      db.upsertCharacter(p)
    }
  }

  db.upsertWorld(freshWorld)

  const attackLine = render.renderEnemyAttacks(attacks)
  if (attackLine) say(channel, attackLine)

  // combat hint: enemies + party HP snapshot, then action prompt
  const stillAlive = freshWorld.enemies.filter((e) => e.hp > 0)
  if (stillAlive.length > 0) {
    const freshParty = db.getActivePlayers(channel).filter((p) => p.hp > 0 && p.respawnAt === null)
    const partyHp = freshParty.reduce((s, p) => s + p.hp, 0)
    const partyMaxHp = freshParty.reduce((s, p) => s + p.maxHp, 0)
    const enemyStr = stillAlive.map((e) => `${e.name} ${e.hp}/${e.maxHp}HP`).join(', ')
    const partyStr = partyMaxHp > 0 ? ` | party ${partyHp}/${partyMaxHp}HP` : ''
    say(channel, `${enemyStr}${partyStr} | !b a · !b d · !b spell`)
  }

  // status ticks on players
  for (const target of targets) {
    const fresh = db.getCharacter(target.username, channel)
    if (!fresh || fresh.hp <= 0) continue
    const tick = combat.statusTickDamage(fresh.statusEffects)
    if (tick > 0) {
      const newHp = db.damageCharacter(target.username, channel, tick)
      say(channel, `@${fresh.username} takes ${tick} status dmg (${newHp}/${fresh.maxHp}HP)`)
      if (newHp <= 0) {
        db.killCharacter(target.username, channel, Date.now() + RESPAWN_MS)
        scheduleRespawn(target.username, channel, RESPAWN_MS)
      }
    }
  }
}

async function handleFloorClear(channel: string, world: WorldState) {
  world.floorCleared = true

  // floor-transition respawn: anyone dead comes back on floor clear
  const deadChars = db.getAllDeadCharacters(channel)
  if (deadChars.length > 0) {
    const respawnedNames: string[] = []
    for (const dead of deadChars) {
      // give ghost XP for spectating
      db.addCharacterXp(dead.username, channel, 3)
      // cancel respawn timer and revive
      const key = `${dead.username.toLowerCase()}:${channel.toLowerCase()}`
      const timer = respawnTimers.get(key)
      if (timer) { clearTimeout(timer); respawnTimers.delete(key) }
      db.respawnCharacter(dead.username, channel)
      respawnedNames.push(dead.username)
    }
    say(channel, `${respawnedNames.map((u) => `@${u}`).join(' ')} rise from the grave — floor clear respawn! !b floor to see what's next.`)
  }

  const activePlayers = db.getActivePlayers(channel)
  const loot: Array<{ username: string; item?: string; gold: number }> = []
  const levelUps: Array<{ username: string; level: number }> = []

  // distribute gold to living players who participated (acted within last 10min)
  for (const p of activePlayers) {
    if (p.hp <= 0 || p.respawnAt !== null) continue
    const goldReward = 5 + world.floor * 2
    p.gold += goldReward
    p.spellReady = true  // recharge spell on floor clear
    p.defending = false
    db.upsertCharacter(p)
    loot.push({ username: p.username, gold: goldReward })
  }

  // small heal on floor clear (not boss)
  if (world.encounterType !== 'boss') {
    for (const p of activePlayers.filter((p) => p.hp > 0)) {
      db.healCharacter(p.username, channel, 15)
    }
  }

  db.upsertWorld(world)
  say(channel, render.renderFloorClear(world.floor, loot, levelUps))

  // check season complete (floor 10 boss)
  if (world.floor === 10 && world.encounterType === 'boss') {
    // prestige + veteran achievement for survivors
    const survivors = db.getAllCharacters(channel).filter((p) => p.hp > 0 && p.respawnAt === null)
    for (const p of survivors) {
      db.addPrestige(p.username, channel)
      db.grantAchievement(p.username, channel, 'veteran')
    }
    if (survivors.length > 0) {
      const names = survivors.map((p) => `@${p.username}★`).join(' ')
      setTimeout(() => say(channel, `${names} earned Prestige ★ for conquering the season! +2% dmg per star, permanently.`), 600)
    }
    say(channel, render.renderSeasonComplete(world.season, world.floor))
    setTimeout(() => startNewSeason(channel), 3500)
  }
}

function startNewSeason(channel: string) {
  const world = db.getWorld(channel)
  if (!world) return
  const newWorld: WorldState = {
    ...world,
    floor: 1,
    actionSequence: 0,
    encounterType: floor.getFloorType(1),
    enemies: floor.generateEnemies(world.season + 1, 1),
    floorCleared: false,
    scene: '',
    season: world.season + 1,
    nlLifted: false,
    shopInventory: [],
    veganShrineVisited: false,
  }
  db.upsertWorld(newWorld)
  say(channel, `Season ${newWorld.season} begins! Floor 1 awaits. !b floor to descend.`)
}

// --- spell resolution ---
interface SpellResult { message: string; levelUp?: string }

function resolveSpell(char: Character, world: WorldState, channel: string): SpellResult {
  if (!char.spellReady) {
    return { message: `@${char.username}: spell not ready (recharges on floor clear)` }
  }

  const livingEnemies = world.enemies.filter((e) => e.hp > 0)
  if (livingEnemies.length === 0) return { message: '' }

  char.spellReady = false
  char.lastActionAt = Date.now()

  switch (char.class) {
    case 'Merchant': {
      // Liquidate: convert worst item to 20g + 20 flat damage to first enemy
      const target = livingEnemies[0]
      target.hp = Math.max(0, target.hp - 20)
      let goldGained = 20
      if (char.inventory.length > 0) {
        // remove last (worst) item
        const removed = char.inventory.pop()
        goldGained += 10
        db.upsertCharacter(char)
        char.gold += goldGained
        db.upsertCharacter(char)
        return { message: `@${char.username} LIQUIDATES ${removed ?? 'nothing'}! +${goldGained}g, ${target.name} takes 20dmg (${target.hp}/${target.maxHp}HP).` }
      }
      char.gold += goldGained
      db.upsertCharacter(char)
      return { message: `@${char.username} LIQUIDATES thin air for +${goldGained}g and 20dmg to ${target.name} (${target.hp}/${target.maxHp}HP).` }
    }

    case 'Rogue': {
      // Shadowstrike: guaranteed crit + double poison on first enemy
      const target = livingEnemies[0]
      const seq = db.nextSequence(channel)
      const outcome = combat.resolvePlayerAttack(char, target, seq, world.nlLifted, 'shadowstrike')
      target.hp = Math.max(0, target.hp - outcome.damage)
      // add two poison stacks
      target.statusEffects.push('poison', 'poison')
      db.upsertCharacter(char)
      const killed = target.hp <= 0
      if (killed) {
        char.gold += floor.enemyReward(target, world.floor).gold
        db.upsertCharacter(char)
      }
      return { message: `@${char.username} SHADOWSTRIKES ${target.name} for ${outcome.damage}dmg [CRIT!] + double poison! ${killed ? 'DEFEATED.' : `${target.hp}/${target.maxHp}HP`}` }
    }

    case 'Tinkerer': {
      // Overclock: buff is active for next attack — mark with a temp flag via next queued action
      // We apply it immediately as a buffed attack
      const target = livingEnemies[0]
      const seq = db.nextSequence(channel)
      const outcome = combat.resolvePlayerAttack(char, target, seq, world.nlLifted, 'overclock')
      target.hp = Math.max(0, target.hp - outcome.damage)
      db.upsertCharacter(char)
      const killed = target.hp <= 0
      return { message: `@${char.username} OVERCLOCKS — attacks ${target.name} for ${outcome.damage}dmg (+50% item power)! ${killed ? 'DEFEATED.' : `${target.hp}/${target.maxHp}HP`}` }
    }

    case 'Brawler': {
      // Charge: 3x damage + stun first enemy
      const target = livingEnemies[0]
      const seq = db.nextSequence(channel)
      const outcome = combat.resolvePlayerAttack(char, target, seq, world.nlLifted, 'charge')
      target.hp = Math.max(0, target.hp - outcome.damage)
      target.stunned = true
      db.upsertCharacter(char)
      const killed = target.hp <= 0
      return { message: `@${char.username} CHARGES ${target.name} for ${outcome.damage}dmg [3x!] — stunned! ${killed ? 'DEFEATED.' : `${target.hp}/${target.maxHp}HP, will miss next attack`}` }
    }

    case 'Pyromancer': {
      // Inferno: 25 dmg + burn to ALL enemies
      const parts: string[] = []
      for (const enemy of livingEnemies) {
        enemy.hp = Math.max(0, enemy.hp - 25)
        if (!enemy.statusEffects.includes('burn')) enemy.statusEffects.push('burn')
        parts.push(`${enemy.name}(${enemy.hp}HP)`)
      }
      db.upsertCharacter(char)
      return { message: `@${char.username} unleashes INFERNO! 25dmg + burn to all: ${parts.join(', ')}` }
    }

    case 'Veteran': {
      // Adapt: copy first enemy's top item effect for this floor (apply blessed + enemy item bonus as status)
      const target = livingEnemies[0]
      if (!char.statusEffects.includes('blessed')) char.statusEffects.push('blessed')
      db.upsertCharacter(char)
      const copiedItem = target.items[0] ?? 'enemy essence'
      return { message: `@${char.username} ADAPTS — copies ${copiedItem} from ${target.name}. Blessed +20% dmg this floor.` }
    }

    default:
      return { message: '' }
  }
}

// --- join announcement (debounced per channel, one floor ping per burst of joins) ---
const joinAnnounceTimers = new Map<string, Timer>()
// track the most recent joiner for personalized welcome
const pendingJoiners = new Map<string, { username: string; cls: string }>()

export function announceJoin(channel: string, newPlayer?: { username: string; cls: string }): void {
  if (newPlayer) pendingJoiners.set(channel, newPlayer)
  if (joinAnnounceTimers.has(channel)) return // already scheduled
  const timer = setTimeout(async () => {
    joinAnnounceTimers.delete(channel)
    const joiner = pendingJoiners.get(channel)
    pendingJoiners.delete(channel)
    const world = db.getWorld(channel)
    if (!world || !world.enabled) return
    const players = db.getActivePlayers(channel)
    const aliveEnemies = world.enemies.filter((e) => e.hp > 0)
    if (joiner) {
      // personal welcome for brand-new or returning player
      const msg = await aiDm.welcomePlayer(
        joiner.username, joiner.cls,
        world.floor, world.encounterType,
        aliveEnemies.map((e) => e.name),
      )
      if (msg) { say(channel, msg); return }
    }
    // fallback: narrative floor state
    const narration = await aiDm.narrateFloor(
      world.floor, world.encounterType,
      aliveEnemies.map((e) => ({ name: e.name, hp: e.hp, maxHp: e.maxHp })),
      players.filter((p) => p.hp > 0).length,
      world.nlLifted,
    )
    say(channel, narration || render.renderFloor(world, players))
  }, 400)
  joinAnnounceTimers.set(channel, timer)
}

// --- respawn timers ---
const respawnTimers = new Map<string, Timer>()

export function scheduleRespawn(username: string, channel: string, delayMs: number) {
  const key = `${username.toLowerCase()}:${channel.toLowerCase()}`
  const existing = respawnTimers.get(key)
  if (existing) clearTimeout(existing)

  const timer = setTimeout(() => {
    respawnTimers.delete(key)
    db.respawnCharacter(username, channel)
    // solo floor reset: if player returns to an empty party, refresh enemies to solo scale
    const world = db.getWorld(channel)
    if (world && !world.floorCleared && (world.encounterType === 'combat' || world.encounterType === 'boss')) {
      const active = db.getActivePlayers(channel).filter((p) => p.hp > 0 && p.respawnAt === null)
      if (active.length <= 1) {
        world.enemies = floor.generateEnemies(world.season, world.floor)
        for (const e of world.enemies) {
          e.hp = Math.max(10, Math.floor(e.hp * 0.65))
          e.maxHp = e.hp
        }
        db.upsertWorld(world)
        say(channel, `@${username} rises from the grave — enemies reset for solo. → !b floor to descend.`)
        return
      }
    }
    say(channel, `@${username} respawns at the floor entrance with half HP. !b floor to rejoin.`)
  }, delayMs)
  respawnTimers.set(key, timer)
}

// --- public action API ---

export function queueAttack(username: string, channel: string, target: string | null): string | null {
  if (!checkCooldown(username, channel)) return null

  const world = db.getWorld(channel)
  if (!world || !world.enabled) return null

  const char = db.getCharacter(username, channel)
  if (!char) return `!b join <class> to enter the Depths`

  const now = Date.now()
  if (char.respawnAt !== null) {
    if (char.respawnAt > now) {
      const secs = Math.ceil((char.respawnAt - now) / 1000)
      return `@${username} you're dead — respawning in ${secs}s`
    }
    db.respawnCharacter(username, channel)
  }

  if (world.floorCleared) return `floor ${world.floor} cleared — !b move to descend`
  if (world.encounterType === 'shop') return `you're in a shop — !b buy <1-4> or !b move`
  if (world.encounterType === 'event') return `it's an event floor — !b explore`

  const living = world.enemies.filter((e) => e.hp > 0)
  if (living.length === 0) return null

  enqueue(channel, { username, action: 'attack', target })
  return null
}

export function queueDefend(username: string, channel: string): string | null {
  if (!checkCooldown(username, channel)) return null

  const world = db.getWorld(channel)
  if (!world || !world.enabled) return null

  const char = db.getCharacter(username, channel)
  if (!char || char.hp <= 0 || char.respawnAt !== null) return null

  enqueue(channel, { username, action: 'defend', target: null })
  return null
}

export function queueSpell(username: string, channel: string): string | null {
  if (!checkCooldown(username, channel)) return null

  const world = db.getWorld(channel)
  if (!world || !world.enabled) return null

  const char = db.getCharacter(username, channel)
  if (!char || char.hp <= 0 || char.respawnAt !== null) return `@${username} you're not in fighting shape`
  if (!char.spellReady) return `@${username}: spell spent — recharges on floor clear`
  if (world.floorCleared) return `floor ${world.floor} cleared — !b move to descend`

  enqueue(channel, { username, action: 'spell', target: null })
  return null
}

export function resolveUseItem(username: string, channel: string, itemName: string): string | null {
  const world = db.getWorld(channel)
  if (!world || !world.enabled) return null

  const char = db.getCharacter(username, channel)
  if (!char) return null
  if (char.hp <= 0 && char.respawnAt !== null) return null

  const idx = char.inventory.findIndex((i) => i.toLowerCase().includes(itemName.toLowerCase()))
  if (idx === -1) return `@${username}: no "${itemName}" in inventory (use !b me to check)`

  const item = char.inventory[idx]
  const bonus = combat.getItemBonus(item)

  if (bonus.onUseHeal > 0) {
    char.inventory.splice(idx, 1)
    const newHp = db.healCharacter(username, channel, bonus.onUseHeal)
    db.upsertCharacter(char)
    return `@${username} uses ${item} — heals ${bonus.onUseHeal}HP (${newHp}/${char.maxHp}HP). Item consumed.`
  }

  return `@${username}: ${item} has no use effect in combat (it's a passive item).`
}

export function resolveFlee(username: string, channel: string): string | null {
  const world = db.getWorld(channel)
  if (!world || !world.enabled || world.floorCleared) return null

  const char = db.getCharacter(username, channel)
  if (!char || char.hp <= 0) return null

  const seq = db.nextSequence(channel)
  const { hit } = combat.diceRolls(seq, world.nlLifted)

  if (hit > 0.5) {
    return `@${username} flees from floor ${world.floor}! The Depths let them go... this time. (!b floor to see remaining enemies)`
  }
  // failed flee — enemy gets a free hit
  const living = world.enemies.filter((e) => e.hp > 0)
  if (living.length > 0) {
    const enemy = living[0]
    const dmg = 8 + world.floor * 3
    const newHp = db.damageCharacter(username, channel, dmg)
    if (newHp <= 0) {
      db.killCharacter(username, channel, Date.now() + RESPAWN_MS)
      scheduleRespawn(username, channel, RESPAWN_MS)
      return `@${username} tries to flee but ${enemy.name} strikes first for ${dmg}dmg! SLAIN. Respawning in 1min.`
    }
    return `@${username} fails to flee — ${enemy.name} hits for ${dmg}dmg (${newHp}/${char.maxHp}HP). Classic.`
  }
  return null
}

export function resolveBuy(username: string, channel: string, arg: string): string | null {
  const world = db.getWorld(channel)
  if (!world || !world.enabled) return null
  if (world.encounterType !== 'shop') return `no shop here — find one on floors 3 and 5`

  const char = db.getCharacter(username, channel)
  if (!char) return `!b join <class> to enter the Depths`

  const slotNum = parseInt(arg.trim())
  const shop = world.shopInventory
  const item = isNaN(slotNum) ? shop.find((s) => s.name.toLowerCase().includes(arg.toLowerCase())) : shop[slotNum - 1]

  if (!item) return `@${username}: no item "${arg}" in shop (1-${shop.length})`
  if (char.gold < item.price) return `@${username}: need ${item.price}g, you have ${char.gold}g`
  if (char.inventory.length >= 6) return `@${username}: inventory full (6/6) — !b me to check what you have`

  char.gold -= item.price
  char.inventory.push(item.name)
  db.upsertCharacter(char)
  return `@${username} buys ${item.name} for ${item.price}g. (${char.gold}g left | inv: ${char.inventory.length}/6)`
}

export async function resolveMove(username: string, channel: string): Promise<string | null> {
  const world = db.getWorld(channel)
  if (!world || !world.enabled) return null

  const char = db.getCharacter(username, channel)
  if (!char || (char.hp <= 0 && char.respawnAt !== null)) return null

  if (!world.floorCleared && world.encounterType !== 'shop' && world.encounterType !== 'event') {
    const living = world.enemies.filter((e) => e.hp > 0)
    if (living.length > 0) return `enemies still alive on floor ${world.floor} — defeat them first! (!b floor to see HP)`
  }

  const nextFloor = world.floor + 1
  if (nextFloor > 10) {
    return `you're at the final floor — defeat the boss to complete the season!`
  }

  const newEncounterType = floor.getFloorType(nextFloor)
  const newEnemies = (newEncounterType === 'combat' || newEncounterType === 'boss')
    ? floor.generateEnemies(world.season, nextFloor)
    : []
  const newShop = newEncounterType === 'shop' ? floor.generateShop(world.season, nextFloor) : []

  // scale enemy HP by live party size
  const players = db.getActivePlayers(channel)
  const aliveCount = Math.max(1, players.filter((p) => p.hp > 0 && p.respawnAt === null).length)
  const hpScale = aliveCount === 1 ? 0.65 : aliveCount === 2 ? 0.85 : 1.0
  if (hpScale < 1.0) {
    for (const e of newEnemies) {
      e.hp = Math.max(10, Math.floor(e.hp * hpScale))
      e.maxHp = e.hp
    }
  }

  const newWorld: WorldState = {
    ...world,
    floor: nextFloor,
    encounterType: newEncounterType,
    enemies: newEnemies,
    floorCleared: newEncounterType === 'event' || newEncounterType === 'shop',
    scene: '',
    shopInventory: newShop,
  }
  db.upsertWorld(newWorld)

  if (newEncounterType === 'shop') {
    return render.renderShop(newShop, char.gold, nextFloor)
  }

  const aliveEnemies = newEnemies.filter((e) => e.hp > 0)
  const narration = await aiDm.narrateFloor(
    nextFloor, newEncounterType,
    aliveEnemies.map((e) => ({ name: e.name, hp: e.hp, maxHp: e.maxHp })),
    players.filter((p) => p.hp > 0).length,
    newWorld.nlLifted,
  )
  return narration || render.renderFloor(newWorld, players)
}

export async function resolveExplore(username: string, channel: string): Promise<string | null> {
  const world = db.getWorld(channel)
  if (!world || !world.enabled) return null
  if (world.encounterType !== 'event') return `nothing to explore here`

  const char = db.getCharacter(username, channel)
  if (!char) return `!b join <class> to enter the Depths`

  if (!world.veganShrineVisited) {
    // Vegan shrine
    world.veganShrineVisited = true
    world.floorCleared = true
    db.upsertWorld(world)

    const hasMeat = combat.hasMeatItems(char.inventory)
    if (!hasMeat) {
      // Full heal + blessed + vegan achievement
      db.healCharacter(username, channel, char.maxHp)
      if (!char.statusEffects.includes('blessed')) char.statusEffects.push('blessed')
      db.upsertCharacter(char)
      db.grantAchievement(username, channel, 'vegan')
    }

    const flavor = await aiDm.narrateVeganShrine(!hasMeat, username)
    if (flavor) return flavor.slice(0, 480)

    if (!hasMeat) {
      return `@${username} approaches the Vegan Shrine. It glows. "A true vegan." Full heal + blessed. !b move to continue.`
    }
    return `@${username} approaches the Vegan Shrine. It recoils. "Carnivore detected." Nothing happens. Classic. !b move to continue.`
  } else {
    // NL Shrine (second event)
    const players = db.getActivePlayers(channel)
    const totalGold = players.reduce((sum, p) => sum + p.gold, 0)

    if (totalGold < 50) {
      return `NL Shrine demands 50g from the party. Current total: ${totalGold}g. "Not enough gold to appease the RNG gods. Classic."`
    }

    // deduct proportionally
    let remaining = 50
    for (const p of players) {
      if (remaining <= 0) break
      const share = Math.min(p.gold, Math.ceil((p.gold / totalGold) * 50))
      p.gold -= share
      remaining -= share
      db.upsertCharacter(p)
    }

    world.nlLifted = true
    world.floorCleared = true
    db.upsertWorld(world)
    return `The party pools 50g into the NL Shrine. The curse lifts. +5% luck for the rest of the season. "Actually not as cursed." !b move to continue.`
  }
}

export async function resolveFloor(username: string, channel: string): Promise<string | null> {
  const world = db.getWorld(channel)
  if (!world || !world.enabled) return null

  const players = db.getActivePlayers(channel)

  if (world.encounterType === 'shop') {
    const char = db.getCharacter(username, channel)
    return render.renderShop(world.shopInventory, char?.gold ?? 0, world.floor)
  }

  const aliveEnemies = world.enemies.filter((e) => e.hp > 0)
  const narration = await aiDm.narrateFloor(
    world.floor, world.encounterType,
    aliveEnemies.map((e) => ({ name: e.name, hp: e.hp, maxHp: e.maxHp })),
    players.filter((p) => p.hp > 0).length,
    world.nlLifted,
  )
  return narration || render.renderFloor(world, players)
}

// --- stream hooks ---

export function onStreamOffline(channel: string): void {
  const world = db.getWorld(channel)
  if (!world?.enabled) return
  say(channel, render.renderOfflineAnnouncement(world.floor))
}

export function onStreamOnline(channel: string): void {
  const world = db.getWorld(channel)
  if (!world?.enabled) return
  const survivors = db.getActivePlayers(channel).filter((p) => p.hp > 0).length
  say(channel, render.renderOnlineAnnouncement(world.floor, survivors))
}

// --- init / restore ---

export function initEngine(sayFn: SayFn): void {
  say = sayFn
  log('dnd: engine started')
}

export function stopEngine(): void {
  for (const timer of debounceTimers.values()) clearTimeout(timer)
  debounceTimers.clear()
  for (const timer of respawnTimers.values()) clearTimeout(timer)
  respawnTimers.clear()
  for (const timer of joinAnnounceTimers.values()) clearTimeout(timer)
  joinAnnounceTimers.clear()
}

export function restoreFromDb(): void {
  const pending = db.getPendingRespawns()
  const now = Date.now()
  for (const { username, channel, respawnAt } of pending) {
    const delay = Math.max(0, respawnAt - now)
    scheduleRespawn(username, channel, delay)
  }
  if (pending.length > 0) log(`dnd: restored ${pending.length} respawn timer(s)`)
  log('dnd: state ready')
}

export function createWorld(channel: string): WorldState {
  const existing = db.getWorld(channel)
  if (existing) return existing

  const w: WorldState = {
    channel: channel.toLowerCase(),
    floor: 1,
    actionSequence: 0,
    encounterType: floor.getFloorType(1),
    enemies: floor.generateEnemies(1, 1),
    floorCleared: false,
    scene: '',
    season: 1,
    enabled: true,
    nlLifted: false,
    shopInventory: [],
    veganShrineVisited: false,
  }
  db.upsertWorld(w)
  return w
}

export function isDndEnabled(channel: string): boolean {
  const world = db.getWorld(channel)
  return world?.enabled ?? false
}

export function setDndEnabled(channel: string, enabled: boolean): void {
  let world = db.getWorld(channel)
  if (!world) world = createWorld(channel)
  world.enabled = enabled
  db.upsertWorld(world)
}

export function resetFloor(channel: string): void {
  const world = db.getWorld(channel)
  if (!world) return
  world.enemies = floor.generateEnemies(world.season, world.floor)
  world.floorCleared = false
  world.scene = ''
  db.upsertWorld(world)
}
