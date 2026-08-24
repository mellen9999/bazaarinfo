import { describe, expect, it, beforeEach, afterAll } from 'bun:test'

// The source lens exists for exactly one failure class: correlated error. The generator
// and all three panel lenses share training data, so a confidently misremembered detail
// ("an infected grain called Scourgestone") passes every model-memory check. This lens
// grounds the shipped question in live web sources — these tests pin its contract:
// web_search tool in the request, verdict parsed from the LAST text block, fail-closed
// on anything unparseable, and wave-through only during a hard stop (bank must stay
// alive through an outage).

process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
process.env.AI_TRIVIA = '1'

const { sourceCheck } = await import('./ai-trivia')
const { resetHardStopForTests, noteHardStop } = await import('./ai-http')

const realFetch = globalThis.fetch
afterAll(() => {
  globalThis.fetch = realFetch
})

const Q = { question: 'In WC3, what city does Arthas purge?', answer: 'Stratholme', accept: ['Stratholme'] }

let lastBody: Record<string, unknown> | null = null

function mockApi(content: object[]): void {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    lastBody = JSON.parse(init?.body as string)
    return new Response(JSON.stringify({ content, stop_reason: 'end_turn' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
}

// a realistic tool-using response: preamble text, the server tool round-trip, then the
// verdict — the JSON the lens must find even though it is NOT the first text block.
function searchResponse(verdict: object): object[] {
  return [
    { type: 'text', text: 'Let me verify the central claim.' },
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'culling of stratholme' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://example.com', title: 'x' }] },
    { type: 'text', text: JSON.stringify(verdict) },
  ]
}

describe('sourceCheck — web-grounded gate on the shipped question', () => {
  beforeEach(() => {
    resetHardStopForTests()
    lastBody = null
  })

  it('passes a source-confirmed question and sends the web_search tool', async () => {
    mockApi(searchResponse({ check: 'sources confirm the culling of Stratholme', ok: true }))
    expect(await sourceCheck(Q, '#test')).toBe(true)
    const tools = lastBody?.tools as { type: string; name: string }[]
    expect(tools?.[0]?.type).toBe('web_search_20260209')
    expect(tools?.[0]?.name).toBe('web_search')
  })

  it('rejects when the sources refute the claim', async () => {
    mockApi(searchResponse({ check: 'no source mentions any such grain', ok: false }))
    expect(await sourceCheck(Q, '#test')).toBe(false)
  })

  it('fails closed on an unparseable verdict', async () => {
    mockApi([{ type: 'text', text: 'the sources were inconclusive, sorry' }])
    expect(await sourceCheck(Q, '#test')).toBe(false)
  })

  it('fails closed on an API error', async () => {
    globalThis.fetch = (async () => new Response('overloaded', { status: 529 })) as typeof fetch
    expect(await sourceCheck(Q, '#test')).toBe(false)
  })

  it('waves the question through during a hard stop — the bank must survive an outage', async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return new Response('should not be reached', { status: 500 })
    }) as typeof fetch
    noteHardStop(401, 'authentication_error')
    expect(await sourceCheck(Q, '#test')).toBe(true)
    expect(called).toBe(false)
  })
})
