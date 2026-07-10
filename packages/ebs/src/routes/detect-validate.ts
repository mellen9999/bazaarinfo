// Pure validators for detect route — no external dependencies so tests can import safely.

export interface DetectPayload {
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
}

export const MAX_CARDS = 50
const MAX_TITLE_LEN = 80
const MAX_TIER_LEN = 32
const MAX_OWNER_LEN = 64
const MAX_TYPE_LEN = 64
const MAX_ENCHANTMENT_LEN = 64
const CHANNEL_ID_RE = /^\d{1,15}$/
const MAX_SECRET_LEN = 256
const MAX_ATTRS_KEYS = 100

export function isValidCard(c: Record<string, unknown>): boolean {
  if (typeof c.title !== 'string' || c.title.length === 0 || c.title.length > MAX_TITLE_LEN) return false
  if (typeof c.tier !== 'string' || c.tier.length > MAX_TIER_LEN) return false
  if (typeof c.x !== 'number' || typeof c.y !== 'number' || !isFinite(c.x) || !isFinite(c.y)) return false
  if (typeof c.w !== 'number' || typeof c.h !== 'number' || !isFinite(c.w) || !isFinite(c.h)) return false
  if (c.x < 0 || c.x > 1 || c.y < 0 || c.y > 1 || c.w <= 0 || c.w > 1 || c.h <= 0 || c.h > 1) return false
  if (c.owner !== undefined && (typeof c.owner !== 'string' || c.owner.length > MAX_OWNER_LEN)) return false
  if (c.type !== undefined && (typeof c.type !== 'string' || c.type.length > MAX_TYPE_LEN)) return false
  if (c.enchantment !== undefined && (typeof c.enchantment !== 'string' || c.enchantment.length > MAX_ENCHANTMENT_LEN)) return false
  if (c.attrs !== undefined) {
    if (typeof c.attrs !== 'object' || c.attrs === null || Array.isArray(c.attrs)) return false
    const attrsObj = c.attrs as Record<string, unknown>
    if (Object.keys(attrsObj).length > MAX_ATTRS_KEYS) return false
    for (const v of Object.values(attrsObj)) {
      if (typeof v !== 'number' || !isFinite(v)) return false
    }
  }
  return true
}

// Fatal fields (channelId, secret, array shape) reject the whole request.
// Individual bad cards are filtered out; the surviving valid subset is broadcast.
// A single malformed card must never blank the entire viewer overlay.
export function parsePayload(body: unknown): DetectPayload | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (typeof b.channelId !== 'string' || !b.channelId) return null
  if (!CHANNEL_ID_RE.test(b.channelId)) return null
  if (typeof b.secret !== 'string' || !b.secret) return null
  if (b.secret.length > MAX_SECRET_LEN) return null
  if (!Array.isArray(b.cards)) return null

  const valid: DetectPayload['cards'] = []
  let dropped = 0
  for (const card of b.cards) {
    if (typeof card === 'object' && card !== null && isValidCard(card as Record<string, unknown>)) {
      valid.push(card as DetectPayload['cards'][number])
    } else {
      dropped++
    }
  }
  if (dropped > 0) console.warn(`detect: dropped ${dropped} invalid card(s) from frame for channel ${b.channelId}`)

  return {
    channelId: b.channelId,
    secret: b.secret,
    cards: valid.slice(0, MAX_CARDS),
  }
}
