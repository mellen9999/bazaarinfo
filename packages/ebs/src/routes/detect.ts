// POST /detect — receives card detections from companion app, broadcasts via PubSub

import { verifyCompanionSecret } from '../auth'
import { broadcastCards } from '../pubsub'

interface DetectPayload {
  channelId: string
  cards: Array<{
    title: string
    tier: string
    x: number
    y: number
    w: number
    h: number
  }>
  secret: string
}

function isValidPayload(body: unknown): body is DetectPayload {
  if (!body || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  if (typeof b.channelId !== 'string' || !b.channelId) return false
  if (typeof b.secret !== 'string' || !b.secret) return false
  if (!Array.isArray(b.cards)) return false
  for (const card of b.cards) {
    if (typeof card !== 'object' || !card) return false
    const c = card as Record<string, unknown>
    if (typeof c.title !== 'string') return false
    if (typeof c.tier !== 'string') return false
    if (typeof c.x !== 'number' || typeof c.y !== 'number') return false
    if (typeof c.w !== 'number' || typeof c.h !== 'number') return false
  }
  return true
}

export async function handleDetect(req: Request): Promise<Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return new Response('invalid JSON', { status: 400 })
  }

  if (!isValidPayload(body)) {
    return new Response('invalid payload', { status: 400 })
  }

  if (!verifyCompanionSecret(body.secret)) {
    return new Response('unauthorized', { status: 401 })
  }

  const ok = await broadcastCards(body.channelId, body.cards)
  if (!ok) {
    return new Response('broadcast failed', { status: 502 })
  }

  return new Response('ok', { status: 200 })
}
