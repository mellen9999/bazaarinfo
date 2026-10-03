import { describe, expect, it, beforeEach, afterAll } from 'bun:test'

// The source lens exists for exactly one failure class: correlated error. The generator
// and all three panel lenses share training data, so a confidently misremembered detail
// ("an infected grain called Scourgestone") passes every model-memory check. This lens
// grounds the shipped question in live web sources — these tests pin its contract:
// web_search tool in the request, verdict parsed from the LAST text block, fail-closed
// on anything unparseable, and 'pass' needs PROOF: a search actually ran and a cited
// source text states the answer. no key / hard stop = 'error' (never ships unchecked).

process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
process.env.AI_TRIVIA = '1'

const { sourceCheck, generateCustomTrivia } = await import('./ai-trivia')
const { initDb, bankTrivia, takeBankedTrivia } = await import('./db')
const { enableAiForChannel } = await import('./ai-cache')
const { resetHardStopForTests, noteHardStop } = await import('./ai-http')

const realFetch = globalThis.fetch
afterAll(() => {
  globalThis.fetch = realFetch
})

const Q = { question: 'In WC3, what city does Arthas purge?', answer: 'Stratholme', accept: ['Stratholme'] }

let lastBody: Record<string, unknown> | null = null

function mockApi(content: object[], searches = 1): void {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    lastBody = JSON.parse(init?.body as string)
    return new Response(JSON.stringify({ content, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10, server_tool_use: { web_search_requests: searches } } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
}

// a realistic tool-using response: preamble text, the server tool round-trip, a cited
// sentence, then the verdict JSON — which the lens must find even though it is NOT the
// first text block. `cited` is the page text the API attaches as a citation.
function searchResponse(verdict: object, cited = 'The Culling of Stratholme: Arthas purges the city of Stratholme.', title = 'Culling of Stratholme - Wowpedia'): object[] {
  return [
    { type: 'text', text: 'Let me verify the central claim.' },
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'culling of stratholme' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://example.com', title: 'x' }] },
    { type: 'text', text: 'Arthas purges Stratholme.', citations: [{ type: 'web_search_result_location', cited_text: cited, title, url: 'https://example.com' }] },
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
    expect(await sourceCheck(Q, '#test')).toBe('pass')
    const tools = lastBody?.tools as { type: string; name: string }[]
    expect(tools?.[0]?.type).toBe('web_search_20250305')
    expect(tools?.[0]?.name).toBe('web_search')
  })

  it('rejects when the sources refute the claim', async () => {
    mockApi(searchResponse({ check: 'no source mentions any such grain', ok: false }))
    expect(await sourceCheck(Q, '#test')).toBe('fail')
  })

  it('fails ok:true with zero searches — the model answered from memory', async () => {
    mockApi(searchResponse({ check: 'i just know', ok: true }), 0)
    expect(await sourceCheck(Q, '#test')).toBe('fail')
  })

  it('fails ok:true when no cited source text contains the answer', async () => {
    mockApi(searchResponse({ check: 'looks right', ok: true }, 'Arthas Menethil is a paladin of the Silver Hand.', 'Arthas Menethil - Wowpedia'))
    expect(await sourceCheck(Q, '#test')).toBe('fail')
  })

  it('fails ok:true when the cited source states the answer but never names the subject', async () => {
    mockApi(searchResponse({ check: 'looks right', ok: true }, 'Stratholme is a city in the Eastern Plaguelands.', 'Stratholme - travel guide'))
    expect(await sourceCheck(Q, '#test')).toBe('fail')
  })

  it('sends the source call uncached (its search results are never reused)', async () => {
    mockApi(searchResponse({ check: 'sources confirm', ok: true }))
    await sourceCheck(Q, '#test')
    const sys = lastBody?.system as { cache_control?: unknown }[]
    expect(sys?.[0]?.cache_control).toBeUndefined()
  })

  it('fails ok:true when there are no citations at all', async () => {
    mockApi([{ type: 'text', text: JSON.stringify({ check: 'trust me', ok: true }) }], 1)
    expect(await sourceCheck(Q, '#test')).toBe('fail')
  })

  it('reports an unparseable verdict as a check error, not a refutation', async () => {
    mockApi([{ type: 'text', text: 'the sources were inconclusive, sorry' }])
    expect(await sourceCheck(Q, '#test')).toBe('error')
  })

  it('reports an API failure as a check error, not a refutation', async () => {
    globalThis.fetch = (async () => new Response('overloaded', { status: 529 })) as typeof fetch
    expect(await sourceCheck(Q, '#test')).toBe('error')
  })

  it('fails closed during a hard stop: error, and no api call', async () => {
    // scope the assertion to the anthropic API — noteHardStop fires an ntfy alert
    // through the same global fetch when a topic is configured (real .env on prod boxes)
    let apiCalled = false
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
      if (String(url).includes('api.anthropic.com')) apiCalled = true
      return new Response('should not be reached', { status: 500 })
    }) as typeof fetch
    noteHardStop(401, 'authentication_error')
    expect(await sourceCheck(Q, '#test')).toBe('error')
    expect(apiCalled).toBe(false)
  })
})

describe('banked question + source lens error', () => {
  it('is re-banked, not shipped or dropped', async () => {
    initDb(':memory:')
    enableAiForChannel('banktest', false)
    resetHardStopForTests()
    bankTrivia('stratholme', 'stratholme', Q, 2, false)
    globalThis.fetch = (async () => new Response('overloaded', { status: 529 })) as typeof fetch
    const r = await generateCustomTrivia('stratholme', 'banktest')
    expect(r).toBeNull()
    expect(takeBankedTrivia('stratholme')?.question).toBe(Q.question)
  })
})
