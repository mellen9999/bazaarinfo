// Companion-secret rotation: versioned derivation, persist-then-commit state,
// and the endpoint matrix (rotate is broadcaster-only, old secret dies instantly).

import { describe, it, expect, beforeEach, afterAll } from 'bun:test'
import { unlinkSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// env must be set before auth/index are imported (they read it at module load)
process.env.TWITCH_EXTENSION_SECRET ||= 'dGVzdA=='
process.env.COMPANION_SECRET = 'test-master-secret-value-do-not-ship'

const TEST_DIR = join(tmpdir(), `bzi-rotation-test-${process.pid}`)
mkdirSync(TEST_DIR, { recursive: true })
const TEST_PATH = join(TEST_DIR, 'rotations.json')
process.env.ROTATIONS_PATH = TEST_PATH

const { loadRotations, getVersion, bumpVersion, rotationCount } = await import('./rotation')
const { deriveChannelSecret, verifyCompanionSecret } = await import('./auth')
const { handleRequest } = await import('./index')
const { setCardCache } = await import('./routes/cards')

function resetState() {
  if (existsSync(TEST_PATH)) unlinkSync(TEST_PATH)
  loadRotations()
}

beforeEach(resetState)
afterAll(resetState) // leave a clean (empty) rotation map for other test files

// ── derivation ──────────────────────────────────────────────────────────────

describe('versioned derivation', () => {
  it('v0 is bit-identical to the legacy derivation (zero migration)', () => {
    const ch = '111000111'
    const hasher = new Bun.CryptoHasher('sha256', process.env.COMPANION_SECRET!)
    hasher.update(ch)
    expect(deriveChannelSecret(ch, 0)).toBe(hasher.digest('hex'))
  })

  it('each version derives a distinct secret; channels never collide', () => {
    const ch = '111000111'
    const v0 = deriveChannelSecret(ch, 0)
    const v1 = deriveChannelSecret(ch, 1)
    const v2 = deriveChannelSecret(ch, 2)
    expect(new Set([v0, v1, v2]).size).toBe(3)
    expect(deriveChannelSecret('222000222', 1)).not.toBe(v1)
  })

  it('bumping kills the old secret instantly and blesses the new one', () => {
    const ch = '333000333'
    const old = deriveChannelSecret(ch)
    expect(verifyCompanionSecret(old, ch)).toBe(true)
    bumpVersion(ch)
    expect(verifyCompanionSecret(old, ch)).toBe(false)
    expect(verifyCompanionSecret(deriveChannelSecret(ch), ch)).toBe(true)
  })
})

// ── state persistence ───────────────────────────────────────────────────────

describe('rotation state', () => {
  it('missing file is fresh state: 0 rotations, everyone at v0', () => {
    expect(loadRotations()).toBe(0)
    expect(getVersion('any')).toBe(0)
    expect(rotationCount()).toBe(0)
  })

  it('a bump survives a reload from disk', () => {
    bumpVersion('444000444')
    bumpVersion('444000444')
    bumpVersion('555000555')
    expect(loadRotations()).toBe(2)
    expect(getVersion('444000444')).toBe(2)
    expect(getVersion('555000555')).toBe(1)
  })

  it('a corrupt file throws instead of failing open', () => {
    writeFileSync(TEST_PATH, 'not json')
    expect(() => loadRotations()).toThrow()
    writeFileSync(TEST_PATH, '[1,2]')
    expect(() => loadRotations()).toThrow()
    writeFileSync(TEST_PATH, '{"ch":"one"}')
    expect(() => loadRotations()).toThrow()
    writeFileSync(TEST_PATH, '{"ch":0}')
    expect(() => loadRotations()).toThrow()
  })

  it('a failed persist leaves the in-memory version unchanged (clean no-op)', () => {
    const ch = '666000666'
    const before = getVersion(ch)
    process.env.ROTATIONS_PATH = join(TEST_DIR, 'no-such-dir', 'rotations.json')
    expect(() => bumpVersion(ch)).toThrow()
    process.env.ROTATIONS_PATH = TEST_PATH
    expect(getVersion(ch)).toBe(before)
  })
})

// ── endpoints ───────────────────────────────────────────────────────────────

const enc = new TextEncoder()

function b64url(data: string | Uint8Array): string {
  const bytes = typeof data === 'string' ? enc.encode(data) : data
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function signJwt(payload: object): Promise<string> {
  const secretBytes = Uint8Array.from(atob(process.env.TWITCH_EXTENSION_SECRET!), c => c.charCodeAt(0))
  const key = await crypto.subtle.importKey(
    'raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const head = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}`
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(head))
  return `${head}.${b64url(new Uint8Array(sig))}`
}

let ipCounter = 0
function req(path: string, init: RequestInit = {}): Request {
  // unique ip per request keeps the per-ip limiter out of these tests
  const headers = new Headers(init.headers)
  headers.set('CF-Connecting-IP', `203.0.113.${++ipCounter % 250}`)
  return new Request(`https://ebs.test${path}`, { ...init, headers })
}

async function broadcasterJwt(channelId: string, role = 'broadcaster'): Promise<string> {
  return signJwt({
    exp: Math.floor(Date.now() / 1000) + 300,
    opaque_user_id: 'U1', channel_id: channelId, role,
  })
}

describe('POST /api/companion-rotate', () => {
  it('401 without a JWT, 403 for non-broadcasters', async () => {
    expect((await handleRequest(req('/api/companion-rotate', { method: 'POST' }))).status).toBe(401)
    const viewer = await broadcasterJwt('777000777', 'viewer')
    const res = await handleRequest(req('/api/companion-rotate', {
      method: 'POST', headers: { Authorization: `Bearer ${viewer}` },
    }))
    expect(res.status).toBe(403)
  })

  it('broadcaster rotate returns a fresh 64-hex secret and companion-setup agrees', async () => {
    const ch = '888000888'
    const jwt = await broadcasterJwt(ch)
    const before = deriveChannelSecret(ch)

    const res = await handleRequest(req('/api/companion-rotate', {
      method: 'POST', headers: { Authorization: `Bearer ${jwt}` },
    }))
    expect(res.status).toBe(200)
    const { secret } = await res.json() as { secret: string }
    expect(secret).toMatch(/^[a-f0-9]{64}$/)
    expect(secret).not.toBe(before)

    const setup = await handleRequest(req('/api/companion-setup', {
      headers: { Authorization: `Bearer ${jwt}` },
    }))
    expect(((await setup.json()) as { secret: string }).secret).toBe(secret)
  })

  it('/detect rejects the pre-rotate secret and accepts the new one', async () => {
    const ch = '999000999'
    const old = deriveChannelSecret(ch)
    const jwt = await broadcasterJwt(ch)
    await handleRequest(req('/api/companion-rotate', {
      method: 'POST', headers: { Authorization: `Bearer ${jwt}` },
    }))

    const detect = (secret: string) => handleRequest(req('/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: ch, secret, cards: [] }),
    }))
    expect((await detect(old)).status).toBe(401)
    expect((await detect(deriveChannelSecret(ch))).status).not.toBe(401)
  })
})

describe('GET /health/ready exposure', () => {
  const cache = { items: [], skills: [], monsters: [], fetchedAt: new Date().toISOString() }

  it('proxied requests get status only; direct localhost curls get full stats', async () => {
    setCardCache(cache as never)

    const pub = await handleRequest(req('/health/ready'))
    const pubBody = await pub.json() as Record<string, unknown>
    expect(pubBody.status).toBe('ready')
    expect(pubBody.rotations).toBe(0)
    expect(pubBody.pubsub).toBeUndefined()
    expect(pubBody.uptime).toBeUndefined()

    const internal = await handleRequest(new Request('https://ebs.test/health/ready'))
    const intBody = await internal.json() as Record<string, unknown>
    expect(intBody.pubsub).toBeDefined()
    expect(intBody.uptime).toBeDefined()
    expect(intBody.rotations).toBe(0)
  })
})
