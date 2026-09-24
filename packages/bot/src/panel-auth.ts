// twitch oauth (authorization-code + pkce) for the mod control panel. a mod's own twitch
// login is the only credential the panel accepts — no bot secret ever reaches the browser,
// and twitch tokens never touch disk or a log line. sessions are in-memory only: a restart
// logs everyone out, which is the point (nothing to leak, nothing to rotate).

import { randomBytes, createHash } from 'crypto'
import { log } from './log'
import { BOT_ADMINS } from './commands'
import { getJoinedChannels } from './ai-cache'

const CLIENT_ID = process.env.TWITCH_CLIENT_ID ?? ''
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET ?? ''
const PANEL_ORIGIN = process.env.PANEL_ORIGIN ?? ''
const SCOPE = 'user:read:moderated_channels'

const AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize'
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token'
const REVOKE_URL = 'https://id.twitch.tv/oauth2/revoke'
const HELIX = 'https://api.twitch.tv/helix'
const FETCH_TIMEOUT = 10_000

export const SESSION_COOKIE = 'bzi_s'
const STATE_TTL_MS = 10 * 60_000
const SESSION_TTL_MS = 12 * 60 * 60_000
const RECHECK_MS = 5 * 60_000
const MAX_SESSIONS = 500
const MAX_PENDING = 1000
const MAX_MOD_PAGES = 20 // 2000 channels — a hard cap, not a real-world number

// http:// localhost is the only origin allowed to skip Secure, so local dev works without tls
const isLocalhost = PANEL_ORIGIN.startsWith('http://localhost')

// test seam — swap in a mock instead of hitting real twitch
let doFetch: typeof fetch = fetch
export function __setFetchForTest(fn: typeof fetch | null): void { doFetch = fn ?? fetch }

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// --- pkce / state: single-use, short-lived, keyed by the state param itself so no cookie
// is needed until a session actually exists ---
interface PendingAuth { verifier: string; createdAt: number }
const pending = new Map<string, PendingAuth>()

function prunePending(): void {
  const cutoff = Date.now() - STATE_TTL_MS
  for (const [k, v] of pending) if (v.createdAt < cutoff) pending.delete(k)
}

export function redirectUri(): string {
  return `${PANEL_ORIGIN}/auth/callback`
}

export function buildLoginUrl(): string {
  prunePending()
  // bounded even under a login flood — oldest half-finished login is the one to lose
  if (pending.size >= MAX_PENDING) {
    const oldest = pending.keys().next().value
    if (oldest !== undefined) pending.delete(oldest)
  }
  const state = b64url(randomBytes(24))
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  pending.set(state, { verifier, createdAt: Date.now() })
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  return `${AUTHORIZE_URL}?${params}`
}

// --- sessions ---

export interface Session {
  login: string
  userId: string
  token: string
  refreshToken: string
  channels: string[]
  admin: boolean
  exp: number
  checkedAt: number
}

const sessions = new Map<string, Session>()

function newSessionId(): string {
  return b64url(randomBytes(32))
}

// evict the oldest session (insertion order) rather than refuse a new login — a stale
// session is worthless the moment it's evicted, a refused login blocks a mod entirely.
function evictIfFull(): void {
  if (sessions.size < MAX_SESSIONS) return
  const oldest = sessions.keys().next().value
  if (oldest !== undefined) sessions.delete(oldest)
}

export function sessionCookie(id: string | null, maxAgeSec: number): string {
  const secure = isLocalhost ? '' : '; Secure'
  return `${SESSION_COOKIE}=${id ?? ''}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${secure}`
}

/** raw cookie value, unverified — panel-server uses this only to key rate limits/caps
 * for a request that has already passed getSession(). */
export function cookieSessionId(req: Request): string | null {
  const header = req.headers.get('Cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i === -1) continue
    if (part.slice(0, i).trim() === SESSION_COOKIE) return part.slice(i + 1).trim()
  }
  return null
}

// --- helix / token helpers ---

interface TokenResp { access_token: string; refresh_token: string; expires_in: number }

async function exchangeCode(code: string, verifier: string): Promise<TokenResp> {
  const res = await doFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  })
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`)
  return res.json() as Promise<TokenResp>
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResp> {
  const res = await doFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  })
  if (!res.ok) throw new Error(`token refresh failed: ${res.status}`)
  return res.json() as Promise<TokenResp>
}

async function revokeAccessToken(token: string): Promise<void> {
  await doFetch(REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, token }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  })
}

async function helixGet(path: string, token: string): Promise<Response> {
  return doFetch(`${HELIX}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Client-Id': CLIENT_ID },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  })
}

async function fetchSelf(token: string): Promise<{ id: string; login: string } | null> {
  const res = await helixGet('/users', token)
  if (!res.ok) return null
  const data = (await res.json()) as { data: { id: string; login: string }[] }
  return data.data[0] ?? null
}

