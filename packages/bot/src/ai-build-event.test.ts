// an event ask with an official announcement on file must reach the model as data — never as
// "no game data" — in BOTH tones. unhinged carries its own Bazaar-facts rule, and a shipped
// regression had the bot refusing the event in chat while a normal-tone check passed.
import { describe, it, expect, beforeAll } from 'bun:test'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dir = mkdtempSync(join(tmpdir(), 'official-'))
process.env.BAZAARINFO_OFFICIAL_CACHE = join(dir, 'official-posts.json')
writeFileSync(process.env.BAZAARINFO_OFFICIAL_CACHE, JSON.stringify([{
  title: 'End of Season Event - Partner Portal!',
  body: 'Choose a Partner Hero. Runs until the start of Season 20 on November 4.',
  updated: new Date().toISOString(),
}]))

import { initDb } from './db'
import { loadStore } from './store'
import { buildUserMessage } from './ai-build'
import { setTone, __resetToneForTest } from './tone'

beforeAll(async () => { initDb(':memory:'); await loadStore() })

describe('event ask grounding', () => {
  for (const tone of ['normal', 'unhinged'] as const) {
    it(`${tone}: official event is in the prompt and the no-data gate stays off`, () => {
      __resetToneForTest()
      const ch = `#event-${tone}`
      setTone(ch, tone, 'test')
      const r = buildUserMessage('describe the new bazaar event pls', { user: 'mellen', channel: ch } as any)
      expect(r.text).toContain('Partner Portal')
      expect(r.text).toContain('November 4')
      expect(r.text).not.toContain('NO GAME DATA matched')
      __resetToneForTest()
    })
  }

  it('the unhinged hint lets official lines count as a Bazaar source', () => {
    __resetToneForTest()
    setTone('#event-hint', 'unhinged', 'test')
    const r = buildUserMessage('describe the new bazaar event pls', { user: 'mellen', channel: '#event-hint' } as any)
    expect(r.text).toContain('Game data or the official patch/event lines')
    __resetToneForTest()
  })
})
