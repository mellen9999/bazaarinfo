import { describe, expect, it, beforeEach } from 'bun:test'

import * as db from './db'

// the gate reads its cap at module load — bun auto-loads .env, so the test must exercise the
// default, not whatever mele's env says (pattern: ai-user-budget.test.ts).
delete process.env.WEB_SEARCH_DAILY_CAP
db.initDb(':memory:')
const gate = await import('./ai-search-gate')
const verify = await import('./ai-verify')

const plain = { hasGameData: false, isPasta: false, isCreative: false, isContinuation: false, isRememberReq: false, contextSections: [{ name: 'recentChat', len: 400 }, { name: 'chatters', len: 200 }, { name: 'liveBoard', len: 300 }, { name: 'gameNow', len: 500 }] }
const eligible = (q: string, b: Partial<typeof plain> = {}) => gate.searchEligible(q, { ...plain, ...b }, 0, 0)

describe('search gate — which asks are offered the tool', () => {
  it('offers it on real knowledge asks chat actually typed', () => {
    for (const q of [
      'what are Germans general view of people from saxony anhalt',
      'does chocolate donuts actually make you go nuts',
      'which hero would you recomment in deadlock',
      'how many days till blizzcon?',
      'whats the drop rate on cham rune in diablo 2?',
      'is fun really subjective',
      'do you know the story behind the song Bonehead\'s Bank Holiday from oasis?',
      'tell me about the fall of constantinople',
    ]) expect(eligible(q)).toBe(true)
  })

  it('keeps chat, the streamer, the bot and the board off the web', () => {
    for (const q of [
      'would kripp marry me?',
      'what skills does kripp have?',
      'what did i miss?',
      'whats the shirt colour',
      'when is the next stream',
      'who is balding harder, kripp or moonmoon',
      'is mellen online',
      'how many points do i have',
      'what happened in chat',
    ]) expect(eligible(q)).toBe(false)
  })

  it('a named other game beats the subject exclusion, an incidental bazaar hit, and the stream schedule', () => {
    expect(eligible('whats the best build in deadlock right now?')).toBe(true)
    expect(eligible('what board should i run in tft')).toBe(true)
    // "rune" / "snap" / "familiar" match bazaar items — live, these closed the gate
    expect(eligible('whats the drop rate on cham rune in diablo 2?', { hasGameData: true, contextSections: [{ name: 'gameBlock', len: 400 }] })).toBe(true)
    expect(eligible('is there a familiar hero like mcginnis in overwatch?', { hasGameData: true, contextSections: [{ name: 'gameBlock', len: 400 }] })).toBe(true)
    // "when does … start" fires the stream-schedule section — about kripp, not the league
    expect(eligible('when does path of exile 2 next league start?', { contextSections: [{ name: 'schedule', len: 300 }] })).toBe(true)
    // but real data about THAT game still grounds it
    expect(eligible('what does jaraxxus do in hearthstone?', { hasGameData: true, contextSections: [{ name: 'hsCards', len: 300 }] })).toBe(false)
  })

  it('a fact ask that reads as "creative" to the pasta detector is still a fact ask', () => {
    expect(eligible("do you know the story behind the song Bonehead's Bank Holiday from oasis?", { isCreative: true })).toBe(true)
    expect(eligible('tell me a story about a dragon?', { isCreative: true })).toBe(false)
  })

  it('never on banter shapes, arithmetic, or non-questions', () => {
    for (const q of ['gm', 'lol', 'thanks', 'what 9+10', "what's 2+2?", 'krippFey', 'i love this chat', 'nice run']) {
      expect(eligible(q)).toBe(false)
    }
  })

  it('never when the ask already has data behind it', () => {
    expect(eligible('what does the toaster do?', { hasGameData: true })).toBe(false)
    expect(eligible('whats the weather in toronto?', { contextSections: [{ name: 'weather', len: 200 }] })).toBe(false)
    expect(eligible('what is jaraxxus rating?', { contextSections: [{ name: 'hs', len: 200 }] })).toBe(false)
    expect(eligible('was that trivia answer right?', { contextSections: [{ name: 'triviaRef', len: 200 }] })).toBe(false)
    expect(eligible('what model are you?', { contextSections: [{ name: 'self', len: 200 }] })).toBe(false)
  })

  it('never for creative, pasta, continuation or remember asks', () => {
    expect(eligible('write a poem about who won ww2?', { isCreative: true })).toBe(false)
    expect(eligible('what is the pasta?', { isPasta: true })).toBe(false)
    expect(eligible('what happened next?', { isContinuation: true })).toBe(false)
    expect(eligible('what is my name? remember it', { isRememberReq: true })).toBe(false)
  })

  it('closes on capacity: the daily cap and two in flight', () => {
    const q = 'how many days till blizzcon?'
    expect(gate.searchEligible(q, plain, 0, gate.WEB_SEARCH_DAILY_CAP - 1)).toBe(true)
    expect(gate.searchEligible(q, plain, 0, gate.WEB_SEARCH_DAILY_CAP)).toBe(false)
    expect(gate.searchEligible(q, plain, gate.MAX_INFLIGHT_SEARCHES - 1, 0)).toBe(true)
    expect(gate.searchEligible(q, plain, gate.MAX_INFLIGHT_SEARCHES, 0)).toBe(false)
  })

  it('has a real cap by default and the tool definition trivia already proved live', () => {
    expect(gate.WEB_SEARCH_DAILY_CAP).toBe(25)
    expect(gate.WEB_SEARCH_TOOL).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 1 }])
  })
})

