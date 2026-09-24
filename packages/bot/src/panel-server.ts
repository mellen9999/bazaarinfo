// mods-only web control center, served from the bot process — the only place the live
// state (suppressions, vibes, trivia round, raid) actually lives. auth is panel-auth.ts;
// this file is the http surface: routing, security headers, rate limits, and the three
// api routes that read/act on control.ts.

import { resolve } from 'path'
import { log } from './log'
import * as db from './db'
import { parseAction, describe, act, snapshot, onControlChange, ADMIN_KINDS, type Action } from './control'
import { handleLogin, handleCallback, handleLogout, getSession, cookieSessionId } from './panel-auth'
import { parseControlIntent } from './control-intent'

const PANEL_ORIGIN = process.env.PANEL_ORIGIN ?? ''
const PANEL_PORT = parseInt(process.env.PANEL_PORT ?? '3200')
const BODY_MAX = 4096
const MAX_STREAMS_PER_SESSION = 4

const CSP = "default-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"

const PANEL_DIR = resolve(import.meta.dir, '../panel')
const INDEX_HTML = resolve(PANEL_DIR, 'index.html')
const PANEL_CSS = resolve(PANEL_DIR, 'panel.css')
const PANEL_TS = resolve(PANEL_DIR, 'panel.ts')

// --- rate limiting (same fixed-window idiom as packages/ebs/src/ratelimit.ts) ---

function makeLimiter(windowMs: number, max: number): (key: string) => boolean {
  const hits = new Map<string, number>()
  const timer = setInterval(() => hits.clear(), windowMs)
  if (typeof timer.unref === 'function') timer.unref()
  return (key: string) => {
    const n = (hits.get(key) ?? 0) + 1
    hits.set(key, n)
    return n <= max
  }
}

const authLimiter = makeLimiter(60_000, 20) // per-ip, /auth/*
const apiLimiter = makeLimiter(10_000, 30) // per-session, /api/act + /api/parse combined

// mirrors ebs: no proxy header means we can't distinguish viewers, so fail open for
// service and let the per-session/per-ip limiter downstream still bound abuse where it can.
function getIp(req: Request): string | null {
  const cf = req.headers.get('cf-connecting-ip')
  if (cf) return cf
  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    const comma = xff.indexOf(',')
    return comma === -1 ? xff.trim() : xff.slice(0, comma).trim()
  }
  return null
}

function authRateOk(req: Request): boolean {
  const ip = getIp(req)
  return ip === null ? true : authLimiter(ip)
}

// --- static assets ---

let warnedMissingAsset = false
function warnMissing(path: string): void {
  if (warnedMissingAsset) return
  warnedMissingAsset = true
  log(`panel: missing frontend asset ${path} — control panel UI unavailable until built`)
}

async function serveFile(path: string, contentType: string): Promise<Response> {
  const f = Bun.file(path)
  if (!(await f.exists())) {
    warnMissing(path)
    return new Response('panel frontend not built', { status: 503 })
  }
  return new Response(f, { headers: { 'Content-Type': contentType } })
}

let builtPanelJs: string | null = null
async function buildPanelJs(): Promise<void> {
  try {
    const result = await Bun.build({ entrypoints: [PANEL_TS], minify: true, target: 'browser' })
    if (!result.success || result.outputs.length === 0) throw new Error('build produced no output')
    builtPanelJs = await result.outputs[0].text()
  } catch (e) {
    warnMissing(PANEL_TS)
    log(`panel: panel.js build failed: ${e}`)
    builtPanelJs = null
  }
}

function servePanelJs(): Response {
  if (builtPanelJs === null) return new Response('panel frontend not built', { status: 503 })
  return new Response(builtPanelJs, { headers: { 'Content-Type': 'application/javascript; charset=utf-8' } })
}

// --- response helpers ---

function errorJson(status: number, msg?: string): Response {
  return Response.json({ error: msg ?? 'error' }, { status })
}
const json401 = () => errorJson(401, 'unauthorized')

