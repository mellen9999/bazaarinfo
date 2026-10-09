// A JSON blob prepared once per load and served many times: compressed ahead of
// time and content-tagged, so a repeat viewer spends a 304 and a first-time viewer
// on mobile data downloads a fraction of the raw text. Shared by every big, rarely
// changing payload (cards, translations).

import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib'

// Quality 5, not 11. This runs on the bot host at startup and on every patch-day
// cache swap; 11 spends minutes of CPU on a passively-cooled box to save a few
// percent that nobody can perceive over a network.
const BROTLI_QUALITY = 5

interface Encoded {
  body: Uint8Array<ArrayBuffer>
  encoding: string
}

export interface Prepared {
  json: string
  etag: string
  gzip: Encoded
  brotli: Encoded
}

export function prepare(json: string): Prepared {
  return {
    json,
    // Content-addressed, so an unchanged file keeps its tag across a restart and
    // viewers keep their cached copy instead of re-downloading on every deploy.
    etag: `"${Bun.hash(json).toString(36)}"`,
    // copy out of the zlib Buffers: detaches from any pooled slab and gives the
    // plain-ArrayBuffer view Response wants — runs only on cache swaps, not requests
    gzip: { body: new Uint8Array(gzipSync(json)), encoding: 'gzip' },
    brotli: {
      body: new Uint8Array(brotliCompressSync(json, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY },
      })),
      encoding: 'br',
    },
  }
}

// Only what the client actually said it accepts. An unrecognised or absent
// Accept-Encoding falls through to the raw JSON — correct beats small.
function pickEncoding(p: Prepared, accept: string | null): Encoded | null {
  if (!accept) return null
  const a = accept.toLowerCase()
  if (/(^|[\s,])br($|[\s,;])/.test(a)) return p.brotli
  if (/(^|[\s,])gzip($|[\s,;])/.test(a)) return p.gzip
  return null
}

export function respondPrepared(p: Prepared, req?: Request): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300',
    ETag: p.etag,
    // The body differs by encoding; without this a shared cache can hand a
    // brotli body to a client that never asked for one.
    Vary: 'Accept-Encoding',
  }

  // A viewer who already has this exact payload re-opens the stream for free.
  if (req?.headers.get('If-None-Match') === p.etag) {
    return new Response(null, { status: 304, headers })
  }

  const enc = pickEncoding(p, req?.headers.get('Accept-Encoding') ?? null)
  if (enc) {
    return new Response(enc.body, { headers: { ...headers, 'Content-Encoding': enc.encoding } })
  }
  return new Response(p.json, { headers })
}
