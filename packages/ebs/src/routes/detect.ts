// POST /detect — receives card detections from companion app, broadcasts via PubSub

import { verifyCompanionSecret } from '../auth'
import { broadcastState } from '../pubsub'
import { parsePayload } from './detect-validate'
import { rateOk } from '../ratelimit'
import { storeBoard } from './board'

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
    return new Response('bad request', { status: 400 })
  }

  const payload = parsePayload(body)
  if (!payload) {
    return new Response('bad request', { status: 400 })
  }

  if (!verifyCompanionSecret(payload.secret, payload.channelId)) {
    return new Response('unauthorized', { status: 401 })
  }

  if (!rateOk(`det:${payload.channelId}`, MAX_CHANNEL_RATE)) {
    return new Response('rate limited', { status: 429 })
  }

  // retain for the bot's /board reads regardless of PubSub outcome — a Helix outage
  // shouldn't also blind chat answers about the live board
  storeBoard(payload.channelId, payload.cards)

  const accepted = broadcastState(payload.channelId, {
    cards: payload.cards,
  })
  if (!accepted) {
    return new Response('broadcast failed', { status: 502 })
  }

  return new Response('ok', { status: 202 })
}
