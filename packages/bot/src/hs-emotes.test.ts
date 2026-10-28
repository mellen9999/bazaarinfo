import { test, expect, afterEach } from 'bun:test'
import { noteChatterEmotes } from './hs-emotes'
import { isExactEmote } from './emotes'

const real = globalThis.fetch
afterEach(() => { globalThis.fetch = real })

test('inventory names become emotes', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ sets: { 'twitch:111': [{ custom_name: 'hsZorpEmote' }, { custom_name: 'bad name' }] } }))) as unknown as typeof fetch
  await noteChatterEmotes('111')
  expect(isExactEmote('hsZorpEmote')).toBe(true)
  expect(isExactEmote('bad name')).toBe(false)
})

test('bad id and fetch failure are silent', async () => {
  globalThis.fetch = (async () => { throw new Error('down') }) as unknown as typeof fetch
  await noteChatterEmotes('abc')
  await noteChatterEmotes('222')
})
