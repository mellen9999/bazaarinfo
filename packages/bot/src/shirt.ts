import { createHash } from 'crypto'

import { log } from './log'
import { anthropicCall } from './ai-http'
import * as db from './db'
import type { ShirtLook } from './db'
import { AI_CHANNELS, getStreamInfo, isChannelLive, isLiveStateKnown } from './ai-cache'
import { familiesIn, toFamily } from './shirt-colour'

// chat bets on what colour shirt kripp is wearing. the bot could never see the stream, so it
// had nothing to say. this reads frames of the broadcast — the Twitch thumbnail that already
// rides along in the /helix/streams poll — through a cheap vision call, and keeps every look
// as a row, so the outfit is TRACKED: what he started in, what he changed into, what he wore
// the last twenty streams.
//
// the whole design is about spending as little as possible and never guessing:
//   * zero extra Twitch requests — thumbnail_url is in the poll response we already make.
//   * a handful of vision calls per broadcast: an intro phase that stops the moment a read is
//     confident, one look at the end of the intro, then a check an hour, with a hard budget.
//   * timed at the intro. kripp opens fullscreen facecam for ~10 minutes before shrinking to
//     the bottom-left inset, so the first attempts land while the shirt fills the frame — and
//     the intro is worn in a ROBE, so the look at fifteen minutes is the one that catches the
//     actual shirt.
//   * a thumbnail whose bytes we have already seen is the PREVIOUS broadcast's frame still on
//     the CDN — reading it would report yesterday's shirt with total confidence. hashed and
//     skipped, and the hashes are stored so a restart between streams still refuses it.
//   * a change is never announced off one frame. a confident read that disagrees with the
//     current outfit gets a confirm look three minutes later; two agreeing reads make a
//     change, one is a reaction clip.
//   * a low-confidence read is stored, shown as provisional, and never presented as fact. no
//     read at all means the bot says it hasn't had a look.
//
// nothing in memory decides anything: the outfit, its changes and each broadcast's colour are
// derived from the rows (outfitTimeline / broadcastShirt), so a restart mid-stream lands in
// exactly the state it left.

const MODEL = 'claude-haiku-4-5-20251001'
// 1280x720 is ~1230 image tokens (w*h/750). the inset cam is still ~200px wide there, and
// doubling to 1080p quadruples the token bill for detail a colour question does not need.
const THUMB_W = 1280
const THUMB_H = 720
const FETCH_TIMEOUT_MS = 8_000
const CALL_TIMEOUT_MS = 20_000
const MAX_BYTES = 4 * 1024 * 1024

// a read this sure opens (or confirms) an outfit segment.
export const LOCK_CONFIDENCE = 0.8
// below this the model is describing noise, not a shirt. discarded, not stored.
const MIN_CONFIDENCE = 0.35

// --- intro phase: until the first confident read ---
const MAX_INTRO_TRIES = 6
const RETRY_MS = 3 * 60_000
// a look that never reached the model (CDN blip, stale frame) costs nothing, so it is
// refunded rather than burning a try — but not forever, or a channel whose preview is
// permanently broken would re-fetch every minute for a twelve-hour stream.
const MAX_FREE = 10
const FREE_RETRY_MS = 60_000
// a fresh broadcast's first attempt: late enough that the CDN has a frame from THIS stream,
// early enough to be inside the fullscreen-cam intro.
const FIRST_ATTEMPT_MS = 3 * 60_000
// past this the thumbnail is unambiguously current, so a bot that started mid-broadcast
// attempts immediately instead of waiting out a delay meant for a stream that just began.
// it is also when the intro is over and the cam has shrunk to the inset: the first look
// after the lock lands here, because the intro robe is not the shirt.
const MIDSTREAM_MS = 15 * 60_000
const POST_INTRO_MS = MIDSTREAM_MS

// --- cruise phase: after the intro ---
const RECHECK_MS = 60 * 60_000
const CONFIRM_MS = 3 * 60_000
// recheck + confirm. a rolling budget instead of a flat cap, so a fourteen-hour stream is
// still tracked at hour thirteen instead of frozen on the shirt from hour six.
const CRUISE_PER_HOUR = 2
const HOUR_MS = 60 * 60_000
// a confident outfit whose cam hasn't been seen this long is stated with its age.
const STALE_MS = 90 * 60_000

