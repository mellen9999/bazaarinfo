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

const STATE_TTL_MS = 10 * 60_000
const SESSION_TTL_MS = 12 * 60 * 60_000
const RECHECK_MS = 5 * 60_000
const MAX_SESSIONS = 500
const MAX_SESSIONS_PER_USER = 3
const MAX_PENDING = 1000
const MAX_MOD_PAGES = 20 // 2000 channels — a hard cap, not a real-world number

// http:// localhost is the only origin allowed to skip Secure, so local dev works without tls
const isLocalhost = PANEL_ORIGIN.startsWith('http://localhost')
// __Host- locks a cookie to this exact origin (no Domain, Path=/, Secure mandatory) — the
// strongest binding a cookie can have, but the prefix requires Secure, which http://localhost
// dev can't offer, so it keeps the plain name there.
export const SESSION_COOKIE = isLocalhost ? 'bzi_s' : '__Host-bzi_s'
const STATE_COOKIE = isLocalhost ? 'bzi_st' : '__Host-bzi_st'

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

/** the pre-auth cookie binds the oauth `state` to THIS browser — without it, an attacker
 * who tricks a mod into visiting an attacker-initiated callback URL (a valid `state` the
 * attacker generated themselves, since `pending` is server-global) could complete a login
 * as the attacker's own twitch identity in the victim's browser session (login CSRF).
 * SameSite=Lax (not Strict) because the callback arrives as a top-level cross-site
 * redirect FROM twitch — a Strict cookie would not be sent on it at all. */
function stateCookie(value: string | null, maxAgeSec: number): string {
  const secure = isLocalhost ? '' : '; Secure'
  return `${STATE_COOKIE}=${value ?? ''}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure}`
}

function readStateCookie(req: Request): string | null {
  const header = req.headers.get('Cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i === -1) continue
    if (part.slice(0, i).trim() === STATE_COOKIE) return part.slice(i + 1).trim()
  }
  return null
}

