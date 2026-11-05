// the Clock section reaches the model on a time-somewhere ask, and only then
import { describe, it, expect, beforeAll, beforeEach } from 'bun:test'
import { initDb } from './db'
import { buildUserMessage } from './ai-build'
import { loadStore } from './store'
import * as chatbuf from './chatbuf'

beforeAll(async () => { initDb(':memory:'); await loadStore() })

const CH = '#clock-test'

describe('clock section in the built message', () => {
  beforeEach(() => chatbuf.cleanupChannel(CH))

  it('"time nz" carries the computed NZ time and counts as grounding', () => {
    const r = buildUserMessage('time nz', { user: 'alice', channel: CH } as any)
    expect(r.text).toContain('Clock (REAL')
    expect(r.text).toMatch(/now in new zealand: \w+day \d+ \w+ \d{1,2}(:\d\d)?[ap]m/)
    expect(r.contextSections.map((s) => s.name)).toContain('clock')
  })

  it('"what\'s that in cet" converts the bot\'s own last ET time', () => {
    chatbuf.record(CH, 'alice', 'next stream?')
    chatbuf.record(CH, 'bazaarinfo', 'next likely thursday ~18:30 ET (±1h)')
    const r = buildUserMessage("what's that in cet", { user: 'alice', channel: CH } as any)
    // the exact gap moves with DST (5h or 6h), so the shape is checked here and the math in clock.test.ts
    expect(r.text).toMatch(/6:30pm ET \(from your last reply\) = \d{1,2}:30[ap]m \(\d\d:30\) CES?T in central europe, the next day/)
  })

  it('a non-clock ask carries no Clock section', () => {
    const r = buildUserMessage('first time in chat, is boomerang good', { user: 'alice', channel: CH } as any)
    expect(r.text).not.toContain('Clock')
  })
})
