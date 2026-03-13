// POST /detect — receives card detections from companion app, broadcasts via PubSub

import { verifyCompanionSecret } from '../auth'
import { broadcastState } from '../pubsub'

interface DetectPayload {
  channelId: string
  secret: string
  cards: Array<{
    title: string
    tier: string
    x: number
    y: number
    w: number
    h: number
    owner?: string
    type?: string
    enchantment?: string
    attrs?: Record<string, number>
  }>
  shop?: Array<{
    title: string
    type: string
    tier: string
    size: string
  }>
}

const MAX_CARDS = 50

function isValidCard(c: Record<string, unknown>): boolean {
  if (typeof c.title !== 'string') return false
  if (typeof c.tier !== 'string') return false
  if (typeof c.x !== 'number' || typeof c.y !== 'number' || !isFinite(c.x) || !isFinite(c.y)) return false
  if (typeof c.w !== 'number' || typeof c.h !== 'number' || !isFinite(c.w) || !isFinite(c.h)) return false
  if (c.x < 0 || c.x > 1 || c.y < 0 || c.y > 1 || c.w <= 0 || c.w > 1 || c.h <= 0 || c.h > 1) return false
  if (c.owner !== undefined && typeof c.owner !== 'string') return false
  if (c.type !== undefined && typeof c.type !== 'string') return false
  if (c.enchantment !== undefined && typeof c.enchantment !== 'string') return false
  if (c.attrs !== undefined) {
    if (typeof c.attrs !== 'object' || c.attrs === null || Array.isArray(c.attrs)) return false
    for (const v of Object.values(c.attrs as Record<string, unknown>)) {
      if (typeof v !== 'number' || !isFinite(v)) return false
    }
  }
  return true
}

function isValidPayload(body: unknown): body is DetectPayload {
  if (!body || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  if (typeof b.channelId !== 'string' || !b.channelId) return false
  if (typeof b.secret !== 'string' || !b.secret) return false
  if (!Array.isArray(b.cards) || b.cards.length > MAX_CARDS) return false
  for (const card of b.cards) {
    if (typeof card !== 'object' || !card) return false
    if (!isValidCard(card as Record<string, unknown>)) return false
  }
  return true
}

const MAX_BODY = 100_000

export async function handleDetect(req: Request): Promise<Response> {
  const len = parseInt(req.headers.get('Content-Length') ?? '0')
  if (len > MAX_BODY) return new Response('bad request', { status: 413 })

  let body: unknown
  try {
    const text = await req.text()
    if (text.length > MAX_BODY) return new Response('bad request', { status: 413 })
    body = JSON.parse(text)
  } catch {
    return new Response('bad request', { status: 400 })
  }

  if (!isValidPayload(body)) {
    return new Response('bad request', { status: 400 })
  }

  if (!verifyCompanionSecret(body.secret)) {
    return new Response('unauthorized', { status: 401 })
  }

  const ok = await broadcastState(body.channelId, {
    cards: body.cards,
    shop: body.shop,
  })
  if (!ok) {
    return new Response('broadcast failed', { status: 502 })
  }

  return new Response('ok', { status: 200 })
}
