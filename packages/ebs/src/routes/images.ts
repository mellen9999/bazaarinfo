// GET /api/images/:hash — proxies bazaardb.gg CDN images
// so the extension only needs to allowlist the EBS domain

const CDN_BASE = 'https://s.bazaardb.gg/v1/z11.0'
const HASH_RE = /^[a-f0-9]{20,64}$/

export async function handleImage(hash: string): Promise<Response> {
  if (!HASH_RE.test(hash)) {
    return new Response('invalid hash', { status: 400 })
  }

  const url = `${CDN_BASE}/${hash}@256.webp`
  const upstream = await fetch(url, {
    headers: { 'User-Agent': 'BazaarInfo-EBS/1.0' },
    signal: AbortSignal.timeout(10_000),
  })

  if (!upstream.ok) {
    return new Response('image not found', { status: upstream.status })
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'image/webp',
      'Cache-Control': 'public, max-age=86400',
    },
  })
}