function normChannel(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase().replace(/^#/, '') : ''
}

async function readJsonBody(req: Request, maxBytes: number): Promise<{ ok: true; data: unknown } | { ok: false; status: number }> {
  const ct = req.headers.get('Content-Type') ?? ''
  if (!ct.toLowerCase().startsWith('application/json')) return { ok: false, status: 415 }
  const len = req.headers.get('Content-Length')
  if (len && Number(len) > maxBytes) return { ok: false, status: 413 }
  const text = await req.text()
  if (text.length > maxBytes) return { ok: false, status: 413 }
  try {
    return { ok: true, data: JSON.parse(text) }
  } catch {
    return { ok: false, status: 400 }
  }
}

function requireOrigin(req: Request): boolean {
  return req.headers.get('Origin') === PANEL_ORIGIN
}

// --- api routes ---

async function apiMe(req: Request): Promise<Response> {
  const session = await getSession(req)
  if (!session) return json401()
  return Response.json({ login: session.login, admin: session.admin, channels: session.channels })
}

async function apiAct(req: Request): Promise<Response> {
  const session = await getSession(req)
  if (!session) return json401()
  const sid = cookieSessionId(req) ?? session.login
  if (!apiLimiter(sid)) return errorJson(429, 'rate limited')

  const body = await readJsonBody(req, BODY_MAX)
  if (!body.ok) return errorJson(body.status)
  const data = (body.data && typeof body.data === 'object' ? body.data : {}) as Record<string, unknown>

  const action = parseAction(data.action)
  if (!action) return errorJson(400, 'bad action')
  const ch = normChannel(data.channel)
  if (!ch || !session.channels.includes(ch)) return errorJson(403, 'not your channel')
  if (ADMIN_KINDS.has(action.kind) && !session.admin) return errorJson(403, 'admin only')

  const result = await act(ch, session.login, action)
  db.logPanelAction(session.login, ch, action.kind, describe(action))
  return Response.json(result)
}

async function apiParse(req: Request): Promise<Response> {
  const session = await getSession(req)
  if (!session) return json401()
  const sid = cookieSessionId(req) ?? session.login
  if (!apiLimiter(sid)) return errorJson(429, 'rate limited')

  const body = await readJsonBody(req, BODY_MAX)
  if (!body.ok) return errorJson(body.status)
  const data = (body.data && typeof body.data === 'object' ? body.data : {}) as Record<string, unknown>

  const ch = normChannel(data.channel)
  if (!ch || !session.channels.includes(ch)) return errorJson(403, 'not your channel')
  const text = typeof data.text === 'string' ? data.text : ''
  if (!text || text.length > 300) return errorJson(400, 'bad text')

  let action: Action | null = null
  try {
    action = await parseControlIntent(text, ch)
  } catch (e) {
    log(`panel: parse failed: ${e}`)
  }
  return Response.json(action ? { action, preview: describe(action) } : { action: null })
}

const streamCounts = new Map<string, number>()

async function apiStream(req: Request, url: URL): Promise<Response> {
  const session = await getSession(req)
  if (!session) return json401()
  const ch = normChannel(url.searchParams.get('ch'))
  if (!ch || !session.channels.includes(ch)) return errorJson(403, 'not your channel')

  const sid = cookieSessionId(req) ?? session.login
  const open = streamCounts.get(sid) ?? 0
  if (open >= MAX_STREAMS_PER_SESSION) return errorJson(429, 'too many open streams')
  // first frame built before a slot is taken — a throw here is a plain 500, never a leaked slot
  const first = JSON.stringify(snapshot(ch))
  streamCounts.set(sid, open + 1)

  let closed = false
  let lastSent = ''
  let lastPush = 0
  let off: (() => void) | null = null
  let tick: ReturnType<typeof setInterval> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let cleanup: () => void = () => {}

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder()
      const send = (pre?: string) => {
        let json: string
        try {
          json = pre ?? JSON.stringify(snapshot(ch))
        } catch (e) {
          log(`panel: snapshot failed for #${ch}: ${e}`)
          return
        }
        if (json === lastSent) return
        lastSent = json
        try { controller.enqueue(enc.encode(`event: snap\ndata: ${json}\n\n`)) } catch {}
      }
      cleanup = () => {
        if (closed) return
        closed = true
        off?.()
        if (tick) clearInterval(tick)
        if (heartbeat) clearInterval(heartbeat)
        const n = (streamCounts.get(sid) ?? 1) - 1
        if (n <= 0) streamCounts.delete(sid)
        else streamCounts.set(sid, n)
        try { controller.close() } catch {}
      }

      send(first)
      off = onControlChange((changedCh) => {
        if (changedCh !== ch) return
        const now = Date.now()
        if (now - lastPush < 1000) return // coalesce bursts of actions to <=1/s
        lastPush = now
        send()
      })
      tick = setInterval(() => send(), 2000) // catches state that drifts without an action (timers)
      heartbeat = setInterval(() => {
        try { controller.enqueue(enc.encode(': hb\n\n')) } catch {}
      }, 15_000)

      req.signal.addEventListener('abort', cleanup)
    },
    cancel() {
      cleanup()
    },
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' },
  })
}

