import '../test-env'
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { handleLink, COMPANION_CLIENT_ID } from './link'
import { handleRequest } from '../index'
import { hits } from '../ratelimit'

const TOKEN = 'abcdefghij0123456789abcdefghij' // gitleaks:allow — test fixture
const CLIENT = 'ourclient'
const derive = (id: string) => `secret-for-${id}`

function req(body: unknown): Request {
  return new Request('http://x/companion/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function twitch(validate: () => Response | Promise<Response>) {
  const calls: string[] = []
  const f = (async (url: string | URL | Request) => {
    const u = String(url)
    calls.push(u)
    if (u.endsWith('/validate')) return validate()
    return new Response(null, { status: 200 })
  }) as typeof fetch
  return { f, calls }
}

const ok = (over: Record<string, unknown> = {}) =>
  () => Response.json({ client_id: CLIENT, user_id: '12345', login: 'streamer', ...over })

describe('handleLink', () => {
  it('returns the derived secret for the token owner and revokes the token', async () => {
    const { f, calls } = twitch(ok())
    const res = await handleLink(req({ token: TOKEN }), { derive, fetch: f, clientId: CLIENT })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ channelId: '12345', login: 'streamer', secret: 'secret-for-12345' }) // gitleaks:allow — test fixture
    expect(calls.some((u) => u.endsWith('/revoke'))).toBe(true)
  })

  it('rejects a token minted for another app', async () => {
    const { f } = twitch(ok({ client_id: 'someoneelse' }))
    const res = await handleLink(req({ token: TOKEN }), { derive, fetch: f, clientId: CLIENT })
    expect(res.status).toBe(403)
  })

  it('passes an expired/invalid token through as 401', async () => {
    const { f } = twitch(() => new Response('{}', { status: 401 }))
    const res = await handleLink(req({ token: TOKEN }), { derive, fetch: f, clientId: CLIENT })
    expect(res.status).toBe(401)
  })

  it('never calls twitch for a malformed token', async () => {
    for (const body of [{}, { token: 5 }, { token: 'short' }, { token: 'has spaces in it 1234567890' }, 'not json']) {
      const { f, calls } = twitch(ok())
      const res = await handleLink(req(body), { derive, fetch: f, clientId: CLIENT })
      expect(res.status).toBe(400)
      expect(calls.length).toBe(0)
    }
  })

  it('fails closed on a twitch outage or garbage reply', async () => {
    for (const v of [
      () => { throw new Error('down') },
      () => new Response('oops', { status: 500 }),
      () => new Response('not json', { status: 200 }),
      ok({ user_id: 'not-a-number' }),
      ok({ user_id: undefined }),
    ]) {
      const { f } = twitch(v as () => Response)
      const res = await handleLink(req({ token: TOKEN }), { derive, fetch: f, clientId: CLIENT })
      expect(res.status).toBe(502)
    }
  })

  it('still answers when the revoke call fails', async () => {
    const f = (async (url: string | URL | Request) => {
      if (String(url).endsWith('/revoke')) throw new Error('down')
      return ok()()
    }) as typeof fetch
    const res = await handleLink(req({ token: TOKEN }), { derive, fetch: f, clientId: CLIENT })
    expect(res.status).toBe(200)
  })
})

describe('POST /companion/link routing', () => {
  const post = () => new Request('http://x/companion/link', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': '203.0.113.9' },
    body: '{}',
  })

  it('is reachable without a twitch extension jwt', async () => {
    hits.clear()
    expect((await handleRequest(post())).status).toBe(400)
  })

  it('has its own tight rate bucket', async () => {
    hits.clear()
    for (let i = 0; i < 10; i++) expect((await handleRequest(post())).status).toBe(400)
    expect((await handleRequest(post())).status).toBe(429)
  })
})

it('companion and ebs agree on the twitch client id', () => {
  const py = readFileSync(join(import.meta.dir, '../../../companion/logwatch.py'), 'utf-8')
  expect(py).toContain(`TWITCH_CLIENT_ID = "${COMPANION_CLIENT_ID}"`)
})