// how many past broadcasts the history looks back over, and how many it lists by name.
const HISTORY_BROADCASTS = 20
const HISTORY_LISTED = 10

// garments worn OVER a shirt — a robe's colour is never the shirt's colour, and a broadcast
// that has a shirt segment at all never gets its robe segment as the answer.
const OUTER = new Set(['robe', 'jacket'])
const GARMENTS = new Set(['t-shirt', 'shirt', 'hoodie', 'sweater', 'jacket', 'robe', 'tank', 'jersey', 'other'])

// db reads are wrapped: a query-time throw here would take the whole answer down, and a
// shirt line is never worth that. every caller treats a miss as "no data".
function safe<T>(fn: () => T, fallback: T): T {
  try { return fn() } catch { return fallback }
}

export interface ShirtRead {
  color: string
  hex: string
  confidence: number
  garment: string
  /** where the model says it found the streamer — logged, so a run of bad reads is diagnosable. */
  where: string
}

interface Watch {
  startedAt: number
  /** this broadcast's stored reads, oldest first. seeded from the db, appended per read. */
  looks: ShirtLook[]
  /** intro-phase vision calls spent. */
  tries: number
  /** looks that ended before the model saw anything — refunded, and capped. */
  free: number
  nextAt: number
  /** cruise-phase vision call times inside the rolling hour. */
  cruise: number[]
  /** outfit segments already announced — a restart must not re-announce an old change. */
  announced: number
  /** sha1 of every thumbnail already sent for this broadcast — plus recent broadcasts'. */
  seen: Set<string>
}

/**
 * When a broadcast gets its first look. A stream that just began waits out FIRST_ATTEMPT_MS
 * so the CDN is serving a frame from THIS broadcast (and so the look lands during the
 * fullscreen-cam intro); one already well underway — which is what a bot restart sees — is
 * looked at right away, because its thumbnail cannot be anything but current.
 */
export function firstAttemptAt(startedAt: number, now: number): number {
  return now - startedAt >= MIDSTREAM_MS ? now : startedAt + FIRST_ATTEMPT_MS
}

const watches = new Map<string, Watch>()
let inFlight = 0
let onChange: ((channel: string, text: string) => void) | null = null

/** a confirmed mid-stream change fires this with a transcript line — index.ts wires it to chatbuf. */
export function onShirtChange(fn: (channel: string, text: string) => void): void {
  onChange = fn
}

/** the odd shape a Twitch thumbnail template takes: .../live_user_x-{width}x{height}.jpg */
export function thumbUrl(template: string, w = THUMB_W, h = THUMB_H, now = Date.now()): string {
  const sized = template.replace(/\{width\}/g, String(w)).replace(/\{height\}/g, String(h))
  // the CDN caches aggressively and we are asking precisely because we want a NEW frame.
  return `${sized}${sized.includes('?') ? '&' : '?'}t=${now}`
}

/** only ever fetch an image from Twitch's own CDN, whatever the API hands us. */
export function isTwitchCdn(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && (u.hostname === 'jtvnw.net' || u.hostname.endsWith('.jtvnw.net'))
  } catch {
    return false
  }
}

// a colour a human would say out loud — "black", "dark blue", "black and white". anything
// else — a sentence, a refusal, an injected instruction — is not a colour and does not
// reach the prompt.
const COLOR_RE = /^[a-z]+(?:[ -][a-z]+)?(?: and [a-z]+)?$/
const HEX_RE = /^#[0-9a-f]{6}$/

