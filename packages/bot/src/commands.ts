import { formatItem, formatMonster, formatEvent, formatTagResults, formatDayResults, truncate } from '@bazaarinfo/shared'
import * as store from './store'
import * as db from './db'
import { snapshotSchedule, resolveScheduleChannel } from './schedule-query'
import { formatSchedule, formatLastStream, isScheduleQuery, isPastStreamQuery, withTitleOverride } from './schedule'
import { getChannelTitle } from './channel-title'
import { getTriviaScore, formatStats, formatTop, invalidateAliasCache, isGameActive, skipTrivia } from './trivia'
import { isMuted } from './directives'
import { isSuppressed, suppressNotice } from './suppress'
import { CONTINUE_RE } from './ai'
import { aiUnavailableReason, getChannelGame } from './ai-cache'
import { isLowValue, isThrowawayReply } from './ai-query'
import { META_QUERY_RE } from './intents'
import { detectSpamIntent } from './spam-intent'
import { isPastaRecall, findChatPasta, isConfidentPasta, pastaText } from './pasta'
import { glossaryAnswer, isBareKeyword, DEFINITIONAL_INTENT, BUILD_INTENT } from './glossary'
import { isGuildrunCategory, isGrQuery, grKeywordCard, grExactCard, describeGrCard } from './guildrun'
import { enchantAnswer } from './enchants'
import { getThread } from './chatbuf'
import { RESERVED_SUBS } from './self'
import * as raidCmds from './raid/commands'
import * as dungeon from './dungeon'
import { BLOCKED_BANG_CMDS, isModAliasCommand, ALLOWED_SLASH_CMDS } from './text-safety'
import { patchNote, withSuffix, logMiss, logHit, aiOrQuip, tryAiRespond, noMatchMsg, looksLikeItemQuery, AI_OFF_LINE, aiBusyLine, steerBystanderRoast, getBFallbackCooldown, bFallbackCooldowns, B_FALLBACK_CD } from './commands-reply'
import { buildBareBQuery } from './commands-bare'
import { ALIAS_ADMINS, selfTimeoutDodge, proxyWithCooldown, proxyCooldowns, PROXY_COOLDOWN } from './commands-proxy'
import { itemLookup, resolveSkills, heroPoolReply, suggestTags, capitalize, TRIVIA_RESULT_RE, TRAILING_TRIVIA_BAIL, TRIVIA_STANDINGS_RE, BARE_STANDINGS_RE, EMBEDDED_STANDINGS_RE, isStandingsTypo } from './commands-lookup'
import { runTrivia, stripTopicConnector, triviaCommand } from './commands-trivia'
import { DIRECTIVE_INTENT, MOD_CONTROL_HINT, handlePlantDirective, handleLanguageOrder, handleVibes, TRIVIA_UNBAN_RE, TRIVIA_BAN_RE, unbanTriviaTopic, banTriviaTopic, normTopic, stripArticles, featureOf, applySuppress, applyResume, parseSuppressMinutes, SUPPRESS_RE, SUPPRESS_ALL_RE, RESUME_RE } from './commands-mod'

export interface CommandContext {
  user?: string
  channel?: string
  privileged?: boolean
  isMod?: boolean
  messageId?: string
  threadId?: string
  // set only by handleCommand's addressedQuery routing — never construct this by hand.
  // 'at' = the message opened with @botname (they summoned it: honest non-answers are ok);
  // 'reply' = a twitch reply to the bot's own line (a canned excuse there reads bot-ish,
  // so a non-answer is silence).
  mention?: 'at' | 'reply'
  replyParent?: { login: string; body?: string }
  // the line was already consumed as a live-trivia guess upstream (index.ts checkAnswer)
  triviaGuess?: boolean
  // twitch's own first-message/returning-chatter signal — threaded through to aiRespond
  firstMsg?: boolean
  returningChatter?: boolean
}

export type CommandHandler = (args: string, ctx: CommandContext) => string | null | Promise<string | null>
const OWNER = (process.env.BOT_OWNER ?? '').toLowerCase()
const BOT_ADMINS = new Set(
  (process.env.BOT_ADMINS ?? '').split(',').concat(OWNER).map((s) => s.trim().toLowerCase()).filter(Boolean),
)
function isAdmin(user?: string): boolean {
  return !!user && BOT_ADMINS.has(user.toLowerCase())
}

let onRefresh: ((force?: boolean) => Promise<string>) | null = null
export function setRefreshHandler(handler: (force?: boolean) => Promise<string>) { onRefresh = handler }

let onEmoteRefresh: (() => Promise<string>) | null = null
export function setEmoteRefreshHandler(handler: () => Promise<string>) { onEmoteRefresh = handler }

let onJoinChannel: ((target: string, requester: string) => Promise<string>) | null = null
export function setJoinHandler(handler: (target: string, requester: string) => Promise<string>) { onJoinChannel = handler }

let onPartChannel: ((target: string, requester: string) => Promise<string>) | null = null
export function setPartHandler(handler: (target: string, requester: string) => Promise<string>) { onPartChannel = handler }

let onStatus: (() => string) | null = null
export function setStatusHandler(handler: () => string) { onStatus = handler }

export { BOT_ADMINS }

// --- query dedup: suppress identical lookups within 30s per channel ---
const DEDUP_WINDOW = 30_000
const recentQueries = new Map<string, number>()

function isDuplicate(channel: string, query: string): boolean {
  const key = `${channel}:${query.toLowerCase()}`
  const now = Date.now()
  const last = recentQueries.get(key)
  if (last && now - last < DEDUP_WINDOW) return true
  recentQueries.set(key, now)
  // prune old entries periodically (aggressive threshold to prevent unbounded growth)
  if (recentQueries.size > 200) {
    for (const [k, t] of recentQueries) {
      if (now - t > DEDUP_WINDOW) recentQueries.delete(k)
    }
  }
  return false
}

