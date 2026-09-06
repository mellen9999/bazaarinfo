// trivia command surface: category/custom-topic routing, topic-string cleanup,
// person-dossier trivia, and the short queue that holds a topic while a round is live.
import type { CustomTrivia } from './ai-trivia'
import { generateCustomTrivia, generateChatTrivia, generatePersonTrivia, generateGameTrivia, generateLoreTrivia } from './ai-trivia'
import { buildLoreDossier, isKnownChatter } from './lore'
import { detectGameTopic, buildGameDossier } from './trivia-game-topic'
import { registerStateProvider } from './bot-state'
import { isSuppressed, remainingMinutes } from './suppress'
import { aiTriviaEnabled, AI_VIP, isUserOverDailyAiCap, noteUserAiRequest } from './ai-cache'
import { userStandingLine } from './ai-build-user'
import { getChannelSnapshotLine } from './twitch-profile'
import { findEmote } from './emotes'
import { getRecent } from './chatbuf'
import { log } from './log'
import * as db from './db'
import { startTrivia, startCustomTrivia, getTriviaScore, formatStats, isGameActive, skipTrivia, recentQuestionList, isRecentQuestion, recentAnswerList, isRecentAnswer, startKrippTrivia, startFallbackTrivia, startQuizCultureTrivia, setRoundEndHook } from './trivia'
import type { CommandContext, CommandHandler } from './commands'
import { withSuffix } from './commands-reply'
import { bannedTriviaTopic, triviaBanStateLine, onSuppressClearQueue } from './commands-mod'

// 'bg' / 'battlegrounds' / 'hearthstone' all mean the same round — chat types all three
const TRIVIA_CATEGORIES = new Set(['items', 'heroes', 'monsters', 'kripp', 'bg', 'bgs', 'battlegrounds', 'hearthstone', 'hs', 'guildrun', 'gr'])
const TRIVIA_CATEGORY_ALIASES: Record<string, string> = {
  bgs: 'bg', battlegrounds: 'bg', hearthstone: 'bg', hs: 'bg', gr: 'guildrun',
}

// custom-topic generation is async + costs an API call — guard against concurrent
// builds (one per channel) and a fast-fire loop that would burn calls without ever
// starting a round (e.g. repeatedly feeding a topic the model refuses).
const CUSTOM_GEN_CD = 8_000
const customPending = new Set<string>()
const customGenCooldown = new Map<string, number>()

// chatters pepper topics with emotes ("birds Birdge 🐦", "Crowge the rookery") — those
// are participation noise, not part of the topic, and they tank generation. strip unicode
// emoji/pictographs first, then drop any whitespace token that resolves to a known 7tv/
// twitch emote name. if nothing real survives, keep the original trimmed input so a lone
// emote name can still be its own topic rather than a dead miss.
// invisible/format chars chat injects (zero-width, bidi controls, soft hyphen, the
// combining grapheme joiner U+034F, Hangul fillers). stripped so a topic like "sex" with a
// trailing U+034F becomes just "sex" instead of junk — without touching real letters/accents.
const INVISIBLE_RE = /[\p{Cf}\u034F\u115F\u1160\u3164\uFFA0]/gu

function stripEmotesFromTopic(topic: string): string {
  const noEmoji = topic.replace(INVISIBLE_RE, '').replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}️‍]/gu, ' ')
  const tokens = noEmoji.split(/\s+/).filter(Boolean)
  const kept = tokens.filter((tok) => !findEmote(tok))
  return kept.length ? kept.join(' ') : topic.trim()
}

