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

  it('the bot\'s own recent line renders as "you:" only under mention', () => {
    chatbuf.record(CH, 'alice', 'is boomerang good')
    chatbuf.record(CH, 'bazaarinfo', 'yeah it holds up')

    const mentioned = buildUserMessage('why though', { user: 'alice', channel: CH, mention: true } as any)
    expect(mentioned.text).toContain('> you: yeah it holds up')

    const plain = buildUserMessage('why though', { user: 'alice', channel: CH } as any)
    expect(plain.text).not.toContain('> you:')
    expect(plain.text).not.toContain('yeah it holds up')
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
})
