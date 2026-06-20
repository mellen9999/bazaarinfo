import * as db from './db'
import * as combat from './combat'
import * as floor from './floor'
import * as render from './render'
import * as aiDm from './ai-dm'
import { log } from '../log'
import { getModifier, type Character, type WorldState, type Enemy } from './types'
import { getClassDef, chassisOf } from './classdef'

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
  // allow re-queuing during an open window (player can change attack/defend/spell decision)
  if (debounceTimers.has(channel)) {
    lastAction.set(key, now)
    return true
  }
  const last = lastAction.get(key) ?? 0
  if (now - last < ACTION_COOLDOWN) return false
  lastAction.set(key, now)
  return true
}

const COMBAT_ACTIVE_MS = 5 * 60 * 1000
const RESPAWN_MS = 60_000

// --- action queue + round window ---
interface QueuedAction {
  username: string
  action: 'attack' | 'defend' | 'spell'
  target: string | null
}

const queues = new Map<string, QueuedAction[]>()
const debounceTimers = new Map<string, Timer>()
const windowStartTimes = new Map<string, number>()
const processing = new Set<string>()
const roundCounters = new Map<string, number>()

// Solo: short window (player acts alone, fast feedback)
// Party: 20s window from first action — everyone has time to decide
// Early-close: all recently-active players have acted → fire immediately
const SOLO_ROUND_MS = 3_000
const PARTY_ROUND_MS = 20_000
const RECENTLY_ACTIVE_MS = 45_000  // acted in last 45s = "waiting for this player"

function getWaitedForPlayers(channel: string) {
  const now = Date.now()
  // windowStart: 0 if no window open (open window: only wait for players active before it opened + 5s grace)
  const windowStart = windowStartTimes.get(channel) ?? 0
  return db.getActivePlayers(channel).filter((p) => {
    if (p.hp <= 0 || p.respawnAt !== null || p.isDying) return false
    if ((now - p.lastActionAt) >= RECENTLY_ACTIVE_MS) return false
    // if a window is open, exclude players who joined after it started (prevents new joiners blocking early-close)
    if (windowStart > 0 && p.lastActionAt > windowStart + 5_000) return false
    return true
  })
}