type SubHandler = (query: string, ctx: CommandContext, suffix: string) => string | null | Promise<string | null>
const subcommands: [RegExp, SubHandler][] = [
  [/^alias$/i, (_q, ctx) => {
    if (!isAdmin(ctx.user) && !ALIAS_ADMINS.has(ctx.user ?? '')) return 'alias management is restricted'
    return 'usage: !b alias <slang> = <item> | !b alias del <slang> | !b alias list'
  }],
  [/^alias\s+list$/i, (_q, ctx) => {
    if (!isAdmin(ctx.user) && !ALIAS_ADMINS.has(ctx.user ?? '')) return 'alias management is restricted'
    const aliases = store.getDynamicAliases()
    if (aliases.size === 0) return 'no dynamic aliases set'
    const entries = [...aliases.entries()].map(([k, v]) => `${k}→${v}`)
    return truncate(`aliases: ${entries.join(', ')}`)
  }],
  [/^alias\s+del\s+(.+)$/i, (query, ctx) => {
    if (!isAdmin(ctx.user) && !ALIAS_ADMINS.has(ctx.user ?? '')) return 'alias management is restricted'
    const removed = store.removeDynamicAlias(query)
    if (removed) invalidateAliasCache()
    return removed ? `removed alias "${query}"` : `no alias found for "${query}"`
  }],
  [/^(?:refresh|update)(?:\s+force)?$/i, async (q, ctx) => {
    if (!isAdmin(ctx.user)) return null
    if (!onRefresh) return 'refresh not available'
    // force bypasses the >30% delta guard for a genuinely massive content cull
    return onRefresh(/\bforce\b/i.test(q))
  }],
  [/^emotes?\s+refresh$/i, async (_q, ctx) => {
    if (!isAdmin(ctx.user)) return null
    if (!onEmoteRefresh) return 'emote refresh not available'
    return onEmoteRefresh()
  }],
  [/^status$/i, (_q, ctx) => {
    if (!isAdmin(ctx.user)) return null
    return onStatus?.() ?? 'status not available'
  }],
  [/^join\s+#(\S+)$/i, async (query, ctx) => {
    if (!isAdmin(ctx.user)) return null
    if (!onJoinChannel) return 'join not available'
    return onJoinChannel(query.toLowerCase(), ctx.user ?? '')
  }],
  [/^part\s+#?(\S+)$/i, async (query, ctx) => {
    if (!isAdmin(ctx.user)) return null
    if (!onPartChannel) return 'part not available'
    return onPartChannel(query.toLowerCase(), ctx.user ?? '')
  }],
  [/^(?:mob|monster)$/i, () => 'usage: !b mob <name>'],
  [/^hero$/i, () => 'usage: !b hero <name>'],
  [/^tag$/i, () => 'usage: !b tag <tagname>'],
  [/^skill$/i, () => 'usage: !b skill <name>'],
  [/^day$/i, () => 'usage: !b day <number>'],
  [/^(?:mob|monster)\s+(.+)$/i, async (query, ctx, suffix) => {
    const monster = store.findMonster(query)
    if (!monster) {
      logMiss(query, ctx)
      const suggestions = store.monsterSuggest(query, 3)
      if (suggestions.length) return withSuffix(`no monster found for ${query} — did you mean: ${suggestions.join(', ')}?`, suffix)
      return aiOrQuip(`mob ${query}`, ctx, suffix)
    }
    logHit('mob', query, monster.Title, ctx)
    return withSuffix(formatMonster(monster, resolveSkills(monster), patchNote(monster.Title)), suffix)
  }],
  [/^(?:event|encounter)\s+(.+)$/i, async (query, ctx, suffix) => {
    // explicit event lookup — forces the encounter even when an item shares the name
    // (e.g. "Apothecary" is both an item and an event).
    const event = store.findEventExact(query)
    if (!event) {
      logMiss(query, ctx)
      return aiOrQuip(`event ${query}`, ctx, suffix)
    }
    logHit('event', query, event.Title, ctx)
    return withSuffix(formatEvent(event, patchNote(event.Title)), suffix)
  }],
  [/^hero\s+(.+)$/i, async (query, ctx, suffix) => {
    const resolved = store.findHeroName(query)
    const items = store.byHero(query)
    if (items.length === 0) {
      logMiss(query, ctx)
      return aiOrQuip(`hero ${query}`, ctx, suffix)
    }
    logHit('hero', query, `${items.length} items`, ctx)
    return heroPoolReply(resolved ?? query, items, suffix)
  }],
  [/^enchant(?:s|ments)?$/i, (_query, ctx, suffix) => {
    const names = store.getEnchantments().map(capitalize)
    logHit('enchants', _query, `${names.length} enchants`, ctx)
    return withSuffix(truncate(`Enchantments: ${names.join(', ')}`), suffix)
  }],
  // let streamers self-serve the overlay/bot setup without the broadcaster pasting the link
  [/^overlay$/i, (_query, _ctx, suffix) => withSuffix('stream card tooltips for your viewers + this bot in chat — setup guide (tos-safe, ~2 min): https://github.com/mellen9999/bazaarinfo/blob/master/docs/streamer-setup.md', suffix)],
  [/^tag\s+(.+)$/i, async (query, ctx, suffix) => {
    const resolved = store.findTagName(query)
    const cards = store.byTag(query)
    if (cards.length === 0) {
      logMiss(query, ctx)
      // suggest real TAG names (not item titles) — the user mistyped a tag, so item
      // suggestions would be a category error that sends them down the wrong path.
      const tagSuggest = suggestTags(query, 3)
      if (tagSuggest.length) return withSuffix(`no tag ${query} — did you mean tag: ${tagSuggest.join(', ')}?`, suffix)
      return aiOrQuip(`tag ${query}`, ctx, suffix)
    }
    const displayTag = resolved ?? query
    logHit('tag', query, `${cards.length} items`, ctx)
    return withSuffix(formatTagResults(displayTag, cards), suffix)
  }],
  [/^day\s+(\d+)$/i, async (query, ctx, suffix) => {
    const day = parseInt(query)
    if (day < 1 || day > 99) return `invalid day number (1-99)`
    const mobs = store.monstersByDay(day)
    if (mobs.length === 0) { logMiss(query, ctx); return aiOrQuip(`day ${day}`, ctx, suffix) }
    logHit('day', query, `${mobs.length} monsters`, ctx)
    return withSuffix(formatDayResults(day, mobs), suffix)
  }],
  [/^skill\s+(.+)$/i, async (query, ctx, suffix) => {
    const skill = store.findSkill(query)
    if (!skill) { logMiss(query, ctx); return aiOrQuip(`skill ${query}`, ctx, suffix) }
    logHit('skill', query, skill.Title, ctx)
    return withSuffix(formatItem(skill, undefined, patchNote(skill.Title)), suffix)
  }],
  [/^trivia(?:\s+([\s\S]+))?$/i, (query, ctx, suffix) => runTrivia(ctx, query ?? '', suffix)],
  // natural-language trivia start: "make a trivia about happy gilmore", "do a quiz on
  // cats", "can you start a trivia", "do some trivias" (the plural used to leave a stray
  // "s" as the topic, which failed the topic guard silently — four asks, zero rounds). the verb + "trivia"/"quiz" makes intent explicit, so
  // route it to the trivia game instead of letting it fall to AI chat. the topic (incl. a
  // leading "about"/"on") is handed to runTrivia, which resolves category vs custom topic.
  [/^(?:pls\s+|please\s+)?(?:can\s+(?:you|u|we)\s+)?(?:make|do|start|begin|create|run|generate|gen|give|gimme|set\s*up|lets?\s+do|let'?s\s+do|wanna|i\s+wanna|i\s+want(?:\s+to)?)\s+(?:me\s+)?(?:a|an|some|the|new)?\s*(?:new\s+)?(?:trivias?|quiz(?:zes)?)(?:\s+(?:question|round|game|q))?(?:\s+(?:about|on|for|regarding|over|covering))?\s*([\s\S]*)$/i,
    (query, ctx, suffix) => runTrivia(ctx, stripTopicConnector(query ?? ''), suffix)],
  // "quiz" as a full alias for "trivia" (quiz / quiz me / quiz about cats)
  [/^quiz(?:\s+me)?(?:\s+([\s\S]+))?$/i, (query, ctx, suffix) => runTrivia(ctx, stripTopicConnector(query ?? ''), suffix)],
  [/^(?:vibes?|directives?)(?:\s+([\s\S]+))?$/i, (query, ctx, suffix) => handleVibes(query ?? '', ctx, suffix)],
  [/^skip$/i, (_query, ctx, suffix) => {
    if (!ctx.channel) return null
    const msg = skipTrivia(ctx.channel, ctx.user)
    return msg ? withSuffix(msg, suffix) : null
  }],
  [/^score$/i, (_query, ctx, suffix) => {
    if (!ctx.channel) return null
    return withSuffix(getTriviaScore(ctx.channel), suffix)
  }],
  // --- the depths (offline shared-hero dungeon) ---
  // descend / attack / defend / special / flee / 1 / 2 all flow through the bare-keyword
  // vote hook in index.ts (NOT !b routes). only the on-demand status + a mod reset are commands.
  [/^depths\s+reset$/i, (_q, ctx) => (ctx.channel && ctx.isMod) ? dungeon.resetRun(ctx.channel) : null],
  [/^depths$/i, (_q, ctx) => (ctx.channel ? dungeon.statusLine(ctx.channel) : null)],
  // --- raid game commands (silent) ---
  [/^join(?:\s+(.+))?$/i, (_q, ctx) => raidCmds.handleJoin('', ctx)],
  [/^leave$/i, (_q, ctx) => raidCmds.handleLeave('', ctx)],
  [/^pick\s+(.+)$/i, (query, ctx) => raidCmds.handlePick(query, ctx)],
  [/^vote\s+(.+)$/i, (query, ctx) => raidCmds.handleVote(query, ctx)],
  [/^party$/i, (_q, ctx) => raidCmds.handleParty('', ctx)],
  [/^shop$/i, (_q, ctx) => raidCmds.handleParty('', ctx)],
  [/^history$/i, (_q, ctx) => raidCmds.handleHistory('', ctx)],
  [/^resolve$/i, (_q, ctx) => raidCmds.handleResolve('', ctx)],
  [/^game\s+pace\s+(fast|normal|slow)$/i, (query, ctx) => raidCmds.handleGamePace(query, ctx)],
  [/^game\s+(on|off)$/i, (query, ctx) => raidCmds.handleGameToggle(query, ctx)],
  [/^stats(?:\s+@?(\S+))?$/i, (query, ctx, suffix) => {
    // bare `!b stats` has no capture group → the dispatcher passes the literal word "stats";
    // treat that as "my own stats", not a lookup of a user named stats.
    const target = (query && query.toLowerCase() !== 'stats') ? query : ctx.user
    if (!target) return null
    return withSuffix(formatStats(target, ctx.channel), suffix)
  }],
  [/^top$/i, (_query, ctx, suffix) => {
    if (!ctx.channel) return null
    return withSuffix(formatTop(ctx.channel), suffix)
  }],
]

