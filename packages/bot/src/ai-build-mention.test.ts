// P1: talking to the bot without !b. buildUserMessage must (1) keep the bot's own recent
// lines in context — rendered as "you:" — only when the ask is addressed to it, and (2) tell
// the model plainly whether this was a reply to its own line (with the exact parent text) or
// an @mention, so it answers the actual thread instead of guessing at who's talking to whom.
import { describe, it, expect, beforeAll, beforeEach } from 'bun:test'
import { initDb } from './db'
import { buildUserMessage } from './ai-build'
import { loadStore } from './store'
import * as chatbuf from './chatbuf'

beforeAll(async () => { initDb(':memory:'); await loadStore() })

const CH = '#mention-test'

describe('mention-mode context (P1)', () => {
  beforeEach(() => chatbuf.cleanupChannel(CH))

  // P2: the bot's own lines always sit in the transcript as "you:" (a "lol bot is
  // bricked" in chat needs the line it's about), capped to the newest three.
  it('the bot\'s own recent lines render as "you:", mention or not, newest 3 only', () => {
    chatbuf.record(CH, 'alice', 'is boomerang good')
    chatbuf.record(CH, 'bazaarinfo', 'first old line')
    chatbuf.record(CH, 'bazaarinfo', 'second old line')
    chatbuf.record(CH, 'bazaarinfo', 'third line')
    chatbuf.record(CH, 'bazaarinfo', 'yeah it holds up')
    chatbuf.record(CH, 'bob', 'lol bot is confident today')

    const mentioned = buildUserMessage('why though', { user: 'alice', channel: CH, mention: true } as any)
    expect(mentioned.text).toContain('> you: yeah it holds up')

    const plain = buildUserMessage('why though', { user: 'alice', channel: CH } as any)
    expect(plain.text).toContain('> you: yeah it holds up')
    expect(plain.text).toContain('> you: second old line')
    expect(plain.text).not.toContain('first old line')
    // the bot is never a "chatter" — profile context stays human-only
    expect(plain.text).not.toMatch(/Chatters:[^\n]*bazaarinfo/)
  })

  it('framing cites the exact reply-parent body when this was a reply', () => {
    const r = buildUserMessage('why though', {
      user: 'alice', channel: CH, mention: true,
      replyParent: { login: 'bazaarinfo', body: 'burn deals damage over time' },
    } as any)
    expect(r.text).toContain('@MENTION')
    expect(r.text).toContain('replied to your line: "burn deals damage over time"')
    expect(r.text).toContain('answer them directly')
  })

  it('framing falls back to "addressed you by name" for an @mention with no reply body', () => {
    const r = buildUserMessage('hey there', { user: 'alice', channel: CH, mention: true } as any)
    expect(r.text).toContain('addressed you by name')
    expect(r.text).not.toContain('replied to your line')
  })

  it('a non-mention ask keeps the plain [USER] framing — no @MENTION block', () => {
    const r = buildUserMessage('hey there', { user: 'alice', channel: CH } as any)
    expect(r.text).not.toContain('@MENTION')
  })

  // stream events render inline in "Recent chat" — zero new system-prompt text, the model
  // already reads this section. "[mod" is the exact token the prompt already trusts.
  it('a mod /announce shows up under Recent chat as "* [mod announce] …"', () => {
    chatbuf.record(CH, 'alice', 'is boomerang good')
    chatbuf.recordEvent(CH, '* [mod announce] raffle starting in 5 minutes')

    const r = buildUserMessage('why though', { user: 'alice', channel: CH, mention: true } as any)
    expect(r.text).toContain('Recent chat:')
    expect(r.text).toContain('> * [mod announce] raffle starting in 5 minutes')
  })
})

// P3: a chatter disputing the bot's own line gets the PUSHBACK hint — the two honest paths
// (data-backed: hold; memory: concede, no invented replacement) — and only when there is a
// bot line to dispute. soft shapes need the exchange to actually be with the bot.
describe('pushback hint (P3)', () => {
  const CH3 = '#pushback-test'
  beforeEach(() => chatbuf.cleanupChannel(CH3))

  it('fires on a strong dispute when the bot has a recent line', () => {
    chatbuf.record(CH3, 'bazaarinfo', "ult's the panic button - full stun on a cluster")
    chatbuf.record(CH3, 'dong', 'lol')
    const r = buildUserMessage('nobody mentioned overwatch till now', { user: 'dong', channel: CH3 } as any)
    expect(r.text).toContain('PUSHBACK:')
    expect(r.text).toContain('Never invent a replacement fact')
  })

  it('a soft dispute counts only when the bot spoke last or is addressed', () => {
    chatbuf.record(CH3, 'bazaarinfo', "ult's the panic button - full stun on a cluster")
    const direct = buildUserMessage('it doesnt have stun, but maybe it should', { user: 'dong', channel: CH3 } as any)
    expect(direct.text).toContain('PUSHBACK:')
    chatbuf.record(CH3, 'alice', 'anyone else lagging')
    const drifted = buildUserMessage('it doesnt have stun, but maybe it should', { user: 'dong', channel: CH3 } as any)
    expect(drifted.text).not.toContain('PUSHBACK:')
    const replied = buildUserMessage('are you sure', { user: 'dong', channel: CH3, mention: true, replyParent: { login: 'bazaarinfo', body: 'x' } } as any)
    expect(replied.text).toContain('PUSHBACK:')
  })

  it('never fires without a bot line to dispute, or on an ordinary ask', () => {
    chatbuf.record(CH3, 'alice', 'thats wrong')
    expect(buildUserMessage("you're wrong", { user: 'dong', channel: CH3 } as any).text).not.toContain('PUSHBACK:')
    chatbuf.record(CH3, 'bazaarinfo', 'boomerang is filler')
    expect(buildUserMessage('is boomerang good', { user: 'dong', channel: CH3 } as any).text).not.toContain('PUSHBACK:')
  })
})

// P4: a title ask gets the cached channel title as its own section — the store must be loaded
// (buildUserMessage resolves entities), which this file already does.

describe('title ask (P4)', () => {
  it('quotes the cached title on a title ask and stays out otherwise', async () => {
    const { __setTitleCacheForTest } = await import('./channel-title')
    const { buildUserMessage } = await import('./ai-build')
    __setTitleCacheForTest('titletest', 'NEW BAZAAR SEASON! | !IRL')
    const asked = buildUserMessage('title', { user: 'h', channel: 'titletest' } as any)
    expect(asked.text).toContain('Channel title (REAL')
    expect(asked.text).toContain('"NEW BAZAAR SEASON! | !IRL"')
    const other = buildUserMessage('is boomerang good', { user: 'h', channel: 'titletest' } as any)
    expect(other.text).not.toContain('Channel title (REAL')
    __setTitleCacheForTest('titletest', null)
    expect(buildUserMessage('title', { user: 'h', channel: 'titletest' } as any).text).not.toContain('Channel title (REAL')
  })
})