function enqueue(channel: string, action: QueuedAction) {
  const q = queues.get(channel) ?? []
  // allow changing action during the window (replace, don't stack)
  const idx = q.findIndex((a) => a.username.toLowerCase() === action.username.toLowerCase())
  if (idx >= 0) q[idx] = action
  else q.push(action)
  queues.set(channel, q)

  // early-close: all waited-for players have acted
  const waitedFor = getWaitedForPlayers(channel)
  const actedSet = new Set(q.map((a) => a.username.toLowerCase()))
  const allActed = waitedFor.length > 0 && waitedFor.every((p) => actedSet.has(p.username.toLowerCase()))
  if (allActed) {
    const existing = debounceTimers.get(channel)
    if (existing) clearTimeout(existing)
    debounceTimers.delete(channel)
    windowStartTimes.delete(channel)
    processQueue(channel).catch((e) => log(`dnd: processQueue error: ${e}`))
    return
  }

  // don't reset the window once it's open — let it run its full duration
  if (debounceTimers.has(channel)) return

  // record when this window opened (used to exclude mid-window joiners from "waited-for" list)
  windowStartTimes.set(channel, Date.now())

  // start window: solo = 3s, party = 20s
  const windowMs = waitedFor.length <= 1 ? SOLO_ROUND_MS : PARTY_ROUND_MS
  const timer = setTimeout(() => {
    debounceTimers.delete(channel)
    windowStartTimes.delete(channel)
    processQueue(channel).catch((e) => log(`dnd: processQueue error: ${e}`))
  }, windowMs)
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
      if (!char || char.hp <= 0 || char.respawnAt !== null || char.isDying) continue

      const livingEnemies = world.enemies.filter((e) => e.hp > 0)
      if (livingEnemies.length === 0) break

      if (action.action === 'defend') {
        char.defending = true
        char.lastActionAt = Date.now()
        db.upsertCharacter(char)
        resultLines.push(`@${action.username} takes a defensive stance (+2 AC until next attack).`)
        continue
      }

      if (action.action === 'spell') {
        const spellResult = resolveSpell(char, world, channel)
        if (spellResult.message) resultLines.push(spellResult.message)
        if (spellResult.levelUp) levelUpLines.push(spellResult.levelUp)
        db.upsertWorld(world)
        continue
      }

      // --- attack ---
      // auto-distribute: each player naturally targets a different enemy by username hash
      const autoIdx = action.username.charCodeAt(0) % livingEnemies.length
      const targetEnemy = action.target
        ? world.enemies.find((e) => e.hp > 0 && e.name.toLowerCase().includes(action.target!.toLowerCase()))
        : livingEnemies[autoIdx]
      if (!targetEnemy) continue

      const seq = db.nextSequence(channel)
      const activePlayers = db.getActivePlayers(channel).filter((p) => p.hp > 0 && !p.isDying && p.respawnAt === null)
      const hasAdvantage = chassisOf(char) === 'sneak' && activePlayers.length > 1
      const hasDisadvantage = char.statusEffects.some((s) => s === 'poisoned' || s === 'blinded')
      const damageMult = 1 + (char.prestige ?? 0) * 0.02
      const outcome = combat.resolvePlayerAttack(char, targetEnemy, seq, hasAdvantage, hasDisadvantage, damageMult)

      if (!outcome.hit) {
        const result: import('./types').CombatResult = {
          attacker: action.username, targetEnemy: targetEnemy.name,
          enemyMaxHp: targetEnemy.maxHp,
          d20Roll: outcome.d20Roll, attackTotal: outcome.attackTotal, targetAC: outcome.targetAC,
          hit: false, crit: false, fumble: outcome.fumble,
          damage: 0, damageDiceStr: '', weaponName: outcome.weaponName,
          enemyKilled: false, enemyHpAfter: targetEnemy.hp,
        }
        resultLines.push(render.renderCombatResult(result))
        char.lastActionAt = Date.now()
        db.upsertCharacter(char)
        continue
      }

      // --- handle Warlock Hex bonus damage ---
      let extraDmg = 0
      if (chassisOf(char) === 'curse' && targetEnemy.statusEffect === 'hexed') {
        const hexRolls = Array.from({ length: 1 }, () => Math.floor(Math.random() * 6) + 1)
        extraDmg = hexRolls.reduce((s, r) => s + r, 0)
      }
      const totalDmg = outcome.damage + extraDmg

      targetEnemy.hp = Math.max(0, targetEnemy.hp - totalDmg)
      if (outcome.statusApplied && !targetEnemy.statusEffect) {
        const isFireStatus = outcome.statusApplied === 'burning'
        const fireImmune = targetEnemy.specialAbility === 'fire_immunity'
        if (!isFireStatus || !fireImmune) {
          targetEnemy.statusEffect = outcome.statusApplied
          targetEnemy.statusRoundsLeft = 3
        } else {
          resultLines.push(`${targetEnemy.name} is immune to fire!`)
        }
      }

      const killed = targetEnemy.hp <= 0

      // Troll special: regenerate 10HP at end of round if not killed by fire/acid
      if (killed && targetEnemy.specialAbility === 'regeneration') {
        const killerChassis = chassisOf(char)
        if (killerChassis !== 'nuke' && killerChassis !== 'chaos') {
          // Troll doesn't die yet — regenerates next round
          targetEnemy.hp = 10
          const result: import('./types').CombatResult = {
            attacker: action.username, targetEnemy: targetEnemy.name,
            enemyMaxHp: targetEnemy.maxHp,
            d20Roll: outcome.d20Roll, attackTotal: outcome.attackTotal, targetAC: outcome.targetAC,
            hit: true, crit: outcome.crit, fumble: false,
            damage: totalDmg, damageDiceStr: outcome.damageDiceStr, weaponName: outcome.weaponName,
            enemyKilled: false, enemyHpAfter: 10,
            statusApplied: outcome.statusApplied,
          }
          resultLines.push(render.renderCombatResult(result) + ` (${targetEnemy.name} regenerates 10HP! Use fire or acid!)`)
          char.lastActionAt = Date.now()
          db.upsertCharacter(char)
          continue
        }
      }

      const result: import('./types').CombatResult = {
        attacker: action.username, targetEnemy: targetEnemy.name,
        enemyMaxHp: targetEnemy.maxHp,
        d20Roll: outcome.d20Roll, attackTotal: outcome.attackTotal, targetAC: outcome.targetAC,
        hit: true, crit: outcome.crit, fumble: false,
        damage: totalDmg, damageDiceStr: outcome.damageDiceStr + (extraDmg > 0 ? `+${extraDmg}hex` : ''),
        weaponName: outcome.weaponName,
        statusApplied: outcome.statusApplied,
        enemyKilled: killed, enemyHpAfter: targetEnemy.hp,
        actuallySick: outcome.actuallySick,
      }
      resultLines.push(render.renderCombatResult(result))

      if (killed) {
        const reward = floor.enemyReward(targetEnemy, world.floor)
        char.gold += reward.gold
        char.totalKills++
        // Sneak chassis: steal extra gold on kill
        if (chassisOf(char) === 'sneak') char.gold += Math.floor(reward.gold * 0.5)
        // boss achievement
        if (targetEnemy.isBoss) db.grantAchievement(action.username, channel, 'boss')

        char.lastActionAt = Date.now()
        db.upsertCharacter(char)

        const { newLevel, leveledUp } = db.addCharacterXp(action.username, channel, reward.xp)
        if (leveledUp) {
          const updatedChar = db.getCharacter(action.username, channel)
          if (updatedChar) levelUpLines.push(render.renderLevelUp(updatedChar, newLevel))
        }

        // loot drop
        const drop = targetEnemy.isBoss
          ? floor.bossLootDrop(world.season, world.floor)
          : floor.lootDrop(world.season, world.floor, world.enemies.indexOf(targetEnemy))

        if (drop) {
          const freshChar = db.getCharacter(action.username, channel)
          if (freshChar && freshChar.inventory.length < 6) {
            freshChar.inventory.push(drop)
            db.upsertCharacter(freshChar)
            resultLines.push(`@${action.username} found [${drop}]!${outcome.actuallySick ? ' ACTUALLY SICK — double gold!' : ''}`)
            if (outcome.actuallySick) {
              freshChar.gold += reward.gold * 2
              db.upsertCharacter(freshChar)
            }
          }
        }

        db.logDndAction(channel, action.username, 'kill', targetEnemy.name, `${totalDmg}dmg`)
      } else {
        char.lastActionAt = Date.now()
        db.upsertCharacter(char)
      }
    }

    // Zombie fortitude: 25% chance to survive killing blow at 1 HP
    for (const enemy of world.enemies) {
      if (enemy.hp <= 0 && enemy.specialAbility === 'fortitude') {
        if (Math.random() < 0.25) {
          enemy.hp = 1
          resultLines.push(`${enemy.name} refuses to die — Zombie Fortitude! (1HP)`)
        }
      }
    }

    // status ticks on enemies
    for (const enemy of world.enemies.filter((e) => e.hp > 0)) {
      if (!enemy.statusEffect) continue
      // fire immunity: burning does nothing, clear the status
      if (enemy.specialAbility === 'fire_immunity' && (enemy.statusEffect === 'burning' || enemy.statusEffect === 'burn')) {
        delete enemy.statusEffect
        delete enemy.statusRoundsLeft
        continue
      }
      const tick = combat.singleStatusTick(enemy.statusEffect)
      if (tick > 0) {
        enemy.hp = Math.max(0, enemy.hp - tick)
        resultLines.push(`${enemy.name} takes ${tick} ${enemy.statusEffect} dmg (${enemy.hp}HP)`)
      }
      if (enemy.statusRoundsLeft !== undefined) {
        enemy.statusRoundsLeft--
        if (enemy.statusRoundsLeft <= 0) {
          delete enemy.statusEffect
          delete enemy.statusRoundsLeft
        }
      }
    }

    // decrement Barbarian rage
    for (const action of actions) {
      const char = db.getCharacter(action.username, channel)
      if (char && chassisOf(char) === 'rage' && char.rageTurnsLeft > 0) {
        char.rageTurnsLeft--
        if (char.rageTurnsLeft === 0) {
          resultLines.push(`@${action.username}'s Rage ends.`)
        }
        db.upsertCharacter(char)
      }
    }

    db.upsertWorld(world)

    const combined = resultLines.join(' | ')
    if (combined) say(channel, combined.slice(0, 480))
    for (const lu of levelUpLines) say(channel, lu)

    const allDead = world.enemies.every((e) => e.hp <= 0)
    if (allDead) {
      await handleFloorClear(channel, world)
      return
    }

    await processDeathSaves(channel, world)
    await resolveEnemyCounterattacks(channel, world)
  } finally {
    processing.delete(channel)
  }
}

