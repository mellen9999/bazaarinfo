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

// throttle the per-join "you're in" ack so a burst of joiners can't spam chat —
// one ack line per channel per window, the rest claim their slot silently.
const JOIN_ACK_MS = 12_000
const lastJoinAck = new Map<string, number>()

function joinAckAllowed(channel: string): boolean {
  const now = Date.now()
  const last = lastJoinAck.get(channel) ?? 0
  if (now - last < JOIN_ACK_MS) return false
  lastJoinAck.set(channel, now)
  return true
}

// !b join: creating a brand-new raid posts the intro narrative (bounded bot-output trigger).
// joining an existing raid returns a terse, throttled ack so joiners aren't met with silence —
// and a full raid says so instead of failing invisibly (the big-channel footgun: 10 slots fill,
// everyone after gets nothing and thinks the bot is broken).
export function handleJoin(args: string, ctx: CommandContext): string | null {
  if (!ctx.user || !ctx.channel) return null
  if (!checkCooldown(ctx.user)) return null
  if (!state.isEnabled(ctx.channel)) return null
  const createdNewRaid = !state.getRaid(ctx.channel)
  const result = state.claimSlot(ctx.channel, ctx.user)
  if (createdNewRaid) {
    engine.announceStart(ctx.channel, ctx.user)
    engine.triggerCheck(ctx.channel)
    return null // intro already covers how to play
  }
  engine.triggerCheck(ctx.channel)
  if (result === 'full') {
    return joinAckAllowed(ctx.channel)
      ? `raid's full (10/10) — !b party to watch, a slot frees when the run ends`
      : null
  }
  if (result !== 'joined') return null // already in a slot — don't nag
  return joinAckAllowed(ctx.channel)
    ? `@${ctx.user} joined the raid — !b pick <item> to play, !b party for the board`
    : null
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
