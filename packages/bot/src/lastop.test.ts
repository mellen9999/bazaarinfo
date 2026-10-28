import { test, expect, afterEach } from 'bun:test'
import { lastOp } from './lastop'

const real = globalThis.fetch
afterEach(() => { globalThis.fetch = real })
const reply = (map: Record<string, unknown>) => (async (u: string) => {
  const hit = Object.entries(map).find(([k]) => String(u).includes(k))
  return hit ? new Response(JSON.stringify(hit[1])) : new Response('{}', { status: 404 })
}) as unknown as typeof fetch

test('newest root post, skipping replies', async () => {
  globalThis.fetch = reply({
    '/api/profile/opper': { profile: { id: '55' } },
    '/api/messages': { messages: [
      { base36_id: '000042', content: 'a reply', reply_to: '000041', created_at: new Date().toISOString() },
      { base36_id: '000041', content: 'the   real op', reply_to: null, created_at: new Date(Date.now() - 2 * 86400_000).toISOString() },
    ] },
  })
  expect(await lastOp('opper')).toBe("opper's last op (2d ago): the real op heatsync.org/thread/41")
})

test('not on heatsync / bad login / down', async () => {
  globalThis.fetch = reply({})
  expect(await lastOp('ghosty')).toBe("ghosty isn't on heatsync")
  expect(await lastOp('bad name!')).toBe('no op found')
})
