import * as db from './db'
import * as engine from './engine'
import * as render from './render'
import * as floorMod from './floor'
import * as aiDm from './ai-dm'
import type { Character, WorldState } from './types'
import { maxHpFor, maxSpellSlotsFor, type ClassDef } from './classdef'
import { getBoon, applyBoonOnPick, boonLabels } from './boons'
import { XP_PER_LEVEL } from './types'
import type { CommandContext } from '../commands'

function dndActive(channel: string): boolean {
  return !engine.isLive(channel)
}

// a custom class name can be any string — cap length so a giant name can't bloat
// the db, blow the 480-char render budget, or pad the AI generation prompt.
const MAX_CLASS_NAME = 40
function clampClassName(raw: string): string {
  return raw.trim().slice(0, MAX_CLASS_NAME)
}

// build a fresh (catch-up-leveled) character for a class. shared by join + reroll
// so both paths produce an identical, fully-initialised record.
function freshCharacter(username: string, channel: string, def: ClassDef, world: WorldState): Character {
  // catch-up level: a fresh joiner on a deep floor starts floor-appropriate (no
  // gear/boons, so still weaker than a natural veteran) — otherwise a level-1
  // char joining a floor-7 channel mid-season is instantly crushed and stuck.
  const startLevel = Math.max(1, Math.min(9, world.floor - 1))
  const stats = { ...def.baseStats }
  const maxHp = maxHpFor(def, startLevel, stats.con)
  const maxSpellSlots = maxSpellSlotsFor(def, startLevel)
  return {
    username, channel,
    class: def.name,
    level: startLevel, xp: XP_PER_LEVEL[startLevel] ?? 0,
    hp: maxHp, maxHp,
    gold: 10,
    inventory: [], statusEffects: [],
    stats,
    spellSlots: maxSpellSlots, maxSpellSlots,
    hitDice: 1, maxHitDice: 1,
    kiPoints: def.chassis === 'flurry' ? startLevel : 0,
    maxKiPoints: def.chassis === 'flurry' ? startLevel : 0,
    rageCharges: def.chassis === 'rage' ? 2 + Math.floor(startLevel / 3) : 0,
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
}

export async function handleJoin(arg: string, ctx: CommandContext): Promise<string | null> {
  if (!ctx.channel || !ctx.user) return null
  if (!dndActive(ctx.channel)) return null  // let raid handler take over when live

  const channel = ctx.channel.toLowerCase()
  const username = ctx.user.toLowerCase()

  const base = db.getWorld(channel) ?? engine.createWorld(channel)
  if (!base.enabled) return null
  // abandoned deep run → fresh floor 1, so a newcomer isn't dropped onto a stuck boss
  const world = engine.resetIfDormant(channel) ?? base

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
    return `@${username} you're already in the Depths as Lv${existing.level} ${existing.class} — your character carries over every session. !b floor for the action · !b reroll ${arg.trim()} to switch class.`
  }

  // resolve the typed name to a class definition — builtins instant, custom names
  // generated + cached on the fly (any string becomes a real, balanced class)
  const def = await aiDm.ensureClassDef(channel, clampClassName(arg))
  const newChar = freshCharacter(username, channel, def, world)
  db.upsertCharacter(newChar)
  engine.announceJoin(channel, { username, cls: def.name })
  return render.renderJoin(newChar)
}

// --- reroll: ditch your character and remake as a new class ---
// characters are permanent (only the world resets each season), so a player who
// fat-fingers a joke class at first has no other escape hatch. reroll is a hard
// wipe — new char starts at catch-up level with 10g and no boons/prestige/gear,
// so it's always a downgrade except for the class swap (no exploit to gate against).
// guarded by: an explicit `confirm` word (no accidental wipe of a real character)
// + a per-user cooldown (a custom class name is one AI call; stop reroll-spam from
// generating endless distinct classes and draining the AI budget).
const REROLL_COOLDOWN_MS = 60_000
const lastReroll = new Map<string, number>()