export function buildLoginUrl(): { url: string; state: string } {
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
  return { url: `${AUTHORIZE_URL}?${params}`, state }
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

// fire-and-forget: a revoke is a courtesy to twitch, never something a request should wait
// on or fail over. every place a session's token stops being ours to use calls this.
function revokeInBackground(token: string): void {
  revokeAccessToken(token).catch((e) => log(`panel: token revoke failed: ${e}`))
}

// evict the oldest session (insertion order) rather than refuse a new login — a stale
// session is worthless the moment it's evicted, a refused login blocks a mod entirely.
function evictIfFull(): void {
  if (sessions.size < MAX_SESSIONS) return
  const oldest = sessions.entries().next().value
  if (oldest) { sessions.delete(oldest[0]); revokeInBackground(oldest[1].token) }
}

// caps how many live sessions one twitch account can hold at once — otherwise a compromised
// or scripted login could flood the global session table (and every one of them counts
// against the per-login SSE stream cap too) without ever touching another user's sessions.
function evictOldestForUser(userId: string, max: number): void {
  const mine = [...sessions.entries()].filter(([, s]) => s.userId === userId)
  while (mine.length >= max) {
    const oldest = mine.shift()
    if (!oldest) break
    sessions.delete(oldest[0])
    revokeInBackground(oldest[1].token)
  }
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

// 'unauthorized' = the token is rejected (caller should try a refresh, then give up).
// 'transient' = twitch is rate-limiting/erroring/unreachable right now — this says NOTHING
// about whether the mod is still modded, and must never be read as a demod (that was
// reverify's bug: a 5xx or a timeout logged a mod out of their own panel).
type ModResult = string[] | 'unauthorized' | 'transient'

async function fetchModeratedChannels(userId: string, token: string): Promise<ModResult> {
  const out: string[] = []
  let cursor: string | undefined
  try {
    for (let page = 0; page < MAX_MOD_PAGES; page++) {
      const qs = new URLSearchParams({ user_id: userId, first: '100' })
      if (cursor) qs.set('after', cursor)
      const res = await helixGet(`/moderation/channels?${qs}`, token)
      if (res.status === 401) return 'unauthorized'
      if (res.status === 429 || res.status >= 500) return 'transient'
      if (!res.ok) return out
      const data = (await res.json()) as { data: { broadcaster_login: string }[]; pagination?: { cursor?: string } }
      out.push(...data.data.map((d) => d.broadcaster_login.toLowerCase()))
      cursor = data.pagination?.cursor
      if (!cursor) break
    }
    return out
  } catch (e) {
    log(`panel: fetchModeratedChannels network error: ${e}`)
    return 'transient'
  }
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
  const { url, state } = buildLoginUrl()
  const headers = new Headers({ Location: url })
  headers.append('Set-Cookie', stateCookie(state, Math.floor(STATE_TTL_MS / 1000)))
  return new Response(null, { status: 302, headers })
}

// the actual callback logic; wrapped below so the pre-auth state cookie is cleared on
// EVERY exit path (success or any failure) without repeating it at each return.
async function handleCallbackInner(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const err = url.searchParams.get('error')
  if (err) return textResponse(400, 'twitch declined the login')
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state) return textResponse(400, 'missing code or state')

  // the state param must match BOTH the server-side record (proves it's a state we issued)
  // AND this browser's own pre-auth cookie (proves it's the same browser we issued it to —
  // without this second check, an attacker who captured or guessed a valid `state` value
  // could complete a login in a victim's browser as the attacker's own twitch identity).
  const cookieState = readStateCookie(req)
  if (!cookieState || cookieState !== state) return textResponse(400, 'login link expired — try again')

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
  const { channels, admin } = computeChannels(self.login, Array.isArray(moderated) ? moderated : [])
  if (channels.length === 0) {
    revokeInBackground(tok.access_token) // never sat in a session — nothing else will revoke it
    return textResponse(200, "you're not a mod in any channel bazaarinfo is in")
  }

  evictIfFull()
  evictOldestForUser(self.id, MAX_SESSIONS_PER_USER)
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

export async function handleCallback(req: Request): Promise<Response> {
  const res = await handleCallbackInner(req)
  const headers = new Headers(res.headers)
  headers.append('Set-Cookie', stateCookie(null, 0))
  return new Response(res.body, { status: res.status, headers })
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

// re-verify the mod list against twitch. false clears the session — but ONLY on a real
// auth failure (401 that survives a refresh attempt, or zero channels left); a transient
// twitch hiccup (5xx/429/timeout) keeps the existing channels and just retries next window,
// so an outage on twitch's end can never read as "you got demodded".
async function reverify(id: string, s: Session): Promise<boolean> {
  let result = await fetchModeratedChannels(s.userId, s.token)
  if (result === 'unauthorized') {
    try {
      const tok = await refreshAccessToken(s.refreshToken)
      s.token = tok.access_token
      s.refreshToken = tok.refresh_token
      result = await fetchModeratedChannels(s.userId, s.token)
    } catch (e) {
      log(`panel: session refresh failed for ${s.login}: ${e}`)
      result = 'unauthorized' // the refresh itself failed (bad/revoked token) — a real logout
    }
  }
  if (result === 'transient') {
    s.checkedAt = Date.now() // don't hammer twitch again until the next normal window
    return true
  }
  if (result === 'unauthorized') { sessions.delete(id); revokeInBackground(s.token); return false }
  const { channels, admin } = computeChannels(s.login, result)
  if (channels.length === 0) { sessions.delete(id); revokeInBackground(s.token); return false }
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
  if (Date.now() > s.exp) { sessions.delete(id); revokeInBackground(s.token); return null }
  if (Date.now() - s.checkedAt < RECHECK_MS) return s
  return (await reverifyOnce(id, s)) ? s : null
}

/**
 * pure, synchronous check — no twitch call, no reverify, never mutates anything. lets a
 * long-lived SSE stream notice a session that vanished (logout, eviction, expiry) or lost
 * this channel between the 5-minute reverify windows, without spamming twitch every 2s to
 * find out. expired-but-still-present sessions read as false but are left for getSession's
 * own lazy delete to clean up (avoids a second code path deciding when a session dies).
 */
export function sessionCovers(id: string, channel: string): boolean {
  const s = sessions.get(id)
  if (!s) return false
  if (Date.now() > s.exp) return false
  return s.channels.includes(channel)
}

export function __resetForTest(): void {
  sessions.clear()
  pending.clear()
}

// test/harness-only door into a Session — never reachable from an http route. lets a
// local harness (or a test) stand up a logged-in cookie without a real twitch oauth
// round-trip. returns the Set-Cookie value to hand back to the client.
export function __injectSessionForTest(s: Omit<Session, 'exp' | 'checkedAt'> & { exp?: number; checkedAt?: number }): string {
  evictIfFull()
  const id = newSessionId()
  sessions.set(id, { exp: Date.now() + SESSION_TTL_MS, checkedAt: Date.now(), ...s })
  return sessionCookie(id, 12 * 3600)
}
