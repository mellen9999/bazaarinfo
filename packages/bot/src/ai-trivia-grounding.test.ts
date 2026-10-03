import { describe, expect, it, beforeEach, afterAll } from 'bun:test'

// the grounding guard: a question ships only when its answer can be SHOWN to appear in the
// material it was written from. pure matcher first, then each generator with a stubbed api.

process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
process.env.AI_TRIVIA = '1'

const { groundedIn, groundedInSources, questionAnchors, normEvidence, parseGen, generateChatTrivia, generatePersonTrivia, generateGameTrivia } = await import('./ai-trivia')
const { initDb } = await import('./db')
const { enableAiForChannel } = await import('./ai-cache')
const { resetHardStopForTests } = await import('./ai-http')

const mk = (answer: string, accept: string[] = []) => ({ question: 'q?', answer, accept })

describe('groundedIn', () => {
  it('matches a whole-word run, case and punctuation blind', () => {
    expect(groundedIn(mk('Stratholme'), 'Arthas purged STRATHOLME, then left.')).toBe(true)
    expect(groundedIn(mk('Wall Sina'), 'the wall-sina is innermost')).toBe(true)
  })
  it('never matches inside a longer word', () => {
    expect(groundedIn(mk('cat'), 'the category is concatenated')).toBe(false)
    expect(groundedIn(mk('Ember'), 'remember')).toBe(false)
  })
  it('matches any accepted form', () => {
    expect(groundedIn(mk('George R. R. Martin', ['grrm', 'george martin']), 'co-written with george martin')).toBe(true)
  })
  it('numbers match as whole tokens only', () => {
    expect(groundedIn(mk('2385'), 'it deals 23850 damage')).toBe(false)
    expect(groundedIn(mk('2385'), 'it deals 2385 damage')).toBe(true)
    expect(groundedIn(mk('12'), 'a 120 hp monster')).toBe(false)
    expect(groundedIn(mk('4'), 'deals 4 damage')).toBe(true)
  })
  it('skips short non-numeric forms', () => {
    expect(groundedIn(mk('Ti'), 'this item is a tiny thing, ti appears alone')).toBe(false)
    expect(groundedIn(mk('Ti', ['titanium']), 'made of titanium')).toBe(true)
  })
  it('strips @ and handles unicode punctuation', () => {
    expect(groundedIn(mk('@Sw1ngggg'), 'sw1ngggg: gg')).toBe(true)
    expect(groundedIn(mk('caf\u00e9 noir'), 'the caf\u00e9 noir is open')).toBe(true) // both sides normalize the same way
    expect(groundedIn(mk('caf\u00e9 noir'), 'the cafe bleu is open')).toBe(false)
  })
  it('fails closed when the answer normalizes to nothing', () => {
    expect(groundedIn(mk('\u{1F525}'), 'a \u{1F525} emote')).toBe(false)
    expect(groundedIn(mk('!!!'), '!!! wow')).toBe(false)
  })
  it('normEvidence pads for word-run search', () => {
    expect(normEvidence('Hi, there!')).toBe(' hi there ')
  })
})

describe('groundedInSources — one source must name the subject AND state the answer', () => {
  const malenia = { question: "In Elden Ring, Malenia's boss theme shares its name with a kanji meaning what?", answer: 'law', accept: ['law', 'dharma'] }

  it('anchors are the capitalized subjects past the first word, never the answer', () => {
    expect(questionAnchors(malenia)).toEqual(['elden', 'ring', 'malenia'])
    expect(questionAnchors({ question: 'What 2016 FPS advances time only when you move?', answer: 'Superhot', accept: [] })).toEqual([])
    expect(questionAnchors({ question: 'Which city did Arthas purge in Stratholme?', answer: 'Stratholme', accept: [] })).toEqual(['arthas'])
  })

  it('a common answer word on a page that never names the subject does not count', () => {
    expect(groundedInSources(malenia, ['the rule of law in feudal japan — Wikipedia'])).toBe(false)
  })

  it('subject and answer split across two different sources does not count', () => {
    expect(groundedInSources(malenia, ['Malenia, Blade of Miquella — Elden Ring Wiki', 'the rule of law — Wikipedia'])).toBe(false)
  })

  it('one source naming the subject and stating the answer passes', () => {
    expect(groundedInSources(malenia, ['the theme title uses the kanji for law — Malenia - Elden Ring Wiki'])).toBe(true)
  })

  it('anchors match on a stem, so Sardinian finds Sardinia', () => {
    const q = { question: 'This Sardinian cheese is infested with larvae — name it?', answer: 'Casu Marzu', accept: [] }
    expect(groundedInSources(q, ['Casu marzu is a traditional cheese from Sardinia, Italy'])).toBe(true)
  })

  it('a question with no named subject falls back to the answer alone', () => {
    const q = { question: 'What 2016 FPS advances time only when you move?', answer: 'Superhot', accept: [] }
    expect(groundedInSources(q, ['SUPERHOT is the FPS where time moves only when you move'])).toBe(true)
    expect(groundedInSources(q, ['a time-bending shooter'])).toBe(false)
  })
})

