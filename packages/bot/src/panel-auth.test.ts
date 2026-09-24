import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test'

// tests hard-set env before importing — panel-auth reads client id/secret/origin at
// import time, same convention as auth.ts / index.ts.
process.env.TWITCH_CLIENT_ID = 'test_client_id'
process.env.TWITCH_CLIENT_SECRET = 'test_client_secret'
process.env.PANEL_ORIGIN = 'http://localhost:3200'

// './commands' pulls in the entire bot dependency graph (store/db/ai/trivia/...) just for
// one Set — mock it out rather than dragging that in here. mutate the Set's contents (not
// the binding) so bun's module mock — which snapshots the returned object once — keeps seeing
// the same live Set every test.
const botAdmins = new Set<string>()
mock.module('./commands', () => ({ BOT_ADMINS: botAdmins }))

let joinedChannels: string[] = []
mock.module('./ai-cache', () => ({ getJoinedChannels: () => joinedChannels }))

const panelAuth = await import('./panel-auth')
const {
  buildLoginUrl, handleCallback, handleLogout, getSession, sessionCookie, cookieSessionId,
  __setFetchForTest, __resetForTest,
} = panelAuth

function reqWithCookie(id: string | null): Request {
  const headers = id ? { Cookie: `bzi_s=${id}` } : {}
  return new Request('http://localhost:3200/api/me', { headers })
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function bodyGrantType(init?: RequestInit): string | null {
  const body = init?.body
  if (!body) return null
  const params = new URLSearchParams(body.toString())
  return params.get('grant_type')
}

let calls: { url: string; init?: RequestInit }[] = []
let moderated: { broadcaster_login: string }[] = [{ broadcaster_login: 'kripp' }]
let selfUser = { id: 'u1', login: 'modlogin' }
let tokenOk = true
let refreshOk = true

function installFetch() {
  calls = []
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const u = url.toString()
    calls.push({ url: u, init })
    if (u.includes('oauth2/token')) {
      const grant = bodyGrantType(init)
      if (grant === 'authorization_code' && !tokenOk) return new Response('bad', { status: 400 })
      if (grant === 'refresh_token' && !refreshOk) return new Response('bad', { status: 400 })
      return jsonRes({ access_token: `tok-${grant}`, refresh_token: `ref-${grant}`, expires_in: 3600 })
    }
    if (u.includes('oauth2/revoke')) return new Response(null, { status: 200 })
    if (u.includes('/users')) return jsonRes({ data: [selfUser] })
    if (u.includes('/moderation/channels')) return jsonRes({ data: moderated, pagination: {} })
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  __setFetchForTest(fn)
}

beforeEach(() => {
  __resetForTest()
  botAdmins.clear()
  joinedChannels = ['kripp', 'modlogin']
  moderated = [{ broadcaster_login: 'kripp' }]
  selfUser = { id: 'u1', login: 'modlogin' }
  tokenOk = true
  refreshOk = true
  installFetch()
})

afterEach(() => {
  __setFetchForTest(null)
})

// --- login url / pkce ---

describe('buildLoginUrl', () => {
  it('carries client id, redirect uri, scope, state and a S256 pkce challenge', () => {
    const url = new URL(buildLoginUrl())
    expect(url.searchParams.get('client_id')).toBe('test_client_id')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3200/auth/callback')
    expect(url.searchParams.get('scope')).toBe('user:read:moderated_channels')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBeTruthy()
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
  })

  it('generates a fresh state each call', () => {
    const a = new URL(buildLoginUrl()).searchParams.get('state')
    const b = new URL(buildLoginUrl()).searchParams.get('state')
    expect(a).not.toBe(b)
  })
})

// --- callback ---

async function doLogin(): Promise<{ state: string }> {
  const url = new URL(buildLoginUrl())
  return { state: url.searchParams.get('state')! }
}

describe('handleCallback', () => {
  it('400s on missing code/state', async () => {
    const res = await handleCallback(new Request('http://localhost:3200/auth/callback'))
    expect(res.status).toBe(400)
  })

  it('400s when twitch reports an error param', async () => {
    const res = await handleCallback(new Request('http://localhost:3200/auth/callback?error=access_denied'))
    expect(res.status).toBe(400)
  })

  it('400s on an unknown state', async () => {
    const res = await handleCallback(new Request('http://localhost:3200/auth/callback?code=abc&state=neverissued'))
    expect(res.status).toBe(400)
  })

  it('400s on a replayed state (single-use)', async () => {
    const { state } = await doLogin()
    const first = await handleCallback(new Request(`http://localhost:3200/auth/callback?code=abc&state=${state}`))
    expect(first.status).toBe(302)
    const replay = await handleCallback(new Request(`http://localhost:3200/auth/callback?code=abc&state=${state}`))
    expect(replay.status).toBe(400)
  })

  it('400s on an expired state', async () => {
    const realNow = Date.now
    const { state } = await doLogin()
    Date.now = () => realNow() + 11 * 60_000 // past the 10min ttl
    const res = await handleCallback(new Request(`http://localhost:3200/auth/callback?code=abc&state=${state}`))
    Date.now = realNow
    expect(res.status).toBe(400)
  })

  it('on success sets a session cookie and redirects to /', async () => {
    const { state } = await doLogin()
    const res = await handleCallback(new Request(`http://localhost:3200/auth/callback?code=abc&state=${state}`))
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/')
    const cookie = res.headers.get('Set-Cookie')
    expect(cookie).toContain('bzi_s=')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
  })

  it('mod-in-a-channel + own channel intersected with joined channels', async () => {
    moderated = [{ broadcaster_login: 'kripp' }, { broadcaster_login: 'not_joined' }]
    joinedChannels = ['kripp', 'modlogin']
    const { state } = await doLogin()
    const res = await handleCallback(new Request(`http://localhost:3200/auth/callback?code=abc&state=${state}`))
    const cookie = res.headers.get('Set-Cookie')!
    const id = /bzi_s=([^;]+)/.exec(cookie)![1]
    const session = await getSession(reqWithCookie(id))
    expect(session?.channels.sort()).toEqual(['kripp', 'modlogin'])
    expect(session?.admin).toBe(false)
  })

  it('BOT_ADMINS gets admin=true and every joined channel', async () => {
    botAdmins.add('modlogin')
    moderated = [] // admin bypasses the moderated-channels intersection
    joinedChannels = ['kripp', 'other_channel']
    const { state } = await doLogin()
    const res = await handleCallback(new Request(`http://localhost:3200/auth/callback?code=abc&state=${state}`))
    const id = /bzi_s=([^;]+)/.exec(res.headers.get('Set-Cookie')!)![1]
    const session = await getSession(reqWithCookie(id))
    expect(session?.admin).toBe(true)
    expect(session?.channels.sort()).toEqual(['kripp', 'other_channel'])
  })

  it('zero allowed channels: no session, plain not-a-mod message', async () => {
    moderated = []
    joinedChannels = ['kripp']
    selfUser = { id: 'u1', login: 'randomviewer' }
    const { state } = await doLogin()
    const res = await handleCallback(new Request(`http://localhost:3200/auth/callback?code=abc&state=${state}`))
    expect(res.status).toBe(200)
    expect(res.headers.get('Set-Cookie')).toBeNull()
    expect(await res.text()).toContain("not a mod")
  })

  it('token exchange failure fails cleanly', async () => {
    tokenOk = false
    const { state } = await doLogin()
    const res = await handleCallback(new Request(`http://localhost:3200/auth/callback?code=abc&state=${state}`))
    expect(res.status).toBe(400)
  })
})

// --- session lookups ---

describe('getSession', () => {
  it('no cookie -> null', async () => {
    expect(await getSession(reqWithCookie(null))).toBeNull()
  })

  it('forged/unknown cookie -> null', async () => {
    expect(await getSession(reqWithCookie('not-a-real-session'))).toBeNull()
  })

  async function loggedInId(): Promise<string> {
    const { state } = await doLogin()
    const res = await handleCallback(new Request(`http://localhost:3200/auth/callback?code=abc&state=${state}`))
    return /bzi_s=([^;]+)/.exec(res.headers.get('Set-Cookie')!)![1]
  }

  it('expired session -> null', async () => {
    const id = await loggedInId()
    const realNow = Date.now
    Date.now = () => realNow() + 13 * 3600_000 // past the 12h ttl
    const session = await getSession(reqWithCookie(id))
    Date.now = realNow
    expect(session).toBeNull()
  })

  it('fresh session returns without re-checking twitch', async () => {
    const id = await loggedInId()
    calls = []
    const session = await getSession(reqWithCookie(id))
    expect(session?.login).toBe('modlogin')
    expect(calls.length).toBe(0) // still inside the 5min recheck window
  })

  it('stale session lazily re-verifies and drops a demodded channel', async () => {
    const id = await loggedInId()
    const realNow = Date.now
    Date.now = () => realNow() + 6 * 60_000 // past the 5min recheck window
    moderated = [] // twitch says: no longer a mod anywhere
    joinedChannels = ['kripp'] // own login ('modlogin') no longer joined either
    const session = await getSession(reqWithCookie(id))
    Date.now = realNow
    expect(session).toBeNull() // zero channels left -> session dropped entirely
  })

  it('demod that leaves at least one channel keeps the session, drops just that channel', async () => {
    joinedChannels = ['kripp', 'modlogin']
    moderated = [{ broadcaster_login: 'kripp' }]
    const id = await loggedInId()
    const realNow = Date.now
    Date.now = () => realNow() + 6 * 60_000
    moderated = [] // demodded from kripp, but 'modlogin' (own channel) still counts
    const session = await getSession(reqWithCookie(id))
    Date.now = realNow
    expect(session?.channels).toEqual(['modlogin'])
  })

  it('401 on reverify tries a refresh before giving up', async () => {
    const id = await loggedInId()
    const realNow = Date.now
    Date.now = () => realNow() + 6 * 60_000
    let modCallCount = 0
    const fn = (async (url: string | URL, init?: RequestInit) => {
      const u = url.toString()
      if (u.includes('oauth2/token')) return jsonRes({ access_token: 'tok2', refresh_token: 'ref2', expires_in: 3600 })
      if (u.includes('/moderation/channels')) {
        modCallCount++
        if (modCallCount === 1) return new Response('unauthorized', { status: 401 })
        return jsonRes({ data: [{ broadcaster_login: 'kripp' }], pagination: {} })
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch
    __setFetchForTest(fn)
    const session = await getSession(reqWithCookie(id))
    Date.now = realNow
    expect(session).not.toBeNull()
    expect(modCallCount).toBe(2) // first 401, refreshed, retried
  })
})

// --- logout ---

describe('handleLogout', () => {
  it('revokes the token and clears the cookie', async () => {
    const { state } = await doLogin()
    const cbRes = await handleCallback(new Request(`http://localhost:3200/auth/callback?code=abc&state=${state}`))
    const id = /bzi_s=([^;]+)/.exec(cbRes.headers.get('Set-Cookie')!)![1]

    calls = []
    const res = await handleLogout(reqWithCookie(id))
    expect(res.status).toBe(204)
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0')
    expect(calls.some((c) => c.url.includes('oauth2/revoke'))).toBe(true)

    expect(await getSession(reqWithCookie(id))).toBeNull()
  })

  it('no cookie is a harmless no-op', async () => {
    const res = await handleLogout(reqWithCookie(null))
    expect(res.status).toBe(204)
  })
})

describe('sessionCookie / cookieSessionId', () => {
  it('secure flag depends on localhost origin', () => {
    expect(sessionCookie('abc', 3600)).not.toContain('Secure')
  })

  it('round-trips the cookie value', () => {
    const req = new Request('http://x', { headers: { Cookie: 'other=1; bzi_s=the-id; foo=bar' } })
    expect(cookieSessionId(req)).toBe('the-id')
  })
})
