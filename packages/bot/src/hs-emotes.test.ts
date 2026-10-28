import { test, expect, afterEach } from 'bun:test'
import { noteChatterEmotes, setBotHeatsyncId } from './hs-emotes'
import { isExactEmote, formatEmotesForAI } from './emotes'

const real = globalThis.fetch
afterEach(() => { globalThis.fetch = real; delete process.env.HEATSYNC_EMOTES_KEY })

const row = (n: string) => ({ custom_name: n, name: n, url: `https://cdn.7tv.app/emote/${n}/1x.webp`, source: '7tv', source_id: n, width: 32, height: 32 })

function stub(sets: Record<string, unknown[]>, posts: { body: any; auth: string }[], postStatus = 200) {
  globalThis.fetch = (async (u: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).Authorization) })
      return new Response('{}', { status: postStatus })
    }
    const tok = String(u).split('ids=')[1]
    return new Response(JSON.stringify({ sets: { [tok]: sets[tok] ?? [] } }))
  }) as unknown as typeof fetch
}

test('inventory names become emotes; names with spaces are ignored', async () => {
  stub({ 'twitch:111': [row('hsZorpEmote'), row('bad name')] }, [])
  await noteChatterEmotes('111')
  expect(isExactEmote('hsZorpEmote')).toBe(true)
  expect(isExactEmote('bad name')).toBe(false)
})

test('bad id and fetch failure are silent', async () => {
  globalThis.fetch = (async () => { throw new Error('down') }) as unknown as typeof fetch
  await noteChatterEmotes('abc')
  await noteChatterEmotes('222')
})

test('no key = never posts', async () => {
  const posts: { body: any; auth: string }[] = []
  stub({ 'twitch:333': [row('hsNoKey')] }, posts)
  setBotHeatsyncId('999')
  await noteChatterEmotes('333', 'hello hsNoKey')
  expect(posts.length).toBe(0)
})

test('adds an emote the chatter used and the bot lacks, then offers it to the prompt', async () => {
  process.env.HEATSYNC_EMOTES_KEY = 'k'
  const posts: { body: any; auth: string }[] = []
  stub({ 'twitch:444': [row('hsAdoptMe'), row('hsUnused')], 'twitch:999': [row('hsHave')] }, posts)
  setBotHeatsyncId('999')
  await noteChatterEmotes('444', 'yo hsAdoptMe lol')
  expect(posts.length).toBe(1)
  expect(posts[0].auth).toBe('Bearer k')
  expect(posts[0].body).toMatchObject({ customName: 'hsAdoptMe', emoteUrl: 'https://cdn.7tv.app/emote/hsAdoptMe/1x.webp', source: '7tv', sourceId: 'hsAdoptMe' })
  expect(formatEmotesForAI('adoptchan')).toContain('hsAdoptMe')
})
