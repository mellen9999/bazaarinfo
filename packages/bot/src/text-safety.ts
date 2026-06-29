// Zero-dependency text-safety primitives + the canonical command-safety policy. Single
// source of truth shared by ai-sanitize (model output), twitch.say (every outgoing message),
// and commands.ts (the proxy path) so the layers can never drift on what counts as a command
// trigger or which commands are dangerous.
//
// Policy: the bot IS allowed to post commands so chat can play (!uptime, /me, joke customs).
// What it can NEVER post is a command that would harm it or let chat moderate through it:
//   - third-party chatbot self-timeout/destructive customs (!vanish, !endme, !ban…) — bang DENYLIST
//   - native twitch moderation (/ban, /timeout, .clear…) — slash ALLOWLIST (everything else blocked)
// The bot is VIP (not mod) in big channels, so native mod commands no-op there anyway; the
// denylist is the real protection against self-timeout customs, and the slash allowlist keeps
// it safe on channels where it IS mod/broadcaster.
//
// Punctuation patterns are built from numeric code points (not literal glyphs) so this file
// stays pure-ASCII and unambiguous about exactly which chars it folds.

const cc = String.fromCharCode
const span = (a: number, b: number) => cc(a) + '-' + cc(b)
const set = (...codes: number[]) => '[' + codes.map((c) => cc(c)).join('') + ']'

// invisible format chars that bypass \b boundaries and leading-command detection:
// zero-width space/joiners (200B-200F), line/para seps + bidi (2028-202F), BOM (FEFF), soft hyphen (00AD)
const INVISIBLE = new RegExp('[' + span(0x200b, 0x200f) + span(0x2028, 0x202f) + cc(0xfeff) + cc(0x00ad) + ']', 'g')

// smart quotes the model emits -> ascii (so ' and " regex patterns match downstream)
const SMART_SINGLE = new RegExp(set(0x2018, 0x2019), 'g')
const SMART_DOUBLE = new RegExp(set(0x201c, 0x201d), 'g')

// homoglyph / lookalike command prefixes -> ascii. fullwidth ! / \ and friends.
const HOMO_BANG = new RegExp(set(0xff01, 0x01c3, 0x2757), 'g')  // !
const HOMO_SLASH = new RegExp(set(0xff0f, 0x2044, 0x2215), 'g') // /
const HOMO_BACK = new RegExp(set(0xff3c), 'g')                  // \

// strip invisibles and fold lookalike punctuation to ascii. run before any
// command-prefix check so homoglyph/zero-width injection can't slip through.
export function normalizeText(text: string): string {
  return text
    .replace(INVISIBLE, '')
    .replace(SMART_SINGLE, "'")
    .replace(SMART_DOUBLE, '"')
    .replace(HOMO_BANG, '!')
    .replace(HOMO_SLASH, '/')
    .replace(HOMO_BACK, '\\')
}

// --- command-safety policy ---