// natural phrasing puts a connector before the subject ("trivia ON cat", "trivia
// ABOUT birds"). left in, it derails the model — "on cat" yielded an "on'yomi"
// (Japanese reading) question instead of cats. strip a single leading connector so
// the topic is just the subject. only the unambiguous-connector words, so a real
// title that opens with "of"/"for" survives.
export function stripTopicConnector(topic: string): string {
  // drop a leftover "me" from "quiz me about X" / "trivia me X", then one connector.
  const stripped = topic.trim()
    .replace(/^me\s+/i, '')
    .replace(/^(?:on|about|regarding|concerning|covering)\s+/i, '')
    .trim()
  return stripped.length >= 2 ? stripped : topic.trim()
}

// strip a trailing "framing" clause that states WHY the round is being run, not WHAT it's
// about — "...to see if kripp can answer", "...so chat can guess", "...and see who knows".
// these address the audience, not the subject; left in they (a) derail the topic model and
// (b) leak a name (a streamer handle) that hijacks routing — the literal Romania->kripp-D3
// bug. only cuts at an unambiguous testing/purpose marker so a real title survives ("how to
// train your dragon", "to kill a mockingbird" — neither uses see/test/stump/etc.).
const TOPIC_FRAMING_RE = /\s+\b(?:to\s+(?:see|test|check|find\s+out|prove|stump|quiz|challenge)|(?:let'?s\s+|and\s+)?see\s+(?:if|who|whether|how)|so\s+(?:we|i|chat|that|everyone|you|u|kripp)\b)\b[\s\S]*$/i
export function stripTopicFraming(topic: string): string {
  const stripped = topic.replace(TOPIC_FRAMING_RE, '').trim()
  return stripped.length >= 2 ? stripped : topic.trim()
}

// "trivia about chat / the last 5 min / what we just talked about" — the topic is the
// conversation itself, so the question is built from the recent chat log, not a subject.
// must be RECALL intent: a bare "chat"/"the chat" topic or an explicit "last N min /
// recent messages / what we said" phrase. a qualified topic ("Kripp chat", "twitch chat",
// "4chan") is a SUBJECT for deep-lore custom trivia, not a request to quiz the chat log.
const CHAT_TRIVIA_RE = /^(?:the |this |our |these )?(?:chat|conversation|convo|messages?|msgs?)$|\b(?:the )?last \d+\s*(?:min|minute|sec|second|message|msg)s?\b|\brecent (?:chat|messages?|msgs?|convo)\b|\bwhat (?:we|you|i|us|chat|y'?all|everyone) (?:just |were |been )?(?:talk|talked|said|saying|discuss|chatted|wrote)|\bthis (?:stream|conversation)\b/i

// a kripp-subject topic -> route to the curated verified kripp pack (in kripp channels).
// kripp/octavian must LEAD the topic — it's the SUBJECT ("kripp", "kripp's d3 runs",
// "kripparrian lore"), not merely mentioned somewhere inside it ("Romania to see if kripp
// can answer", where kripp is the audience). anchoring to the start is what separates
// subject from incidental mention, so an off-topic ask never gets hijacked to the streamer
// pack — the framing strip above is the first line of defense, this anchor is the backstop.
// the optional "nl" prefix catches the channel's own login form ("nl_kripp"/"nl kripp") —
// that IS the kripp subject, but without it the handle drops into the AI pipeline, drifts
// off-subject, and dead-ends in a generic fallback question.
const KRIPP_TOPIC_RE = /^(?:the\s+)?(?:nl[_\s]?)?(?:kripp(?:a|arrian|arian|errian)?|octavian)\b/i

// pull the recent chat log for chat-trivia: drop the bot's own lines + empties,
// strip a leading command trigger so messages read naturally.
function recentChatLines(channel: string): string[] {
  const botName = (process.env.TWITCH_USERNAME ?? 'bazaarinfo').toLowerCase()
  return getRecent(channel, 40)
    .filter((m) => m.kind !== 'event' && m.user.toLowerCase() !== botName)
    .map((m) => `${m.user}: ${m.text.replace(/^!\w+\s*/, '').replace(/\n/g, ' ').trim()}`)
    .filter((l) => l.split(': ').slice(1).join(': ').trim().length > 0)
}

// "trivia about @someone" -> a person target. an explicit @mention is the only trigger,
// so real-world topics ("birds", "napoleon") are never hijacked. the captured group is
// the bare twitch handle. one token only — "@a b c" isn't a username.
const PERSON_TOPIC_RE = /^@([a-z0-9_]{2,25})$/i

// chat writes handles bare — "!trivia about hamstornado", no @. a single-token topic that
// matches someone who's been chatting HERE in the last few hours is a person ask, not a
// world-knowledge subject: the topic model knows nothing about them, so it nulls out and
// the round dead-ends in a labelled random substitute. gated three ways so a real subject
// is never hijacked — game content wins first, the name must be recently active in THIS
// channel, and there must be a real dossier; anything short of all three falls through to
// the normal topic path.
const BARE_NAME_RE = /^[a-z0-9_]{3,25}$/i
// isKnownChatter lives in lore.ts — the lore gate needs the same "would chat recognise this
// name" test, and it must mean exactly one thing.

// on the `!b` path, @mentions are stripped out of the command text before dispatch (they
// survive only in the suffix tag), so "!b trivia about @x" reaches us as topic "about".
// a leftover bare connector like this, paired with a mention, IS the person intent —
// "trivia about cats" keeps its topic, "trivia about @x" loses it to the tag.
const PERSON_CONNECTOR_RE = /^(?:about|on|for|regarding|concerning|covering)$/i

// the emote a chatter spams most — their signature. a regular who watches them KNOWS
// this, so it makes the fairest, most-fun person-trivia question. counted exactly (the
// model can't reliably eyeball "most-used" from a sample), needs >=2 uses to be a habit.
function signatureEmote(messages: string[]): string | null {
  const counts = new Map<string, number>()
  for (const m of messages) {
    for (const tok of m.split(/\s+/)) {
      const e = findEmote(tok)
      if (e) counts.set(e, (counts.get(e) ?? 0) + 1)
    }
  }
  let best: string | null = null
  let bestN = 1 // a one-off isn't a signature
  for (const [e, n] of counts) if (n > bestN) { best = e; bestN = n }
  return best
}

// assemble what we've logged about a chatter into a compact dossier for the person-trivia
// model. only in-channel data we already store. leads with OBSERVABLE persona — signature
// emote, main item, AI-extracted facts — the things a regular who watches them could
// actually answer; hidden stats come last. returns null if the profile is too thin to make
// a fair question, so the caller misses honestly instead of inventing. gated on the message
// sample, not a users-table row, so a chat-only regular (never runs a command) still counts.
function buildPersonDossier(username: string, channel: string): string | null {
  const msgs = db.getUserMessages(username, channel, 80)
  const sample = msgs
    .map((m) => m.replace(/\n/g, ' ').trim())
    .filter((m) => m.length > 0 && m.length <= 120 && !m.startsWith('!'))
    .slice(0, 25)
  const facts = db.getUserFacts(username, 6)
  if (facts.length === 0 && sample.length < 6) return null // too thin to be fair

  const lines: string[] = []
  const sig = signatureEmote(msgs)
  if (sig) lines.push(`signature emote (their most-spammed): ${sig}`)
  // the twitch record: badges (sub months, gifts, bits, roles), resubs/gifts/raids they
  // did, how long and how much they've chatted here, their own channel if fetched
  // every read here is optional colour — a missing table or a cold cache costs the line,
  // never the round
  try {
    const standing = userStandingLine(username, channel)
    if (standing) lines.push(`twitch standing: ${standing}`)
    const chat = db.getUserChatProfile(username, channel)
    if (chat) {
      // chat_messages is pruned at 180 days: an old regular's "first seen" is the prune
      // horizon, not their arrival — say the window, not a false start date. peak hour needs
      // a real sample or it's noise.
      const ageDays = (Date.now() - new Date(chat.firstSeen + 'Z').getTime()) / 86_400_000
      const span = ageDays > 170 ? 'in the last 6 months (older lines are pruned)' : `since ${chat.firstSeen.slice(0, 7)}`
      const peak = chat.peakHourUtc === null || chat.messages < 30 ? '' : `, most active around ${String(chat.peakHourUtc).padStart(2, '0')}:00 UTC`
      lines.push(`chat history: ${chat.messages} messages logged here ${span}${peak}`)
    }
    const own = getChannelSnapshotLine(username)
    if (own) lines.push(`their channel: ${own}`)
    const tw = db.getCachedTwitchUser(username)
    if (tw?.account_created_at) lines.push(`twitch account ${db.formatAccountAge(tw.account_created_at)}`)
    const fol = db.getCachedFollowage(username, channel)
    if (fol?.followed_at) lines.push(`following #${channel} since ${db.formatAccountAge(fol.followed_at).replace(' old', '')}`)
  } catch {}
  const stats = db.getUserStats(username, channel)
  if (stats?.favorite_item) lines.push(`most-looked-up item: ${stats.favorite_item}`)
  const tops = db.getUserTopItems(username, 4)
  if (tops.length) lines.push(`top items: ${tops.join(', ')}`)
  if (facts.length) lines.push(`facts: ${facts.join(' | ')}`)
  if (stats) {
    const t: string[] = []
    if (stats.trivia_wins) t.push(`${stats.trivia_wins} trivia wins`)
    if (stats.trivia_best_streak) t.push(`best streak ${stats.trivia_best_streak}`)
    if (stats.trivia_points) t.push(`${stats.trivia_points} trivia points`)
    if (t.length) lines.push(`trivia (hidden stats — last resort): ${t.join(', ')}`)
  }
  // their own messages — recurring words/topics the model can spot. last so persona leads.
  if (sample.length) lines.push(`recent messages:\n${sample.map((m) => `- ${m}`).join('\n')}`)

  const text = lines.join('\n')
  return text.length >= 20 ? text : null
}

// --- queued topics ---
//
// "a trivia round is already running — wait for it" promised something nothing delivered:
// the topic was dropped on the floor and the next round was whoever typed first after the
// reveal. Chat called it out ("where is wow trivia"). Now the topic is held and served the
// moment the round ends, which is what the message always said.
//
// Bounded hard on purpose. This channel gets a dozen !trivia a minute during a spree; a
// deep queue would spend the next ten minutes replaying topics nobody remembers asking
// about. Two deep, three minutes to live, first-come.
const QUEUE_MAX = 2
const QUEUE_TTL = 3 * 60_000
interface QueuedTopic { topic: string; user: string; at: number }
const topicQueue = new Map<string, QueuedTopic[]>()

function liveQueue(channel: string): QueuedTopic[] {
  const now = Date.now()
  const q = (topicQueue.get(channel) ?? []).filter((e) => now - e.at < QUEUE_TTL)
  if (q.length) topicQueue.set(channel, q)
  else topicQueue.delete(channel)
  return q
}

/**
 * Hold a topic for the next round.
 *
 * Returns the line to say back, or null to stay quiet. Quiet ONLY when the queue is
 * already full: during a spree a dozen people ask in one round, and answering all of them
 * "busy" is worse noise than saying nothing. We speak when we are making a promise.
 */
function queueTopic(channel: string, topic: string, user: string): string | null {
  const q = liveQueue(channel)
  const norm = topic.trim().toLowerCase()
  if (q.some((e) => e.topic.trim().toLowerCase() === norm)) {
    return `"${topic.slice(0, 30)}" is already queued — it's up after this round`
  }
  if (q.length >= QUEUE_MAX) return null
  q.push({ topic, user, at: Date.now() })
  topicQueue.set(channel, q)
  return q.length === 1
    ? `a round is already running — "${topic.slice(0, 30)}" is up next`
    : `a round is already running — "${topic.slice(0, 30)}" is queued (#${q.length})`
}

export function __queueDepthForTest(channel: string): number {
  return liveQueue(channel).length
}
export function __clearTopicQueueForTest(): void {
  topicQueue.clear()
}

// a mod pause must also drop the held topics — otherwise the queue fires two more
// rounds right after the "stop" (the promise those queue lines made is void now).
export function clearTopicQueue(channel: string): void {
  topicQueue.delete(channel)
}

/**
 * Run the next queued topic. Wired to trivia's round-end hook, so it fires once per round.
 *
 * Everything a typed request goes through, a queued one goes through too — mod bans can
 * land mid-round, and a banned topic must not sneak in through the queue.
 */
async function drainTopicQueue(channel: string): Promise<string | null> {
  const q = liveQueue(channel)
  const next = q.shift()
  if (!next) return null
  if (q.length) topicQueue.set(channel, q)
  else topicQueue.delete(channel)
  const ctx: CommandContext = { user: next.user, channel }
  try {
    const out = await handleCustomTrivia(ctx, next.topic, '')
    return out ? `@${next.user} ${out}` : null
  } catch {
    return null // a failed drain must never take the round-end path down with it
  }
}

setRoundEndHook(drainTopicQueue)

// bot-state introspection: expose the topic queue + mod topic bans (owned here) so a
// plain "what's queued / what's banned" gets a grounded answer. registered instead of
// imported by bot-state (commands -> ai-build -> bot-state would cycle).
registerStateProvider((channel) => {
  const q = liveQueue(channel)
  return q.length ? `trivia queue: ${q.map((e) => `"${e.topic.slice(0, 30)}" (by ${e.user})`).join(', ')}` : ''
})
registerStateProvider(triviaBanStateLine)

// a suppress/pause must clear any queued topic immediately (a stale queue entry must
// not fire after resume) — commands-mod.ts owns applySuppress but calling clearTopicQueue
// directly would cycle (it needs bannedTriviaTopic from here), so it's registered instead.
onSuppressClearQueue(clearTopicQueue)
async function handleCustomTrivia(ctx: CommandContext, topic: string, suffix: string): Promise<string | null> {
  const channel = ctx.channel
  if (!channel) return null
  let t = stripTopicFraming(stripTopicConnector(stripEmotesFromTopic(topic.trim())))
  // need a real topic with at least one alphanumeric char; cap length before the API call.
  if (t.length < 2 || !/[a-z0-9]/i.test(t)) return null
  // "trivia about trivia" — a bare meta-topic gives the generator nothing to ground on
  // and it spirals. it's also common enough to earn a grounded source: serve from the
  // curated quiz-culture pack below (zero AI calls, verified facts); the rewrite here
  // is only the AI fallback subject once the channel has seen the fresh pack questions.
  const isMetaTopic = /^(?:a |the |this |some |more )?(?:trivia|quiz|quizz?es|trivias)(?:\s+(?:game|round|question|q))?$/i.test(t)
  if (isMetaTopic) {
    t = 'trivia and quiz culture — game shows, jeopardy, quiz history, famous trivia facts'
  }
  if (isGameActive(channel)) {
    // hold it rather than dropping it — the reply below is a promise, and drainTopicQueue
    // is what makes it true
    const held = queueTopic(channel, t, ctx.user ?? 'chat')
    return held ? withSuffix(held, suffix) : null
  }
  // mod topic bans — enforced here so every entry path (about-form, topic-first,
  // NL-verb form) hits the same wall.
  const bannedKey = bannedTriviaTopic(channel, t)
  if (bannedKey) {
    return withSuffix(`${bannedKey} trivia is under mod embargo — pick another topic`, suffix)
  }
  // meta-topic -> curated quiz-culture pack first (grounded, instant, no API). placed
  // after the mod-ban wall, before the pending/cooldown gates (no AI call to guard).
  if (isMetaTopic) {
    const qc = startQuizCultureTrivia(channel)
    if (qc) return withSuffix(qc, suffix)
  }
  // kripp-subject topics -> the curated, web-verified kripp pack. the AI fact-checker
  // can't confirm niche streamer lore so the AI path would just NULL out; the pack is the
  // verified, always-lands source. null when not a kripp channel/empty pack -> AI fallback.
  if (KRIPP_TOPIC_RE.test(t)) {
    const kr = startKrippTrivia(channel)
    if (kr) return withSuffix(kr, suffix)
  }
  // AI-written topics are off (AI_TRIVIA unset) — everything past this point costs tokens.
  // say so plainly and still start a real round: the miss messages below ("couldn't cook
  // one", "try again", "let it cook") all imply a retry that will never work.
  if (!aiTriviaEnabled()) {
    return withSuffix(`custom topics are off — bazaar round instead: ${startTrivia(channel)}`, suffix)
  }
  // a custom round fans out to ~a dozen generate/verify calls, so it bills 10 units
  // against the asker's daily AI budget — one person gets a handful of rounds a day,
  // not four unattended days of them. falls back to a free deterministic round.
  if (ctx.user && !AI_VIP.has(ctx.user.toLowerCase())) {
    if (isUserOverDailyAiCap(ctx.user)) {
      return withSuffix(`you're out of ai budget today — bazaar round instead: ${startTrivia(channel)}`, suffix)
    }
    noteUserAiRequest(ctx.user, 10)
  }
  // busy, but not with a round the asker can see: a generation is in flight, or we are
  // inside the post-generation cooldown. This used to `return null` — total silence — and
  // it is what ate "!trivia mellen" while a duke-nukem round was still cooking. From the
  // asker's side it is the same situation as a live round, so it gets the same answer.
  const last = customGenCooldown.get(channel) ?? 0
  if (customPending.has(channel) || Date.now() - last < CUSTOM_GEN_CD) {
    const held = queueTopic(channel, t, ctx.user ?? 'chat')
    return held ? withSuffix(held, suffix) : null
  }

  const isChatTrivia = CHAT_TRIVIA_RE.test(t)
  // "trivia about @someone" -> quiz chat on that person, grounded in what we've logged
  // about them. checked before the generic-topic path so a username never reaches the
  // topic model (which knows nothing about them and drifts to an unrelated question).
  // the @ may survive in the topic (top-level !trivia) or only in the suffix tag (!b).
  const mention = suffix.match(/@(\w{2,25})/)?.[1] ?? null
  // resolved once — both the bare-handle gate below and the game-data branch need it.
  const gameTopic = isChatTrivia ? null : detectGameTopic(t)
  let person: string | null = null
  let personDossier: string | null = null
  if (!isChatTrivia) {
    const pm = t.startsWith('@') ? t.match(PERSON_TOPIC_RE) : null
    if (pm) person = pm[1]
    else if (mention && PERSON_CONNECTOR_RE.test(t)) person = mention
    // a dangling connector with no target ("trivia about" alone) has nothing to quiz on —
    // don't feed the bare word to the topic model (it drifts to a nonsense question).
    else if (PERSON_CONNECTOR_RE.test(t)) return null
    else if (BARE_NAME_RE.test(t) && !gameTopic && isKnownChatter(t, channel)) {
      const d = buildPersonDossier(t, channel)
      if (d) {
        person = t
        personDossier = d
      }
    }
  }

  customPending.add(channel)
  try {
    let q: CustomTrivia | null
    let missMsg: string
    if (isChatTrivia) {
      const avoid = recentQuestionList(channel)
      const avoidAnswers = recentAnswerList(channel)
      q = await generateChatTrivia(recentChatLines(channel), channel, avoid, avoidAnswers)
      // reworded repeat (same answer) = free points for whoever just saw it — regenerate once
      if (q && (isRecentQuestion(channel, q.question) || isRecentAnswer(channel, q.answer))) {
        q = await generateChatTrivia(recentChatLines(channel), channel, avoid, avoidAnswers)
        if (q && (isRecentQuestion(channel, q.question) || isRecentAnswer(channel, q.answer))) q = null
      }
      missMsg = `not enough fresh chat to make a trivia about yet — let it cook`
    } else if (person) {
      const dossier = personDossier ?? buildPersonDossier(person, channel)
      if (!dossier) {
        return withSuffix(`don't know enough about @${person} yet to quiz on — they gotta chat more`, suffix)
      }
      const avoid = recentQuestionList(channel)
      const avoidAnswers = recentAnswerList(channel)
      q = await generatePersonTrivia(dossier, `@${person}`, channel, avoid, avoidAnswers)
      // same-answer repeat about the same person = point farming (ask, answer, re-ask) —
      // retry once for a different fact, then refuse instead of serving the farm
      if (q && (isRecentQuestion(channel, q.question) || isRecentAnswer(channel, q.answer))) {
        q = await generatePersonTrivia(dossier, `@${person}`, channel, avoid, avoidAnswers)
        if (q && (isRecentQuestion(channel, q.question) || isRecentAnswer(channel, q.answer))) {
          return withSuffix(`just asked that one about @${person} — no reruns, they need new material first`, suffix)
        }
      }
      missMsg = `couldn't make a trivia about @${person} — try again`
    } else {
      // pass recent questions AND answers so the model avoids repeats up front; if it still
      // echoes a recent question OR lands on a recent answer (same fact reworded), regenerate
      // — up to 2 retries — before giving up on uniqueness.
      const avoid = recentQuestionList(channel)
      const avoidAnswers = recentAnswerList(channel)
      // a topic naming GAME content (a hero, item, monster, tag, "the bazaar") never goes
      // to the world-knowledge model — the game postdates its knowledge and changes every
      // patch, so it can only fabricate or null out. generate from the live card cache
      // instead; on a miss, serve a real bazaar round rather than an off-game substitute.
      if (gameTopic) {
        const dossier = buildGameDossier(gameTopic)
        q = dossier ? await generateGameTrivia(dossier, t, channel, avoid, avoidAnswers) : null
        if (q && dossier && (isRecentQuestion(channel, q.question) || isRecentAnswer(channel, q.answer))) {
          q = await generateGameTrivia(dossier, t, channel, avoid, avoidAnswers)
        }
        if (!q) {
          return withSuffix(`couldn't cook that exact one — bazaar question instead: ${startTrivia(channel)}`, suffix)
        }
        return withSuffix(startCustomTrivia(channel, q), suffix)
      }
      // a topic that is this channel's OWN in-joke ("the tidolar crime family") is not
      // world knowledge — the model has never heard of it and invents a plausible-sounding
      // answer nobody in chat can win. ask our log instead. the gate is deliberately tight
      // (see lore.ts): when it doesn't fire we drop straight through to the world path
      // below unchanged, so a real world topic is never hijacked.
      const lore = buildLoreDossier(t, channel)
      if (lore) {
        const lq = await generateLoreTrivia(lore.text, t, channel, avoid, avoidAnswers)
        if (lq && !isRecentQuestion(channel, lq.question) && !isRecentAnswer(channel, lq.answer)) {
          return withSuffix(startCustomTrivia(channel, lq), suffix)
        }
        // do NOT fall through to the world model. the gate that got us here means this is
        // chat's own in-joke, and the world model has nothing true to say about one — it
        // fabricates, confidently, which is the whole reason this path exists. same call
        // the game path makes: a real bazaar round, labeled, rather than an invention.
        log(`trivia: lore round for "${t}" produced nothing — serving a bazaar round instead`)
        return withSuffix(`couldn't cook that exact one — bazaar question instead: ${startTrivia(channel)}`, suffix)
      }
      // the freshness gate is handed DOWN rather than applied here: a round verifies
      // several candidates and ships one, so a repeat is answered by walking to the next
      // already-verified survivor. re-running the pipeline (the old 2-retry loop) cost up
      // to 111 API calls for a single round and produced nothing the first round hadn't.
      q = await generateCustomTrivia(t, channel, avoid, avoidAnswers, (cand) =>
        isRecentQuestion(channel, cand.question) || isRecentAnswer(channel, cand.answer))
      // a world-knowledge topic must NEVER dead-end. if the AI couldn't make one (niche
      // subject the verifier won't confirm, daily cap, no key, API hiccup), fall back to a
      // curated, always-true question so chat still gets a round — but LABEL it as a random
      // substitute. silently serving an unrelated question reads as "the bot ignored my
      // topic"; saying so up front keeps it honest (and still never dead-ends).
      if (!q) {
        const fb = startFallbackTrivia(channel)
        if (!fb) return withSuffix(`trivia's catching its breath — try again in a sec`, suffix)
        return withSuffix(`couldn't cook one about "${t.slice(0, 40)}" — random one instead: ${fb}`, suffix)
      }
      return withSuffix(startCustomTrivia(channel, q), suffix)
    }
    if (!q) return withSuffix(missMsg, suffix)
    return withSuffix(startCustomTrivia(channel, q), suffix)
  } finally {
    customPending.delete(channel)
    const now = Date.now()
    customGenCooldown.set(channel, now)
    if (customGenCooldown.size > 200) {
      for (const [k, v] of customGenCooldown) if (now - v > CUSTOM_GEN_CD) customGenCooldown.delete(k)
    }
  }
}
// single trivia router shared by `!trivia ...` and `!b trivia ...`. handles the
// built-in subcommands (score/skip/stats/category), then treats anything else as a
// custom AI topic.
export async function runTrivia(ctx: CommandContext, rawArg: string, suffix: string): Promise<string | null> {
  if (!ctx.channel) return null
  const arg = rawArg.trim()
  const lower = arg.toLowerCase()
  // mod pause: block round STARTS early (a custom topic burns ~a dozen AI calls before
  // hitting the launchRound wall). score/skip/stats stay live — they're not rounds.
  if (isSuppressed(ctx.channel, 'trivia') && !/^(?:score|skip|stats?\b)/i.test(lower)) {
    return withSuffix(`trivia is paused by mods — back in ~${remainingMinutes(ctx.channel, 'trivia')}m`, suffix)
  }
  // bare `!b trivia` arrives as the literal "trivia" (subcommand dispatcher falls back
  // to cleanArgs when no group captured) — treat it, like an empty arg, as a random round.
  if (!arg || lower === 'trivia') return withSuffix(startTrivia(ctx.channel), suffix)
  if (lower === 'score') return withSuffix(getTriviaScore(ctx.channel), suffix)
  if (lower === 'skip') {
    const msg = skipTrivia(ctx.channel, ctx.user)
    return msg ? withSuffix(msg, suffix) : null
  }
  if (lower === 'stats' || lower.startsWith('stats ')) {
    const target = lower.replace(/^stats\s*@?/, '').trim() || ctx.user
    if (!target) return null
    return withSuffix(formatStats(target, ctx.channel), suffix)
  }
  if (TRIVIA_CATEGORIES.has(lower)) {
    const cat = (TRIVIA_CATEGORY_ALIASES[lower] ?? lower) as 'items' | 'heroes' | 'monsters' | 'kripp' | 'bg' | 'guildrun'
    return withSuffix(startTrivia(ctx.channel, cat), suffix)
  }
  return await handleCustomTrivia(ctx, arg, suffix)
}

export const triviaCommand: CommandHandler = (args, ctx) => runTrivia(ctx, args, '')
