// GET /api/images/:hash — proxies bazaardb.gg CDN images
// so the extension only needs to allowlist the EBS domain

import { statSync, readFileSync } from 'fs'
import { resolve } from 'path'
import artCdn from '@bazaarinfo/data/art-cdn.json'

// The z-segment tracks the game version. Newer segments serve every older hash, but
// a new patch's cards exist ONLY under its own segment. The bot's data refresh records
// the newest segment it sees in its card-page cache, so the proxy follows that file at
// runtime (re-read on mtime change); the committed art-cdn.json is the fallback.
// The ebs runs from another checkout than the bot, so point BAZAARINFO_CARD_PAGES at
// the bot's cache/card-pages.json. BAZAARDB_CDN_VERSION still overrides everything.
const CDN_RE = /^z[1-9]\d*\.\d+$/
const PAGES_PATH = process.env.BAZAARINFO_CARD_PAGES || resolve(import.meta.dir, '../../../../cache/card-pages.json')

const seen = new Map<string, { mtime: number, cdn: string | null }>()

// "z19.0" vs "z9.9": segment by segment
function newer(a: string, b: string): boolean {
  const pa = a.slice(1).split('.').map(Number)
  const pb = b.slice(1).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d > 0
  }
  return false
}

// exported for testing; never throws — a missing/bad file means the committed segment
export function resolveCdnVersion(path: string = PAGES_PATH, fallback: string = artCdn.version): string {
  if (process.env.BAZAARDB_CDN_VERSION) return process.env.BAZAARDB_CDN_VERSION
  let cdn: string | null = null
  try {
    const mtime = statSync(path).mtimeMs
    let hit = seen.get(path)
    if (!hit || hit.mtime !== mtime) {
      const v = (JSON.parse(readFileSync(path, 'utf-8')) as { cdn?: unknown }).cdn
      hit = { mtime, cdn: typeof v === 'string' && CDN_RE.test(v) ? v : null }
      seen.set(path, hit)
    }
    cdn = hit.cdn
  } catch {
    seen.delete(path)
  }
  // never go backwards: the committed segment is a floor
  return cdn && newer(cdn, fallback) ? cdn : fallback
}

const HASH_RE = /^[a-f0-9]{20,64}$/
const MAX_IMAGE_SIZE = 2 * 1024 * 1024 // 2MB

// non-hash keys are 404 (not 400): they're stale client blobs, not malformed API use
export async function handleImage(hash: string): Promise<Response> {
  if (!HASH_RE.test(hash)) {
    return new Response('not found', { status: 404 })
  }

  // DNS failure / timeout must be a clean 502, not a throw into the generic
  // 500 handler — an upstream outage is not an internal error
  const url = `https://s.bazaardb.gg/v1/${resolveCdnVersion()}/${hash}@256.webp`
  let upstream: Response
  try {
    upstream = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    return new Response('upstream unavailable', { status: 502 })
  }

  if (!upstream.ok) {
    return new Response('not found', { status: upstream.status })
  }
  if (!upstream.body) {
    return new Response('upstream unavailable', { status: 502 })
  }

  const contentLength = parseInt(upstream.headers.get('Content-Length') ?? '0')
  if (contentLength > MAX_IMAGE_SIZE) {
    return new Response('too large', { status: 413 })
  }

  const contentType = upstream.headers.get('Content-Type') ?? 'image/webp'
  const responseHeaders = {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
  }

  // Always stream with a running size check. The declared Content-Length is only a
  // hint — a compromised/misbehaving upstream can send a small Content-Length with a
  // huge body, and arrayBuffer() would allocate all of it before any check fires. On a
  // low-RAM box that's the one real memory-exhaustion path, so never trust the header
  // to bound the allocation; cap as we read.
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  const reader = upstream.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > MAX_IMAGE_SIZE) {
      await reader.cancel()
      return new Response('too large', { status: 413 })
    }
    chunks.push(value)
  }

  // Single allocation, single pass
  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }

  return new Response(body, { headers: responseHeaders })
}
