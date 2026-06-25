// POST /detect — receives card detections from companion app, broadcasts via PubSub

import { verifyCompanionSecret } from '../auth'
import { broadcastState } from '../pubsub'
import { parsePayload } from './detect-validate'

const MAX_BODY = 100_000

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

  const accepted = broadcastState(payload.channelId, {
    cards: payload.cards,
  })
  if (!accepted) {
    return new Response('broadcast failed', { status: 502 })
  }

  return new Response('ok', { status: 202 })
}
