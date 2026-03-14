// BazaarInfo EBS — Extension Backend Service
// Relays companion card detections to viewers via Twitch PubSub

import { readFileSync } from 'fs'
import type { CardCache } from '@bazaarinfo/shared'
import { verifyTwitchJwt } from './auth'
import { handleCards, setCardCache } from './routes/cards'
import { handleImage } from './routes/images'
import { handleDetect } from './routes/detect'

const PORT = parseInt(process.env.EBS_PORT ?? '3100')

const TWITCH_ORIGIN_RE = /\.ext-twitch\.tv$/

function allowedOrigin(req: Request): string | null {
  const origin = req.headers.get('Origin')
  if (!origin) return null
  try {
    const host = new URL(origin).hostname
    if (TWITCH_ORIGIN_RE.test(host)) return origin
  } catch {}
  return null
}

// Simple per-IP rate limiter: 60 req/min, resets every minute
const MAX_RATE_ENTRIES = 10_000
const hits = new Map<string, number>()
setInterval(() => hits.clear(), 60_000)

function rateOk(ip: string, max = 60): boolean {
  const n = (hits.get(ip) ?? 0) + 1
  if (hits.size >= MAX_RATE_ENTRIES && !hits.has(ip)) return false
  hits.set(ip, n)
  return n <= max
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
  return req.headers.get('CF-Connecting-IP')
    || req.headers.get('X-Forwarded-For')?.split(',')[0].trim()
    || 'unknown'
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
  if (path.startsWith('/api/')) {
    const auth = await verifyTwitchJwt(req.headers.get('Authorization'))
    if (!auth) {
      console.log(`[ebs] auth failed: ${path}`)
      return cors(new Response('unauthorized', { status: 401 }), origin)
    }
  }

  // GET /api/cards
  if (req.method === 'GET' && path === '/api/cards') {
    return cors(handleCards(), origin)
  }

  // GET /api/images/:hash
  const imageMatch = path.match(/^\/api\/images\/([a-f0-9]+)$/)
  if (req.method === 'GET' && imageMatch) {
    return cors(await handleImage(imageMatch[1]), origin)
  }

  // GET /health
  if (req.method === 'GET' && path === '/health') {
    return cors(new Response('ok'), origin)
  }

  return cors(new Response('not found', { status: 404 }), origin)
}

const CACHE_PATH = process.env.CACHE_PATH ?? 'cache/items.json'

// Load card cache from local file (written by the bot's scraper)
function init() {
  console.log(`[ebs] loading card cache from ${CACHE_PATH}...`)
  try {
    const cache = JSON.parse(readFileSync(CACHE_PATH, 'utf-8')) as CardCache
    setCardCache(cache)
    console.log(`[ebs] loaded ${cache.items.length} items, ${cache.skills.length} skills, ${cache.monsters.length} monsters`)
  } catch (e) {
    console.error('[ebs] failed to load card cache:', e)
    process.exit(1)
  }

  const server = Bun.serve({
    port: PORT,
    hostname: '127.0.0.1',
    fetch: handleRequest,
  })

  console.log(`[ebs] listening on :${server.port}`)
}

init()