describe('finalText — the answer is what comes after the tool blocks', () => {
  it('skips the preamble of a tool turn and keeps the answer', () => {
    const content = [
      { type: 'text', text: 'Let me check that.' },
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'blizzcon 2026 date' } },
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://example.com', title: 'x' }] },
      { type: 'text', text: 'blizzcon 2026 is sept 12-13 in anaheim,' },
      { type: 'text', text: 'looked it up.' },
    ]
    expect(gate.finalText(content)).toBe('blizzcon 2026 is sept 12-13 in anaheim, looked it up.')
  })

  it('is empty when the turn paused mid-search — never ships "let me check"', () => {
    expect(gate.finalText([
      { type: 'text', text: 'Let me look that up.' },
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'x' } },
    ])).toBe('')
    expect(gate.finalText([])).toBe('')
    expect(gate.finalText(undefined)).toBe('')
  })

  it('is just the text of a plain turn', () => {
    expect(gate.finalText([{ type: 'text', text: 'with a heal build yes, otherwise filler' }])).toBe('with a heal build yes, otherwise filler')
  })
})

describe('hasFabricatedDataRef — a real search is the one honest "according to"', () => {
  it('still rejects an invented data source without game data', () => {
    expect(verify.hasFabricatedDataRef('the data shows toaster does 40 burn', false)).toBe(true)
    expect(verify.hasFabricatedDataRef('according to my search it does 40 burn', false)).toBe(true)
  })

  it('lets "according to my search" through only when a search ran, and only that', () => {
    expect(verify.hasFabricatedDataRef('according to my search, blizzcon is sept 12-13', false, true)).toBe(false)
    expect(verify.hasFabricatedDataRef('the data says blizzcon is sept 12-13', false, true)).toBe(true)
  })

  it('never fires with game data present', () => {
    expect(verify.hasFabricatedDataRef('the data shows toaster does 40 burn', true)).toBe(false)
  })
})

describe('web_search_spend — the cap survives a restart', () => {
  beforeEach(() => db.initDb(':memory:'))

  it('counts per PT day and reads back', () => {
    expect(db.getWebSearchesToday('2026-09-07')).toBe(0)
    expect(db.bumpWebSearches(1, '2026-09-07')).toBe(1)
    expect(db.bumpWebSearches(2, '2026-09-07')).toBe(3)
    expect(db.getWebSearchesToday('2026-09-07')).toBe(3)
    expect(db.getWebSearchesToday('2026-09-08')).toBe(0)
  })
})
