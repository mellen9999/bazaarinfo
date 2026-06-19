import * as db from './db'
import * as engine from './engine'
import * as render from './render'
import * as floorMod from './floor'
import type { Character } from './types'
import { ALL_CLASSES, CLASS_BASE_STATS, calcMaxHp, calcMaxSpellSlots } from './types'
import type { CommandContext } from '../commands'

function dndActive(channel: string): boolean {
  return !engine.isLive(channel)
}

export function handleJoin(arg: string, ctx: CommandContext): string | null {
  if (!ctx.channel || !ctx.user) return null
  if (!dndActive(ctx.channel)) return null  // let raid handler take over when live

  const channel = ctx.channel.toLowerCase()
  const username = ctx.user.toLowerCase()

  const world = db.getWorld(channel) ?? engine.createWorld(channel)
  if (!world.enabled) return null

  const existing = db.getCharacter(username, channel)

  if (!arg.trim()) {
    if (existing) {
      const now = Date.now()
      if (existing.respawnAt !== null && existing.respawnAt > now) {
        const secs = Math.ceil((existing.respawnAt - now) / 1000)
        return `@${username}: still dead — respawning in ${secs}s. !b floor to spectate.`
      }
      if (existing.hp <= 0 || existing.respawnAt !== null) {
        db.respawnCharacter(username, channel)
        const fresh = db.getCharacter(username, channel)
        engine.announceJoin(channel)
        return fresh ? render.renderCharacter(fresh) : null
      }
      return render.renderCharacter(existing)
    }
    return render.renderClassList()
  }

  const classArg = arg.trim().toLowerCase()
  const matched = ALL_CLASSES.find((c) => c.toLowerCase() === classArg || c.toLowerCase().startsWith(classArg))

  if (!matched) return `unknown class "${arg.trim()}" — ${render.renderClassList()}`

  if (existing) {
    const now = Date.now()
    if (existing.respawnAt !== null && existing.respawnAt <= now) {
      db.respawnCharacter(username, channel)
    }
    return `@${username} already in the Depths as Lv${existing.level} ${existing.class}. !b floor to see the action.`
  }

  const stats = CLASS_BASE_STATS[matched] ?? { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }
  const maxHp = calcMaxHp(matched, 1, stats.con)
  const maxSpellSlots = calcMaxSpellSlots(matched, 1)
  const newChar: Character = {
    username, channel,
    class: matched,
    level: 1, xp: 0,
    hp: maxHp, maxHp,
    gold: 10,
    inventory: [], statusEffects: [],
    stats,
    spellSlots: maxSpellSlots, maxSpellSlots,
    hitDice: 1, maxHitDice: 1,
    kiPoints: matched === 'Monk' ? 1 : 0,
    maxKiPoints: matched === 'Monk' ? 1 : 0,
    rageCharges: matched === 'Barbarian' ? 2 : 0,
    rageTurnsLeft: 0,
    actionSurgeUsed: false,
    isDying: false, deathSuccesses: 0, deathFailures: 0,
    deaths: 0, totalKills: 0,
    defending: false,
    lastActionAt: Date.now(),
    respawnAt: null,
    prestige: 0, achievements: [],
  }
  db.upsertCharacter(newChar)
  engine.announceJoin(channel, { username, cls: matched })
  return render.renderJoin(newChar)
}

export function handleAttack(arg: string, ctx: CommandContext): string | null {
  if (!ctx.channel || !ctx.user) return null
  if (!dndActive(ctx.channel)) return null
  return engine.queueAttack(ctx.user, ctx.channel, arg.trim() || null)
}

export function handleDefend(arg: string, ctx: CommandContext): string | null {
  if (!ctx.channel || !ctx.user) return null
  if (!dndActive(ctx.channel)) return null
  return engine.queueDefend(ctx.user, ctx.channel)
}

export function handleSpell(arg: string, ctx: CommandContext): string | null {
  if (!ctx.channel || !ctx.user) return null
  if (!dndActive(ctx.channel)) return null
  return engine.queueSpell(ctx.user, ctx.channel)
}

export function handleUse(arg: string, ctx: CommandContext): string | null {
  if (!ctx.channel || !ctx.user) return null
  if (!dndActive(ctx.channel)) return null
  return engine.resolveUseItem(ctx.user, ctx.channel, arg.trim())
}

export function handleFlee(arg: string, ctx: CommandContext): string | null {
  if (!ctx.channel || !ctx.user) return null
  if (!dndActive(ctx.channel)) return null
  return engine.resolveFlee(ctx.user, ctx.channel)
}

export function handleBuy(arg: string, ctx: CommandContext): string | null {
  if (!ctx.channel || !ctx.user) return null
  if (!dndActive(ctx.channel)) return null
  return engine.resolveBuy(ctx.user, ctx.channel, arg.trim())
}