export function parseShirtJson(raw: string | null): ShirtRead | null {
  if (!raw) return null
  const text = raw.replace(/```json?/gi, '').replace(/```/g, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let o: Record<string, unknown>
  try {
    o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
  if (o.visible === false) return null
  const color = typeof o.color === 'string' ? o.color.trim().toLowerCase() : ''
  if (!color || color.length > 24 || !COLOR_RE.test(color)) return null
  const conf = typeof o.confidence === 'number' && Number.isFinite(o.confidence)
    ? Math.max(0, Math.min(1, o.confidence))
    : 0
  if (conf < MIN_CONFIDENCE) return null
  const hexRaw = typeof o.hex === 'string' ? o.hex.trim().toLowerCase() : ''
  const whereRaw = typeof o.where === 'string' ? o.where.trim().toLowerCase() : ''
  const garmentRaw = typeof o.garment === 'string' ? o.garment.trim().toLowerCase().replace(/\s+/g, '-') : ''
  return {
    color,
    hex: HEX_RE.test(hexRaw) ? hexRaw : '',
    confidence: conf,
    garment: GARMENTS.has(garmentRaw) ? garmentRaw : 'other',
    where: whereRaw === 'inset' || whereRaw === 'fullscreen' ? whereRaw : '',
  }
}

// Finding the streamer is the whole problem, and it is not obvious. Verified against real
// live frames on 2026-09-06: an earlier prompt that just said "report the shirt colour" read
// a REACTION CLIP playing in the middle of the frame — it reported the grey t-shirt of the
// person in the TikTok being watched, at 0.95 confidence, while the streamer sat in the
// bottom-left corner in a red robe. Confidently wrong is the worst outcome for a bet, so the
// prompt spends its words on separating the webcam from the content. With these rules the
// same frame reads "red", and inset cams on three other live channels read correctly.
const PROMPT = [
  'This is one frame from a live Twitch stream. Report the colour of the shirt/top worn by THE STREAMER — the person who is broadcasting.',
  '',
  'FINDING THE STREAMER — this is the hard part, do it carefully:',
  '- The streamer is the person in the WEBCAM. The webcam is either a SMALL INSET panel (a separate rectangle, usually in a bottom corner, showing a room/desk, often with a headset, microphone, chair or shelves behind them) or, during a talking intro, the FULLSCREEN shot.',
  '- Everything else in the frame is CONTENT the streamer is showing: gameplay, or a video/clip that may itself contain people.',
  '- A large person in the middle of the frame is usually NOT the streamer. If they are in a car, outdoors, filming on a phone (tall vertical video, social-media like/comment/share icons, progress bar, subtitles), or in any setting that is not a streaming room, they are content being reacted to. NEVER report their clothing.',
  '- If both a webcam inset and a person in the content are visible, the INSET is the streamer.',
  '- If you cannot tell which person is the streamer, or no webcam/person is present, answer {"visible":false} and nothing else. Never guess.',
  '',
  'Then report:',
  '- "where": "inset" or "fullscreen" — where you found the streamer.',
  '- "garment": what the outermost visible top is, exactly one of: t-shirt, shirt, hoodie, sweater, jacket, robe, tank, jersey, other.',
  '- "color": the colour of that outermost visible top (a robe/jacket/hoodie worn over a shirt IS the top), one or two common words, lowercase: "black", "dark blue", "white", "grey", "red".',
  '- "hex": approximate sRGB hex of that garment.',
  '- "confidence": 0 to 1 for BOTH finding the right person and the colour. A tiny, dark or ambiguous cam deserves a low number.',
  'Respond with ONLY the JSON object, no prose and no markdown fences:',
  '{"visible":true,"where":"inset","garment":"t-shirt","color":"black","hex":"#1a1a1a","confidence":0.9}',
].join('\n')

async function fetchThumb(url: string): Promise<{ base64: string; type: string; hash: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return null
    // an offline (or just-ended) channel's preview 302s to Twitch's own placeholder, which
    // is a perfectly valid jpeg — verified live: GET live_user_<offline>-1280x720.jpg lands
    // on ttv-static/404_preview. sending that to the model is a guaranteed wasted call.
    if (/ttv-static\/404_preview/.test(res.url)) return null
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (type !== 'image/jpeg' && type !== 'image/png') return null
    const len = Number(res.headers.get('content-length') ?? 0)
    if (len > MAX_BYTES) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null
    return {
      base64: buf.toString('base64'),
      type,
      hash: createHash('sha1').update(buf).digest('hex'),
    }
  } catch {
    return null
  }
}

/** one vision call. null on any failure — the caller just tries again later. */
async function readShirt(channel: string, image: { base64: string; type: string }): Promise<ShirtRead | null> {
  const out = await anthropicCall({
    tag: 'shirt',
    channel,
    model: MODEL,
    maxTokens: 120,
    timeoutMs: CALL_TIMEOUT_MS,
    content: [
      { type: 'image', source: { type: 'base64', media_type: image.type, data: image.base64 } },
      { type: 'text', text: PROMPT },
    ],
  })
  return parseShirtJson(out)
}

// the two calls that leave the process, swappable so the schedule can be driven in tests
// without a network. production never touches this.
const io = { fetchThumb, readShirt }
export function setShirtIoForTests(over: Partial<typeof io> | null): void {
  io.fetchThumb = over?.fetchThumb ?? fetchThumb
  io.readShirt = over?.readShirt ?? readShirt
}

// --- the outfit, derived from the rows ---------------------------------------------------

export interface Segment {
  family: string
  /** colour and garment as the latest agreeing look described them. */
  color: string
  garment: string
  hex: string
  /** first and latest confident look of this outfit. */
  fromMs: number
  toMs: number
  looks: number
}

export interface Outfit {
  segments: Segment[]
  /** a confident read that disagrees with the current segment and has no second vote yet. */
  pending: Segment | null
}

function segmentOf(look: ShirtLook): Segment {
  return {
    family: toFamily(look.color, look.hex),
    color: look.color,
    garment: look.garment,
    hex: look.hex,
    fromMs: look.capturedAt,
    toMs: look.capturedAt,
    looks: 1,
  }
}

/**
 * The broadcast's outfit over time, from its looks (oldest first). The first confident look
 * opens the outfit. A later confident look of a different family is a CANDIDATE; the next
 * confident look decides — same family as the candidate confirms the change, same family as
 * the outfit means the candidate was one bad frame (a reaction clip) and it is dropped.
 * Provisional looks never open or close anything. A candidate with no verdict yet is
 * returned as pending, so the line can say "might have changed" instead of either lying.
 */
export function outfitTimeline(looks: ShirtLook[]): Outfit {
  const segments: Segment[] = []
  let pending: Segment | null = null
  for (const look of looks) {
    if (look.confidence < LOCK_CONFIDENCE) continue
    const seg = segmentOf(look)
    const cur = segments[segments.length - 1]
    if (!cur) {
      segments.push(seg)
      continue
    }
    if (seg.family === cur.family) {
      cur.color = seg.color
      cur.garment = seg.garment
      cur.hex = seg.hex
      cur.toMs = seg.toMs
      cur.looks++
      pending = null
      continue
    }
    if (pending && pending.family === seg.family) {
      seg.fromMs = pending.fromMs
      seg.looks = 2
      segments.push(seg)
      pending = null
      continue
    }
    pending = seg
  }
  return { segments, pending }
}

/** true when the cam keeps flipping between two families — a navy that reads black half the time. */
export function isFlapping(segments: Segment[]): boolean {
  const n = segments.length
  return n >= 3 && segments[n - 1].family === segments[n - 3].family
}

/**
 * THE shirt of a finished (or running) broadcast, for the history: the outfit worn longest,
 * where a segment lasts until the next one begins. A robe or jacket only counts when nothing
 * else was ever seen — chat bets on the shirt, and the intro robe is not it.
 */
export function broadcastShirt(looks: ShirtLook[]): Segment | null {
  const { segments } = outfitTimeline(looks)
  if (!segments.length) return null
  const inner = segments.filter((s) => !OUTER.has(s.garment))
  const pool = inner.length ? inner : segments
  let best: Segment | null = null
  let bestMs = -1
  for (const s of pool) {
    const i = segments.indexOf(s)
    const until = i + 1 < segments.length ? segments[i + 1].fromMs : s.toMs
    const ms = until - s.fromMs
    // ties go to the later outfit — it is what he ended the stream in.
    if (ms >= bestMs) {
      best = s
      bestMs = ms
    }
  }
  return best
}

// --- the schedule ------------------------------------------------------------------------

/** the next cruise look: the post-intro look if it hasn't happened, else an hour after the last. */
function nextCruiseAt(w: Watch, now: number): number {
  const last = w.looks.length ? w.looks[w.looks.length - 1].capturedAt : 0
  const postIntro = w.startedAt + POST_INTRO_MS
  if (last < postIntro) return Math.max(postIntro, now)
  return last + RECHECK_MS
}

function describe(seg: { color: string; garment: string }): string {
  return seg.garment && seg.garment !== 'other' ? `${seg.color} ${seg.garment}` : seg.color
}

function newWatch(ch: string, startedAt: number, prev: Watch | undefined, now: number): Watch {
  // carry the previous broadcast's thumbnail hashes forward — the CDN serving the old frame
  // is exactly the stale read this guards against. a cold start reads them back from the rows.
  const seen = prev ? prev.seen : new Set(safe(() => db.getSeenFrameHashes(ch, 2), [] as string[]))
  const looks = safe(() => db.getShirtLooks(ch, startedAt), [] as ShirtLook[])
  const outfit = outfitTimeline(looks)
  const w: Watch = {
    startedAt,
    looks,
    tries: looks.length,
    free: 0,
    nextAt: 0,
    cruise: [],
    announced: outfit.segments.length,
    seen,
  }
  // a restart mid-broadcast resumes where it was: an unconfirmed change gets its confirm look
  // now, a settled outfit waits for its next hourly check, a fresh broadcast waits for the intro.
  w.nextAt = outfit.pending ? now : outfit.segments.length ? nextCruiseAt(w, now) : firstAttemptAt(startedAt, now)
  return w
}

/**
 * Called from the /helix/streams poll for every live channel, once a minute. Decides on its
 * own whether this broadcast wants a look right now, and does nothing the vast majority of
 * the time. Fire-and-forget: never awaited by the poller, never throws.
 */
export function noteStreamThumb(channel: string, startedAt: number, template: string, now = Date.now()): void {
  const ch = channel.toLowerCase()
  if (!Number.isFinite(startedAt) || !template) return
  // spending on a channel whose bot cannot answer questions buys nothing.
  if (!AI_CHANNELS.has(ch)) return

  let w = watches.get(ch)
  if (!w || w.startedAt !== startedAt) {
    w = newWatch(ch, startedAt, w, now)
    watches.set(ch, w)
    // one broadcast per channel is all this map ever holds, but a channel the bot has since
    // parted should not sit here forever.
    for (const [k] of watches) if (k !== ch && !isChannelLive(k)) watches.delete(k)
  }

  if (now < w.nextAt) return
  // intro: until a confident read, or until the intro tries are gone (then the hourly cadence
  // keeps looking — a cam too small at minute three may be readable at hour two).
  const intro = !outfitTimeline(w.looks).segments.length && w.tries < MAX_INTRO_TRIES
  if (!intro) {
    w.cruise = w.cruise.filter((t) => now - t < HOUR_MS)
    if (w.cruise.length >= CRUISE_PER_HOUR) {
      w.nextAt = w.cruise[0] + HOUR_MS
      return
    }
  }
  // never let a fan-out of channels going live together stack up vision calls.
  if (inFlight > 0) return

  if (intro) w.tries++
  w.nextAt = now + RETRY_MS
  inFlight++
  const watch = w
  // a look that cost nothing gets its try back, so a flaky CDN can't quietly eat the whole
  // budget of a broadcast without the model ever being asked.
  const refund = () => {
    if (watch.free >= MAX_FREE) return
    watch.free++
    if (intro) watch.tries--
    watch.nextAt = now + FREE_RETRY_MS
  }

  void (async () => {
    try {
      const url = thumbUrl(template, THUMB_W, THUMB_H, now)
      if (!isTwitchCdn(url)) return
      const img = await io.fetchThumb(url)
      // the stream rolled over while this look was in flight: whatever this frame shows, it
      // cannot be attributed to a broadcast anymore. drop it — a look is cheap, a wrong row is not.
      if (watches.get(ch) !== watch) return
      if (!img) return refund()
      if (watch.seen.has(img.hash)) {
        // byte-identical to a frame we already have: the CDN has not refreshed since — the
        // exact case that would otherwise report the PREVIOUS broadcast's shirt.
        return refund()
      }
      watch.seen.add(img.hash)
      if (!intro) watch.cruise.push(now)
      const read = await io.readShirt(ch, img)
      if (watches.get(ch) !== watch) return
      if (!read) return
      const look: ShirtLook = {
        startedAt: watch.startedAt,
        capturedAt: now,
        color: read.color,
        garment: read.garment,
        hex: read.hex,
        confidence: read.confidence,
        cam: read.where,
        frameHash: img.hash,
      }
      db.recordShirtLook(ch, look)
      watch.looks.push(look)
      const outfit = outfitTimeline(watch.looks)
      const n = outfit.segments.length
      if (n > watch.announced) {
        // a confirmed change of outfit — never the first lock, and never a cam that keeps
        // flipping between two readings of the same shirt.
        if (watch.announced > 0 && !isFlapping(outfit.segments) && onChange) {
          onChange(ch, `* shirt changed: ${describe(outfit.segments[n - 2])} -> ${describe(outfit.segments[n - 1])}`)
        }
        watch.announced = n
      }
      // intro keeps knocking every three minutes; everything after the intro is on the cruise
      // cadence, with a confirm look pulled forward when a change is waiting on its second vote.
      watch.nextAt = outfit.pending ? now + CONFIRM_MS : !n && intro ? now + RETRY_MS : nextCruiseAt(watch, now)
      const state = !n ? 'provisional' : outfit.pending ? 'change pending confirm' : n > 1 ? `outfit ${n}` : 'locked'
      log(`shirt: #${ch} ${describe(read)}${read.hex ? ` ${read.hex}` : ''} (confidence ${read.confidence.toFixed(2)}${read.where ? `, ${read.where} cam` : ''}, ${intro ? `intro try ${watch.tries}` : 'recheck'}, ${state})`)
    } catch (e) {
      log(`shirt: #${ch} read failed — ${(e as Error)?.message ?? e}`)
    } finally {
      inFlight--
    }
  })()
}

/** the broadcast is over: forget its schedule. the rows keep everything worth keeping. */
export function noteStreamOffline(channel: string): void {
  watches.delete(channel.toLowerCase())
}

export function resetShirtWatchesForTests(): void {
  watches.clear()
  inFlight = 0
  onChange = null
  setShirtIoForTests(null)
}

// --- the ask -------------------------------------------------------------------------------

// "shirt" in this chat means exactly one thing, so the garment words fire on their own.
const GARMENT_RE = /\b(shirts?|t-?shirts?|hoodies?|sweaters?|jumpers?|robes?|jerseys?|tank ?tops?)\b/i
// what he's wearing / what colour is he today / fit check — only alongside a person or the day.
const WEARING_RE = /\b(wear(?:ing|s)?|wore|worn|dressed|outfit|fit check|drip)\b/i
const COLOR_WORD_RE = /\bcolou?rs?\b/i
const SUBJECT_RE = /\b(he|him|his|kripp\w*|krip|streamer|nl_?kripp)\b/i
const STANDALONE_RE = /\bcolou?r of the day\b/i

/** true when the query is asking what the streamer has on. */
export function isShirtQuery(query: string): boolean {
  if (GARMENT_RE.test(query) || STANDALONE_RE.test(query)) return true
  if ((WEARING_RE.test(query) || COLOR_WORD_RE.test(query)) && SUBJECT_RE.test(query)) return true
  return false
}

function ago(ms: number): string {
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

/** "14m in", "2h05m in" — an offset into the stream, never a wall clock. */
function sinceIn(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000))
  if (mins < 60) return `${mins}m in`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${h}h${m ? String(m).padStart(2, '0') + 'm' : ''} in`
}

function outerNote(seg: Segment): string {
  return OUTER.has(seg.garment) ? ` That is the outer layer — the shirt under it isn't visible.` : ''
}