// death saving throws for dying players
async function processDeathSaves(channel: string, _world: WorldState) {
  const allPlayers = db.getActivePlayers(channel)
  const dyingPlayers = allPlayers.filter((p) => p.isDying && p.respawnAt === null)
  if (dyingPlayers.length === 0) return

  for (const char of dyingPlayers) {
    const seq = db.nextSequence(channel)
    const roll = combat.d20Roll(seq + 888888)

    // nat 20: revive at 1HP
    if (roll === 20) {
      char.isDying = false
      char.deathSuccesses = 0
      char.deathFailures = 0
      char.hp = 1
      db.upsertCharacter(char)
      say(channel, render.renderDeathSave(char.username, roll, 0, 0, false, true))
      continue
    }

    // nat 1: 2 failures
    const failMult = roll === 1 ? 2 : 1
    const success = roll >= 10
    const newSuccesses = success ? char.deathSuccesses + 1 : char.deathSuccesses
    const newFailures = success ? char.deathFailures : char.deathFailures + failMult

    if (newFailures >= 3) {
      // dead
      db.killCharacter(char.username, channel, Date.now() + RESPAWN_MS)
      scheduleRespawn(char.username, channel, RESPAWN_MS)
      db.logDndAction(channel, char.username, 'death', 'death saves')
      aiDm.narrateDeath(char.username, 'failed death saves', 0).then((flavor) => {
        const base = render.renderDeath(char.username, 'failed death saves')
        say(channel, flavor ? `${base} ${flavor.slice(0, 80)}` : base)
      }).catch(() => say(channel, render.renderDeath(char.username, 'failed death saves')))
      continue
    }

    if (newSuccesses >= 3) {
      // stabilized
      char.isDying = false
      char.deathSuccesses = 0
      char.deathFailures = 0
      db.upsertCharacter(char)
      say(channel, render.renderDeathSave(char.username, roll, newSuccesses, newFailures, true, false))
      continue
    }

    db.updateDeathSaves(char.username, channel, newSuccesses, newFailures)
    say(channel, render.renderDeathSave(char.username, roll, newSuccesses, newFailures, false, false))
  }
}

