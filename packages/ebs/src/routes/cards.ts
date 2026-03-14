// GET /api/cards — serves the full card cache

import type { CardCache } from '@bazaarinfo/shared'

let cache: CardCache | null = null
let cachedJson: string | null = null

export function setCardCache(data: CardCache) {
  cache = data
  cachedJson = JSON.stringify(data)
}

export function getCardCache(): CardCache | null {
  return cache
}

export function handleCards(): Response {
  if (!cachedJson) {
    return new Response('service unavailable', { status: 503 })
  }
  return new Response(cachedJson, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
    },
  })
}
