// GET /api/cards — serves the full card cache

import type { CardCache } from '@bazaarinfo/shared'

let cache: CardCache | null = null

export function setCardCache(data: CardCache) {
  cache = data
}

export function getCardCache(): CardCache | null {
  return cache
}

export function handleCards(): Response {
  if (!cache) {
    return new Response('card cache not loaded', { status: 503 })
  }
  return Response.json(cache, {
    headers: { 'Cache-Control': 'public, max-age=300' },
  })
}
