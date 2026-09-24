import { describe, expect, it, mock, beforeEach } from 'bun:test'

process.env.PANEL_ORIGIN = 'http://localhost:3200'
process.env.PANEL_PORT = '0'

// isolate the http layer: control.ts/db.ts/panel-auth.ts each have their own dependency
// graphs (and their own test files) — this suite only exercises routing, auth gating,
// origin/content-type/size checks, and the SSE framing.

interface FakeSession { login: string; admin: boolean; channels: string[] }

let currentSession: FakeSession | null = null
let currentSid = 'sid1'
const mockGetSession = mock(async (_req: Request) => currentSession)
const mockCookieSessionId = mock((_req: Request) => currentSid)
const mockHandleLogin = mock(() => new Response(null, { status: 302, headers: { Location: 'https://id.twitch.tv/authorize' } }))
const mockHandleCallback = mock(async (_req: Request) => new Response(null, { status: 302, headers: { Location: '/' } }))
const mockHandleLogout = mock(async (_req: Request) => new Response(null, { status: 204 }))

mock.module('./panel-auth', () => ({
  handleLogin: mockHandleLogin,
  handleCallback: mockHandleCallback,
  handleLogout: mockHandleLogout,
  getSession: mockGetSession,
  cookieSessionId: mockCookieSessionId,
}))

let parseActionResult: { kind: string; [k: string]: unknown } | null = { kind: 'pause', feature: 'trivia' }
const mockParseAction = mock((_input: unknown) => parseActionResult)
const mockDescribe = mock(() => 'did the thing')
const mockAct = mock(async (_ch: string, _by: string, _a: unknown) => ({ ok: true, msg: 'did the thing' }))
const mockSnapshot = mock((ch: string) => ({ channel: ch, now: 1, fake: true }))
const mockOnControlChange = mock((_fn: (ch: string) => void) => () => {})

mock.module('./control', () => ({
  parseAction: mockParseAction,
  describe: mockDescribe,
  act: mockAct,
  snapshot: mockSnapshot,
  onControlChange: mockOnControlChange,
  ADMIN_KINDS: new Set(['join', 'part']),
}))

const mockLogPanelAction = mock((_login: string, _ch: string, _kind: string, _detail: string) => {})
mock.module('./db', () => ({ logPanelAction: mockLogPanelAction }))

let parseControlIntentResult: { kind: string } | null = null
mock.module('./control-intent', () => ({
  parseControlIntent: mock(async (_text: string, _ch: string) => parseControlIntentResult),
}))

const { __handleForTest: handle } = await import('./panel-server')

const ORIGIN = 'http://localhost:3200'

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return handle(new Request(`${ORIGIN}${path}`, { headers }))
}
function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return handle(new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }))
}

beforeEach(() => {
  currentSession = { login: 'modlogin', admin: false, channels: ['kripp'] }
  currentSid = 'sid1'
  parseActionResult = { kind: 'pause', feature: 'trivia' }
  parseControlIntentResult = null
  mockGetSession.mockClear()
  mockAct.mockClear()
  mockLogPanelAction.mockClear()
})

// --- security headers, on every response ---

describe('security headers', () => {
  it('are set on a 404', async () => {
    const res = await get('/nope')
    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'")
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
  })

  it('sets no-store on api responses only', async () => {
    currentSession = null
    const api = await get('/api/me')
    expect(api.headers.get('Cache-Control')).toBe('no-store')
    const notApi = await get('/nope')
    expect(notApi.headers.get('Cache-Control')).not.toBe('no-store')
  })
})

// --- /api/me ---

describe('GET /api/me', () => {
  it('401s with no session', async () => {
    currentSession = null
    const res = await get('/api/me')
    expect(res.status).toBe(401)
  })

  it('returns login/admin/channels for a valid session', async () => {
    const res = await get('/api/me')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ login: 'modlogin', admin: false, channels: ['kripp'] })
  })
})

// --- /api/act ---