async function resolveEnemyCounterattacks(channel: string, world: WorldState) {
  const freshWorld = db.getWorld(channel)
  if (!freshWorld) return
  const livingEnemies = freshWorld.enemies.filter((e) => e.hp > 0)
  if (livingEnemies.length === 0) return

  const now = Date.now()
  const targets = db.getActivePlayers(channel).filter((p) =>
    (p.hp > 0 || p.isDying) && p.respawnAt === null && (now - p.lastActionAt) < COMBAT_ACTIVE_MS
  )
  if (targets.length === 0) return

  const livingTargets = targets.filter((p) => p.hp > 0 && !p.isDying)
  const partySize = Math.max(1, livingTargets.length)
  const isBossEncounter = freshWorld.encounterType === 'boss'
  const damageScale = partySize === 1
    ? (isBossEncounter ? 0.60 : 0.75)
    : partySize === 2
      ? (isBossEncounter ? 0.80 : 0.90)
      : 1.0

  const attacks: Array<{
    enemy: string; target: string; d20Roll?: number; attackTotal?: number; targetAC?: number
    damage: number; defended: boolean; killed: boolean; targetHp: number; targetMaxHp: number; isDying?: boolean
  }> = []

  // special ability: Dragon fire breath (first use only, tracked via statusEffect on world enemy)
  for (const enemy of livingEnemies) {
    if (enemy.specialAbility === 'fire_breath' && !enemy.statusEffect) {
      enemy.statusEffect = 'breathed'
      enemy.statusRoundsLeft = 999
      db.upsertWorld(freshWorld)

      // AoE fire breath: 8d6 to all living targets, DC 14 DEX save for half
      const breathDmg = Array.from({ length: 8 }, () => Math.floor(Math.random() * 6) + 1).reduce((a, b) => a + b, 0)
      const parts: string[] = []
      for (const t of livingTargets) {
        const dexMod = getModifier(t.stats.dex)
        const saveDC = 14
        const saveRoll = combat.d20Roll(db.nextSequence(channel)) + dexMod
        const saved = saveRoll >= saveDC
        const dmg = saved ? Math.floor(breathDmg / 2) : breathDmg
        const newHp = db.damageCharacter(t.username, channel, dmg)
        const died = newHp <= 0
        if (died) {
          db.setDying(t.username, channel, true)
          parts.push(`@${t.username} -${dmg}HP DYING`)
        } else {
          parts.push(`@${t.username} -${dmg}HP${saved ? '(saved)' : ''}`)
        }
      }
      say(channel, `${enemy.name} unleashes FIRE BREATH! ${breathDmg} fire dmg — ${parts.join(', ')}`)
    }
  }

  for (const enemy of livingEnemies) {
    if (enemy.statusEffect === 'stunned') {
      enemy.statusEffect = undefined
      enemy.statusRoundsLeft = undefined
      continue
    }

    // pick random living target (enemies prefer living over dying)
    const eligible = livingTargets.length > 0 ? livingTargets : targets.filter((p) => p.isDying)
    if (eligible.length === 0) continue
    const target = eligible[Math.floor((Date.now() % 999983) % eligible.length)]
    if (!target) continue

    // multiattack: loop enemy.multiattack times
    for (let atk = 0; atk < (enemy.multiattack ?? 1); atk++) {
      const seq = db.nextSequence(channel)
      const result = combat.resolveEnemyAttack(enemy, target, seq, damageScale)

      if (!result.hit || result.damage === 0) {
        attacks.push({ enemy: enemy.name, target: target.username, d20Roll: result.d20Roll, attackTotal: result.attackTotal, targetAC: result.targetAC, damage: 0, defended: false, killed: false, targetHp: target.hp, targetMaxHp: target.maxHp })
        continue
      }

      // Ghoul paralyze: on hit, target is restrained (skip their next action)
      if (enemy.specialAbility === 'paralyze' && !target.statusEffects.includes('restrained')) {
        if (combat.d20Roll(seq + 77777) <= 4) {
          target.statusEffects.push('restrained')
          db.upsertCharacter(target)
        }
      }

      if (target.isDying) {
        // extra hit on dying player = additional failure
        const freshDying = db.getCharacter(target.username, channel)
        if (freshDying?.isDying) {
          const newFailures = freshDying.deathFailures + 1
          if (newFailures >= 3) {
            db.killCharacter(target.username, channel, Date.now() + RESPAWN_MS)
            scheduleRespawn(target.username, channel, RESPAWN_MS)
            attacks.push({ enemy: enemy.name, target: target.username, damage: result.damage, defended: false, killed: true, targetHp: 0, targetMaxHp: target.maxHp })
          } else {
            db.updateDeathSaves(target.username, channel, freshDying.deathSuccesses, newFailures)
            attacks.push({ enemy: enemy.name, target: target.username, damage: result.damage, defended: false, killed: false, targetHp: 0, targetMaxHp: target.maxHp, isDying: true })
          }
        }
        continue
      }

      // Rage chassis resistance: half physical damage while raging
      let finalDmg = result.damage
      if (chassisOf(target) === 'rage' && target.rageTurnsLeft > 0) {
        finalDmg = Math.max(1, Math.floor(finalDmg / 2))
      }

      const newHp = db.damageCharacter(target.username, channel, finalDmg)
      const died = newHp <= 0

      attacks.push({
        enemy: enemy.name, target: target.username,
        d20Roll: result.d20Roll, attackTotal: result.attackTotal, targetAC: result.targetAC,
        damage: finalDmg,
        defended: target.defending,
        killed: died, targetHp: newHp, targetMaxHp: target.maxHp,
        isDying: died,
      })

      if (died) {
        // Vampire drain: heal the vampire
        if (enemy.specialAbility === 'drain') {
          enemy.hp = Math.min(enemy.maxHp, enemy.hp + Math.floor(finalDmg / 2))
        }
        // Player drops to 0 → enter dying state (not dead yet)
        db.setDying(target.username, channel, true)
        db.logDndAction(channel, target.username, 'dying', enemy.name)
      }
    }

    // Lich lair action: after regular attack, legendary bonus — Disrupt Life (2d6 necrotic to random target)
    if (enemy.specialAbility === 'lair_actions' && livingTargets.length > 0) {
      const lairTarget = livingTargets[Math.floor((db.nextSequence(channel) % 999983) % livingTargets.length)]
      if (lairTarget) {
        const lairDmg = Array.from({ length: 2 }, () => Math.floor(Math.random() * 6) + 1).reduce((a, b) => a + b, 0)
        const lairHp = db.damageCharacter(lairTarget.username, channel, lairDmg)
        if (lairHp <= 0) {
          db.setDying(lairTarget.username, channel, true)
          attacks.push({ enemy: `${enemy.name} LAIR ACTION`, target: lairTarget.username, damage: lairDmg, defended: false, killed: false, targetHp: 0, targetMaxHp: lairTarget.maxHp, isDying: true })
        } else {
          attacks.push({ enemy: `${enemy.name} LAIR ACTION`, target: lairTarget.username, damage: lairDmg, defended: false, killed: false, targetHp: lairHp, targetMaxHp: lairTarget.maxHp })
        }
      }
    }
  }

  // reset defending flags
  for (const p of targets) {
    if (p.defending) {
      const fresh = db.getCharacter(p.username, channel)
      if (fresh) {
        fresh.defending = false
        db.upsertCharacter(fresh)
      }
    }
  }

  db.upsertWorld(freshWorld)

  const attackLine = render.renderEnemyAttacks(attacks)
  if (attackLine) say(channel, attackLine)

  // combat hint with round counter and window duration
  const stillAlive = freshWorld.enemies.filter((e) => e.hp > 0)
  if (stillAlive.length > 0) {
    const freshParty = db.getActivePlayers(channel).filter((p) => p.hp > 0 && !p.isDying && p.respawnAt === null)
    const waitingFor = getWaitedForPlayers(channel)
    const round = (roundCounters.get(channel) ?? 0) + 1
    roundCounters.set(channel, round)
    const windowSec = waitingFor.length <= 1 ? SOLO_ROUND_MS / 1000 : PARTY_ROUND_MS / 1000
    const enemyStr = stillAlive.map((e) => `${e.name} ${e.hp}/${e.maxHp}HP`).join(', ')
    const partyStr = freshParty.length === 1
      ? ` | you ${freshParty[0].hp}/${freshParty[0].maxHp}HP`
      : freshParty.length > 1
        ? ` | ${freshParty.slice(0, 3).map((p) => `@${p.username} ${p.hp}HP`).join(' ')}`
        : ''
    say(channel, `— Round ${round} — ${enemyStr}${partyStr} | !b a · !b d · !b spell [${windowSec}s]`)
  }

  // status ticks on players
  for (const target of targets) {
    const fresh = db.getCharacter(target.username, channel)
    if (!fresh || fresh.hp <= 0 || fresh.isDying) continue
    const tick = combat.statusTickDamage(fresh.statusEffects)
    if (tick > 0) {
      const newHp = db.damageCharacter(target.username, channel, tick)
      say(channel, `@${fresh.username} takes ${tick} status dmg (${newHp}/${fresh.maxHp}HP)`)
      if (newHp <= 0) {
        db.setDying(target.username, channel, true)
      }
    }
  }
}

