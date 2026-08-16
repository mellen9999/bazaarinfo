// POST /hs — the companion's Battlegrounds board, and GET /hsboard — the bot reading it.
//
// The Bazaar's board rides /detect because it also feeds the viewer overlay via PubSub.
// This one does not: Hearthstone Deck Tracker already draws a board for viewers, and a
// second overlay competing with it would be noise. The only consumer is the bot, so the
// state is stored and read back internally and never broadcast.
//
// Everything here treats the payload as untrusted. It arrives from a program on someone
// else's machine, authenticated by a secret that can leak — so shapes, ranges and counts
// are all bounded before anything is kept.

import { verifyCompanionSecret } from '../auth'
import { rateOk } from '../ratelimit'
import type { HsState } from '@bazaarinfo/shared'
import { parseHsState, CHANNEL_ID_RE, MAX_SECRET_LEN } from './hsboard-validate'

const MAX_BODY = 20_000
// a recruit phase plus a combat is a handful of frames a minute; this is a runaway guard,
// not a working limit
const MAX_CHANNEL_RATE = 240
const IDLE_EVICT_MS = 6 * 60 * 60 * 1000


interface Stored { hs: HsState; at: number }

const latest = new Map<string, Stored>()

setInterval(() => {
  const now = Date.now()
  for (const [id, s] of latest) {
    if (now - s.at > IDLE_EVICT_MS) latest.delete(id)
  }
}, 60 * 60 * 1000).unref?.()

export function storeHsState(channelId: string, hs: HsState | null): void {
  // an explicit "no game" clears rather than lingers — the bot must stop describing a
  // board the streamer has already left
  if (hs === null) latest.delete(channelId)
  else latest.set(channelId, { hs, at: Date.now() })
}

// --- routes ---

export async function handleHsPost(req: Request): Promise<Response> {
  const len = Number(req.headers.get('Content-Length') ?? 0)
  if (Number.isFinite(len) && len > MAX_BODY) return new Response('bad request', { status: 413 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return new Response('bad request', { status: 400 })
  }
  if (!body || typeof body !== 'object') return new Response('bad request', { status: 400 })
  const b = body as Record<string, unknown>
  if (typeof b.channelId !== 'string' || !CHANNEL_ID_RE.test(b.channelId)) return new Response('bad request', { status: 400 })
  if (typeof b.secret !== 'string' || !b.secret || b.secret.length > MAX_SECRET_LEN) return new Response('bad request', { status: 400 })

  if (!verifyCompanionSecret(b.secret, b.channelId)) return new Response('unauthorized', { status: 401 })
  if (!rateOk(`hs:${b.channelId}`, MAX_CHANNEL_RATE)) return new Response('rate limited', { status: 429 })

  // hs: null is the leave-the-game signal, and must be accepted as readily as a board
  if (b.hs === null || b.hs === undefined) {
    storeHsState(b.channelId, null)
    return new Response('ok', { status: 202 })
  }
  const hs = parseHsState(b.hs)
  if (!hs) return new Response('bad request', { status: 400 })
  storeHsState(b.channelId, hs)
  return new Response('ok', { status: 202 })
}

const enc = new TextEncoder()
function secretOk(given: string | null): boolean {
  const secret = process.env.INTERNAL_SECRET ?? ''
  if (!secret || !given) return false
  const a = enc.encode(given)
  const b = enc.encode(secret)
  let diff = a.length ^ b.length
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

export function handleHsBoard(req: Request, url: URL): Response {
  // same doctrine as /board: no secret and no such channel are both 404, so the route
  // never confirms which channels exist to anyone without the internal secret
  if (!secretOk(req.headers.get('x-internal-secret'))) return new Response('not found', { status: 404 })
  const s = latest.get(url.searchParams.get('channel_id') ?? '')
  if (!s) return new Response('not found', { status: 404 })
  return Response.json({ hs: s.hs, ageMs: Date.now() - s.at })
}

export function __clearHsForTest(): void {
  latest.clear()
}
