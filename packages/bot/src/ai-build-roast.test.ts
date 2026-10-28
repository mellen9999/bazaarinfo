// roast ammo: in unhinged tone the bot gets the target's own recent lines (not their tenure),
// and nothing of the kind leaks into normal tone.
import { describe, it, expect, beforeAll } from 'bun:test'
import { initDb, logChat, flushWrites } from './db'
import { loadStore } from './store'
import { buildUserMessage } from './ai-build'
import { pickAmmo, personaFromMessages } from './roast-ammo'
import { setTone, __resetToneForTest } from './tone'

beforeAll(async () => { initDb(':memory:'); await loadStore() })

const CH = '#roast-test'

describe('pickAmmo', () => {
  it('drops commands, short noise and duplicates; keeps real lines', () => {
    const got = pickAmmo([
      { message: '!b vanessa' },
      { message: 'lol' },
      { message: 'KEKW KEKW' },
      { message: 'i never lose a fight with this build' },
      { message: 'I never lose a fight with this build' },
      { message: 'dooley is genuinely unplayable rn' },
    ])
    expect(got).toEqual(['i never lose a fight with this build', 'dooley is genuinely unplayable rn'])
  })

  it('caps lines and length', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ message: `message number ${i} ` + 'x'.repeat(200) }))
    const got = pickAmmo(rows)
    expect(got.length).toBe(3)
    expect(got.every((l) => l.length <= 90)).toBe(true)
  })
})

describe('personaFromMessages', () => {
  const mk = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i))

  it('needs enough history to call anything a pattern', () => {
    expect(personaFromMessages(mk(5, () => 'is this good?'))).toEqual([])
  })

  it('reads habits: questions, one-liners, catchphrase, topic, emote spam', () => {
    const msgs = mk(40, (i) => (i % 8 < 5 ? 'is vanessa good?' : 'vanessa KEKW?'))
    const bits = personaFromMessages(msgs, new Set(['KEKW']))
    expect(bits).toContain('writes in one-liners')
    expect(bits).toContain('mostly asks questions')
    expect(bits).toContain('keeps saying "is vanessa good?"')
    expect(bits).toContain('spams KEKW')
    expect(bits).toContain('keeps bringing up "vanessa"')
  })

  it('reads essays and caps', () => {
    const essay = mk(20, (i) => `i honestly believe that build number ${i} is the strongest thing this game has ever produced overall`)
    expect(personaFromMessages(essay)).toContain('writes essays')
    expect(personaFromMessages(mk(20, (i) => `THIS IS BROKEN ${i}`))).toContain('types in caps a lot')
  })

  it('invents nothing from a varied history', () => {
    const vocab = 'copper lantern meadow quartz harbor velvet thistle marble orchard falcon ember willow cobalt saddle prairie anchor drizzle pewter walnut fennel garnet tundra bishop canyon ladder muffin nectar oyster pebble raisin'.split(' ')
    const msgs = mk(30, (i) => `${vocab[i]} ${vocab[(i + 7) % 30]} ${i}`)
    // style is real here (short lines) but no catchphrase, topic or emote can be conjured
    expect(personaFromMessages(msgs).filter((b) => /^(keeps|spams)/.test(b))).toEqual([])
  })
})

describe('roast ammo wiring', () => {
  it('unhinged: asker and @named chatter lines ride the prompt; normal: nothing', () => {
    logChat(CH, 'alice', 'my vanessa build has never once lost a fight')
    logChat(CH, 'bob', 'honestly i think pygmalien is overpriced garbage')
    for (let i = 0; i < 20; i++) logChat(CH, 'bob', `is pygmalien worth buying ${i}?`)
    flushWrites()
    const ctx = { user: 'alice', channel: CH } as any

    __resetToneForTest()
    setTone(CH, 'unhinged', 'test')
    const hot = buildUserMessage('roast @bob', ctx)
    expect(hot.text).toContain('Who they are')
    expect(hot.text).toContain('my vanessa build has never once lost a fight')
    expect(hot.text).toContain('bob: 21 msgs here')
    expect(hot.text).toContain('keeps bringing up "pygmalien"')

    setTone(CH, 'normal', 'test')
    const calm = buildUserMessage('roast @bob', ctx)
    expect(calm.text).not.toContain('Who they are')
    __resetToneForTest()
  })
})
