// GET /api/cards — serves the full card cache
//
// Every viewer of every channel pulls this same blob before the overlay or the
// panel can do anything, so it is the slowest thing the extension does and the
// only one that scales with audience. It is therefore prepared once per cache
// load (see encoded.ts), never per request.

import type { CardCache } from '@bazaarinfo/shared'
import { prepare, respondPrepared, type Prepared } from './encoded'

let cache: CardCache | null = null
let prepared: Prepared | null = null

export function setCardCache(data: CardCache) {
  cache = data
  prepared = prepare(JSON.stringify(data))
}

export function getCardCache(): CardCache | null {
  return cache
}

export function handleCards(req?: Request): Response {
  if (!prepared) return new Response('service unavailable', { status: 503 })
  return respondPrepared(prepared, req)
}
