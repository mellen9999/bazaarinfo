// proxy-command surface: alias admins, per-channel/per-command cooldowns, and the
// self-timeout dodge lines for commands other bots use to time out the sender.

export const ALIAS_ADMINS = new Set(
  (process.env.ALIAS_ADMINS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
)

// BLOCKED_BANG_CMDS / MOD_ALIAS_RE / ALLOWED_SLASH_CMDS now live in text-safety.ts — the
// single source of truth shared with the outgoing funnel (twitch.say -> stripOutgoingCommands)
// so the proxy-input check and the last-line outgoing guard can never drift. the bot's own
// command names are added to the denylist at the bottom of this file.

// --- proxy cooldown: per-channel per-command ---
export const PROXY_COOLDOWN = 30_000
const PROXY_COOLDOWN_SHORT = 5_000
// harmless fun commands get shorter cooldown
const SHORT_CD_CMDS = new Set(['love', 'hate', 'hug', 'kiss', 'slap', 'highfive', 'duel', 'cookie', 'pet'])
export const proxyCooldowns = new Map<string, number>()

// commands other bots use to time out the sender — bot is vip not mod, so silent block is safe but boring
// CRITICAL: dodge text must never contain a literal !cmd token (would just trigger the other bot)
const SELF_TIMEOUT_DODGES: Record<string, readonly string[]> = {
  endme: [
    'no thx, vibes immaculate',
    'counterproposal: you go first',
    'have you tried snacks instead',
    'will to live is at peak performance',
    'endmne? hardly know mne',
    'my therapist says no',
    'nice try, i\'m unkillable',
  ],
  sacrifice: [
    'altar closed for renovations',
    'pick someone with more hp',
    'vip benefits do not include sacrificial duties',
    'nice try cultist',
    'you mean !sacarafice',
    'i\'m worth more alive, ask my agent',
  ],
  kms: ['absolutely not', 'thriving actually', 'you mean !kmd'],
  sudoku: ['the puzzle remains unsolved', 'i prefer wordle'],
  seppuku: ['honor intact, thanks', 'sword left at home'],
  die: ['hard pass', 'dye? the hair? sure'],
  kill: ['unionized, can\'t legally accept', 'you mean !kil lol'],
  killme: ['try kissing me instead', 'killmne? hardly etc'],
  rip: ['still respawning, give it a sec', 'you mean !rop'],
}

export function selfTimeoutDodge(channel: string | undefined, cmd: string): string | null {
  const list = SELF_TIMEOUT_DODGES[cmd]
  if (!list) return null
  if (channel) {
    const key = `${channel}:dodge:${cmd}`
    const now = Date.now()
    const last = proxyCooldowns.get(key)
    if (last && now - last < PROXY_COOLDOWN) return null
    proxyCooldowns.set(key, now)
  }
  return list[Math.floor(Math.random() * list.length)]
}

export function proxyWithCooldown(channel: string | undefined, cmdStr: string, cmd: string): string {
  if (!channel) return cmdStr
  const key = `${channel}:${cmd.toLowerCase()}`
  const cd = SHORT_CD_CMDS.has(cmd.toLowerCase()) ? PROXY_COOLDOWN_SHORT : PROXY_COOLDOWN
  const now = Date.now()
  const last = proxyCooldowns.get(key)
  if (last && now - last < cd) {
    const left = Math.ceil((cd - (now - last)) / 1000)
    return `on cooldown: ${cmd} (${left}s)`
  }
  proxyCooldowns.set(key, now)
  if (proxyCooldowns.size > 200) {
    for (const [k, t] of proxyCooldowns) {
      if (now - t > PROXY_COOLDOWN) proxyCooldowns.delete(k)
    }
  }
  return cmdStr
}
