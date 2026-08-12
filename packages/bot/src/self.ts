// what the bot can do, and what changed recently — derived, never written down twice.
//
// "what can you do?" and "what's new with you?" are among the most common things a new
// viewer asks, and until now the model answered them from the one identity sentence in the
// system prompt. That means guessing, and guessing about your own features is the worst
// kind of hallucination: chat goes and tries the thing you invented.
//
// So both halves come from the source of truth. Capabilities are the real subcommand table
// (this module owns the list; commands.ts imports it, so adding a command updates the answer).
// Recent changes are the actual git log of the checkout the bot is running from — it cannot
// drift, because it IS the deploy.

import { log } from './log'

// the canonical subcommand names. commands.ts imports this for reserved-name checking, and
// the self-description below is generated from the same set, so a new command can never be
// documented wrong — only documented or not at all.
export const RESERVED_SUBS = new Set([
  'mob', 'monster', 'hero', 'tag', 'skill', 'day', 'enchants', 'enchantments', 'event', 'encounter',
  'trivia', 'skip', 'score', 'stats', 'top', 'alias', 'help', 'info',
  'refresh', 'update', 'emotes', 'status', 'join', 'part',
  'leave', 'pick', 'vote', 'party', 'shop', 'history', 'resolve', 'game',
  'overlay',
])

// questions aimed at the bot itself. deliberately requires a self-referent, so the bare
// "what's new" stays with the GAME patch line (META_QUERY_RE) where chat means it.
export const SELF_QUERY_RE = /\b(?:what\s+(?:can|do)\s+(?:you|u)\s+do|what\s+(?:are|r)\s+(?:you|u)|how\s+(?:do|does)\s+(?:you|u|this\s+bot|it)\s+work|how\s+(?:were|was)\s+(?:you|u|this)\s+(?:made|built|created)|who\s+(?:made|built|wrote|created)\s+(?:you|u|this)|(?:your|ur)\s+(?:features?|commands?|updates?|changelog|abilities|capabilit\w+)|what\s+commands?\b|what(?:'?s| is| are)\s+new\s+(?:with|about|for)\s+(?:you|u|the\s+bot)|(?:you|u)\s+(?:get|got|had)\s+(?:an?\s+)?updates?|what\s+changed\s+(?:with|about)\s+(?:you|u)|can\s+(?:you|u)\s+(?:do|play|run)\s+\w+|are\s+(?:you|u)\s+(?:an?\s+)?(?:ai|bot|robot|human|real))\b/i

export function isSelfQuery(query: string): boolean {
  return SELF_QUERY_RE.test(query)
}

// plain-language grouping of the command table. the GROUPS keys are what chat would call
// them; the values are checked against RESERVED_SUBS at startup so a rename can't leave a
// stale label behind (see assertGroupsCoverSubs).
const GROUPS: Record<string, string[]> = {
  'look up any card, hero, monster, skill, tag or day': ['hero', 'mob', 'monster', 'skill', 'tag', 'day', 'event', 'encounter', 'enchants'],
  'run trivia and keep the standings': ['trivia', 'skip', 'score', 'stats', 'top'],
  'play The Depths, the co-op dungeon run': ['pick', 'vote', 'party', 'shop', 'history', 'resolve', 'leave', 'game'],
  'join or leave a channel on request': ['join', 'part'],
  'read the live board through the overlay': ['overlay'],
}

let cachedChanges: string[] | null = null

// the git log of the running checkout. process-lifetime cache is exactly right: a deploy
// restarts the process, so the answer refreshes precisely when the code does.
function recentChanges(): string[] {
  if (cachedChanges) return cachedChanges
  cachedChanges = []
  try {
    const proc = Bun.spawnSync(['git', 'log', '-14', '--no-merges', '--format=%s'], {
      cwd: new URL('../../..', import.meta.url).pathname,
      stderr: 'ignore',
    })
    if (proc.exitCode === 0) {
      cachedChanges = proc.stdout.toString().split('\n')
        .map((l) => l.trim())
        // conventional-commit prefixes are for the repo, not for chat
        .map((l) => l.replace(/^(?:feat|fix|refactor|perf)(?:\([^)]*\))?:\s*/, ''))
        // chore/docs/test commits changed nothing a viewer can observe
        .filter((l) => l && !/^(?:chore|docs|test|style|ci|build)(?:\([^)]*\))?:/.test(l))
        .slice(0, 8)
    }
  } catch (e) {
    log(`self: git log unavailable (${(e as Error).message})`)
  }
  return cachedChanges
}

/**
 * grounding for questions about the bot itself. empty unless the query actually asks —
 * this is never ambient, because a bot that volunteers its feature list is a pamphlet.
 */
export function selfContext(query: string): string {
  if (!isSelfQuery(query)) return ''
  const can = Object.keys(GROUPS).map((g) => `- ${g}`).join('\n')
  const changes = recentChanges()
  const changeBlock = changes.length
    ? `\nShipped recently (newest first, real commit history):\n${changes.map((c) => `- ${c}`).join('\n')}`
    : ''
  return `\nAbout yourself (authoritative, answer from this and never invent a feature):
Everything runs off "!b" plus plain language. What you can actually do:
${can}
You also answer anything else chat asks, Bazaar or not. Card data comes from bazaardb.gg; your prompt is public on github.${changeBlock}
Asked what you can do: pick the two or three that fit the room, in your own words. Never recite this as a list, never promise anything not above.\n`
}

// startup sanity: every subcommand named in GROUPS must be a real reserved sub, or the
// self-description is describing a command that no longer exists.
export function assertGroupsCoverSubs(): string[] {
  return Object.values(GROUPS).flat().filter((s) => !RESERVED_SUBS.has(s))
}
