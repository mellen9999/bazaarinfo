import type { CommandContext } from '../commands'
import * as state from './state'
import * as engine from './engine'
import { getShop } from './shop'
import { renderParty, renderHistory } from './render'

const OWNER = (process.env.BOT_OWNER ?? '').toLowerCase()
const ADMINS = new Set(
  (process.env.BOT_ADMINS ?? '').split(',').concat(OWNER).map((s) => s.trim().toLowerCase()).filter(Boolean),
)

const GAME_COOLDOWN_MS = 3_000
const gameCooldowns = new Map<string, number>()

function isMod(ctx: CommandContext): boolean {
  return !!ctx.isMod || isAdmin(ctx)
}

function isAdmin(ctx: CommandContext): boolean {
  return !!ctx.user && ADMINS.has(ctx.user.toLowerCase())
}

function checkCooldown(user: string): boolean {
  const key = user.toLowerCase()
  const now = Date.now()
  const last = gameCooldowns.get(key)
  if (last && now - last < GAME_COOLDOWN_MS) return false
  gameCooldowns.set(key, now)
  if (gameCooldowns.size > 500) {
    for (const [k, t] of gameCooldowns) {
      if (now - t > GAME_COOLDOWN_MS * 10) gameCooldowns.delete(k)
    }
  }
  return true
}

// !b join is silent UNLESS this join creates a brand-new raid, in which case the engine
// emits the intro narrative (the third bounded bot-output trigger after resolutions + run-end).
export function handleJoin(args: string, ctx: CommandContext): null {
  if (!ctx.user || !ctx.channel) return null
  if (!checkCooldown(ctx.user)) return null
  if (!state.isEnabled(ctx.channel)) return null
  const createdNewRaid = !state.getRaid(ctx.channel)
  state.claimSlot(ctx.channel, ctx.user)
  if (createdNewRaid) engine.announceStart(ctx.channel, ctx.user)
  engine.triggerCheck(ctx.channel)
  return null
}

export function handleLeave(args: string, ctx: CommandContext): null {
  if (!ctx.user || !ctx.channel) return null
  if (!checkCooldown(ctx.user)) return null
  state.releaseSlot(ctx.channel, ctx.user)
  return null
}

// supports both numeric (`!b pick 3`) and name-fuzzy (`!b pick crusher claw`) forms
export function handlePick(arg: string, ctx: CommandContext): null {
  if (!ctx.user || !ctx.channel) return null
  if (!checkCooldown(ctx.user)) return null
  if (!state.isEnabled(ctx.channel)) return null
  const raid = state.getRaid(ctx.channel)
  if (!raid) return null
  const shop = getShop(raid.raidId, raid.day, raid.hero)

  let slot: number | null = null
  const trimmed = arg.trim()
  const asNum = parseInt(trimmed)
  if (!isNaN(asNum) && shop.find((s) => s.shopSlot === asNum)) {
    slot = asNum
  } else if (trimmed.length >= 2) {
    // fuzzy name match against shop titles (substring, then word-prefix)
    const lower = trimmed.toLowerCase()
    const direct = shop.find((s) => s.card.Title.toLowerCase().includes(lower))
    slot = direct?.shopSlot ?? null
  }

  if (slot === null) return null
  state.submitPick(ctx.channel, ctx.user, slot)
  engine.triggerCheck(ctx.channel)
  return null
}

export function handleVote(choice: string, ctx: CommandContext): null {
  if (!ctx.user || !ctx.channel) return null
  if (!checkCooldown(ctx.user)) return null
  if (!state.isEnabled(ctx.channel)) return null
  state.submitVote(ctx.channel, ctx.user, choice.trim())
  return null
}

export function handleParty(args: string, ctx: CommandContext): string | null {
  if (!ctx.channel) return null
  const raid = state.getRaid(ctx.channel)
  if (!raid) return 'no raid yet — !b join to start one'
  const shop = getShop(raid.raidId, raid.day, raid.hero)
  return renderParty(raid, shop)
}

export function handleHistory(args: string, ctx: CommandContext): string | null {
  if (!ctx.channel) return null
  const raid = state.getRaid(ctx.channel)
  if (!raid) return 'no active run — !b join to start one'
  return renderHistory(raid)
}

export function handleResolve(args: string, ctx: CommandContext): null {
  if (!ctx.channel) return null
  if (!isAdmin(ctx) && !isMod(ctx)) return null
  if (!state.isEnabled(ctx.channel)) return null
  engine.resolveChannel(ctx.channel).catch(() => {})
  return null
}

export function handleGameToggle(onOff: string, ctx: CommandContext): string | null {
  if (!ctx.channel) return null
  if (!isMod(ctx)) return null
  const on = onOff.toLowerCase() === 'on'
  state.setEnabled(ctx.channel, on)
  return on ? 'raid game enabled' : 'raid game disabled'
}

// !b game pace fast|normal|slow — streamer matches the run cadence to their stream feel
export function handleGamePace(paceArg: string, ctx: CommandContext): string | null {
  if (!ctx.channel) return null
  if (!isMod(ctx)) return null
  const p = paceArg.toLowerCase().trim()
  if (p !== 'fast' && p !== 'normal' && p !== 'slow') return null
  state.setPace(ctx.channel, p)
  const cfg = p === 'fast' ? 'floor 30s, slow-chat 90s, force 4m'
    : p === 'slow' ? 'floor 90s, slow-chat 5m, force 10m'
    : 'floor 60s, slow-chat 3m, force 6m'
  return `raid pace set to ${p} (${cfg})`
}