// subcommands whose output is dynamic (changes between calls) or that are silent game actions —
// exempt from the 30s duplicate-lookup suppressor (which is meant for static item/mob lookups).
const DYNAMIC_SUBS = new Set([
  'score', 'top', 'stats', 'skip', 'trivia', 'quiz', 'vote', 'pick',
  'join', 'leave', 'party', 'shop', 'history', 'resolve', 'depths', 'game',
])

async function bazaarinfo(args: string, ctx: CommandContext): Promise<string | null> {
  // (mute is enforced centrally in handleCommand, covering every command path)
  // extract @mentions to tag at end of response
  const mentions = args.match(/@\w+/g) ?? []
  // keep usernames in AI query (strip @ only), strip fully for item lookup
  const aiQuery = steerBystanderRoast(args.replace(/@(\w+)/g, '$1').replace(/"/g, '').replace(/\s+/g, ' ').trim())
  const cleanArgs = args.replace(/@\w+/g, '').replace(/"/g, '').replace(/\s+/g, ' ').trim()

  // addressed-without-!b: a throwaway reaction ("lol", "KEKW", "?") to the bot's line is a
  // human aside, not a real ask — silence, not a forced AI reply. isLowValue/isNoise don't
  // cover a bare single-letter reaction ("w"/"l"), so that's a small addition here.
  if (ctx.mention && isThrowawayReply(cleanArgs)) return null

  // bare !b in a thread reply → read the full thread and try to help
  if (!cleanArgs && ctx.threadId && ctx.channel) {
    const thread = getThread(ctx.channel, ctx.threadId)
    const botName = (process.env.TWITCH_USERNAME ?? 'bazaarinfo').toLowerCase()
    const threadMsgs = thread
      .filter((m) => m.user.toLowerCase() !== botName)
      .map((m) => m.text.replace(/^!\w+\s*/, '').trim())
      .filter(Boolean)
    if (threadMsgs.length > 0) {
      // try item lookup on the first non-command message (the original question)
      const rootText = threadMsgs[0].replace(/@\w+/g, '').replace(/"/g, '').replace(/\s+/g, ' ').trim()
      const suffix = mentions.length ? ` ${mentions.join(' ')}` : ''
      if (rootText) {
        const lookupResult = await itemLookup(rootText, ctx, suffix)
        if (lookupResult !== null) return lookupResult
      }
      // no item match → AI with full thread as context
      const threadContext = threadMsgs.map((m, i) => i === 0 ? m : `followup: ${m}`).join('\n')
      return tryAiRespond(threadContext, ctx, [], cleanArgs || '!b')
    }
  }

  // bare !b → riff on recent chat; help/info → describe capabilities (no hardcoded usage line)
  if (!cleanArgs) return tryAiRespond(buildBareBQuery(ctx.channel), ctx, mentions, '!b')
  if (cleanArgs === 'help' || cleanArgs === 'info') return tryAiRespond('what does this bot do', ctx, mentions, cleanArgs)

  // a pure identity ask gets the bot's VOICE, not a static brochure — the old hardcoded
  // "try: !b <item>..." blurb was exactly the banned usage-string format. identity facts are
  // grounded in the system prompt, so this is the same trusted path as help/info above.
  // end-anchored so only a pure identity ask fires — trailing words ("doing rn", "card do",
  // "talking about") fall through to the isDeictic → tryAiRespond path.
  if (/^(how (do you|does this( bot)?) work|what are you|what is this( bot)?)\??$/i.test(cleanArgs))
    return tryAiRespond('introduce yourself — who are you and what can you do', ctx, mentions, cleanArgs)

  // trivia-result questions ("who won the trivia?", "trivia leaderboard") answered from
  // REAL data — never routed to the AI, which would invent a winner. tightly scoped to
  // interrogative result-phrasing so a topic request ("trivia about winning") still starts
  // a round instead of being hijacked.
  if (ctx.channel && TRIVIA_RESULT_RE.test(cleanArgs)) {
    const sfx = mentions.length ? ` ${mentions.join(' ')}` : ''
    if (TRIVIA_STANDINGS_RE.test(cleanArgs)) {
      return withSuffix(getTriviaScore(ctx.channel), sfx)
    }
    if (isGameActive(ctx.channel)) return withSuffix(`a round's live right now — get your answer in!`, sfx)
    const last = db.getLastTriviaResult(ctx.channel)
    if (!last) return withSuffix(`no trivia has run here yet — start one with !b trivia`, sfx)
    if (last.winner) return withSuffix(`@${last.winner} won the last round (answer: ${last.answer})`, sfx)
    return withSuffix(`nobody got the last round — the answer was ${last.answer}`, sfx)
  }

  // a BARE standings ask ("leaderboard", "who's winning", "trivia rankings") → the exact
  // trivia top-5 table, free + no hallucination risk. anchored to the whole query so a
  // conversational mention ("i am talking about the leaderboard") falls through to the AI,
  // which is grounded with the same standings data in ai-build (so it never deflects either).
  // mid-round: the standings table is always safe — only the trivia-result/last-winner path
  // (TRIVIA_RESULT_RE branch above) needs the isGameActive guard to avoid leaking the answer.
  if (ctx.channel && (BARE_STANDINGS_RE.test(cleanArgs) || (!store.exact(cleanArgs) && isStandingsTypo(cleanArgs)))) {
    const sfx = mentions.length ? ` ${mentions.join(' ')}` : ''
    const score = getTriviaScore(ctx.channel)
    const midRound = isGameActive(ctx.channel) ? ` (round's live — get an answer in!)` : ''
    return withSuffix(score + midRound, sfx)
  }

  // mod trivia-topic ban/unban + feature pause/resume — a mod's "no more digimon trivia"
  // or "stop doing trivia" takes real effect. placed BEFORE schedule/lookups so mod
  // control phrasing is never swallowed by another deterministic path ("trivia back on"
  // reads schedule-ish). non-mods fall through to the AI (which knows [MOD] semantics).
  if (ctx.channel && ctx.isMod) {
    const sfx = mentions.length ? ` ${mentions.join(' ')}` : ''
    // language lock — "only english" / "no german" / "stop speaking chinese". deterministic
    // and free: the sep-2026 cascade was six mod orders in a row landing in the AI chat
    // path (the hint regex had no negation forms) while a viewer's chinese vibe stayed live.
    const lock = handleLanguageOrder(cleanArgs, ctx, sfx)
    if (lock) return lock
    const unban = cleanArgs.match(TRIVIA_UNBAN_RE)
    if (unban) {
      const topic = stripArticles(unban[1])
      return unbanTriviaTopic(ctx.channel, topic)
        ? withSuffix(`${normTopic(topic)} trivia unbanned`, sfx)
        : withSuffix(`${normTopic(topic)} trivia wasnt banned`, sfx)
    }
    const ban = cleanArgs.match(TRIVIA_BAN_RE)
    if (ban) {
      const topic = stripArticles(ban[1])
      // reject verb/filler captures ("stop making trivia about me" must not ban "making",
      // "stop the trivia" must not ban "the" — that one is a feature pause below)
      if (topic && !/^(?:making|doing|playing|running|giving|more|any|some|these|those|the|this|that|it)$/i.test(topic)) {
        const key = banTriviaTopic(ctx.channel, topic)
        return withSuffix(`${key} trivia banned for 2h — mod's orders`, sfx)
      }
    }
    // feature pause/resume — resume first ("turn trivia back on" carries no stop-verb,
    // stop-phrasings never carry resume verbs). an INFO QUESTION ("why did you stop
    // doing trivia", "is trivia paused") must never toggle state — it falls through to
    // the AI, which sees the [MOD PAUSE] hint and answers honestly. polite modal
    // requests ("can you stop doing trivia") are commands in intent and DO act.
    // anything else these regexes miss still lands via the AI parse in the plant block
    // below (plain mod talking is the primary path).
    const isQuestion = /^(?:when|what|why|how|where|who|is|are|was|were|does|do|did)\b/i.test(cleanArgs)
    if (!isQuestion && RESUME_RE.test(cleanArgs)) {
      const resumed = applyResume(ctx.channel, featureOf(cleanArgs) ?? 'all', sfx)
      if (resumed) return resumed
    }
    const sup = isQuestion ? null : cleanArgs.match(SUPPRESS_RE)
    if (sup) {
      return applySuppress(ctx.channel, featureOf(sup[1]) ?? 'ai', ctx.user ?? 'mod', parseSuppressMinutes(cleanArgs), sfx)
    }
    if (!isQuestion && SUPPRESS_ALL_RE.test(cleanArgs)) {
      return applySuppress(ctx.channel, 'all', ctx.user ?? 'mod', parseSuppressMinutes(cleanArgs), sfx)
    }
  }

  // "when's the next stream / stream schedule" → deterministic prediction from logged
  // Helix start times (schedule.ts). NEVER routed through AI — a schedule is statistics,
  // and an AI guess would fabricate a time. answers honestly ("still learning", "too
  // irregular") rather than inventing one when the data can't support a call.
  // past-tense asks ("when did kripp start yesterday") get the last logged start instead.
  if (ctx.channel && isScheduleQuery(cleanArgs) && !store.exact(cleanArgs)) {
    const sfx = mentions.length ? ` ${mentions.join(' ')}` : ''
    const now = Date.now()
    // the ask may name another tracked channel ("when kripp getting on" in #mellen)
    const target = resolveScheduleChannel(cleanArgs, ctx.channel)
    const { pred, live, sessions } = snapshotSchedule(target, now)
    let body = isPastStreamQuery(cleanArgs)
      ? formatLastStream(target, sessions, now, live)
      : formatSchedule(target, pred, now, live)
    // streamer-stated schedule in the title outranks the stats ("kripps title says
    // next stream wednesday" must never get the same canned prediction again)
    if (!live.isLive) body = withTitleOverride(body, target, await getChannelTitle(target), live)
    return withSuffix(body, sfx)
  }

  // proxy ! and / commands — before dedup so cooldown messages always show
  const bangMatch = cleanArgs.match(/^!(\w+)(.*)$/)
  if (bangMatch) {
    const cmd = bangMatch[1].toLowerCase()
    if (BLOCKED_BANG_CMDS.has(cmd) || isModAliasCommand(cmd)) {
      return selfTimeoutDodge(ctx.channel, cmd)
    }
    return proxyWithCooldown(ctx.channel, cleanArgs, cmd)
  }
  const slashMatch = cleanArgs.match(/^\/(\w+)(.*)$/)
  if (slashMatch) {
    const cmd = slashMatch[1].toLowerCase()
    if (!ALLOWED_SLASH_CMDS.has(cmd)) return null
    if ((cmd === 'announce' || cmd === 'me' || cmd === 'color') && !ctx.isMod) return null
    return cleanArgs
  }
  // embedded command: "so can u run !jory pls" → "!jory"
  // skip if asking about a command ("who has the most !a"), not requesting one
  // questions about commands mention them as nouns; requests use action verbs near them
  const isAskingAbout = /^(who|what|when|where|why|how|does|has|have|is|should|can|will|could|would|may|might|don'?t|never|please)\b/i.test(cleanArgs)
  // content-gen request — !cmd is a topic, not a request to proxy ("write a pasta about !afk")
  const isContentGen = /\b(copypasta|pasta|joke|story|poem|rant|monologue|lore|sonnet|haiku|fanfic|saga|ballad|essay|tweet|limerick|rap|song|roast|narrative|bit)\b/i.test(cleanArgs)
  if (!isAskingAbout && !isContentGen) {
    const embeddedMatch = cleanArgs.match(/!(\w+)(?:\s+(\d+))?/)
    if (embeddedMatch) {
      const cmd = embeddedMatch[1].toLowerCase()
      // skip the proxy short-circuit when a substantive lookup subject precedes the !cmd:
      // "tell me about pegasus and run !uptime" → do the pegasus lookup, not the proxy.
      // strip transition filler words; if real content (>=4 chars) remains before the !cmd,
      // there is a lookup subject — fall through to the normal handling path.
      const beforeCmd = cleanArgs.slice(0, embeddedMatch.index ?? 0)
        .replace(/\b(run|do|fire|also|and|or|pls|please|can|u|me|that|it|this)\b/gi, ' ')
        .replace(/\s+/g, ' ').trim()
      const hasSubjectBefore = beforeCmd.length >= 4
      if (!hasSubjectBefore) {
        if (!BLOCKED_BANG_CMDS.has(cmd) && !isModAliasCommand(cmd)) {
          const cmdStr = embeddedMatch[2] ? `!${embeddedMatch[1]} ${embeddedMatch[2]}` : `!${embeddedMatch[1]}`
          return proxyWithCooldown(ctx.channel, cmdStr, cmd)
        }
        const dodge = selfTimeoutDodge(ctx.channel, cmd)
        if (dodge) return dodge
      }
    }
  }

  // suppress duplicate lookups within 30s per channel (same user only).
  // continuations ("continue", "more"…) are exempt — each one extends an active bit.
  // dynamic/silent subcommands are exempt too: their output changes between calls (score/top/
  // stats/skip after a round) or they're silent-by-design game actions (vote/pick) where a
  // spoken "posted that just now" note would be wrong. only static lookups get deduped.
  // on a dup, return a DISTINCT terse note (twitch silently drops exact re-sends anyway).
  const firstTok = cleanArgs.split(/\s+/)[0]?.toLowerCase()
  const isDynamicSub = firstTok != null && DYNAMIC_SUBS.has(firstTok)
  // emote-wall intent is repeat-by-design — the bit IS asking again. answered further down;
  // resolved here only so the duplicate suppressor never answers a spam ask with a dunk.
  const spamWall = detectSpamIntent(cleanArgs, (n) => {
    if (!ctx.channel) return false
    try { return db.userHasChatted(n, ctx.channel) } catch { return false }
  })
  if (ctx.channel && ctx.user && !isDynamicSub && !spamWall && !CONTINUE_RE.test(cleanArgs) && isDuplicate(ctx.channel, `${ctx.user}:${cleanArgs}`)) {
    const sfx = mentions.length ? ` ${mentions.join(' ')}` : ''
    return withSuffix(`↑ ${cleanArgs}, posted that just now`, sfx)
  }

  const suffix = mentions.length ? ` ${mentions.join(' ')}` : ''

  // alias add: !b alias <slang> = <target>
  const aliasAdd = cleanArgs.match(/^alias\s+(.+?)\s*=\s*(.+)$/i)
  if (aliasAdd) {
    if (!isAdmin(ctx.user) && !ALIAS_ADMINS.has(ctx.user ?? '')) return 'alias management is restricted'
    const aliasKey = aliasAdd[1].trim().toLowerCase()
    if (/\s/.test(aliasKey)) return 'alias name cannot contain spaces'
    const targetQuery = aliasAdd[2].trim()
    if (RESERVED_SUBS.has(aliasKey)) return `"${aliasKey}" is a reserved command name`
    const match = store.exact(targetQuery) ?? store.search(targetQuery, 1)[0]
    if (!match) return `no item found for ${targetQuery}`
    store.addDynamicAlias(aliasKey, match.Title, ctx.user)
    invalidateAliasCache()
    return `alias set: ${aliasKey} → ${match.Title}`
  }

  for (const [pattern, handler] of subcommands) {
    const match = cleanArgs.match(pattern)
    if (match) return await handler(match[1]?.trim() ?? cleanArgs, ctx, suffix)
  }

  // topic-first trivia: "bakugon trivia" / "digimon quiz" — chatters put the topic before
  // the game word. lives OUTSIDE the subcommand table because a bail here must fall
  // through to the normal pipeline (a table match always returns, even null → silence).
  const trailingTrivia = cleanArgs.match(/^(.{2,60}?)\s+(?:trivia|quiz)(?:\s+(?:game|round|time|pls|please))?$/i)
  if (trailingTrivia && ctx.channel) {
    const topic = trailingTrivia[1].trim()
    if (/^(?:an?other(?:\s+one)?|more|again|new|next|one\s+more)$/i.test(topic)) {
      const t = await runTrivia(ctx, '', suffix)
      if (t) return t
    } else if (!TRAILING_TRIVIA_BAIL.test(topic)) {
      const t = await runTrivia(ctx, topic, suffix)
      if (t) return t
    }
  }

  // emote-wall interception — handled without AI, all four shapes, in spam-intent.ts.
  // chat-norm for an emote aimed at chat ("LICK", "spam LICK", "LICK anyone",
  // "can u LICK mellen") is participation, not prose about it. deterministic because the
  // AI drifted into refusing the bit; the question form ("what is X") still reaches it.
  if (spamWall) return withSuffix(spamWall, suffix)

  // pasta recall — post the logged pasta verbatim, no model in the loop. asked to recite
  // one, the model kept substituting words with the kripp emote ("Subscribe kripp Kripp's
  // kripp for kripp daily kripp...") because it mimics chat's voice, and a verbatim quote
  // is the one place voice must not apply. only a CONFIDENT hit skips the model; a weak
  // match still goes through the AI path, which can hedge or ask. outgoing command
  // stripping happens centrally at twitch.say, so chat text is safe to echo.
  if (ctx.channel && isPastaRecall(cleanArgs)) {
    const hit = findChatPasta(cleanArgs, ctx.channel)
    if (hit && isConfidentPasta(hit)) {
      try { db.logCommand(ctx, 'ai', cleanArgs, 'keyword') } catch {}
      return withSuffix(pastaText(hit), suffix)
    }
  }

  // plant intent: "anytime someone asks about X, do Y" → store a steering directive
  // instead of answering. AI-gated (rejects mean/targeting/unsafe + false positives);
  // on reject it returns null and we fall through to a normal answer.
  // for MODS the gate is broad: any control-ish phrasing goes to the AI parse so plain
  // talking works ("you're being too much, take a breather") — mod messages are rare,
  // a classify call is fine; ordinary mod lookups ("!b toaster") still skip it.
  if (ctx.channel && (DIRECTIVE_INTENT.test(cleanArgs) || (ctx.isMod && MOD_CONTROL_HINT.test(cleanArgs)))) {
    const planted = await handlePlantDirective(cleanArgs, ctx, suffix)
    if (planted) return planted
  }

  // generic enchant definition — deterministic, BEFORE item lookup + glossary so
  // "what does fiery do" / "golden enchant" returns the enchant rule instead of a
  // fuzzy item miss. gated to never steal an item+enchant lookup ("fiery boomerang")
  // or a same-spelled mechanic ("shielded" -> Shield unless "enchant" is stated).
  // an exact item named like an enchant still wins.
  {
    const ench = enchantAnswer(cleanArgs)
    if (ench && !store.exact(cleanArgs.trim())) {
      try { db.logCommand(ctx, 'enchant', cleanArgs, 'keyword') } catch {}
      return withSuffix(ench, suffix)
    }
  }

  // keyword/mechanic definition — deterministic, BEFORE item lookup + AI so
  // "what is flying" returns the verified rule, not the fuzzy item "Flying Pig".
  // a bare keyword that is also an exact item name lets the item win.
  // compound: when a standings clause also appears ("what does burn do and who's winning"),
  // append the live standings table — both paths are deterministic and free.
  // guildrun claims a query while it's the live category (or named), unless the asker
  // says "bazaar" — shared vocabulary means guildrun's rules, not the home game's
  const grAsk = (isGrQuery(cleanArgs) || (!!ctx.channel && isGuildrunCategory(getChannelGame(ctx.channel))))
    && !/\bbazaar\b/i.test(cleanArgs)
  {
    // shared keywords (burn, poison, shield, crit…) exist in both games with different
    // rules. while guildrun owns the term it answers deterministically (free, curated,
    // no AI call). a bazaar-only term still answers, labeled, so the wrong game's rule
    // can never read as the live one.
    if (grAsk && (DEFINITIONAL_INTENT.test(cleanArgs) || /^\S+[?!.]*$/.test(cleanArgs.trim())) && !BUILD_INTENT.test(cleanArgs)) {
      const kw = grKeywordCard(cleanArgs)
      if (kw) {
        try { db.logCommand(ctx, 'glossary', cleanArgs, 'keyword') } catch {}
        const line = describeGrCard(kw)
        if (ctx.channel && EMBEDDED_STANDINGS_RE.test(cleanArgs)) {
          return withSuffix(line + ' | ' + getTriviaScore(ctx.channel), suffix)
        }
        return withSuffix(line, suffix)
      }
    }
    const gloss = glossaryAnswer(cleanArgs)
    if (gloss && !(isBareKeyword(cleanArgs) && store.exact(cleanArgs.trim()))) {
      try { db.logCommand(ctx, 'glossary', cleanArgs, 'keyword') } catch {}
      if (ctx.channel && EMBEDDED_STANDINGS_RE.test(cleanArgs)) {
        return withSuffix(gloss + ' | ' + getTriviaScore(ctx.channel), suffix)
      }
      return withSuffix((grAsk ? 'in the bazaar: ' : '') + gloss, suffix)
    }
  }

  // deterministic guildrun card lookup — same contract as the bazaar's exact lookup:
  // the WHOLE query is a name ("!b irini", "!b hydra") → the card answers free and
  // instant, no AI call. an exact bazaar name still wins (home game owns collisions),
  // and opinion questions ("is irini good") fall through to the AI with grounding.
  if (grAsk && !store.exact(cleanArgs.trim())) {
    const card = grExactCard(cleanArgs.replace(/\bin guild\s?run\b/i, '').replace(/[?!.]+$/, '').trim())
    if (card) {
      try { db.logCommand(ctx, 'item', cleanArgs, 'guildrun') } catch {}
      return withSuffix(describeGrCard(card), suffix)
    }
  }

  // detect conversational/creative queries that should skip item lookup entirely
  const isGreeting = /^(h(ello|i|ey|owdy)|yo|sup|hey+|what'?s? ?up|greetings|hola|whats good|good (morning|evening|night)|gm|gn|gg|ty|thanks|thank you|lol|lmao|wow|nice|cool|pog|based|true|real|facts|nah|bruh|bro|dude|man|omg|rip|oof|haha|o7|bye|cya|later|peace|gl|hf|glhf|ggs)\b/i.test(cleanArgs)
  const isContinuation = /^(how about|what about|and |or |but )\b/i.test(cleanArgs)
  // deictic/context questions — "what is that", "what do you mean", "wdym" — point
  // at recent chat, not an item. route to AI (it gets the Recent-chat block) so the
  // referent is read from the line above, not fuzzy-matched ("that" → "Stop That!").
  const isDeictic = /^(?:wdym|wym|huh|(?:what|who|why)(?:'?s| is| was| are| do(?:es)?| did)?\s+(?:you|they|he|she|it|that|this|dat|those|these|them|i)\b)/i.test(cleanArgs)
  // long queries used to route to AI purely on word count (>4), which made every
  // hero/size/filler-wrapped lookup ("vanessa flying fish medium item") read as "the bot
  // needs the exact name". now only QUESTION-shaped long queries go to the AI (nuanced
  // asks deserve a real answer, and the AI gets game data injected); long noun phrases
  // try the deterministic lookup first — salvageQuery strips the wrapping — and only
  // fall to the AI on a genuine miss.
  const isLongQuestion = cleanArgs.split(/\s+/).length > 4
    && (/\?/.test(cleanArgs) || /^(?:what|who|when|where|why|how|is|are|does|do|can|could|should|would|which|will)\b/i.test(cleanArgs))
  const isConversational = isGreeting
    || isContinuation
    || isDeictic
    || isLongQuestion
    // "what's new / is there an event / current patch" → AI, which injects the live bazaardb
    // patch line (ai-build META_QUERY_RE) and answers authoritatively instead of fuzzy-matching
    // "new" to an item or dead-ending in "did you mean".
    || META_QUERY_RE.test(cleanArgs)
    || /\b(continue|extend|expand|write|make|create|do|say|tell|give|sing|rap|roast|rate|rank|compare|explain|describe|imagine|pretend|spam|repeat|copypasta|pasta)\b/i.test(cleanArgs)

  // conversational queries go straight to AI — no item lookup, no fallback cooldown
  if (isConversational) {
    const response = await tryAiRespond(aiQuery, ctx, mentions, cleanArgs)
    if (response) {
      try { db.logCommand(ctx, 'ai', cleanArgs, 'fallback') } catch {}
      return response
    }
    // a deliberate low-value reaction (gg/lol/pog, punctuation, 1-2 chars) is a DECLINE,
    // not a transient failure — stay silent rather than lie with a "glitched, run it back"
    // line that invites a doomed retry. aiBusyLine is strictly for real-query transient misses.
    if (isLowValue(cleanArgs)) return null
    // a reply to the bot's own line never earns a canned excuse — the viewer didn't type
    // !b, and "servers lagging" under their reply reads as a bot talking to itself.
    if (ctx.mention === 'reply') return null
    // AI switched off here (no key, channel never enabled) is PERMANENT, not a hiccup.
    // "servers are lagging, give it a few seconds" would be a lie inviting a retry that can
    // never succeed — but going quiet breaks the answer-every-!b contract. So: say the true
    // thing, don't beg a retry, and point at what still works.
    if (aiUnavailableReason(ctx.channel) !== 'ok') return withSuffix(AI_OFF_LINE, suffix)
    // never go silent on a real creative/conversational ask — a transient AI miss
    // (timeout, retry-exhaustion) still gets an answer. every real !b is answered.
    return withSuffix(aiBusyLine(), suffix)
  }

  const lookupResult = await itemLookup(cleanArgs, ctx, suffix)
  if (lookupResult !== null) return lookupResult

  // short non-conversational queries that missed item lookup — AI fallback with cooldown.
  // mention-mode skips the cooldown deflection too — straight to the AI with reply context.
  const cd = ctx.mention ? 0 : getBFallbackCooldown(ctx.user)
  if (cd > 0) {
    const suggestions = store.suggest(cleanArgs, 3)
    if (suggestions.length) return withSuffix(`try: ${suggestions.join(', ')}`, suffix)
    return withSuffix(noMatchMsg(cleanArgs), suffix)
  }

  const aiResponse = await tryAiRespond(aiQuery, ctx, mentions, cleanArgs)
  if (aiResponse) {
    if (ctx.user) {
      bFallbackCooldowns.set(ctx.user.toLowerCase(), Date.now())
      if (bFallbackCooldowns.size > 500) {
        const now = Date.now()
        for (const [k, t] of bFallbackCooldowns) {
          if (now - t > B_FALLBACK_CD) bFallbackCooldowns.delete(k)
        }
      }
    }
    try { db.logCommand(ctx, 'ai', cleanArgs, 'fallback') } catch {}
    return aiResponse
  }

  // mod ai-pause: the miss above was the pause, not a lookup whiff — the throttled
  // honest notice (or silence) is the only truthful reply; a "found only dust" quip
  // would blame a lookup for what a mod ordered.
  if (ctx.channel && isSuppressed(ctx.channel, 'ai')) return suppressNotice(ctx.channel)

  // AI was attempted and missed (timeout, or every retry blocked by a guard). a
  // bazaar-flavoured "found only dust" quip here lies twice: it blames a failed ITEM
  // lookup for what was an AI miss, and on a conversational ask it IS the "no bazaar
  // data" dodge the prompt bans. mirror the conversational branch above instead.
  // a real near-miss item name still gets suggestions — that part was always right.
  const suggestions = store.suggest(cleanArgs, 3)
  if (suggestions.length) return withSuffix(`try: ${suggestions.join(', ')}`, suffix)
  // an item-shaped whiff is a genuine lookup miss and reads correctly whether or not the
  // AI is up — it stays ahead of both AI-state lines.
  if (looksLikeItemQuery(cleanArgs)) return withSuffix(noMatchMsg(cleanArgs), suffix)
  if (aiUnavailableReason(ctx.channel) !== 'ok') return withSuffix(AI_OFF_LINE, suffix)
  return withSuffix(aiBusyLine(), suffix)
}

const commands: Record<string, CommandHandler> = {
  b: bazaarinfo,
  trivia: triviaCommand,
}

// #10: block the bot's own command names from the proxy so chatters can't self-relay !b/!trivia.
// derived at module-init so it never drifts when new commands are added to the registry.
for (const k of Object.keys(commands)) BLOCKED_BANG_CMDS.add(k)

// is this message an ask, without a leading !b? only two shapes count: a direct reply to
// the bot's own line, or a message that OPENS with @botname. never a mid-sentence mention
// ("the bazaarinfo bot said x", "bazaarinfo hi" with no @, "@bazaarinfo2 hi") — those stay
// silent, chat volume already complains about the bot talking too much.
export function addressedQuery(text: string, ctx: CommandContext): { text: string; shape: 'at' | 'reply' } | null {
  const botName = (process.env.TWITCH_USERNAME ?? 'bazaarinfo').toLowerCase()
  // a line checkAnswer already scored as the WIN is done — routing it here too would answer
  // it twice (once as points, once as an AI reply). a miss keeps its ask.
  if (ctx.triviaGuess) return null

  const mentionMatch = text.match(/^@(\w+)[,:]?\s+(.+)/)
  if (mentionMatch && mentionMatch[1].toLowerCase() === botName) return { text: mentionMatch[2].trim(), shape: 'at' }

  if (ctx.replyParent?.login.toLowerCase() === botName) {
    // a reply to a LIVE trivia question is an answer, not an ask — even one checkAnswer
    // didn't score (a non-answer shape). routing it would talk over the round.
    if (ctx.channel && isGameActive(ctx.channel)) return null
    // defensive re-strip — twitch's own "@parent " auto-prefix is already stripped
    // upstream (twitch.ts), but user-controlled text never gets trusted from one site only.
    const at = new RegExp(`^@${botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`, 'i')
    return { text: text.replace(at, '').trim(), shape: 'reply' }
  }

  return null
}

export async function handleCommand(text: string, ctx: CommandContext = {}): Promise<string | null> {
  // strip leading @mention so !b works in Twitch replies
  const cleaned = text.replace(/^@\w+\s+/, '')
  const match = cleaned.match(/^!(\w+)\s*(.*)$/)

  let cmd: string
  let args: string
  let runCtx = ctx
  if (match) {
    ;[, cmd, args] = match
  } else {
    const addressed = addressedQuery(text, ctx)
    if (addressed === null) return null
    cmd = 'b'
    args = addressed.text
    runCtx = { ...ctx, mention: addressed.shape }
  }

  const handler = commands[cmd.toLowerCase()]
  if (!handler) return null

  // muted by a chat-planted directive → stay silent across ALL commands (!b, !trivia,
  // !vibes…), so a mute can't be escaped via trivia. mods/broadcaster are never muteable.
  if (runCtx.channel && runCtx.user && !runCtx.isMod && isMuted(runCtx.channel, runCtx.user, !!runCtx.privileged)) return null

  // mod pause 'all' → the bot goes quiet for everyone but mods, who keep the resume
  // path ("!b wake up") and !b vibes. never gate mods here or the pause is a one-way door.
  if (runCtx.channel && !runCtx.isMod && isSuppressed(runCtx.channel, 'all')) return null

  return handler(args.trim(), runCtx)
}

export function resetDedup() {
  recentQueries.clear()
}

export function resetProxyCooldowns() {
  proxyCooldowns.clear()
  bFallbackCooldowns.clear()
}