// null = the token is unauthorized (caller should try a refresh, then give up)
async function fetchModeratedChannels(userId: string, token: string): Promise<string[] | null> {
  const out: string[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_MOD_PAGES; page++) {
    const qs = new URLSearchParams({ user_id: userId, first: '100' })
    if (cursor) qs.set('after', cursor)
    const res = await helixGet(`/moderation/channels?${qs}`, token)
    if (res.status === 401) return null
    if (!res.ok) return out
    const data = (await res.json()) as { data: { broadcaster_login: string }[]; pagination?: { cursor?: string } }
    out.push(...data.data.map((d) => d.broadcaster_login.toLowerCase()))
    cursor = data.pagination?.cursor
    if (!cursor) break
  }
  return out
}

function computeChannels(login: string, moderated: string[]): { channels: string[]; admin: boolean } {
  const joined = new Set(getJoinedChannels().map((c) => c.toLowerCase()))
  const lower = login.toLowerCase()
  if (BOT_ADMINS.has(lower)) return { channels: [...joined], admin: true }
  const mod = new Set(moderated)
  mod.add(lower) // own channel counts even when twitch doesn't list you as your own mod
  return { channels: [...mod].filter((c) => joined.has(c)), admin: false }
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

// --- routes (panel-server wires these in; it owns security headers/origin checks) ---

export function handleLogin(): Response {
  return new Response(null, { status: 302, headers: { Location: buildLoginUrl() } })
}

export async function handleCallback(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const err = url.searchParams.get('error')
  if (err) return textResponse(400, 'twitch declined the login')
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state) return textResponse(400, 'missing code or state')

  const entry = pending.get(state)
  pending.delete(state) // single-use regardless of outcome — a replayed state always fails
  if (!entry || Date.now() - entry.createdAt > STATE_TTL_MS) {
    return textResponse(400, 'login link expired — try again')
  }

  let tok: TokenResp
  try {
    tok = await exchangeCode(code, entry.verifier)
  } catch (e) {
    log(`panel: oauth exchange failed: ${e}`)
    return textResponse(400, 'login failed — try again')
  }

  const self = await fetchSelf(tok.access_token)
  if (!self) return textResponse(400, 'login failed — try again')

  const moderated = await fetchModeratedChannels(self.id, tok.access_token)
  const { channels, admin } = computeChannels(self.login, moderated ?? [])
  if (channels.length === 0) {
    return textResponse(200, "you're not a mod in any channel bazaarinfo is in")
  }

  evictIfFull()
  const id = newSessionId()
  sessions.set(id, {
    login: self.login.toLowerCase(),
    userId: self.id,
    token: tok.access_token,
    refreshToken: tok.refresh_token,
    channels,
    admin,
    exp: Date.now() + SESSION_TTL_MS,
    checkedAt: Date.now(),
  })
  return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': sessionCookie(id, 12 * 3600) } })
}

export async function handleLogout(req: Request): Promise<Response> {
  const id = cookieSessionId(req)
  if (id) {
    const s = sessions.get(id)
    sessions.delete(id)
    if (s) {
      try { await revokeAccessToken(s.token) } catch (e) { log(`panel: token revoke failed: ${e}`) }
    }
  }
  return new Response(null, { status: 204, headers: { 'Set-Cookie': sessionCookie(null, 0) } })
}

// one re-check per session at a time: parallel requests (sse + an action) must share it,
// or two refreshes race and the loser's spent refresh token kills a valid session
const inflight = new Map<string, Promise<boolean>>()
function reverifyOnce(id: string, s: Session): Promise<boolean> {
  let p = inflight.get(id)
  if (!p) {
    p = reverify(id, s).finally(() => inflight.delete(id))
    inflight.set(id, p)
  }
  return p
}

// re-verify the mod list against twitch. false clears the session (401ed even after a
// refresh attempt, or the mod is left with zero allowed channels).
async function reverify(id: string, s: Session): Promise<boolean> {
  let moderated = await fetchModeratedChannels(s.userId, s.token)
  if (moderated === null) {
    try {
      const tok = await refreshAccessToken(s.refreshToken)
      s.token = tok.access_token
      s.refreshToken = tok.refresh_token
      moderated = await fetchModeratedChannels(s.userId, s.token)
    } catch (e) {
      log(`panel: session refresh failed for ${s.login}: ${e}`)
      moderated = null
    }
  }
  if (moderated === null) { sessions.delete(id); return false }
  const { channels, admin } = computeChannels(s.login, moderated)
  if (channels.length === 0) { sessions.delete(id); return false }
  s.channels = channels
  s.admin = admin
  s.checkedAt = Date.now()
  return true
}

/** the only door into a Session — expired/forged/demoded cookies all resolve to null. */
export async function getSession(req: Request): Promise<Session | null> {
  const id = cookieSessionId(req)
  if (!id) return null
  const s = sessions.get(id)
  if (!s) return null
  if (Date.now() > s.exp) { sessions.delete(id); return null }
  if (Date.now() - s.checkedAt < RECHECK_MS) return s
  return (await reverifyOnce(id, s)) ? s : null
}

export function __resetForTest(): void {
  sessions.clear()
  pending.clear()
}
