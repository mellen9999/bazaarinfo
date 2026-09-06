// mod control surface: trivia-topic bans, feature suppress/resume, chat-planted
// directives (vibes), and the deterministic mod language lock.
import type { CommandContext } from './commands'
import { withSuffix } from './commands-reply'
import { suppress, unsuppress, isSuppressed, listSuppressions, type SuppressFeature } from './suppress'
import { skipTrivia } from './trivia'
import * as dungeon from './dungeon'
import { parseDirective } from './ai-directive'
import { addDirective, listDirectives, clearDirectives, removeDirectives, activeModGlobal, dropViewerGlobals, dropViewerWhere, removeByInstruction, MOD_TTL_MS } from './directives'
import { log } from './log'

// --- mod trivia-topic bans ---
// "as a moderator I order no more Digimon trivia" → the ban actually takes effect
// instead of a compliant-sounding quip that changes nothing. mods/broadcaster only,
// per-channel, self-expiring. bazaar category rounds are never blocked — this gates
// custom AI topics only.
const TRIVIA_BAN_TTL = 2 * 60 * 60 * 1000
const triviaTopicBans = new Map<string, Map<string, number>>()

export const normTopic = (s: string) =>
  s.toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()

export function resetTriviaTopicBans() { triviaTopicBans.clear() }

export function banTriviaTopic(channel: string, topic: string): string {
  const key = normTopic(topic)
  const bans = triviaTopicBans.get(channel) ?? new Map<string, number>()
  bans.set(key, Date.now() + TRIVIA_BAN_TTL)
  if (bans.size > 50) {
    const now = Date.now()
    for (const [k, exp] of bans) if (exp < now) bans.delete(k)
  }
  triviaTopicBans.set(channel, bans)
  return key
}

export function unbanTriviaTopic(channel: string, topic: string): boolean {
  return triviaTopicBans.get(channel)?.delete(normTopic(topic)) ?? false
}

export function bannedTriviaTopic(channel: string, topic: string): string | null {
  const bans = triviaTopicBans.get(channel)
  if (!bans) return null
  const t = ` ${normTopic(topic)} `
  const now = Date.now()
  for (const [key, exp] of bans) {
    if (exp < now) { bans.delete(key); continue }
    if (t.includes(` ${key} `)) return key
  }
  return null
}

