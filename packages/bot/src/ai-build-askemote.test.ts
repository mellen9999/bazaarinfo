// an emote name in the ask (heatsync inventory, 7tv) must reach the model as an emote, never
// left for it to guess a source ("it's a BTTV emote") or hunt for in the game data.
import { describe, it, expect, beforeAll } from 'bun:test'
import { initDb } from './db'
import { loadStore } from './store'
import { buildUserMessage } from './ai-build'
import { addHeatsyncEmotes, noteBotHsEmote } from './emotes'

beforeAll(async () => { initDb(':memory:'); await loadStore(); addHeatsyncEmotes(['ass11']) })

describe('emote names in the ask', () => {
  it('flags a known emote that has no description', () => {
    const r = buildUserMessage('thoughts on ass11 ?', { user: 'mellen', channel: '#askemote' } as any)
    expect(r.text).toContain('Emote names in the ask: ass11')
  })

  it('tells the model it may post back an emote the bot owns', () => {
    noteBotHsEmote('ass11')
    const r = buildUserMessage('thoughts on ass11 ?', { user: 'mellen', channel: '#askemote' } as any)
    expect(r.text).toContain('you own ass11 too')
  })

  it('stays quiet when no token is an emote', () => {
    const r = buildUserMessage('thoughts on the weather ?', { user: 'mellen', channel: '#askemote' } as any)
    expect(r.text).not.toContain('Emote names in the ask')
  })
})