describe('parseGen with evidence', () => {
  const ok = '{"ok":true,"question":"Who spammed the most clap?","answer":"bob","accept":["bob"]}'
  it('passes when the answer is in the evidence', () => {
    expect(parseGen(ok, 'bob: clap clap').ok).toBe(true)
  })
  it('asks for a retry when the answer is not in the evidence', () => {
    expect(parseGen(ok, 'alice: clap clap')).toEqual({ ok: false, retry: true })
  })
  it('no evidence arg keeps the old behavior', () => {
    expect(parseGen(ok).ok).toBe(true)
  })
})

const realFetch = globalThis.fetch
afterAll(() => {
  globalThis.fetch = realFetch
})

let calls: { system: string; user: string }[] = []
function stub(reply: (system: string, user: string) => string): void {
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string)
    const system = body.system?.[0]?.text ?? ''
    const user = typeof body.messages[0].content === 'string' ? body.messages[0].content : ''
    calls.push({ system, user })
    return new Response(JSON.stringify({ content: [{ type: 'text', text: reply(system, user) }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
}

const gen = (answer: string) => `{"ok":true,"question":"What did chat keep saying about the boss fight?","answer":"${answer}","accept":["${answer}"]}`
const LOG = ['a: boss fight again', 'b: pogchamp pogchamp', 'c: the boss is hard', 'd: pogchamp', 'e: gg', 'f: nice']

describe('generators drop ungrounded answers', () => {
  beforeEach(() => {
    initDb(':memory:')
    resetHardStopForTests()
    enableAiForChannel('groundch', false)
    calls = []
  })

  it('chat: ungrounded parse retries once, then gives up', async () => {
    stub(() => gen('unicorn'))
    expect(await generateChatTrivia(LOG, 'groundch')).toBeNull()
    expect(calls.length).toBe(2)
  })

  it('chat: a grounded answer ships', async () => {
    stub(() => gen('pogchamp'))
    expect((await generateChatTrivia(LOG, 'groundch'))?.answer).toBe('pogchamp')
    expect(calls.length).toBe(1)
  })

  it('chat: ungrounded first, grounded second -> ships the second', async () => {
    let n = 0
    stub(() => gen(n++ === 0 ? 'unicorn' : 'pogchamp'))
    expect((await generateChatTrivia(LOG, 'groundch'))?.answer).toBe('pogchamp')
  })

  const DOSSIER = 'signature emote: Kappa (used 412 times). most looked up item: Toaster. favorite word: gg'
  it('person: ungrounded parse retries then null', async () => {
    stub(() => gen('unicorn'))
    expect(await generatePersonTrivia(DOSSIER, '@bob', 'groundch')).toBeNull()
    expect(calls.length).toBe(2)
  })
  it('person: grounded ships', async () => {
    stub(() => gen('Kappa'))
    expect((await generatePersonTrivia(DOSSIER, '@bob', 'groundch'))?.answer).toBe('Kappa')
  })

  it('game: an ungrounded candidate never reaches the verifier', async () => {
    const DATA = 'Item: Toaster. Tier: Bronze. Tags: Tool, Friend. Burn 4. Cooldown 6 seconds. Hero: Vanessa. Size: Small.'
    stub((system) => {
      if (system.includes('fact-check')) return '{"check":"ok","ok":true,"quality":3}'
      return '{"ok":true,"question":"How much burn does this bronze small tool apply?","answer":"99","accept":["99"]}'
    })
    expect(await generateGameTrivia(DATA, 'toaster', 'groundch')).toBeNull()
    expect(calls.some((c) => c.system.includes('fact-check'))).toBe(false)
  })
})
