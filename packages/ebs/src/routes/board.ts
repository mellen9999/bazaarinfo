// GET /board — the bot's window into the overlay pipeline: the latest accepted
// companion frame per channel, so chat questions about the live board get real card
// names instead of a shrug. guarded by INTERNAL_SECRET, shared with the bot only —
// never the extension (JWT) or the companion (per-channel derived secret).

import type { DetectPayload } from './detect-validate'

interface StoredBoard {
  cards: DetectPayload['cards']
  at: number
}

const latest = new Map<string, StoredBoard>()

// entries only appear after companion-secret auth, so growth is bounded by real
// adoption — but a streamer who stops playing shouldn't pin their last board forever
const IDLE_EVICT_MS = 6 * 60 * 60 * 1000
setInterval(() => {
  const now = Date.now()
  for (const [id, b] of latest) {
    if (now - b.at > IDLE_EVICT_MS) latest.delete(id)
  }
}, 60 * 60 * 1000).unref?.()

export function storeBoard(channelId: string, cards: DetectPayload['cards']): void {
  latest.set(channelId, { cards, at: Date.now() })
}

const enc = new TextEncoder()
function secretOk(given: string | null): boolean {
  // read lazily so tests can set the env; fail closed when unset (route disabled)
  const secret = process.env.INTERNAL_SECRET ?? ''
  if (!secret || !given) return false
  const a = enc.encode(given)
  const b = enc.encode(secret)
  let diff = a.length ^ b.length
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

export function handleBoard(req: Request, url: URL): Response {
  // bad secret and unknown channel are both 404 on purpose — the route doesn't
  // exist for anyone without the secret, and it never confirms channel presence
  if (!secretOk(req.headers.get('x-internal-secret'))) return new Response('not found', { status: 404 })
  const b = latest.get(url.searchParams.get('channel_id') ?? '')
  if (!b) return new Response('not found', { status: 404 })
  return Response.json({ cards: b.cards, ageMs: Date.now() - b.at })
}

export function __clearBoardsForTest(): void {
  latest.clear()
}
