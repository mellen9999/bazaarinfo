// BazaarInfo EBS — Extension Backend Service
// Relays companion card detections to viewers via Twitch PubSub

import { readFileSync, watch } from 'fs'
import { resolve, dirname, basename } from 'path'
import type { CardCache } from '@bazaarinfo/shared'
import { verifyTwitchJwt, deriveChannelSecret } from './auth'
import { loadRotations, bumpVersion, rotationCount } from './rotation'
import { handleCards, setCardCache, getCardCache } from './routes/cards'
import { handleImage } from './routes/images'
import { handleDetect } from './routes/detect'
import { redirectTarget } from './routes/redirects'
import { readyStatus } from './routes/health'
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

// null = no proxy header. The server is loopback-bound behind cloudflared, which
// always sets CF-Connecting-IP, so a null here is either a direct localhost curl
// (ops) or a proxy misconfiguration — never a distinguishable viewer.
function getIp(req: Request): string | null {
  const cf = req.headers.get('CF-Connecting-IP')
  if (cf) return cf
  const xff = req.headers.get('X-Forwarded-For')
  if (xff) {
    const comma = xff.indexOf(',')
    return comma === -1 ? xff.trim() : xff.slice(0, comma).trim()
  }
  return null
}

let warnedNoIp = false

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname
  const origin = allowedOrigin(req)
  const ip = getIp(req)

  // CORS preflight
  if (req.method === 'OPTIONS') {
    return cors(new Response(null, { status: 204 }), origin)
  }

  // Rate limit. The companion's /detect path gets a much higher per-IP budget than
  // the viewer default: it posts a frame on every board change (a busy shop can burst
  // well past 1/s) and is secret-authenticated, so the tight viewer cap would silently
  // drop live detections. 600/min still bounds a runaway/compromised companion.
  // Images get their own bucket: a board+panel session bursts dozens of art fetches
  // and CGNAT viewers share an IP, so sharing the 60/min viewer budget would 429
  // legitimate tooltips.
  if (ip === null) {
    // No proxy header: rate-limiting one shared 'unknown' bucket would collapse every
    // viewer into it and 429 the whole extension. Fail open for service, loudly for ops.
    if (!warnedNoIp) {
      warnedNoIp = true
      console.error('[ebs] request with no client-ip header — proxy misconfigured? rate limiting skipped for such requests')
    }
  } else {
    const image = IMAGE_PATH_RE.test(path)
    const rateMax = path === '/detect' ? 600 : image ? 300 : 60
    const bucket = image ? `img:${ip}` : ip
    if (!rateOk(bucket, rateMax)) {
      return cors(new Response('rate limited', { status: 429 }), origin)
    }
  }

  // Public redirects for the stable URLs baked into the extension (privacy/terms/
  // download). Kept server-side so their destinations can change without a review.
  if (req.method === 'GET') {
    const to = redirectTarget(path)
    if (to) return cors(new Response(null, { status: 302, headers: { Location: to } }), origin)
  }

  // POST /detect — companion → PubSub (uses companion secret, not JWT)
  if (req.method === 'POST' && path === '/detect') {
    return cors(await handleDetect(req), origin)
  }

  // GET /api/images/:hash — public. Card art is loaded by <img src> in the overlay,
  // which cannot send the Authorization header, so this MUST sit ahead of the JWT
  // gate below or every tooltip falls back to a glyph. The art is public game data
  // (hashes come straight from the public card list) and is rate-limited, so there's
  // nothing to protect by gating it.
  const imageMatch = path.match(IMAGE_PATH_RE)
  if (req.method === 'GET' && imageMatch) {
    return cors(await handleImage(imageMatch[1]), origin)
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

  // POST /api/companion-rotate — broadcaster invalidates their companion secret.
  // Bearer-token API with CORS locked to *.ext-twitch.tv: no ambient credential,
  // so the JWT is the intent proof (classic CSRF does not apply).
  if (req.method === 'POST' && path === '/api/companion-rotate' && twitchAuth) {
    if (twitchAuth.role !== 'broadcaster') {
      return cors(new Response('broadcaster only', { status: 403 }), origin)
    }
    const channelId = twitchAuth.channel_id
    try {
      const v = bumpVersion(channelId)
      console.log(`[ebs] rotated companion secret for channel ${channelId} (v${v})`)
    } catch (e) {
      // failed persist is a clean no-op: memory unchanged, old secret still works,
      // and the broadcaster is told the rotation did NOT happen
      console.error('[ebs] secret rotation failed to persist:', e)
      return cors(new Response('rotation failed', { status: 500 }), origin)
    }
    return cors(Response.json({ channelId, secret: deriveChannelSecret(channelId) }), origin)
  }

  // GET /api/cards
  if (req.method === 'GET' && path === '/api/cards') {
    return cors(handleCards(req), origin)
  }

  // GET /health/live — process is up
  if (req.method === 'GET' && path === '/health/live') {
    return cors(new Response('ok'), origin)
  }

  // GET /health/ready — card cache loaded + ready to serve. The public (proxied)
  // response is status-only: uptime, channel counts and queue depth are adoption
  // data nobody outside needs. A direct localhost curl (no proxy header) gets the
  // full stats for ops. `rotations` stays public — it's the lost-rotations-file
  // tripwire and must be checkable remotely (>=1 forever once any channel rotates).
  if (req.method === 'GET' && path === '/health/ready') {
    const cache = getCardCache()
    if (!cache) return cors(new Response('not ready', { status: 503 }), origin)
    const { cacheAgeHours, stale } = readyStatus(cache)
    const body = ip === null ? {
      status: stale ? 'stale' : 'ready',
      rotations: rotationCount(),
      uptime: Math.floor((Date.now() - STARTED_AT) / 1000),
      cards: cache.items.length,
      skills: cache.skills.length,
      monsters: cache.monsters.length,
      pubsub: pubsubStats(),
      cacheAgeHours,
    } : {
      status: stale ? 'stale' : 'ready',
      rotations: rotationCount(),
    }
    return cors(Response.json(body, { status: stale ? 503 : 200 }), origin)
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
  // fail closed on corrupt rotation state — starting with an empty map would
  // silently resurrect rotated-away (leaked) secrets
  try {
    console.log(`[ebs] loaded ${loadRotations()} secret rotation(s)`)
  } catch (e) {
    console.error('[ebs] rotations file is corrupt — refusing to start:', e)
    process.exit(1)
  }

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
    // slowloris bound — pin Bun's implicit 10s default so a runtime upgrade can't
    // silently change the public route's idle-connection exposure
    idleTimeout: 10,
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

// import.meta.main guard so tests can import handleRequest without binding the port
if (import.meta.main) init()
