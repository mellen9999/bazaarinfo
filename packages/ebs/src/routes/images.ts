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

  const contentType = upstream.headers.get('Content-Type') ?? 'image/webp'
  const responseHeaders = {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
  }

  // Fast path: Content-Length present and within bounds — buffer in one shot
  if (contentLength > 0) {
    const buf = await upstream.arrayBuffer()
    if (buf.byteLength > MAX_IMAGE_SIZE) return new Response('too large', { status: 413 })
    return new Response(buf, { headers: responseHeaders })
  }

  // Slow path: no Content-Length — stream with running size check to avoid
  // allocating the full body before knowing its size
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  const reader = upstream.body!.getReader()
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
