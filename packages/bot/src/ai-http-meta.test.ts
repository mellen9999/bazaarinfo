import { describe, expect, it, afterAll } from 'bun:test'

process.env.ANTHROPIC_API_KEY = 'sk-ant-test'

const { anthropicCall, anthropicCallMeta, resetHardStopForTests } = await import('./ai-http')
const { initDb } = await import('./db')
initDb(':memory:')
resetHardStopForTests()

const realFetch = globalThis.fetch
afterAll(() => {
  globalThis.fetch = realFetch
})

const content = [
  { type: 'text', text: 'looking' },
  { type: 'server_tool_use', id: 'x', name: 'web_search', input: {} },
  { type: 'text', text: 'Stratholme.', citations: [{ type: 'web_search_result_location', cited_text: 'Arthas purges Stratholme', title: 'Wowpedia', url: 'u' }, { cited_text: 5 }] },
  { type: 'text', text: '{"ok":true}' },
]
function mock(): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ content, usage: { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 2 } } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
}
const opts = { tag: 'ai-http-meta', channel: 'x', model: 'm', maxTokens: 10, content: 'hi' }

describe('anthropicCallMeta', () => {
  it('returns text, citations (cited_text + title) and the search count', async () => {
    mock()
    const r = await anthropicCallMeta(opts)
    expect(r?.searches).toBe(2)
    expect(r?.citations).toEqual(['Arthas purges Stratholme', 'Wowpedia'])
    expect(r?.text).toBe('looking\nStratholme.\n{"ok":true}')
  })
  it('default mode is still the plain joined text', async () => {
    mock()
    expect(await anthropicCall(opts)).toBe('looking\nStratholme.\n{"ok":true}')
  })
  it('a failed call is null in both modes', async () => {
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch
    expect(await anthropicCallMeta(opts)).toBeNull()
    expect(await anthropicCall(opts)).toBeNull()
  })
})