export async function handleFloor(arg: string, ctx: CommandContext): Promise<string | null> {
  if (!ctx.channel || !ctx.user) return null
  if (!dndActive(ctx.channel)) return null
  return engine.resolveFloor(ctx.user, ctx.channel)
}

export async function handleMove(arg: string, ctx: CommandContext): Promise<string | null> {
  if (!ctx.channel || !ctx.user) return null
  if (!dndActive(ctx.channel)) return null
  return engine.resolveMove(ctx.user, ctx.channel)
}

export async function handleExplore(arg: string, ctx: CommandContext): Promise<string | null> {
  if (!ctx.channel || !ctx.user) return null
  if (!dndActive(ctx.channel)) return null
  return engine.resolveExplore(ctx.user, ctx.channel)
}

// works any time (not gated on offline)
export function handleStats(arg: string, ctx: CommandContext): string | null {
  if (!ctx.channel || !ctx.user) return null
  const char = db.getCharacter(ctx.user.toLowerCase(), ctx.channel.toLowerCase())
  if (!char) {
    if (dndActive(ctx.channel)) return `no character yet — !b join <class> to create one`
    return null
  }
  return render.renderCharacter(char)
}

export function handleParty(arg: string, ctx: CommandContext): string | null {
  if (!ctx.channel) return null
  if (!dndActive(ctx.channel)) return null
  const world = db.getWorld(ctx.channel.toLowerCase())
  if (!world) return `no Depths session active — !b join <class> to enter`
  const players = db.getAllCharacters(ctx.channel.toLowerCase())
  return render.renderParty(players, world)
}

export function handleRecap(arg: string, ctx: CommandContext): string | null {
  if (!ctx.channel) return null
  const world = db.getWorld(ctx.channel.toLowerCase())
  if (!world) return null
  const logs = db.getRecentLog(ctx.channel.toLowerCase(), 30)
  const chars = db.getAllCharacters(ctx.channel.toLowerCase())
  return render.renderRecap(ctx.channel, world.floor, world.season, logs, chars)
}

export function handleLeaderboard(arg: string, ctx: CommandContext): string | null {
  if (!ctx.channel) return null
  const chars = db.getAllCharacters(ctx.channel.toLowerCase())
  if (chars.length === 0) return `no adventurers yet — !b join <class> to enter the Depths`
  const top = chars.slice(0, 5).map((c, i) => {
    const stars = (c.prestige ?? 0) > 0 ? '★'.repeat(Math.min(c.prestige, 3)) : ''
    return `${i + 1}.${c.username}${stars}(Lv${c.level} ${c.class[0]} ${c.totalKills}k)`
  })
  return `Depths leaderboard: ${top.join(' | ')}`
}

export function handleDndToggle(arg: string, ctx: CommandContext): string | null {
  if (!ctx.channel || !ctx.isMod) return null
  const on = arg.toLowerCase().trim() === 'on'
  engine.setDndEnabled(ctx.channel, on)
  return `depths ${on ? 'enabled' : 'disabled'}`
}

export function handleDndReset(arg: string, ctx: CommandContext): string | null {
  if (!ctx.channel || !ctx.isMod) return null
  engine.resetFloor(ctx.channel)
  return `floor reset — same floor, fresh enemies`
}

export function handleDndSeason(arg: string, ctx: CommandContext): string | null {
  if (!ctx.channel || !ctx.isMod) return null
  const world = db.getWorld(ctx.channel.toLowerCase())
  if (!world) return null
  const newSeason = world.season + 1
  db.upsertWorld({
    ...world,
    floor: 1,
    actionSequence: 0,
    encounterType: floorMod.getFloorType(1),
    enemies: floorMod.generateEnemies(newSeason, 1),
    floorCleared: false,
    scene: '',
    season: newSeason,
    nlLifted: false,
    shopInventory: [],
    veganShrineVisited: false,
    longRestCounter: 0,
  })
  return `new season ${newSeason} started — floor 1, characters carry over`
}

export function handleStabilize(arg: string, ctx: CommandContext): string | null {
  if (!ctx.channel || !ctx.user) return null
  if (!dndActive(ctx.channel)) return null
  const target = arg.trim().replace(/^@/, '')
  if (!target) return `!b stabilize @<username>`
  return engine.resolveStabilize(ctx.user.toLowerCase(), target.toLowerCase(), ctx.channel.toLowerCase())
}

export function handleRest(arg: string, ctx: CommandContext): string | null {
  if (!ctx.channel || !ctx.user) return null
  if (!dndActive(ctx.channel)) return null
  return engine.resolveShortRest(ctx.user.toLowerCase(), ctx.channel.toLowerCase())
}
