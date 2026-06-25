// BazaarInfo EBS — Extension Backend Service
// Relays companion card detections to viewers via Twitch PubSub

import { readFileSync, watch } from 'fs'
import { resolve, dirname, basename } from 'path'
import type { CardCache } from '@bazaarinfo/shared'
import { verifyTwitchJwt, deriveChannelSecret } from './auth'
import { handleCards, setCardCache, getCardCache } from './routes/cards'
import { handleImage } from './routes/images'
import { handleDetect } from './routes/detect'
import { pubsubStats } from './pubsub'
import { rateOk } from './ratelimit'

const STARTED_AT = Date.now()

const PORT = parseInt(process.env.EBS_PORT ?? '3100')

const TWITCH_ORIGIN_RE = /\.ext-twitch\.tv$/
const IMAGE_PATH_RE = /^\/api\/images\/([a-f0-9]+)$/

function allowedOrigin(req: Request): string | null {
  const origin = req.headers.get('Origin')
  if (!origin) return null
  try {
    const host = new URL(origin).hostname
    if (TWITCH_ORIGIN_RE.test(host)) return origin
  } catch {}
  return null
}

function cors(res: Response, origin: string | null): Response {
  if (origin) {
    res.headers.set('Access-Control-Allow-Origin', origin)
    res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  }
  res.headers.set('X-Content-Type-Options', 'nosniff')
  return res
}

function getIp(req: Request): string {
  const cf = req.headers.get('CF-Connecting-IP')
  if (cf) return cf
  const xff = req.headers.get('X-Forwarded-For')
  if (xff) {
    const comma = xff.indexOf(',')
    return comma === -1 ? xff.trim() : xff.slice(0, comma).trim()
  }
  return 'unknown'
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname
  const origin = allowedOrigin(req)

  // CORS preflight
  if (req.method === 'OPTIONS') {
    return cors(new Response(null, { status: 204 }), origin)
  }

  // Rate limit
  if (!rateOk(getIp(req))) {
    return cors(new Response('rate limited', { status: 429 }), origin)
  }

  // POST /detect — companion → PubSub (uses companion secret, not JWT)
  if (req.method === 'POST' && path === '/detect') {
    return cors(await handleDetect(req), origin)
  }

  // All other routes require valid Twitch JWT
  let twitchAuth: Awaited<ReturnType<typeof verifyTwitchJwt>> = null
  if (path.startsWith('/api/')) {
    twitchAuth = await verifyTwitchJwt(req.headers.get('Authorization'))
    if (!twitchAuth) {
      console.log(`[ebs] auth failed: ${path}`)
      return cors(new Response('unauthorized', { status: 401 }), origin)
    }
  }

  // GET /api/companion-setup — broadcaster gets their companion secret + channel_id
  if (req.method === 'GET' && path === '/api/companion-setup' && twitchAuth) {
    if (twitchAuth.role !== 'broadcaster') {
      return cors(new Response('broadcaster only', { status: 403 }), origin)
    }
    const channelId = twitchAuth.channel_id
    const secret = deriveChannelSecret(channelId)
    return cors(Response.json({ channelId, secret }), origin)
  }

  // GET /api/cards
  if (req.method === 'GET' && path === '/api/cards') {
    return cors(handleCards(), origin)
  }

  // GET /api/images/:hash
  const imageMatch = path.match(IMAGE_PATH_RE)
  if (req.method === 'GET' && imageMatch) {
    return cors(await handleImage(imageMatch[1]), origin)
  }

  // GET /health/live — process is up
  if (req.method === 'GET' && path === '/health/live') {
    return cors(new Response('ok'), origin)
  }

  // GET /health/ready — card cache loaded + ready to serve
  if (req.method === 'GET' && path === '/health/ready') {
    const cache = getCardCache()
    if (!cache) return cors(new Response('not ready', { status: 503 }), origin)
    const stats = pubsubStats()
    return cors(Response.json({
      status: 'ready',
      uptime: Math.floor((Date.now() - STARTED_AT) / 1000),
      cards: cache.items.length,
      skills: cache.skills.length,
      monsters: cache.monsters.length,
      pubsub: stats,
    }), origin)
  }

  // GET /health (back-compat alias of /health/live)
  if (req.method === 'GET' && path === '/health') {
    return cors(new Response('ok'), origin)
  }

  return cors(new Response('not found', { status: 404 }), origin)
}

const CACHE_PATH = process.env.CACHE_PATH ?? 'cache/items.json'

// atomic read-then-swap: parse the full file and only swap the in-memory cache on success,
// so a partial/corrupt read (the bot writes via temp+rename) never clobbers good data.
function loadCache(initial = false): boolean {
  try {
    const cache = JSON.parse(readFileSync(CACHE_PATH, 'utf-8')) as CardCache
    if (!Array.isArray(cache.items) || !Array.isArray(cache.skills) || !Array.isArray(cache.monsters)) {
      throw new Error('cache missing required arrays')
    }
    setCardCache(cache)
    console.log(`[ebs] loaded ${cache.items.length} items, ${cache.skills.length} skills, ${cache.monsters.length} monsters`)
    return true
  } catch (e) {
    console.error(`[ebs] ${initial ? 'failed to load' : 'reload failed, keeping current'} card cache:`, e)
    return false
  }
}

// Load card cache from local file (written by the bot's scraper)
function init() {
  console.log(`[ebs] loading card cache from ${CACHE_PATH}...`)
  if (!loadCache(true)) process.exit(1)

  // the bot re-scrapes and atomically rewrites CACHE_PATH (temp+rename) on dump changes and
  // the daily refresh; without this, EBS served boot-time card data until a manual restart.
  // watch the DIRECTORY (a rename swaps the inode, so a path-watch would go stale) and
  // debounce, since one atomic write can emit several events.
  try {
    const abs = resolve(CACHE_PATH)
    let reloadTimer: ReturnType<typeof setTimeout> | null = null
    watch(dirname(abs), (_event, filename) => {
      if (filename !== basename(abs)) return
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => { console.log('[ebs] card cache changed, reloading'); loadCache() }, 1000)
    })
  } catch (e) {
    console.error('[ebs] could not watch card cache for changes:', e)
  }

  const server = Bun.serve({
    port: PORT,
    hostname: '127.0.0.1',
    // server-enforced body ceiling: /detect's Content-Length check is bypassable via chunked
    // transfer (no Content-Length), so without this an unauthenticated POST could make Bun
    // buffer up to its 128MB default — memory-pressure DoS on a low-RAM host. 200k covers the
    // 100k payload cap + headers; Bun rejects oversize bodies during read, before req.json().
    maxRequestBodySize: 200_000,
    fetch: handleRequest,
    // last-resort guard: any uncaught throw in a route (malformed input, a bug) returns a
    // clean 500 instead of leaking Bun's default error page (with a stack) on a public route.
    error(e) {
      console.error('[ebs] unhandled request error:', e)
      return new Response('internal error', { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } })
    },
  })

  console.log(`[ebs] listening on :${server.port}`)
}

init()
