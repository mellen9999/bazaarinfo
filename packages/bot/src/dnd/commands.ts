import * as db from './db'
import * as engine from './engine'
import * as render from './render'
import * as floorMod from './floor'
import * as aiDm from './ai-dm'
import type { Character } from './types'
import { maxHpFor, maxSpellSlotsFor } from './classdef'
import { getBoon, applyBoonOnPick, boonLabels } from './boons'
import type { CommandContext } from '../commands'

function dndActive(channel: string): boolean {
  return !engine.isLive(channel)
}

export async function handleJoin(arg: string, ctx: CommandContext): Promise<string | null> {
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

  if (existing) {
    const now = Date.now()
    if (existing.respawnAt !== null && existing.respawnAt <= now) {
      db.respawnCharacter(username, channel)
    }
    return `@${username} already in the Depths as Lv${existing.level} ${existing.class}. !b floor to see the action.`
  }

  // resolve the typed name to a class definition — builtins instant, custom names
  // generated + cached on the fly (any string becomes a real, balanced class)
  const def = await aiDm.ensureClassDef(arg.trim())

  const stats = { ...def.baseStats }
  const maxHp = maxHpFor(def, 1, stats.con)
  const maxSpellSlots = maxSpellSlotsFor(def, 1)
  const newChar: Character = {
    username, channel,
    class: def.name,
    level: 1, xp: 0,
    hp: maxHp, maxHp,
    gold: 10,
    inventory: [], statusEffects: [],
    stats,
    spellSlots: maxSpellSlots, maxSpellSlots,
    hitDice: 1, maxHitDice: 1,
    kiPoints: def.chassis === 'flurry' ? 1 : 0,
    maxKiPoints: def.chassis === 'flurry' ? 1 : 0,
    rageCharges: def.chassis === 'rage' ? 2 : 0,
    rageTurnsLeft: 0,
    actionSurgeUsed: false,
    isDying: false, deathSuccesses: 0, deathFailures: 0,
    deaths: 0, totalKills: 0,
    defending: false,
    lastActionAt: Date.now(),
    respawnAt: null,
    prestige: 0, achievements: [],
    boons: [], pendingBoon: [], killStreak: 0, deathsSeason: 0,
  }
  db.upsertCharacter(newChar)
  engine.announceJoin(channel, { username, cls: def.name })
  return render.renderJoin(newChar)
}

export function handlePick(arg: string, ctx: CommandContext): string | null {
  if (!ctx.channel || !ctx.user) return null
  if (!dndActive(ctx.channel)) return null  // live → raid pick takes over
  const channel = ctx.channel.toLowerCase()
  const username = ctx.user.toLowerCase()
  const char = db.getCharacter(username, channel)
  if (!char) return null
  if (!char.pendingBoon || char.pendingBoon.length === 0) return `@${username}: no boon to pick right now. level up to earn one.`

  const idx = parseInt(arg.trim(), 10) - 1
  if (isNaN(idx) || idx < 0 || idx >= char.pendingBoon.length) {
    return render.renderBoonOffer(username, char.pendingBoon)
  }
  const boonId = char.pendingBoon[idx]
  const boon = getBoon(boonId)
  if (!boon) return `@${username}: that boon vanished. try again.`

  char.boons = [...(char.boons ?? []), boonId]
  char.pendingBoon = []
  applyBoonOnPick(char, boonId)  // instant effects (maxHP, resources)
  db.upsertCharacter(char)
  return render.renderBoonPicked(username, boon.name, boonLabels(char))
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

export function handleLegends(arg: string, ctx: CommandContext): string | null {
  if (!ctx.channel) return null
  return render.renderLegends(db.getRecords(ctx.channel.toLowerCase()))
}

export function handleGraveyard(arg: string, ctx: CommandContext): string | null {
  if (!ctx.channel) return null
  return render.renderGraveyard(db.getGraves(ctx.channel.toLowerCase(), 6))
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
    shopInventory: [],
    veganShrineVisited: false,
    longRestCounter: 0,
  })
  db.resetSeasonDeaths(ctx.channel.toLowerCase())
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