async function handleFloorClear(channel: string, world: WorldState) {
  world.floorCleared = true
  world.longRestCounter = (world.longRestCounter ?? 0) + 1
  roundCounters.delete(channel)

  // floor-transition respawn: anyone dead comes back on floor clear
  const deadChars = db.getAllDeadCharacters(channel)
  if (deadChars.length > 0) {
    const respawnedNames: string[] = []
    for (const dead of deadChars) {
      db.addCharacterXp(dead.username, channel, 3)
      const key = `${dead.username.toLowerCase()}:${channel.toLowerCase()}`
      const timer = respawnTimers.get(key)
      if (timer) { clearTimeout(timer); respawnTimers.delete(key) }
      db.respawnCharacter(dead.username, channel)
      respawnedNames.push(dead.username)
    }
    say(channel, `${respawnedNames.map((u) => `@${u}`).join(' ')} rise — floor clear respawn! !b floor to see what's next.`)
  }

  // also stabilize anyone who was dying
  const dyingChars = db.getActivePlayers(channel).filter((p) => p.isDying)
  for (const d of dyingChars) {
    d.isDying = false
    d.hp = 1
    db.upsertCharacter(d)
  }

  const activePlayers = db.getActivePlayers(channel)
  const loot: Array<{ username: string; item?: string; gold: number }> = []
  const levelUps: Array<{ username: string; level: number }> = []

  for (const p of activePlayers) {
    if (p.hp <= 0 || p.respawnAt !== null) continue
    const goldReward = 5 + world.floor * 2
    p.gold += goldReward
    // restore resources on floor clear: spell slots, ki points, action surge
    p.spellSlots = p.maxSpellSlots
    p.actionSurgeUsed = false
    // Curse chassis: restore spell slot on short rest (every floor clear)
    if (chassisOf(p) === 'curse') p.spellSlots = p.maxSpellSlots
    p.defending = false
    db.upsertCharacter(p)
    loot.push({ username: p.username, gold: goldReward })
  }

  // small heal on non-boss clear
  if (world.encounterType !== 'boss') {
    for (const p of activePlayers.filter((p) => p.hp > 0 && !p.isDying)) {
      db.healCharacter(p.username, channel, 15)
    }
  }

  // long rest every 3 floors: restore hit dice
  if (world.longRestCounter >= 3) {
    world.longRestCounter = 0
    for (const p of activePlayers.filter((p) => p.hp > 0)) {
      const fresh = db.getCharacter(p.username, channel)
      if (!fresh) continue
      fresh.hitDice = Math.min(fresh.maxHitDice, fresh.hitDice + Math.ceil(fresh.maxHitDice / 2))
      fresh.rageCharges = chassisOf(fresh) === 'rage' ? 2 + Math.floor(fresh.level / 3) : 0
      db.upsertCharacter(fresh)
    }
    say(channel, `Long rest! Hit dice refreshed for all survivors.`)
  }

  db.upsertWorld(world)
  say(channel, render.renderFloorClear(world.floor, loot, levelUps))

  if (world.floor === 10 && world.encounterType === 'boss') {
    const survivors = db.getAllCharacters(channel).filter((p) => p.hp > 0 && p.respawnAt === null)
    for (const p of survivors) {
      db.addPrestige(p.username, channel)
      db.grantAchievement(p.username, channel, 'veteran')
    }
    if (survivors.length > 0) {
      const names = survivors.map((p) => `@${p.username}★`).join(' ')
      setTimeout(() => say(channel, `${names} earned Prestige ★ for conquering the dungeon! +2% dmg per star, permanently.`), 600)
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
    longRestCounter: 0,
  }
  db.upsertWorld(newWorld)
  say(channel, `Season ${newWorld.season} begins! Floor 1 awaits. !b floor to descend.`)
}

// --- D&D spell resolution ---
interface SpellResult { message: string; levelUp?: string }

function resolveSpell(char: Character, world: WorldState, channel: string): SpellResult {
  char.lastActionAt = Date.now()
  const livingEnemies = world.enemies.filter((e) => e.hp > 0)
  const def = getClassDef(char.class)
  const sig = def.signature.toUpperCase()

  switch (def.chassis) {
    case 'rage': {
      // Rage: +2 dmg on all attacks, resistance (half dmg) for 3 turns
      if (char.rageTurnsLeft > 0) {
        return { message: `@${char.username} is already raging! (${char.rageTurnsLeft} turns left)` }
      }
      char.rageTurnsLeft = 3
      char.rageCharges = Math.max(0, char.rageCharges - 1)
      db.upsertCharacter(char)
      return { message: `@${char.username} enters a ${sig}! +2 dmg on all attacks, resistance for 3 turns. The fury consumes them.` }
    }

    case 'surge': {
      // Action Surge: make a second attack immediately
      if (char.actionSurgeUsed) {
        return { message: `@${char.username}: ${def.signature} spent — recharges on floor clear.` }
      }
      if (livingEnemies.length === 0) return { message: '' }
      char.actionSurgeUsed = true
      const target = livingEnemies[0]
      const seq = db.nextSequence(channel)
      const outcome = combat.resolvePlayerAttack(char, target, seq, false, false, 1 + (char.prestige ?? 0) * 0.02)
      if (outcome.hit) {
        target.hp = Math.max(0, target.hp - outcome.damage)
      }
      db.upsertCharacter(char)
      const killed = target.hp <= 0
      const hitStr = outcome.hit
        ? `${outcome.weaponName}: ${outcome.damageDiceStr} = ${outcome.damage} dmg${outcome.crit ? ' [CRIT!]' : ''}`
        : `misses (d20:${outcome.d20Roll})`
      return { message: `@${char.username} ${sig} — attacks ${target.name} again! ${hitStr}. ${killed ? 'DEFEATED!' : `${target.hp}/${target.maxHp}HP`}` }
    }

    case 'smite': {
      // Divine Smite: spend slot on next attack = +2d8 radiant
      if (char.spellSlots <= 0) {
        return { message: `@${char.username}: no spell slots remaining (recharge on floor clear).` }
      }
      if (livingEnemies.length === 0) return { message: '' }
      const target = livingEnemies[0]
      const seq = db.nextSequence(channel)
      const outcome = combat.resolvePlayerAttack(char, target, seq, false, false, 1 + (char.prestige ?? 0) * 0.02)
      char.spellSlots--
      let smiteDmg = 0
      let smiteStr = ''
      if (outcome.hit) {
        const smiteDice = outcome.crit ? 4 : 2
        smiteDmg = Array.from({ length: smiteDice }, () => Math.floor(Math.random() * 8) + 1).reduce((a, b) => a + b, 0)
        const totalDmg = outcome.damage + smiteDmg
        target.hp = Math.max(0, target.hp - totalDmg)
        smiteStr = `+${smiteDice}d8(${smiteDmg}) RADIANT. Total: ${totalDmg} dmg`
      }
      db.upsertCharacter(char)
      const killed = target.hp <= 0
      if (!outcome.hit) {
        return { message: `@${char.username} calls ${sig} but misses ${target.name} (d20:${outcome.d20Roll}). Slot consumed.` }
      }
      return { message: `@${char.username} ${sig} — ${target.name}: ${outcome.damageDiceStr}+${smiteStr}. ${killed ? 'DEFEATED!' : `${target.hp}/${target.maxHp}HP`}` }
    }

    case 'sneak': {
      // Shadowstrike: guaranteed hit (advantage + auto-sneak), apply poisoned
      if (livingEnemies.length === 0) return { message: '' }
      const target = livingEnemies[0]
      const seq = db.nextSequence(channel)
      const outcome = combat.resolvePlayerAttack(char, target, seq, true, false, 1 + (char.prestige ?? 0) * 0.02)
      // force a hit via simulated high roll if natural miss (shadowstrike cannot miss)
      const finalOutcome = outcome.hit ? outcome : combat.resolvePlayerAttack(char, target, seq + 99999, true, false, 1)
      target.hp = Math.max(0, target.hp - finalOutcome.damage)
      target.statusEffect = 'poisoned'
      target.statusRoundsLeft = 3
      db.upsertCharacter(char)
      const killed = target.hp <= 0
      return { message: `@${char.username} ${sig} — ${target.name}: ${finalOutcome.damageDiceStr} = ${finalOutcome.damage} dmg [GUARANTEED HIT] + poisoned! ${killed ? 'DEFEATED!' : `${target.hp}/${target.maxHp}HP`}` }
    }

    case 'nuke': {
      // Fireball: 8d6 fire dmg to ALL enemies, DC 14 DEX save for half
      if (char.spellSlots <= 0) {
        return { message: `@${char.username}: no spell slots — ${def.signature} expended. Recharge on floor clear.` }
      }
      char.spellSlots--
      const fireDice = Array.from({ length: 8 }, () => Math.floor(Math.random() * 6) + 1)
      const fireDmg = fireDice.reduce((a, b) => a + b, 0)
      const parts: string[] = []
      for (const enemy of livingEnemies) {
        // no DEX saves for monsters in this system (full dmg for simplicity)
        enemy.hp = Math.max(0, enemy.hp - fireDmg)
        if (!enemy.statusEffect) { enemy.statusEffect = 'burning'; enemy.statusRoundsLeft = 2 }
        parts.push(`${enemy.name}(${enemy.hp}HP)`)
      }
      db.upsertCharacter(char)
      return { message: `@${char.username} casts ${sig}! 8d6=[${fireDice.join('+')}]=${fireDmg} fire dmg + burning → ${parts.join(', ')}` }
    }

    case 'heal': {
      // Healing Word: restore 1d4+WIS to lowest-HP ally (or self)
      if (char.spellSlots <= 0) {
        return { message: `@${char.username}: no spell slots — ${def.signature} expended. Recharge on floor clear.` }
      }
      char.spellSlots--
      const wisMod = getModifier(char.stats.wis)
      const healDie = Math.floor(Math.random() * 4) + 1
      const healAmt = Math.max(1, healDie + wisMod)

      // find lowest-HP active ally (including self)
      const allies = db.getActivePlayers(channel).filter((p) => p.hp > 0 && !p.isDying && p.respawnAt === null)
      const target = allies.length > 0 ? allies.reduce((a, b) => a.hp < b.hp ? a : b) : char
      const newHp = db.healCharacter(target.username, channel, healAmt)
      db.upsertCharacter(char)
      return { message: `@${char.username} ${sig} — @${target.username} healed ${healAmt}HP (1d4${wisMod >= 0 ? '+' : ''}${wisMod}). ${newHp}/${target.maxHp}HP.` }
    }

    case 'chaos': {
      // Wild Magic: 2d8 Chaos Bolt to random enemy + surge chance
      if (char.spellSlots <= 0) {
        return { message: `@${char.username}: no spell slots — ${def.signature} spent. Recharge on floor clear.` }
      }
      if (livingEnemies.length === 0) return { message: '' }
      char.spellSlots--
      const target = livingEnemies[Math.floor(Math.random() * livingEnemies.length)]
      const dmgDice = Array.from({ length: 2 }, () => Math.floor(Math.random() * 8) + 1)
      const chaMod = getModifier(char.stats.cha)
      const dmg = dmgDice.reduce((a, b) => a + b, 0) + chaMod
      target.hp = Math.max(0, target.hp - dmg)
      db.upsertCharacter(char)

      // Wild Magic Surge table (10%)
      const SURGE_TABLE = [
        'a fireball erupts from their hands',
        'they polymorphed into a sheep for 1 round (skip next action)',
        'gold rains from the ceiling (+10g)',
        'an extra Chaos Bolt fires',
        'all allies gain 5HP',
        'the caster becomes invisible (dodge next enemy attack)',
        'a random spell effect triggers',
        'gravity reverses briefly (everyone falls then lands)',
        'a black hole briefly appears and fades',
        'time slows — next attack has advantage',
      ]
      const surge = Math.random() < 0.10
      let surgeMsg = ''
      if (surge) {
        const effect = SURGE_TABLE[Math.floor(Math.random() * SURGE_TABLE.length)]
        surgeMsg = ` WILD MAGIC SURGE: ${effect}!`
        if (effect.includes('+10g')) {
          char.gold += 10; db.upsertCharacter(char)
        } else if (effect.includes('5HP')) {
          db.getActivePlayers(channel).filter((p) => p.hp > 0).forEach((p) => db.healCharacter(p.username, channel, 5))
        }
      }
      const killed = target.hp <= 0
      return { message: `@${char.username} ${sig}! 2d8+${chaMod}=[${dmgDice.join('+')}]=${dmg} → ${target.name}: ${killed ? 'DEFEATED!' : `${target.hp}/${target.maxHp}HP`}${surgeMsg}` }
    }

    case 'flurry': {
      // Flurry of Blows: spend 1 ki point, make 2 extra unarmed strikes
      if (char.kiPoints <= 0) {
        return { message: `@${char.username}: no ki points remaining (!b rest to restore).` }
      }
      if (livingEnemies.length === 0) return { message: '' }
      char.kiPoints--
      const target = livingEnemies[0]
      const parts: string[] = []
      for (let i = 0; i < 2; i++) {
        const seq = db.nextSequence(channel)
        const outcome = combat.resolvePlayerAttack(char, target, seq + i * 11111, false, false, 1 + (char.prestige ?? 0) * 0.02)
        if (outcome.hit && target.hp > 0) {
          target.hp = Math.max(0, target.hp - outcome.damage)
          parts.push(`${outcome.damage} dmg${outcome.crit ? '[CRIT]' : ''}`)
        } else {
          parts.push('miss')
        }
      }
      db.upsertCharacter(char)
      const killed = target.hp <= 0
      return { message: `@${char.username} ${sig} (ki) → ${target.name}: ${parts.join(', ')}. ${killed ? 'DEFEATED!' : `${target.hp}/${target.maxHp}HP`}` }
    }

    case 'curse': {
      // Hex + Eldritch Blast: apply hex then blast, 1d10+CHA
      if (char.spellSlots <= 0) {
        return { message: `@${char.username}: ${def.signature} spent — recharges on short rest (!b rest).` }
      }
      if (livingEnemies.length === 0) return { message: '' }
      char.spellSlots--
      const target = livingEnemies[0]
      const seq = db.nextSequence(channel)
      const outcome = combat.resolvePlayerAttack(char, target, seq, false, false, 1 + (char.prestige ?? 0) * 0.02)
      // apply hex (causes +1d6 on future attacks)
      target.statusEffect = 'hexed'
      target.statusRoundsLeft = 999
      let dmg = 0
      let blastStr = ''
      if (outcome.hit) {
        dmg = outcome.damage
        target.hp = Math.max(0, target.hp - dmg)
        blastStr = `blast: ${outcome.damageDiceStr} = ${dmg} dmg. `
      } else {
        blastStr = `blast misses (d20:${outcome.d20Roll}). `
      }
      db.upsertCharacter(char)
      const killed = target.hp <= 0
      return { message: `@${char.username} ${sig} — ${target.name} hexed! ${blastStr}${killed ? 'DEFEATED!' : `${target.hp}/${target.maxHp}HP. (Hex: +1d6 to all attacks vs this target)`}` }
    }
  }
}

// --- join announcement ---
const joinAnnounceTimers = new Map<string, Timer>()
const pendingJoiners = new Map<string, { username: string; cls: string }>()

export function announceJoin(channel: string, newPlayer?: { username: string; cls: string }): void {
  if (newPlayer) pendingJoiners.set(channel, newPlayer)
  if (joinAnnounceTimers.has(channel)) return
  const timer = setTimeout(async () => {
    joinAnnounceTimers.delete(channel)
    const joiner = pendingJoiners.get(channel)
    pendingJoiners.delete(channel)
    const world = db.getWorld(channel)
    if (!world || !world.enabled) return
    const players = db.getActivePlayers(channel)
    const aliveEnemies = world.enemies.filter((e) => e.hp > 0)
    if (joiner) {
      const msg = await aiDm.welcomePlayer(
        joiner.username, joiner.cls,
        world.floor, world.encounterType,
        aliveEnemies.map((e) => e.name),
      )
      if (msg) { say(channel, msg); return }
    }
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
    const world = db.getWorld(channel)
    if (world && !world.floorCleared && (world.encounterType === 'combat' || world.encounterType === 'boss')) {
      const active = db.getActivePlayers(channel).filter((p) => p.hp > 0 && p.respawnAt === null && !p.isDying)
      if (active.length <= 1) {
        world.enemies = floor.generateEnemies(world.season, world.floor)
        for (const e of world.enemies) {
          e.hp = Math.max(10, Math.floor(e.hp * 0.65))
          e.maxHp = e.hp
        }
        db.upsertWorld(world)
        say(channel, `@${username} rises — enemies reset for solo. → !b floor`)
        return
      }
    }
    say(channel, `@${username} respawns at half HP. !b floor to rejoin.`)
  }, delayMs)
  respawnTimers.set(key, timer)
}

// --- public action API ---

export function queueAttack(username: string, channel: string, target: string | null): string | null {
  if (!checkCooldown(username, channel)) return null

  const world = db.getWorld(channel)
  if (!world || !world.enabled) return null

  const char = db.getCharacter(username, channel)
  if (!char) return `!b join <class> to enter the dungeon`

  const now = Date.now()
  if (char.respawnAt !== null) {
    if (char.respawnAt > now) {
      const secs = Math.ceil((char.respawnAt - now) / 1000)
      return `@${username} you're dead — respawning in ${secs}s`
    }
    db.respawnCharacter(username, channel)
  }

  if (char.isDying) return `@${username} you're dying! Make death saves or wait for !b stabilize.`
  if (world.floorCleared) return `floor ${world.floor} cleared — !b move to descend`
  if (world.encounterType === 'shop') return `in a shop — !b buy <1-4> or !b move`
  if (world.encounterType === 'event') return `event floor — !b explore`

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
  if (!char || char.hp <= 0 || char.respawnAt !== null || char.isDying) return null
  enqueue(channel, { username, action: 'defend', target: null })
  return null
}

export function queueSpell(username: string, channel: string): string | null {
  if (!checkCooldown(username, channel)) return null
  const world = db.getWorld(channel)
  if (!world || !world.enabled) return null
  const char = db.getCharacter(username, channel)
  if (!char || char.hp <= 0 || char.respawnAt !== null || char.isDying) return `@${username} you're not in fighting shape`
  if (world.floorCleared) return `floor ${world.floor} cleared — !b move to descend`
  enqueue(channel, { username, action: 'spell', target: null })
  return null
}

export function resolveUseItem(username: string, channel: string, itemName: string): string | null {
  const world = db.getWorld(channel)
  if (!world || !world.enabled) return null

  const char = db.getCharacter(username, channel)
  if (!char) return null

  const idx = char.inventory.findIndex((i) => i.toLowerCase().includes(itemName.toLowerCase()))
  if (idx === -1) return `@${username}: no "${itemName}" in inventory (!b me to check)`

  const item = char.inventory[idx]
  const bonus = combat.getItemBonus(item)

  if (bonus.onUseHeal > 0) {
    char.inventory.splice(idx, 1)
    const newHp = db.healCharacter(username, channel, bonus.onUseHeal)
    db.upsertCharacter(char)
    // using a healing potion also stabilizes if dying
    if (char.isDying) {
      db.stabilizeCharacter(username, channel)
      return `@${username} uses ${item} while dying — revived! ${newHp}/${char.maxHp}HP. Item consumed.`
    }
    return `@${username} uses ${item} — heals ${bonus.onUseHeal}HP (${newHp}/${char.maxHp}HP). Item consumed.`
  }

  return `@${username}: ${item} is a passive item (no use effect).`
}

export function resolveFlee(username: string, channel: string): string | null {
  const world = db.getWorld(channel)
  if (!world || !world.enabled || world.floorCleared) return null
  const char = db.getCharacter(username, channel)
  if (!char || char.hp <= 0 || char.isDying) return null

  const seq = db.nextSequence(channel)
  const roll = combat.d20Roll(seq)

  if (roll >= 10) {
    return `@${username} flees from floor ${world.floor}! (d20:${roll}) The dungeon lets them go — for now.`
  }
  const living = world.enemies.filter((e) => e.hp > 0)
  if (living.length > 0) {
    const enemy = living[0]
    const dmg = Math.max(1, enemy.damageMod + Math.floor(Math.random() * enemy.damageDie) + 1)
    const newHp = db.damageCharacter(username, channel, dmg)
    if (newHp <= 0) {
      db.setDying(username, channel, true)
      return `@${username} tries to flee but ${enemy.name} strikes! -${dmg}HP — DYING. Make death saves!`
    }
    return `@${username} fails to flee (d20:${roll}) — ${enemy.name} strikes for ${dmg}dmg (${newHp}/${char.maxHp}HP).`
  }
  return null
}

export function resolveBuy(username: string, channel: string, arg: string): string | null {
  const world = db.getWorld(channel)
  if (!world || !world.enabled) return null
  if (world.encounterType !== 'shop') return `no shop here — find one on floors 3 and 5`

  const char = db.getCharacter(username, channel)
  if (!char) return `!b join <class> to enter the dungeon`

  const slotNum = parseInt(arg.trim())
  const shop = world.shopInventory
  const item = isNaN(slotNum) ? shop.find((s) => s.name.toLowerCase().includes(arg.toLowerCase())) : shop[slotNum - 1]

  if (!item) return `@${username}: no item "${arg}" in shop (1-${shop.length})`
  if (char.gold < item.price) return `@${username}: need ${item.price}g, you have ${char.gold}g`
  if (char.inventory.length >= 6) return `@${username}: inventory full (6/6) — !b me to see`

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
  roundCounters.delete(channel)

  if (!world.floorCleared && world.encounterType !== 'shop' && world.encounterType !== 'event') {
    const living = world.enemies.filter((e) => e.hp > 0)
    if (living.length > 0) return `enemies alive on floor ${world.floor} — defeat them first! (!b floor to see HP)`
  }

  const nextFloor = world.floor + 1
  if (nextFloor > 10) return `you're at the final floor — defeat the boss to complete the season!`

  const newEncounterType = floor.getFloorType(nextFloor)
  const newEnemies = (newEncounterType === 'combat' || newEncounterType === 'boss')
    ? floor.generateEnemies(world.season, nextFloor)
    : []
  const newShop = newEncounterType === 'shop' ? floor.generateShop(world.season, nextFloor) : []

  // scale enemy HP by live party size; bosses get extra solo/duo reduction
  const players = db.getActivePlayers(channel)
  const aliveCount = Math.max(1, players.filter((p) => p.hp > 0 && p.respawnAt === null && !p.isDying).length)
  const isBossFloor = newEncounterType === 'boss'
  const hpScale = aliveCount === 1
    ? (isBossFloor ? 0.50 : 0.65)
    : aliveCount === 2
      ? (isBossFloor ? 0.70 : 0.85)
      : 1.0
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
  if (!char) return `!b join <class> to enter the dungeon`

  if (!world.veganShrineVisited) {
    world.veganShrineVisited = true
    world.floorCleared = true
    db.upsertWorld(world)

    const hasMeat = combat.hasMeatItems(char.inventory)
    if (!hasMeat) {
      db.healCharacter(username, channel, char.maxHp)
      if (!char.statusEffects.includes('blessed')) char.statusEffects.push('blessed')
      db.upsertCharacter(char)
      db.grantAchievement(username, channel, 'vegan')
    }

    const flavor = await aiDm.narrateVeganShrine(!hasMeat, username)
    if (flavor) return flavor.slice(0, 480)

    if (!hasMeat) {
      return `@${username} approaches the Ancient Shrine. It glows. "Worthy." Full heal + blessed. !b move to continue.`
    }
    return `@${username} approaches the Ancient Shrine. It recoils. "Tainted." Nothing happens. !b move to continue.`
  } else {
    const players = db.getActivePlayers(channel)
    const totalGold = players.reduce((sum, p) => sum + p.gold, 0)

    if (totalGold < 50) {
      return `The Cursed Altar demands 50g. Current party total: ${totalGold}g. Not enough. The darkness lingers.`
    }

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
    return `The party offers 50g to the Cursed Altar. An ancient burden lifts. Luck restored for the season. !b move to continue.`
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

export function resolveStabilize(actorUsername: string, targetUsername: string, channel: string): string | null {
  const world = db.getWorld(channel)
  if (!world || !world.enabled) return null

  const target = db.getCharacter(targetUsername, channel)
  if (!target) return `@${actorUsername}: ${targetUsername} not found`
  if (!target.isDying) return `@${targetUsername} is not dying`

  // Medicine check: DC 10
  const actor = db.getCharacter(actorUsername, channel)
  const wisMod = actor ? getModifier(actor.stats.wis) : 0
  const seq = db.nextSequence(channel)
  const roll = combat.d20Roll(seq + 12345)
  const total = roll + wisMod

  if (total >= 10) {
    db.stabilizeCharacter(targetUsername, channel)
    return `@${actorUsername} stabilizes @${targetUsername} (Medicine check: d20:${roll}+${wisMod}=${total} vs DC10). They're stable at 0HP.`
  }
  return `@${actorUsername} tries to stabilize @${targetUsername} but fails (d20:${roll}+${wisMod}=${total} vs DC10). Keep trying!`
}

export function resolveShortRest(username: string, channel: string): string | null {
  const world = db.getWorld(channel)
  if (!world || !world.enabled) return null

  const char = db.getCharacter(username, channel)
  if (!char) return `!b join <class> to enter the dungeon`
  if (char.hp <= 0 || char.respawnAt !== null || char.isDying) return `@${username}: can't rest while dead or dying`

  const living = world.enemies.filter((e) => e.hp > 0)
  if (living.length > 0) return `@${username}: can't rest in combat! Defeat enemies first.`

  if (char.hitDice <= 0) return `@${username}: no hit dice remaining (recharge on long rest every 3 floors).`

  const chassis = getClassDef(char.class).chassis
  const die = getClassDef(char.class).hitDie
  const conMod = getModifier(char.stats.con)
  const roll = Math.floor(Math.random() * die) + 1
  const healAmt = Math.max(1, roll + conMod)
  const newHp = db.healCharacter(username, channel, healAmt)

  char.hitDice--
  // Curse chassis: restore spell slot on short rest
  if (chassis === 'curse') char.spellSlots = char.maxSpellSlots
  // Surge chassis: restore action surge on short rest
  if (chassis === 'surge') char.actionSurgeUsed = false
  // Flurry chassis: restore ki points on short rest
  if (chassis === 'flurry') char.kiPoints = char.maxKiPoints
  db.upsertCharacter(char)

  const restoreMsg = chassis === 'curse' ? ' Spell slot restored.' : chassis === 'surge' ? ' Action Surge restored.' : chassis === 'flurry' ? ' Ki points restored.' : ''
  return `@${username} takes a short rest — spends 1 hit die: 1d${die}+${conMod}=${healAmt}HP healed (${newHp}/${char.maxHp}HP). HD left: ${char.hitDice}/${char.maxHitDice}.${restoreMsg}`
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
    longRestCounter: 0,
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
  roundCounters.delete(channel)
  world.scene = ''
  db.upsertWorld(world)
}
