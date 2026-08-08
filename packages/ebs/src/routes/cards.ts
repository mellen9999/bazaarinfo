// GET /api/cards — serves the full card cache
//
// Every viewer of every channel pulls this same blob before the overlay or the
// panel can do anything, so it is the slowest thing the extension does and the
// only one that scales with audience. It is therefore prepared once per cache
// load, never per request: compressed ahead of time and tagged, so a repeat
// viewer spends a 304 instead of megabytes and a first-time viewer on mobile data
// downloads a fraction of the raw JSON.

import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib'
import type { CardCache } from '@bazaarinfo/shared'

// Quality 5, not 11. This runs on the bot host at startup and on every patch-day
// cache swap; 11 spends minutes of CPU on a passively-cooled box to save a few
// percent that nobody can perceive over a network.
const BROTLI_QUALITY = 5

interface Encoded {
  body: Uint8Array
  encoding: string
}

let cache: CardCache | null = null
let cachedJson: string | null = null
let cachedEtag: string | null = null
let cachedGzip: Encoded | null = null
let cachedBrotli: Encoded | null = null

export function setCardCache(data: CardCache) {
  cache = data
  cachedJson = JSON.stringify(data)
  // Content-addressed, so an unchanged dump keeps its tag across a restart and
  // viewers keep their cached copy instead of re-downloading on every deploy.
  cachedEtag = `"${Bun.hash(cachedJson).toString(36)}"`
  cachedGzip = { body: gzipSync(cachedJson), encoding: 'gzip' }
  cachedBrotli = {
    body: brotliCompressSync(cachedJson, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY },
    }),
    encoding: 'br',
  }
}

export function getCardCache(): CardCache | null {
  return cache
}

// Only what the client actually said it accepts. An unrecognised or absent
// Accept-Encoding falls through to the raw JSON — correct beats small.
function pickEncoding(accept: string | null): Encoded | null {
  if (!accept) return null
  const a = accept.toLowerCase()
  if (cachedBrotli && /(^|[\s,])br($|[\s,;])/.test(a)) return cachedBrotli
  if (cachedGzip && /(^|[\s,])gzip($|[\s,;])/.test(a)) return cachedGzip
  return null
}

export function handleCards(req?: Request): Response {
  if (!cachedJson || !cachedEtag) {
    return new Response('service unavailable', { status: 503 })
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300',
    ETag: cachedEtag,
    // The body differs by encoding; without this a shared cache can hand a
    // brotli body to a client that never asked for one.
    Vary: 'Accept-Encoding',
  }

  // A viewer who already has this exact dump re-opens the stream for free.
  if (req?.headers.get('If-None-Match') === cachedEtag) {
    return new Response(null, { status: 304, headers })
  }

  const enc = pickEncoding(req?.headers.get('Accept-Encoding') ?? null)
  if (enc) {
    return new Response(enc.body, { headers: { ...headers, 'Content-Encoding': enc.encoding } })
  }
  return new Response(cachedJson, { headers })
}
