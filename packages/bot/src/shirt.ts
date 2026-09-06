import { createHash } from 'crypto'

import { log } from './log'
import { anthropicCall } from './ai-http'
import * as db from './db'
import { AI_CHANNELS, getStreamInfo, isChannelLive, isLiveStateKnown } from './ai-cache'

// chat bets on what colour shirt kripp is wearing. the bot could never see the stream, so
// it had nothing to say. this reads ONE frame per broadcast — the Twitch thumbnail that
// already rides along in the /helix/streams poll — through a single cheap vision call, and
// locks the answer in for the rest of the stream.
//
// the whole design is about spending as little as possible and never guessing:
//   * zero extra Twitch requests — thumbnail_url is in the poll response we already make.
//   * one vision call per broadcast on the happy path. attempts stop the moment a read is
//     confident, and are hard-capped either way.
//   * timed at the intro. kripp opens fullscreen facecam for ~10 minutes before shrinking
//     to the bottom-left inset, so the first attempts land while the shirt fills the frame.
//   * a thumbnail whose bytes we have already seen is the PREVIOUS broadcast's frame still
//     on the CDN — reading it would report yesterday's shirt with total confidence. hashed
//     and skipped, which also means it costs nothing.
//   * a low-confidence read is stored as provisional and upgraded by a later attempt; it is
//     never presented as fact. no read at all means the bot says it hasn't had a look.
//
// the read is stored per (channel, started_at), so it survives a restart and builds the
// history that makes the bet interesting — what he wore the last twenty streams.

const MODEL = 'claude-haiku-4-5-20251001'
// 1280x720 is ~1230 image tokens (w*h/750). the inset cam is still ~200px wide there, and
// doubling to 1080p quadruples the token bill for detail a colour question does not need.
const THUMB_W = 1280
const THUMB_H = 720
const FETCH_TIMEOUT_MS = 8_000
const CALL_TIMEOUT_MS = 20_000
const MAX_BYTES = 4 * 1024 * 1024

// a read this sure is the answer — stop spending on the broadcast.
const LOCK_CONFIDENCE = 0.8
// below this the model is describing noise, not a shirt. discarded, not stored.
const MIN_CONFIDENCE = 0.35
const MAX_TRIES = 6
const RETRY_MS = 3 * 60_000
// a look that never reached the model (CDN blip, stale frame) costs nothing, so it is
// refunded rather than burning one of the six — but not forever, or a channel whose preview
// is permanently broken would re-fetch every minute for a twelve-hour stream.
const MAX_FREE = 10
const FREE_RETRY_MS = 60_000
// a fresh broadcast's first attempt: late enough that the CDN has a frame from THIS stream,
// early enough to be inside the fullscreen-cam intro.
const FIRST_ATTEMPT_MS = 3 * 60_000
// past this the thumbnail is unambiguously current, so a bot that started mid-broadcast
// attempts immediately instead of waiting out a delay meant for a stream that just began.
const MIDSTREAM_MS = 15 * 60_000

// how many past broadcasts the odds line looks back over.
const HISTORY_LIMIT = 20

// db reads are wrapped: a query-time throw here would take the whole answer down, and a
// shirt line is never worth that. every caller treats a miss as "no read".
function readRow(ch: string, startedAt: number) {
  try { return db.getShirtRead(ch, startedAt) } catch { return null }
}

function readHistory(ch: string, limit: number) {
  try { return db.getShirtHistory(ch, limit) } catch { return [] }
}

export interface ShirtRead {
  color: string
  hex: string
  confidence: number
  /** where the model says it found the streamer — logged, so a run of bad reads is diagnosable. */
  where: string
}