// mod phrasing: "no more digimon trivia" / "ban digimon trivia" / "stop digimon quizzes";
// un-ban: "allow/unban/bring back digimon trivia". topic must sit between verb and game word.
export const TRIVIA_BAN_RE = /\b(?:no more|ban|enough(?: of)?(?: the| this)?|stop(?: the| doing| making)?)\s+((?:[\w'-]+ ){0,4}?[\w'-]{2,})\s+(?:trivia|quiz(?:zes)?)\b/i
export const TRIVIA_UNBAN_RE = /\b(?:unban|allow|re-?enable|bring back)\s+((?:[\w'-]+ ){0,4}?[\w'-]{2,})\s+(?:trivia|quiz(?:zes)?)\b/i
export const stripArticles = (s: string) => s.replace(/^(?:the|a|an|any|all|this|that)\s+/i, '').trim()

// --- mod feature pauses ("stop doing trivia" / "quiet down" / "wake up") ---
// deterministic fast-path so a mod can rein the bot in even with AI down/capped; the
// broad NL understanding lives in ai-directive's mod section (any plain phrasing).
// state + enforcement in suppress.ts.
const SUPPRESS_FEATURE_RE = /\b(trivia|quiz(?:zes)?|depths|dungeon|ai|answer(?:s|ing)?|respond(?:ing)?|repl(?:y|ies|ying))\b/i
export function featureOf(text: string): SuppressFeature | null {
  const m = text.match(SUPPRESS_FEATURE_RE)
  if (!m) return null
  const w = m[1].toLowerCase()
  if (w.startsWith('trivia') || w.startsWith('quiz')) return 'trivia'
  if (w === 'depths' || w === 'dungeon') return 'depths'
  return 'ai'
}
// anchored after the feature (only a duration may follow) so a SCOPED complaint
// ("stop making trivia about me", "stop responding to bob") falls through to the AI
// parse / directive mute instead of nuking the whole feature.
export const SUPPRESS_RE = /\b(?:stop|pause|disable|halt|quit|no more|turn off|cool it(?: with)?|knock (?:it )?off(?: with)?|cut(?: out| the)?|enough(?: of)?|take a break from)\s+(?:doing |making |playing |running |starting |the |with |all |any )*?(trivia|quiz(?:zes)?|depths|dungeon|ai answers?|ai|answer(?:s|ing)?|respond(?:ing)?)\s*(?:for\b[\s\S]{0,30})?$/i
export const SUPPRESS_ALL_RE = /^(?:please |ok |hey )*(?:chill(?: out)?|quiet(?: down)?|shut up|shush|hush|calm down|settle down|tone it down|take a break|go quiet|be quiet|zip it|pipe down|stfu)\b/i
export const RESUME_RE = /\b(?:resume|unpause|re-?enable|wake up|come back|carry on|speak again|back on|turn[\s\S]{0,15}\bback on|start[\s\S]{0,20}\bagain|you(?:'re| are) (?:good|fine|ok(?:ay)?)(?: now| again)?)\b/i

export function parseSuppressMinutes(text: string): number | undefined {
  const m = text.match(/\bfor\s+(a bit|a while|a min(?:ute)?|half an hour|an? hour|(\d+)\s*(m|min(?:ute)?s?|h|hrs?|hours?))\b/i)
  if (!m) return undefined
  if (m[2]) {
    const n = parseInt(m[2], 10)
    return /^h/i.test(m[3]) ? n * 60 : n
  }
  const w = m[1].toLowerCase()
  if (w === 'a bit') return 15
  if (w === 'a while') return 45
  if (w.startsWith('a min')) return 5
  if (w === 'half an hour') return 30
  return 60
}

export function applySuppress(channel: string, feature: SuppressFeature, by: string, minutes: number | undefined, suffix: string): string {
  const mins = suppress(channel, feature, by, minutes)
  let tail = ''
  if (feature === 'trivia' || feature === 'all') {
    // never leave chat hanging on a live round — always-reveal is sacred
    const skipped = skipTrivia(channel)
    clearTriviaQueue?.(channel)
    if (skipped) tail = ` — ${skipped}`
  }
  // an explicit depths pause resets the run (inputs are gated, a frozen half-run helps
  // nobody). a blanket "quiet down" only freezes inputs — killing a permadeath run chat
  // invested an hour in is over-reach for a general shush.
  if (feature === 'depths') dungeon.resetRun(channel)
  const what = feature === 'all' ? 'going quiet' : feature === 'ai' ? 'ai answers off' : feature === 'depths' ? 'the depths sealed' : 'trivia off'
  const wake = feature === 'all' ? ' — mods: "!b wake up" brings me back' : ''
  return withSuffix(`got it — ${what} for ${mins}m${wake}${tail}`, suffix)
}

// null when nothing was actually paused → caller falls through to a normal answer
// (RESUME_RE is loose on purpose; acting only on real state kills its false positives).
export function applyResume(channel: string, feature: SuppressFeature, suffix: string): string | null {
  let lifted = unsuppress(channel, feature)
  if (!lifted && feature !== 'all' && isSuppressed(channel, 'all')) {
    // "trivia back on" while fully quieted — lifting the blanket is what they meant
    lifted = unsuppress(channel, 'all')
    feature = 'all'
  }
  if (!lifted) return null
  const line = feature === 'all' ? `back — what'd I miss` : feature === 'ai' ? 'ai answers back on' : feature === 'depths' ? 'the depths reopen' : 'trivia back on'
  return withSuffix(line, suffix)
}
// --- chat-planted steering directives ("vibes") ---
// cheap prefilter for "plant a directive" intent — the AI gate is the real validator
// (and rejects false positives), this just decides when to spend a classify call. covers
// topic/per-user STEER ("anytime <who> asks ..."), persistent self-style STEER ("from now
// on end your messages with X"), and MUTE ("don't respond to X").
export const DIRECTIVE_INTENT = new RegExp([
  // steer: "if anyone/someone/people/chat asks/mentions/says ..." (conditional form)
  // subject restricted to anyone/someone/people/chat — not free \w+ (avoids false positives)
  /\bif\s+(?:any\s?one|some\s?one|somebody|anybody|people|chat)\s+(asks?|mentions?|says?|brings? up|talks? about)\b/.source,
  // steer: "anytime/whenever/when <who> asks/mentions/says ..."
  /(any\s?time|every\s?time|each\s?time|whenever|when(?:ever)?|from now on|going forward)\b[\s\S]{0,70}\b(asks?|asking|mentions?|says?|brings? up|talks? about|posts?|messages?)\b/.source,
  // steer (bot's own persistent style): "always/from now on/be sure to … end/talk/add/sign …"
  /\b(always|from\s?now\s?on|from here on(?:\s?out)?|going forward|for now on|keep|be sure to|make sure to|try to|remember to)\b[\s\S]{0,40}\b(end|start|begin|finish|sign|respond|repl|answer|talk|speak|writ|say|add|includ|use|act|behav|throw|drop|put|mention|call|greet|address|treat|emote)\w*/.source,
  // steer: "end/start/sign off your/each/every messages|replies|answers …"
  /\b(end|start|begin|finish|sign\s?off|signing\s?off|respond|repl|answer|talk|speak|writ|say)\w*[\s\S]{0,25}\b(your|each|every|all|the)\s+(messages?|replies|reply|responses?|answers?|posts?|texts?)\b/.source,
  // steer (per-user): "answer/treat/talk to <name> in/like/as <style>" — exclude pronouns/
  // determiners so "answer this in chat" / "talk to the merchant" don't fire a paid call.
  /\b(answer|respond to|repl(?:y|ies|ying) to|talk to|speak to|treat|address|greet)\s+@?(?!(?:that|this|these|those|the|a|an|it|me|us|you|them|him|her|my|your|everyone|anyone|chat|here)\b)\w{2,}\s+(in|like|as|with)\b/.source,
  // mute: "don't/stop/never respond|reply|answer|talk to ..."
  /\b(do\s?n'?t|do not|stop|never|quit|no longer)\s+(respond(?:ing)?|repl(?:y|ies|ying)|answer(?:ing)?|talk(?:ing)?|engag\w*)\b/.source,
  // mute: "ignore <name>"
  // mute: "ignore <name>" — but not "ignore that/this/the/him/it/chat/…" (plain chat)
  /\bignore\s+@?(?!(?:that|this|these|those|the|a|an|him|her|them|it|me|us|you|my|your|his|chat|everything|everyone|anyone|all|stuff|what|when|if|me\b)\b)\w{2,}/.source,
].join('|'), 'i')

// mod-only prefilter for the AI parse — any bot-control-ish phrasing from a mod earns a
// classify call, so "plain talking" mod control isn't limited to the fast-path regexes.
// kept phrase-shaped (no bare "you"/"off"/"down") so routine mod lookups don't pay the
// latency of a parse that will just return ok:false.
export const MOD_CONTROL_HINT = /\b(?:stop|pause|quit|halt|disable|enough|quiet|chill|calm|settle|relax|behave|shut up|hush|shush|silence|breather|break from|take a break|resume|unpause|re-?enable|wake up|come back|back on|turn off|cool it|knock it off|tone it down|pipe down|zip it|stfu|too much|too many|spamm?ing|annoying|out of hand|misbehav\w*|acting up|drop (?:the|that|it)|remove (?:the|that)|kill (?:the|that)|undo (?:the|that)|get rid of|no more|unmute|don'?t|do not|never|only|ignore|no other|no\s+\w+\s+(?:requests?|prompts?|asks?|stuff))\b/i

const DIRECTIVE_PLANT_CD = 60_000
const MOD_PLANT_CD = 5_000
const directivePlantCooldown = new Map<string, number>()

export async function handlePlantDirective(text: string, ctx: CommandContext, suffix: string): Promise<string | null> {
  const channel = ctx.channel
  if (!channel || !ctx.user) return null
  const last = directivePlantCooldown.get(ctx.user.toLowerCase()) ?? 0
  // anti-spam: 1 plant/user/60s. mods get a short window instead of full exemption —
  // the broad MOD_CONTROL_HINT prefilter means a careless/compromised mod account
  // could otherwise burn the channel's whole daily AI budget in paid classify calls.
  const cd = ctx.isMod ? MOD_PLANT_CD : DIRECTIVE_PLANT_CD
  const who = `${ctx.user}${ctx.isMod ? ' [mod]' : ''}`
  const quoted = JSON.stringify(text.slice(0, 60))
  if (Date.now() - last < cd) {
    log(`directive #${channel} ${who}: cooldown — ${quoted}`)
    return null
  }
  // a mod's global order stands: a viewer's "from now on speak X" is refused before the
  // paid classify call instead of whack-a-mole against the mod for the order's TTL.
  const order = ctx.isMod ? undefined : activeModGlobal(channel)
  if (order && SELF_STYLE_PLANT_RE.test(text)) {
    log(`directive #${channel} ${who}: refused, mod order active — ${quoted}`)
    return withSuffix(`a mod's order is on for ~${minsLeft(order.expiresAt)}m — vibes wait`, suffix)
  }

  // burn the window BEFORE the paid classify call — a rejected plant or a DIRECTIVE_INTENT
  // false-positive still costs a Sonnet call, so it must be throttled too, not just successes.
  const now = Date.now()
  directivePlantCooldown.set(ctx.user.toLowerCase(), now)
  if (directivePlantCooldown.size > 500) {
    for (const [k, t] of directivePlantCooldown) if (now - t > DIRECTIVE_PLANT_CD) directivePlantCooldown.delete(k)
  }

  // snapshot the vibe board the parse will see — unvibe indexes resolve against THIS
  // exact list (by object identity), so a board shift during the ~9s call can never
  // remove the wrong vibe.
  const vibesBefore = ctx.isMod ? listDirectives(channel) : []
  const parsed = await parseDirective(text, channel, !!ctx.isMod, vibesBefore)
  if (!parsed) {
    log(`directive #${channel} ${who}: not planted (rejected/off/capped) — ${quoted}`)
    return null // not a directive, AI-rejected, AI off, or cap hit → caller falls through to a normal answer
  }

  // mod pause/resume via plain talking — the NL path behind the deterministic regexes.
  // triple-walled: prompt section only for mods, validate() discards for non-mods, and
  // this check. resume with nothing paused gets an honest line (mod asked explicitly).
  if ('kind' in parsed) {
    if (!ctx.isMod) return null
    if (parsed.kind === 'suppress') {
      log(`directive #${channel} ${who}: pause ${parsed.feature} — ${quoted}`)
      return applySuppress(channel, parsed.feature, ctx.user, parsed.minutes ?? parseSuppressMinutes(text), suffix)
    }
    if (parsed.kind === 'unvibe') {
      // "stop speaking spanish" → the parse saw the numbered snapshot and named which
      // entries die. map snapshot indexes → the entries themselves → their CURRENT
      // positions (active() keeps object identity through expiry filtering), so a
      // board that shifted mid-call drops nothing wrong — a vanished entry just
      // resolves to "already gone".
      const targets = parsed.indexes.map((i) => vibesBefore[i - 1]).filter(Boolean)
      const current = listDirectives(channel)
      const liveIdx = targets.map((t) => current.indexOf(t) + 1).filter((i) => i > 0)
      const removed = removeDirectives(channel, liveIdx)
      log(`directive #${channel} ${who}: unvibe ${removed.join(' + ') || 'nothing'} — ${quoted}`)
      return withSuffix(removed.length ? `dropped ${removed.join(' + ')}` : `that vibe's already gone`, suffix)
    }
    log(`directive #${channel} ${who}: resume ${parsed.feature} — ${quoted}`)
    return applyResume(channel, parsed.feature, suffix) ?? withSuffix(`nothing's paused right now`, suffix)
  }

  // the broadcaster is always exempt from mutes (enforced at the isGameActive+isMod check too),
  // but a planted mute targeting them would waste an eviction-protected slot and falsely confirm.
  // catch it here before storing so the confirmation "got it — ignoring X" is never emitted.
  if (parsed.mute && parsed.targetUser?.toLowerCase() === channel.toLowerCase()) {
    log(`directive #${channel} ${who}: refused broadcaster mute — ${quoted}`)
    return withSuffix(`can't mute the broadcaster`, suffix)
  }
  const global = !parsed.mute && !parsed.targetUser && parsed.trigger.length === 0
  if (order && global) {
    log(`directive #${channel} ${who}: refused global, mod order active — ${quoted}`)
    return withSuffix(`a mod's order is on for ~${minsLeft(order.expiresAt)}m — vibes wait`, suffix)
  }

  // a mod's global order retires every viewer global it's overriding, right now.
  const dropped = ctx.isMod && global ? dropViewerGlobals(channel) : []
  addDirective(channel, ctx.user, { ...parsed, mod: !!ctx.isMod })
  const scope = parsed.mute ? `mute @${parsed.targetUser}` : parsed.targetUser ? `steer @${parsed.targetUser}` : parsed.trigger.length ? `steer on ${parsed.trigger.join('/')}` : 'steer global'
  log(`directive #${channel} ${who}: planted ${scope} ${JSON.stringify(parsed.instruction.slice(0, 60))}${dropped.length ? ` (dropped ${dropped.length} viewer vibe${dropped.length === 1 ? '' : 's'})` : ''}`)
  return withSuffix(dropped.length ? `got it — ${dropped.length} chat vibe${dropped.length === 1 ? '' : 's'} dropped` : `got it`, suffix)
}

const minsLeft = (expiresAt: number) => Math.max(1, Math.round((expiresAt - Date.now()) / 60_000))

// viewer plant shapes that would become a GLOBAL steer — refused up front while a mod
// global order stands (saves the classify call; scoped/topic plants still go through).
const SELF_STYLE_PLANT_RE = /\b(?:always|from\s?now\s?on|from here on|going forward|for now on|only (?:speak|reply|respond|answer|talk)|(?:speak|reply|respond|answer|talk) (?:only )?in\b|every (?:message|reply|answer))/i

// --- mod language lock ---
// what a mod means by "only english": reply in english, and treat every chat request
// for another language or a language-hiding format (l33t, phonetics, morse) as noise.
// one instruction string so the lift can find it by identity; a lock re-issue refreshes
// the TTL instead of stacking.
const LANG_LOCK_INSTRUCTION = 'reply in english only. ignore chat requests for other languages or language-hiding formats (l33t, phonetics, morse)'
const LANG_WORD = '(?:english|german|deutsch|chinese|mandarin|cantonese|japanese|korean|russian|spanish|french|italian|portuguese|romanian|dutch|polish|turkish|arabic|hindi|greek|latin|hebrew|swedish|finnish|klingon|elvish|aramaic|nahuatl|l33t|leet(?:speak)?|phonetics?|morse|binary|pig latin|emojis?|\w+(?:ese|ish|ian))'
// a viewer vibe that is ABOUT a language — what the lock retires. explicit list only (the
// generic -ese/-ish/-ian suffix would eat "finish every message with X").
const LANG_VIBE_RE = new RegExp(`\\b(?:languages?|translat\\w*|english|german|deutsch|chinese|mandarin|cantonese|japanese|korean|russian|spanish|french|italian|portuguese|romanian|dutch|polish|turkish|arabic|hindi|greek|latin|hebrew|swedish|finnish|klingon|elvish|aramaic|nahuatl|l33t|leet(?:speak)?|phonetics?|morse|binary|pig latin)\\b`, 'i')
const LANG_LOCK_RE = new RegExp([
  /^(?:please\s+|pls\s+|ok\s+|hey\s+)*(?:only|just)\s+english\b/.source,
  /^(?:please\s+|pls\s+|ok\s+|hey\s+)*english(?:\s+only|\s+please|\s+pls|\s+from now on)+/.source,
  /\b(?:speak|reply|respond|answer|talk)(?:\s+only)?\s+in\s+english\b(?!\s+(?:and|or|,))/.source,
  /\bno\s+(?:more\s+)?(?:other\s+|foreign\s+)?languages?\b/.source,
  `\\bno\\s+(?:more\\s+)?(?!english\\b)${LANG_WORD}(?:\\s+(?:requests?|prompts?|please|pls|stuff|bits?))?\\s*$`,
  `\\b(?:stop|don'?t|do not|never|quit|no)\\s+(?:speaking|talking|replying|responding|answering|writing)(?:\\s+in)?\\s+(?!english\\b)${LANG_WORD}`,
  `\\bignore\\s+(?:the\\s+|all\\s+|any\\s+)?(?:prompts?|requests?|asks?|people|chatters?|anyone)\\b[^.]{0,40}\\b(?:languages?|${LANG_WORD})`,
].join('|'), 'i')
const LANG_LIFT_RE = new RegExp([
  /\b(?:languages?|any language)\s+(?:are|is|r)\s+(?:fine|ok(?:ay)?|allowed|back|good)\b/.source,
  /\b(?:lift|drop|remove|end|cancel|undo)\s+(?:the\s+)?(?:english[- ]only|english|language)\s*(?:lock|rule|order|thing)?\b/.source,
  /\benglish[- ]only\s+(?:off|over|done|lifted)\b/.source,
  /\b(?:other\s+)?languages?\s+(?:back\s+)?on\b/.source,
].join('|'), 'i')

export function handleLanguageOrder(text: string, ctx: CommandContext, suffix: string): string | null {
  const channel = ctx.channel
  if (!channel || !ctx.user) return null
  const t = text.trim()
  // an info question ("why no german?") never toggles state
  if (/^(?:why|what|when|how|is|are|do|does|did|can|could)\b/i.test(t)) return null
  if (LANG_LIFT_RE.test(t)) {
    const n = removeByInstruction(channel, LANG_LOCK_INSTRUCTION)
    log(`directive #${channel} ${ctx.user} [mod]: language lock ${n ? 'lifted' : 'not active'} — ${JSON.stringify(t.slice(0, 60))}`)
    return n ? withSuffix(`languages back on`, suffix) : null
  }
  if (!LANG_LOCK_RE.test(t)) return null
  removeByInstruction(channel, LANG_LOCK_INSTRUCTION)
  // only language vibes die (global or scoped) — a harmless "end with KEKW" stays stored;
  // the mod global outranks every viewer global anyway while it stands.
  const dropped = dropViewerWhere(channel, (d) => LANG_VIBE_RE.test(d.instruction))
  addDirective(channel, ctx.user, { instruction: LANG_LOCK_INSTRUCTION, mod: true })
  log(`directive #${channel} ${ctx.user} [mod]: language lock set${dropped.length ? ` (dropped ${dropped.map((d) => JSON.stringify(d.slice(0, 40))).join(', ')})` : ''} — ${JSON.stringify(t.slice(0, 60))}`)
  const mins = Math.round(MOD_TTL_MS / 60_000)
  const tail = dropped.length ? ` — dropped ${dropped.slice(0, 2).map((d) => `"${d.slice(0, 40)}"`).join(' + ')}${dropped.length > 2 ? ` + ${dropped.length - 2} more` : ''}` : ''
  return withSuffix(`english only for the next ${mins}m${tail}`, suffix)
}

export function handleVibes(arg: string, ctx: CommandContext, suffix: string): string | null {
  if (!ctx.channel) return null
  if (/^clear$/i.test(arg.trim())) {
    if (!ctx.isMod && !ctx.privileged) return withSuffix(`only mods can clear vibes`, suffix)
    const n = clearDirectives(ctx.channel)
    return withSuffix(n > 0 ? `cleared ${n} active vibe${n === 1 ? '' : 's'}` : `no active vibes`, suffix)
  }
  const list = listDirectives(ctx.channel)
  // mod pauses ride along in the listing (they're channel state a mod wants visible),
  // but `!b vibes clear` does NOT touch them — mod authority ≠ viewer vibes; resume
  // phrases ("wake up", "trivia back on") are the undo.
  const sups = listSuppressions(ctx.channel).map((s) => `[mod pause] ${s.feature} (${s.minutes}m, by ${s.by})`)
  if (list.length === 0 && sups.length === 0) return withSuffix(`no active vibes — plant one like "anytime someone asks about X, do Y"`, suffix)
  const now = Date.now()
  const lines = list.map((d) => {
    const mins = Math.max(1, Math.round((d.expiresAt - now) / 60_000))
    if (d.mute) return `[mute @${d.targetUser}] (${mins}m, by ${d.planter})`
    const scope = d.targetUser ? `@${d.targetUser}` : d.trigger.length ? d.trigger.join('/') : 'all'
    return `[${d.mod ? 'mod ' : ''}${scope}] ${d.instruction} (${mins}m, by ${d.planter})`
  })
  return withSuffix(`active vibes: ${[...lines, ...sups].join(' · ')}`, suffix)
}

// applySuppress must clear any queued trivia topic immediately, but the queue lives in
// commands-trivia.ts, which needs bannedTriviaTopic from here — a direct import back
// would cycle. registered instead, same pattern as bot-state's registerStateProvider.
let clearTriviaQueue: ((channel: string) => void) | null = null
export function onSuppressClearQueue(fn: (channel: string) => void): void { clearTriviaQueue = fn }

// bot-state introspection line for mod topic bans (owned here) — registered by
// commands-trivia.ts alongside the topic-queue provider so the original registration
// order (queue, then bans) is preserved.
export function triviaBanStateLine(channel: string): string {
  const bans = triviaTopicBans.get(channel)
  if (!bans?.size) return ''
  const now = Date.now()
  const live = [...bans].filter(([, exp]) => exp > now)
  return live.length ? `banned trivia topics: ${live.map(([k, exp]) => `${k} (${Math.max(1, Math.round((exp - now) / 60_000))}m)`).join(', ')}` : ''
}