describe('POST /api/act', () => {
  it('403s on a bad Origin', async () => {
    const res = await handle(new Request(`${ORIGIN}/api/act`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'kripp', action: parseActionResult }),
    }))
    expect(res.status).toBe(403)
  })

  it('415s on the wrong content-type', async () => {
    const res = await handle(new Request(`${ORIGIN}/api/act`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'text/plain' },
      body: 'x',
    }))
    expect(res.status).toBe(415)
  })

  it('413s on an oversized body', async () => {
    const big = JSON.stringify({ channel: 'kripp', action: { kind: 'say', text: 'x'.repeat(5000) } })
    const res = await handle(new Request(`${ORIGIN}/api/act`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'Content-Length': String(big.length) },
      body: big,
    }))
    expect(res.status).toBe(413)
  })

  it('400s when parseAction rejects the body', async () => {
    parseActionResult = null
    const res = await post('/api/act', { channel: 'kripp', action: { kind: 'nonsense' } })
    expect(res.status).toBe(400)
  })

  it('403s acting on a channel outside the session', async () => {
    const res = await post('/api/act', { channel: 'someone_else', action: parseActionResult })
    expect(res.status).toBe(403)
    expect(mockAct).not.toHaveBeenCalled()
  })

  it('403s a non-admin kind requiring admin (join)', async () => {
    parseActionResult = { kind: 'join', target: 'newchan' }
    currentSession = { login: 'modlogin', admin: false, channels: ['kripp'] }
    const res = await post('/api/act', { channel: 'kripp', action: parseActionResult })
    expect(res.status).toBe(403)
    expect(mockAct).not.toHaveBeenCalled()
  })

  it('allows an admin-kind action for an admin session and logs it', async () => {
    parseActionResult = { kind: 'join', target: 'newchan' }
    currentSession = { login: 'owner', admin: true, channels: ['kripp'] }
    const res = await post('/api/act', { channel: 'kripp', action: parseActionResult })
    expect(res.status).toBe(200)
    expect(mockAct).toHaveBeenCalledWith('kripp', 'owner', parseActionResult)
    expect(mockLogPanelAction).toHaveBeenCalledTimes(1)
  })

  it('runs a normal (non-admin-kind) action for any session member', async () => {
    const res = await post('/api/act', { channel: 'kripp', action: parseActionResult })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, msg: 'did the thing' })
  })

  it('401s with no session, before any origin/body work matters', async () => {
    currentSession = null
    const res = await post('/api/act', { channel: 'kripp', action: parseActionResult })
    expect(res.status).toBe(401)
  })
})

// --- /api/parse ---

describe('POST /api/parse', () => {
  it('403s for a channel outside the session', async () => {
    const res = await post('/api/parse', { channel: 'someone_else', text: 'pause trivia' })
    expect(res.status).toBe(403)
  })

  it('400s on text over 300 chars', async () => {
    const res = await post('/api/parse', { channel: 'kripp', text: 'x'.repeat(301) })
    expect(res.status).toBe(400)
  })

  it('returns {action:null} when nothing parses', async () => {
    parseControlIntentResult = null
    const res = await post('/api/parse', { channel: 'kripp', text: 'do a barrel roll' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ action: null })
  })

  it('returns {action, preview} when it parses', async () => {
    parseControlIntentResult = { kind: 'trivia-skip' }
    const res = await post('/api/parse', { channel: 'kripp', text: 'skip this question' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ action: { kind: 'trivia-skip' }, preview: 'did the thing' })
  })

  it('never calls act — parse only previews', async () => {
    parseControlIntentResult = { kind: 'trivia-skip' }
    await post('/api/parse', { channel: 'kripp', text: 'skip this question' })
    expect(mockAct).not.toHaveBeenCalled()
  })
})

// --- /api/stream (SSE) ---

describe('GET /api/stream', () => {
  it('401s with no session', async () => {
    currentSession = null
    const res = await get('/api/stream?ch=kripp')
    expect(res.status).toBe(401)
  })

  it('403s for a channel outside the session', async () => {
    const res = await get('/api/stream?ch=someone_else')
    expect(res.status).toBe(403)
  })

  it('sends an initial snap event immediately', async () => {
    currentSid = 'sid-snap'
    const res = await get('/api/stream?ch=kripp')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/event-stream')
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    const text = new TextDecoder().decode(value)
    expect(text.startsWith('event: snap\ndata: ')).toBe(true)
    expect(JSON.parse(text.slice('event: snap\ndata: '.length).trim())).toEqual({ channel: 'kripp', now: 1, fake: true })
    await reader.cancel()
  })

  it('caps concurrent streams per session', async () => {
    currentSid = 'sid-cap-test'
    const opened: Response[] = []
    for (let i = 0; i < 4; i++) opened.push(await get('/api/stream?ch=kripp'))
    for (const r of opened) expect(r.status).toBe(200)
    const fifth = await get('/api/stream?ch=kripp')
    expect(fifth.status).toBe(429)
    for (const r of opened) await r.body!.cancel()
  })
})

// --- /auth/* ---

describe('/auth/*', () => {
  it('logout 403s on a bad origin', async () => {
    const res = await handle(new Request(`${ORIGIN}/auth/logout`, { method: 'POST', headers: { Origin: 'https://evil.example' } }))
    expect(res.status).toBe(403)
  })

  it('logout succeeds with the right origin', async () => {
    const res = await handle(new Request(`${ORIGIN}/auth/logout`, { method: 'POST', headers: { Origin: ORIGIN } }))
    expect(res.status).toBe(204)
  })

  it('login redirects to twitch', async () => {
    const res = await get('/auth/login', { 'cf-connecting-ip': '1.2.3.4' })
    expect(res.status).toBe(302)
  })
})
