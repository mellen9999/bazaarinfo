// BazaarInfo EBS — Extension Backend Service
// Relays companion card detections to viewers via Twitch PubSub

import { readFileSync } from 'fs'
import type { CardCache } from '@bazaarinfo/shared'
import { verifyTwitchJwt } from './auth'
import { handleCards, setCardCache } from './routes/cards'
import { handleImage } from './routes/images'
import { handleDetect } from './routes/detect'

const PORT = parseInt(process.env.EBS_PORT ?? '3100')

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
}

function cors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    res.headers.set(k, v)
  }
  return res
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname

  // CORS preflight
  if (req.method === 'OPTIONS') {
    return cors(new Response(null, { status: 204 }))
  }

  // POST /detect — companion → PubSub (uses companion secret, not JWT)
  if (req.method === 'POST' && path === '/detect') {
    return cors(await handleDetect(req))
  }

  // All other routes require valid Twitch JWT
  if (path.startsWith('/api/')) {
    const auth = await verifyTwitchJwt(req.headers.get('Authorization'))
    if (!auth) {
      console.log(`[ebs] auth failed: ${path} from ${req.headers.get('Origin') ?? 'unknown'}`)
      return cors(new Response('unauthorized', { status: 401 }))
    }
  }

  // GET /api/cards
  if (req.method === 'GET' && path === '/api/cards') {
    return cors(handleCards())
  }

  // GET /api/images/:hash
  const imageMatch = path.match(/^\/api\/images\/([a-f0-9]+)$/)
  if (req.method === 'GET' && imageMatch) {
    return cors(await handleImage(imageMatch[1]))
  }

  // GET /health
  if (req.method === 'GET' && path === '/health') {
    return cors(new Response('ok'))
  }

  return cors(new Response('not found', { status: 404 }))
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
    fetch: handleRequest,
  })

  console.log(`[ebs] listening on :${server.port}`)
}

init()