interface Watch {
  startedAt: number
  /** vision calls actually spent on this broadcast. */
  tries: number
  /** looks that ended before the model saw anything — refunded, and capped. */
  free: number
  nextAt: number
  locked: boolean
  /** sha1 of every thumbnail already sent for this broadcast — plus the previous one's. */
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

// a colour a human would say out loud. anything else — a sentence, a refusal, an injected
// instruction — is not a colour and does not reach the prompt.
const COLOR_RE = /^[a-z]+(?:[ -][a-z]+)?$/
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
  if (!color || color.length > 20 || !COLOR_RE.test(color)) return null
  const conf = typeof o.confidence === 'number' && Number.isFinite(o.confidence)
    ? Math.max(0, Math.min(1, o.confidence))
    : 0
  if (conf < MIN_CONFIDENCE) return null
  const hexRaw = typeof o.hex === 'string' ? o.hex.trim().toLowerCase() : ''
  const whereRaw = typeof o.where === 'string' ? o.where.trim().toLowerCase() : ''
  return {
    color,
    hex: HEX_RE.test(hexRaw) ? hexRaw : '',
    confidence: conf,
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
  '- "color": the colour of their outermost visible top (a robe/jacket/hoodie worn over a shirt IS the top), one or two common words, lowercase: "black", "dark blue", "white", "grey", "red".',
  '- "hex": approximate sRGB hex of that garment.',
  '- "confidence": 0 to 1 for BOTH finding the right person and the colour. A tiny, dark or ambiguous cam deserves a low number.',
  'Respond with ONLY the JSON object, no prose and no markdown fences:',
  '{"visible":true,"where":"inset","color":"black","hex":"#1a1a1a","confidence":0.9}',
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

/**
 * Called from the /helix/streams poll for every live channel, once a minute. Decides on its
 * own whether this broadcast still wants a look, and does nothing the vast majority of the
 * time. Fire-and-forget: never awaited by the poller, never throws.
 */
export function noteStreamThumb(channel: string, startedAt: number, template: string, now = Date.now()): void {
  const ch = channel.toLowerCase()
  if (!Number.isFinite(startedAt) || !template) return
  // spending on a channel whose bot cannot answer questions buys nothing.
  if (!AI_CHANNELS.has(ch)) return

  let w = watches.get(ch)
  if (!w || w.startedAt !== startedAt) {
    // a new broadcast. carry the previous one's thumbnail hashes forward — the CDN serving
    // the old frame is exactly the stale read this guards against.
    const seen = w ? w.seen : new Set<string>()
    const stored = readRow(ch, startedAt)
    w = {
      startedAt,
      tries: 0,
      free: 0,
      nextAt: firstAttemptAt(startedAt, now),
      locked: (stored?.confidence ?? 0) >= LOCK_CONFIDENCE,
      seen,
    }
    watches.set(ch, w)
    // one broadcast per channel is all this map ever holds, but a channel the bot has since
    // parted should not sit here forever.
    for (const [k] of watches) if (k !== ch && !isChannelLive(k)) watches.delete(k)
  }

  if (w.locked || w.tries >= MAX_TRIES || now < w.nextAt) return
  // never let a fan-out of channels going live together stack up vision calls.
  if (inFlight > 0) return

  w.tries++
  w.nextAt = now + RETRY_MS
  inFlight++
  // a look that cost nothing gets its try back, so a flaky CDN can't quietly eat the whole
  // budget of a broadcast without the model ever being asked.
  const refund = () => {
    if (w.free >= MAX_FREE) return
    w.free++
    w.tries--
    w.nextAt = now + FREE_RETRY_MS
  }

  void (async () => {
    try {
      const url = thumbUrl(template, THUMB_W, THUMB_H, now)
      if (!isTwitchCdn(url)) return
      const img = await fetchThumb(url)
      if (!img) return refund()
      if (w.seen.has(img.hash)) {
        // byte-identical to a frame we already have: the CDN has not refreshed since — the
        // exact case that would otherwise report the PREVIOUS broadcast's shirt.
        return refund()
      }
      w.seen.add(img.hash)
      const read = await readShirt(ch, img)
      if (!read) return
      const prev = readRow(ch, w.startedAt)
      if (prev && prev.confidence >= read.confidence) return
      db.recordShirtRead(ch, w.startedAt, read.color, read.hex, read.confidence, now)
      if (read.confidence >= LOCK_CONFIDENCE) w.locked = true
      log(`shirt: #${ch} ${read.color}${read.hex ? ` ${read.hex}` : ''} (confidence ${read.confidence.toFixed(2)}${read.where ? `, ${read.where} cam` : ''}, try ${w.tries}${w.locked ? ', locked' : ', provisional'})`)
    } catch (e) {
      log(`shirt: #${ch} read failed — ${(e as Error)?.message ?? e}`)
    } finally {
      inFlight--
    }
  })()
}

export function resetShirtWatchesForTests(): void {
  watches.clear()
  inFlight = 0
}

// --- the ask ---------------------------------------------------------------

// "shirt" in this chat means exactly one thing, so the garment words fire on their own.
const GARMENT_RE = /\b(shirts?|t-?shirts?|hoodies?|sweaters?|jumpers?)\b/i
// what he's wearing / what colour is he today — only alongside a person or the day.
const WEARING_RE = /\b(wear(?:ing|s)?|dressed|outfit)\b/i
const COLOR_WORD_RE = /\bcolou?rs?\b/i
const SUBJECT_RE = /\b(he|him|his|kripp\w*|krip|streamer|nl_?kripp)\b/i

/** true when the query is asking what the streamer has on. */
export function isShirtQuery(query: string): boolean {
  if (GARMENT_RE.test(query)) return true
  if ((WEARING_RE.test(query) || COLOR_WORD_RE.test(query)) && SUBJECT_RE.test(query)) return true
  return false
}

function ago(ms: number): string {
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

/** "black 11, grey 5, blue 4" over the last broadcasts — the odds, straight from our rows. */
export function shirtOdds(rows: { color: string }[]): string {
  const counts = new Map<string, number>()
  for (const r of rows) counts.set(r.color, (counts.get(r.color) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([c, n]) => `${c} ${n}`)
    .join(', ')
}

/**
 * The injected context section — '' unless the query is shirt-shaped. Every branch is a
 * true statement about what the bot did or did not see, because "he's wearing black" when
 * nothing was read is the one failure that would poison a bet.
 */
export function getShirtLine(channel: string, query: string, now = Date.now()): string {
  if (!isShirtQuery(query)) return ''
  const ch = channel.replace(/^#/, '').toLowerCase()
  const history = readHistory(ch, HISTORY_LIMIT)
  const info = getStreamInfo(ch)
  const live = isLiveStateKnown() && isChannelLive(ch)
  const startedAt = info?.startedAt
  const current = live && startedAt ? readRow(ch, startedAt) : null
  // today's read is not "history" for the odds line — it is the answer.
  const past = history.filter((h) => h.startedAt !== startedAt)
  const odds = past.length >= 3
    ? ` Colours over the last ${past.length} streams: ${shirtOdds(past)}.`
    : ''

  const src = 'READ FROM THE LIVE STREAM by looking at the webcam — this is real, not a guess'

  if (current && current.confidence >= LOCK_CONFIDENCE) {
    return `\nShirt watch — this stream ${ch} is wearing ${current.color}${current.hex ? ` (${current.hex})` : ''} (${src}; seen ${ago(now - current.capturedAt)}). Chat bets on the shirt colour, so state it plainly.${odds}`
  }
  if (current) {
    return `\nShirt watch — best look so far this stream says ${current.color}, but the cam was small/unclear and you are NOT confident. Say that it looks like ${current.color} and that you are not sure yet. Never state it as fact.${odds}`
  }
  if (live) {
    const watching = watches.get(ch)
    const more = !watching || (!watching.locked && watching.tries < MAX_TRIES)
    return `\nShirt watch — you have NOT gotten a clear look at the cam this stream${more ? ' yet (still checking)' : ''}. Say so plainly; do NOT guess a colour.${odds}`
  }
  const last = history[0]
  if (last) {
    return `\nShirt watch — ${ch} is offline. Last stream (${ago(now - last.startedAt)}) the shirt was ${last.color} (${src}).${odds}`
  }
  return `\nShirt watch — no shirt reading exists yet (the bot reads it from the stream once he's live). Say so, don't guess.`
}
