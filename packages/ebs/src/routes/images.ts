// GET /api/images/:hash — proxies bazaardb.gg CDN images
// so the extension only needs to allowlist the EBS domain

const CDN_BASE = 'https://s.bazaardb.gg/v1/z11.0'
const HASH_RE = /^[a-f0-9]{20,64}$/
const MAX_IMAGE_SIZE = 2 * 1024 * 1024 // 2MB

export async function handleImage(hash: string): Promise<Response> {
  if (!HASH_RE.test(hash)) {
    return new Response('invalid hash', { status: 400 })
  }

  const url = `${CDN_BASE}/${hash}@256.webp`
  const upstream = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
  })

  if (!upstream.ok) {
    return new Response('not found', { status: upstream.status })
  }

  const contentLength = parseInt(upstream.headers.get('Content-Length') ?? '0')
  if (contentLength > MAX_IMAGE_SIZE) {
    return new Response('too large', { status: 413 })
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'image/webp',
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