interface PastShirt {
  startedAt: number
  shirt: Segment
}

/**
 * The history block, all from rows: what he wore the last streams newest-first, the counts
 * that are the odds, the current streak, and — when the ask names a colour — that colour's
 * record. Families, not raw words, so "navy" and "dark blue" are one line.
 */
export function historyBlock(past: PastShirt[], asked: string[] = []): string {
  const n = past.length
  if (n < 3) return ''
  const fams = past.map((p) => p.shirt.family)
  const counts = new Map<string, number>()
  for (const f of fams) counts.set(f, (counts.get(f) ?? 0) + 1)
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const pct = (c: number) => Math.round((c / n) * 100)
  let s = ''
  // the named list gives way to the asked colour's record — the budget holds one, not both.
  if (!asked.length) s += ` Last ${Math.min(n, HISTORY_LISTED)} streams newest-first: ${fams.slice(0, HISTORY_LISTED).join(' ')}.`
  s += ` Over ${n} streams: ${ranked.map(([f, c], i) => (i === 0 ? `${f} ${c} (${pct(c)}%)` : `${f} ${c}`)).join(', ')}.`
  let streak = 1
  while (streak < n && fams[streak] === fams[0]) streak++
  s += ` Streak: ${fams[0]} x${streak}.`
  if (streak < n) s += ` Last non-${fams[0]}: ${fams[streak]}, ${streak + 1} streams ago.`
  for (const f of asked.slice(0, 2)) {
    const c = counts.get(f) ?? 0
    if (!c) {
      s += ` ${f}: never in ${n} tracked streams.`
      continue
    }
    const idx = fams.indexOf(f)
    s += ` ${f}: ${c} of ${n} streams (${pct(c)}%), last ${idx === 0 ? 'stream' : `${idx + 1} streams ago`}.`
  }
  return s
}