export async function handleReroll(arg: string, ctx: CommandContext): Promise<string | null> {
  if (!ctx.channel || !ctx.user) return null
  if (!dndActive(ctx.channel)) return null

  const channel = ctx.channel.toLowerCase()
  const username = ctx.user.toLowerCase()

  const base = db.getWorld(channel) ?? engine.createWorld(channel)
  if (!base.enabled) return null
  const world = engine.resetIfDormant(channel) ?? base

  // strip a trailing confirm/yes token → the rest is the (possibly multi-word) class
  const m = arg.trim().match(/^([\s\S]*?)\s+(?:confirm|yes)$/i)
  const confirmed = m !== null
  const classArg = clampClassName(m ? m[1] : arg)
  if (!classArg) return `@${username}: reroll into what? → !b reroll <class>`

  const existing = db.getCharacter(username, channel)

  // a real character (any earned progress) requires confirmation before the wipe
  const hasProgress = existing && (existing.level > 1 || (existing.prestige ?? 0) > 0 ||
    existing.totalKills > 0 || (existing.boons?.length ?? 0) > 0 || existing.gold > 10)
  if (existing && hasProgress && !confirmed) {
    const stars = (existing.prestige ?? 0) > 0 ? ` ${existing.prestige}★` : ''
    return `@${username}: reroll WIPES your Lv${existing.level} ${existing.class}${stars} — ${existing.gold}g, ${existing.boons?.length ?? 0} boons, ${existing.totalKills} kills, gone for good. confirm: !b reroll ${classArg} confirm`
  }

  const now = Date.now()
  const last = lastReroll.get(`${channel}^${username}`) ?? 0
  if (existing && now - last < REROLL_COOLDOWN_MS) {
    const secs = Math.ceil((REROLL_COOLDOWN_MS - (now - last)) / 1000)
    return `@${username}: just rerolled — wait ${secs}s before rerolling again.`
  }
  lastReroll.set(`${channel}^${username}`, now)

  const def = await aiDm.ensureClassDef(channel, classArg)
  const newChar = freshCharacter(username, channel, def, world)
  engine.clearQueuedAction(channel, username)  // drop any stale action from the old char
  engine.cancelRespawn(username, channel)      // and any pending respawn (reroll while dead)
  db.upsertCharacter(newChar)                  // same (user, channel) PK → overwrites
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

// --- natural-language combat ---
// players type "I cast Fireburst at it", "attack the kimono", "burn it", "defend", "flee",
// "use potion" — not the exact subcommand. classify the leading verb (after stripping common
// first-person filler) and route. token-based so it's robust to "I'll"/"imma"/"lemme". gated
// on an active dungeon + the user being an actual player so normal chat is never hijacked.
const CI_FILLER = new Set([
  'i', "i'll", 'ill', 'imma', "i'ma", "i'm", 'im', 'ima', 'lemme', 'let', 'me', 'gonna', 'gon',
  'wanna', 'will', 'just', 'now', 'then', 'try', 'to', 'go', 'and', 'ok', 'okay', 'lol', 'time',
  'a', 'the', 'shall', 'gotta', 'must', 'finna', 'wna', 'gunna', 'bout', 'about', 'my', 'turn',
  "let's", 'lets', 'ok', 'okay', 'yo', 'aight', 'alright', 'really',
])
const CI_SPELL = new Set(['cast', 'spell', 'conjure', 'channel', 'unleash', 'incant', 'chant', 'invoke', 'summon', 'spellcast', 'casting'])
const CI_DEFEND = new Set(['defend', 'block', 'guard', 'brace', 'parry', 'dodge', 'shield', 'cover', 'protect', 'blocking', 'defending'])
const CI_FLEE = new Set(['flee', 'run', 'escape', 'retreat', 'bail', 'nope', 'abscond', 'withdraw', 'leave', 'fleeing', 'running', 'yeet'])
const CI_USE = new Set(['use', 'drink', 'quaff', 'consume', 'eat', 'pop', 'apply', 'equip', 'chug'])
const CI_MOVE = new Set(['move', 'descend', 'next', 'advance', 'continue', 'proceed', 'onward', 'deeper', 'forward', 'down', 'progress', 'delve'])
const CI_EXPLORE = new Set(['explore', 'search', 'loot', 'scavenge', 'investigate', 'scout', 'rummage'])
const CI_ATTACK = new Set([
  'attack', 'hit', 'strike', 'swing', 'stab', 'slash', 'shoot', 'punch', 'smash', 'kill', 'murder',
  'blast', 'throw', 'charge', 'whack', 'bonk', 'slay', 'fight', 'engage', 'maul', 'club', 'bash',
  'pummel', 'lunge', 'chop', 'wallop', 'clobber', 'jab', 'kick', 'attacking', 'hitting', 'fireball',
  'fireburst', 'zap', 'nuke', 'destroy', 'rush', 'assault', 'thwack', 'sock', 'deck', 'beat',
  'burn', 'torch', 'incinerate', 'sear', 'melt', 'roast', 'fry', 'fireblast', 'scorch',
])
const CI_ARTICLE = new Set(['the', 'a', 'an', 'my', 'some', 'that', 'this'])

export type DndIntent = 'spell' | 'attack' | 'defend' | 'flee' | 'move' | 'explore' | 'use'

// pure intent classifier: strip leading first-person filler, then map the head verb to an
// action. returns null when there's no combat verb up front (so normal chat isn't hijacked).
export function classifyDndIntent(text: string): { action: DndIntent; arg: string } | null {
  const toks = text.toLowerCase().replace(/[^\w\s']/g, ' ').split(/\s+/).filter(Boolean)
  while (toks.length && CI_FILLER.has(toks[0])) toks.shift()
  const head = toks[0]
  if (!head) return null
  if (CI_SPELL.has(head)) return { action: 'spell', arg: '' }
  if (CI_DEFEND.has(head)) return { action: 'defend', arg: '' }
  if (CI_FLEE.has(head)) return { action: 'flee', arg: '' }
  if (CI_USE.has(head)) {
    const rest = toks.slice(1)
    while (rest.length && CI_ARTICLE.has(rest[0])) rest.shift() // "drink THE antitoxin" -> "antitoxin"
    return { action: 'use', arg: rest.join(' ') }
  }
  if (CI_MOVE.has(head)) return { action: 'move', arg: '' }
  if (CI_EXPLORE.has(head)) return { action: 'explore', arg: '' }
  if (CI_ATTACK.has(head)) return { action: 'attack', arg: '' }
  return null
}

export async function handleCombatIntent(text: string, ctx: CommandContext): Promise<string | null> {
  if (!ctx.channel || !ctx.user) return null
  const channel = ctx.channel.toLowerCase()
  if (!dndActive(channel)) return null
  if (!db.getCharacter(ctx.user.toLowerCase(), channel)) return null // not a player — leave chat alone

  const intent = classifyDndIntent(text)
  if (!intent) return null

  // queued actions (attack/spell/defend) resolve at round-close via say() and return null —
  // map that to '' so the caller knows the message WAS a dnd action and must NOT fall through
  // to the AI (which would post a duplicate, unrelated reply). null = not a combat intent.
  const handled = (r: string | null): string => r ?? ''
  switch (intent.action) {
    case 'spell': return handled(handleSpell('', ctx))
    case 'defend': return handled(handleDefend('', ctx))
    case 'flee': return handled(handleFlee('', ctx))
    case 'use': return handled(handleUse(intent.arg, ctx))
    case 'move': return handled(await handleMove('', ctx))
    case 'explore': return handled(await handleExplore('', ctx))
    case 'attack': return handled(handleAttack('', ctx))
  }
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