// --- routing ---

async function guardedPost(req: Request, fn: (req: Request) => Promise<Response>): Promise<Response> {
  if (!requireOrigin(req)) return errorJson(403, 'bad origin')
  return fn(req)
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname
  const isApi = path.startsWith('/api/')

  let res: Response
  try {
    if (req.method === 'GET' && path === '/') res = await serveFile(INDEX_HTML, 'text/html; charset=utf-8')
    else if (req.method === 'GET' && path === '/panel.js') res = servePanelJs()
    else if (req.method === 'GET' && path === '/panel.css') res = await serveFile(PANEL_CSS, 'text/css; charset=utf-8')
    else if (req.method === 'GET' && path === '/auth/login') res = authRateOk(req) ? handleLogin() : errorJson(429, 'rate limited')
    else if (req.method === 'GET' && path === '/auth/callback') res = authRateOk(req) ? await handleCallback(req) : errorJson(429, 'rate limited')
    else if (req.method === 'POST' && path === '/auth/logout') res = await guardedPost(req, handleLogout)
    else if (req.method === 'GET' && path === '/api/me') res = await apiMe(req)
    else if (req.method === 'GET' && path === '/api/stream') res = await apiStream(req, url)
    else if (req.method === 'POST' && path === '/api/act') res = await guardedPost(req, apiAct)
    else if (req.method === 'POST' && path === '/api/parse') res = await guardedPost(req, apiParse)
    else res = errorJson(404, 'not found')
  } catch (e) {
    log(`panel: route error ${path}: ${e}`)
    res = errorJson(500, 'internal error')
  }

  const headers = new Headers(res.headers)
  headers.set('Content-Security-Policy', CSP)
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'no-referrer')
  if (isApi) headers.set('Cache-Control', 'no-store')
  return new Response(res.body, { status: res.status, headers })
}

export function startPanel(): ReturnType<typeof Bun.serve> | null {
  if (!PANEL_ORIGIN) {
    log('panel: PANEL_ORIGIN not set — control panel disabled')
    return null
  }
  void buildPanelJs()
  // a taken port must cost the panel, never the bot — chat keeps working without it
  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
    hostname: '127.0.0.1',
    port: PANEL_PORT,
    maxRequestBodySize: 65_536, // app-level 4KB cap does the real work; this is a backstop
    idleTimeout: 60, // SSE streams sit open; 15s heartbeats keep well under this
    fetch: handle,
    error(e) {
      log(`panel: server error: ${e}`)
      return errorJson(500, 'internal error')
    },
    })
  } catch (e) {
    log(`panel: failed to start on 127.0.0.1:${PANEL_PORT}: ${e}`)
    return null
  }
  log(`panel: listening on 127.0.0.1:${server.port}`)
  return server
}

// test seam — export unwrapped handler so tests can drive it without binding a port
export const __handleForTest = handle