const SRC = 'READ FROM THE LIVE CAM — real, not a guess'

/**
 * The injected context section — '' unless the query is shirt-shaped. Every branch is a
 * true statement about what the bot did or did not see, because "he's wearing black" when
 * nothing was read is the one failure that would poison a bet.
 */
export function getShirtLine(channel: string, query: string, now = Date.now()): string {
  if (!isShirtQuery(query)) return ''
  const ch = channel.replace(/^#/, '').toLowerCase()
  const info = getStreamInfo(ch)
  const live = isLiveStateKnown() && isChannelLive(ch)
  const startedAt = live ? info?.startedAt : undefined

  const recent = safe(() => db.getRecentShirtLooks(ch, HISTORY_BROADCASTS + 1), [] as ShirtLook[])
  const byStart = new Map<number, ShirtLook[]>()
  for (const l of recent) {
    const arr = byStart.get(l.startedAt)
    if (arr) arr.push(l)
    else byStart.set(l.startedAt, [l])
  }
  const w = watches.get(ch)
  const currentLooks = startedAt ? (w && w.startedAt === startedAt ? w.looks : byStart.get(startedAt) ?? []) : []
  // today's outfit is not "history" for the odds — it is the answer.
  const past: PastShirt[] = []
  for (const [s, looks] of byStart) {
    if (s === startedAt) continue
    const shirt = broadcastShirt(looks)
    if (shirt) past.push({ startedAt: s, shirt })
  }
  past.sort((a, b) => b.startedAt - a.startedAt)
  const hist = historyBlock(past.slice(0, HISTORY_BROADCASTS), familiesIn(query))

  if (startedAt) {
    const { segments, pending } = outfitTimeline(currentLooks)
    const n = segments.length
    if (n) {
      const cur = segments[n - 1]
      const now_ = isFlapping(segments)
        ? `${cur.family} or ${segments[n - 2].family} (the cam reads flip between the two)`
        : describe(cur)
      let s = `\nShirt watch (${SRC}): now ${now_}, seen ${ago(now - cur.toMs)}`
      if (n > 1) s += `; started in ${describe(segments[0])}, ${describe(cur)} since ${sinceIn(cur.fromMs - startedAt)}`
      if (pending) s += `; the latest look (${ago(now - pending.fromMs)}) hinted ${describe(pending)} — unconfirmed, say it might have changed`
      else if (now - cur.toMs > STALE_MS) s += `; the cam hasn't been checked since, so it may have changed`
      return `${s}.${outerNote(cur)} Chat bets on the shirt colour, so state it plainly.${hist}`
    }
    if (currentLooks.length) {
      const best = currentLooks.reduce((a, b) => (b.confidence > a.confidence ? b : a))
      return `\nShirt watch — best look so far this stream says ${describe(best)}, but the cam was small/unclear and you are NOT confident. Say that it looks like ${best.color} and that you are not sure yet. Never state it as fact.${hist}`
    }
    return `\nShirt watch — you have NOT gotten a clear look at the cam this stream yet (still checking). Say so plainly; do NOT guess a colour.${hist}`
  }
  const last = past[0]
  if (last) {
    return `\nShirt watch — ${ch} is offline. Last stream (${ago(now - last.startedAt)}) he wore ${describe(last.shirt)} (${SRC}).${hist}`
  }
  return `\nShirt watch — no shirt reading exists yet (the bot reads it from the stream once he's live). Say so, don't guess.`
}