// dangerous ! (and \) commands — third-party chatbots (streamlabs/nightbot/fossabot/SE).
// scorched earth: block anything that times out the bot, moderates, reconfigures bots, or
// executes code. everything NOT listed is allowed through so chat can play with fun customs.
// commands.ts also adds the bot's own command names (so chat can't self-relay !b/!trivia).
export const BLOCKED_BANG_CMDS = new Set([
  // stream settings
  'settitle', 'setgame', 'setcategory', 'title', 'game',
  // command management (streamelements/nightbot/streamlabs)
  'addcom', 'addcommand', 'editcom', 'editcommand',
  'delcom', 'deletecom', 'delcommand', 'deletecommand',
  'removecom', 'removecommand', 'disablecom', 'enablecom',
  'command', 'commands', 'cmd',
  // moderation
  'nuke', 'nukeusername', 'permit', 'vanish', 'votekick',
  'ban', 'unban', 'timeout', 'untimeout', 'mute', 'unmute',
  'purge', 'clear', 'warn', 'sacrifice',
  // self-harm / auto-timeout commands (other bots time out the sender)
  'endme', 'kms', 'sudoku', 'seppuku', 'die', 'kill', 'killme', 'rip',
  'unalive', 'yeet', 'yeetus', 'roulette', 'russianroulette', 'rr',
  'timeoutme', 'banme', 'hornyjail', 'commitnotalive', 'perish',
  // DMs/blocking/connection
  'whisper', 'w', 'block', 'unblock', 'disconnect',
  // announcements (mod-only)
  'announce',
  // chat mode control
  'caps', 'emoteonly', 'emoteonlyoff', 'slow', 'slowoff',
  'followers', 'followersoff', 'subscribers', 'subscribersoff',
  'uniquechat', 'r9kbeta', 'r9kbetaoff',
  // bot control
  'bot', 'module', 'disable', 'enable', 'emotes',
  // stream control
  'host', 'unhost', 'raid', 'marker', 'commercial',
  // points/store abuse
  'addpoints', 'setpoints', 'givepoints', 'removepoints',
  'openstore', 'closestore',
  // alerts/sfx
  'alerts', 'enablesfx', 'disablesfx', 'filesay',
  // song/media control
  'skip', 'pause', 'volume', 'removesong', 'srclear', 'play',
  // timers
  'timer',
  // counters
  'editcounter', 'resetwins', 'resetcount', 'resetkills', 'resetgulag',
  // giveaways/contests
  'cancelraffle', 'sraffle', 'giveaway', 'bet',
  // level/permissions
  'level',
  // code execution (custom bots)
  'eval', 'script', 'bash', 'sh', 'exec',
  // bot lifecycle
  'exit', 'restart', 'reload', 'shutdown',
  // info disclosure
  'logs', 'bans',
  // spam risk
  'so', 'shoutout',
  // message deletion
  'delete',
  // short aliases used by some bots for timeout/raid-on (to) and raid-off (ro)
  'to', 'ro',
])

// morphological guard: block command-name variants that enumerate around the denylist
// (e.g. !banuser, !timeoutuser, !purgeuser, !ban_victim, !kickme)
// flags: ban/timeout/purge/kick/mute/nuke/warn/vanish in any position with common suffixes
export const MOD_ALIAS_RE = /(?:^|_)(ban|timeout|purge|kick|mute|nuke|warn|vanish)(?:$|user|chat|s|_|me)/i

// native twitch / (and legacy .) commands are moderation by default → ALLOWLIST only the
// harmless ones. everything else with a / or . prefix is neutralized.
export const ALLOWED_SLASH_CMDS = new Set(['me', 'announce', 'color', 'clip'])

// a dangerous command must never leave the bot's mouth. bang/backslash use the denylist,
// slash/dot use the allowlist (native commands are moderation unless explicitly safe).
function isDangerousCommand(prefix: string, word: string): boolean {
  const w = word.toLowerCase()
  if (prefix === '/' || prefix === '.') return !ALLOWED_SLASH_CMDS.has(w)
  return BLOCKED_BANG_CMDS.has(w) || MOD_ALIAS_RE.test(w)
}

// leading command = optional quote/space wrap, a single trigger char, optional space, the word.
// twitch (and chat bots) only execute a command at the very start of a message, so only the
// leading token can ever fire — anything mid-message is inert text.
const LEADING_CMD_RE = /^["'`\s]*([!\\/.])\s*([a-z0-9_]+)/i
const PEEL_LEADING_RE = /^["'`\s]*[!\\/.\s]+/

// peel EVERY leading command trigger (the legacy strip-all). used by ai-sanitize to judge
// whether a model reply is a degenerate command-echo fragment, independent of what the
// outgoing funnel chooses to let through.
export function peelLeadingTriggers(text: string): string {
  let s = text
  if (/^["'`\s]+[!\\/.]/.test(s)) s = s.replace(/^["'`\s]+/, '')
  return s.replace(/^[!\\/.\s]+/, '')
}

// outgoing funnel: neutralize ONLY a dangerous leading command (peel its trigger so it posts
// as inert text); let every other command through so the bot can post harmless ones. expects
// normalized input.
export function stripLeadingCommands(text: string): string {
  const m = text.match(LEADING_CMD_RE)
  if (!m) return text
  if (isDangerousCommand(m[1], m[2])) return text.replace(PEEL_LEADING_RE, '')
  return text
}

// full outgoing-message guard: normalize, then neutralize a dangerous leading command.
export function stripOutgoingCommands(text: string): string {
  return stripLeadingCommands(normalizeText(text))
}
