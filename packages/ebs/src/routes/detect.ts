// POST /detect — receives card detections from companion app, broadcasts via PubSub

import { verifyCompanionSecret } from '../auth'
import { broadcastState } from '../pubsub'
import { parsePayload, CHANNEL_ID_RE } from './detect-validate'
import { rateOk } from '../ratelimit'
import { storeBoard } from './board'
import { logCompanion } from '../companion-log'

const MAX_BODY = 100_000

// Per-channel ceiling on authenticated detections. The per-IP limit doesn't bound
// a leaked secret used from many IPs, and every accepted frame spends that
// channel's Helix PubSub budget. Checked AFTER secret verification so an attacker
// without the secret can't exhaust the bucket and lock out the real companion.
const MAX_CHANNEL_RATE = 600

export async function handleDetect(req: Request): Promise<Response> {
  const len = Number(req.headers.get('Content-Length') ?? 0)
  if (Number.isFinite(len) && len > MAX_BODY) return new Response('bad request', { status: 413 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    logCompanion('detect', null, 'rejected: body is not json')
    return new Response('bad request', { status: 400 })
  }

  const payload = parsePayload(body)
  if (!payload) {
    logCompanion('detect', claimedChannel(body), 'rejected: malformed payload')
    return new Response('bad request', { status: 400 })
  }

  if (!verifyCompanionSecret(payload.secret, payload.channelId)) {
    logCompanion('detect', payload.channelId, 'rejected: wrong secret')
    return new Response('unauthorized', { status: 401 })
  }

  if (!rateOk(`det:${payload.channelId}`, MAX_CHANNEL_RATE)) {
    logCompanion('detect', payload.channelId, 'rejected: rate limited')
    return new Response('rate limited', { status: 429 })
  }
  logCompanion('detect', payload.channelId, 'frames arriving')

  // retain for the bot's /board reads regardless of PubSub outcome — a Helix outage
  // shouldn't also blind chat answers about the live board
  storeBoard(payload.channelId, payload.cards)

  const accepted = broadcastState(payload.channelId, {
    cards: payload.cards,
  })
  if (!accepted) {
    logCompanion('detect', payload.channelId, 'broadcast failed')
    return new Response('broadcast failed', { status: 502 })
  }

  return new Response('ok', { status: 202 })
}

// the channel a rejected body claims, only when it is shaped like a real id — never
// echo arbitrary attacker text into the journal
function claimedChannel(body: unknown): string | null {
  const id = (body as { channelId?: unknown } | null)?.channelId
  return typeof id === 'string' && CHANNEL_ID_RE.test(id) ? id : null
}
