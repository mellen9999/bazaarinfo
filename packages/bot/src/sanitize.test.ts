import { describe, expect, it } from 'bun:test'
import { sanitize, getBrevity, recordUsage } from './ai'

describe('sanitize', () => {
  it('strips markdown bold', () => {
    expect(sanitize('**hello** world').text).toBe('hello world')
  })

  it('strips markdown italic', () => {
    expect(sanitize('*hello* world').text).toBe('hello world')
  })

  it('strips backticks', () => {
    expect(sanitize('use `cmd` here').text).toBe('use cmd here')
  })

  it('strips banned openers: ok so', () => {
    expect(sanitize('ok so this is cool').text).toBe('this is cool')
  })

  it('strips banned openers: alright so', () => {
    expect(sanitize('alright so here we go').text).toBe('here we go')
  })

  it('strips banned openers: alright', () => {
    expect(sanitize('alright here we go').text).toBe('here we go')
  })

  it('strips banned openers: look', () => {
    expect(sanitize('look this is real').text).toBe('this is real')
  })

  it('strips banned openers: man', () => {
    expect(sanitize('man that was wild').text).toBe('that was wild')
  })

  it('strips banned openers: dude', () => {
    expect(sanitize('dude check this out').text).toBe('check this out')
  })

  it('strips banned openers: yo', () => {
    expect(sanitize('yo what up').text).toBe('what up')
  })

  it('strips stacked openers: alright so look,', () => {
    expect(sanitize('alright so look, here we go').text).toBe('here we go')
  })

  it('strips trailing filler', () => {
    expect(sanitize('nice play lol').text).toBe('nice play')
    expect(sanitize('great stuff lmao').text).toBe('great stuff')
  })

  it('rejects self-referencing bot talk', () => {
    expect(sanitize('im a bot so idk').text).toBe('')
    expect(sanitize('as a bot I think').text).toBe('')
  })

  it('strips narration patterns', () => {
    expect(sanitize("he just asked about cards").text).toBe('cards')
    expect(sanitize("is asking me to look it up").text).toBe('look it up')
    expect(sanitize("asked for a summary of chat").text).toBe('a summary of chat')
  })

  it('strips asker name from body', () => {
    const r = sanitize('hey topkawaii nice play there', 'topkawaii')
    expect(r.text).not.toContain('topkawaii')
  })

  it('extracts @mentions', () => {
    const r = sanitize('nice one @kripp and @mellen')
    expect(r.mentions).toEqual(['@kripp', '@mellen'])
    expect(r.text).not.toContain('@')
  })

  it('strips trailing question', () => {
    const r = sanitize('cabbage is great. What do you think?')
    expect(r.text).toBe('cabbage is great.')
  })

  it('converts large ms to seconds', () => {
    expect(sanitize('responded in 2500ms').text).toBe('responded in 2.5s')
  })

  it('keeps small ms values', () => {
    expect(sanitize('took 50ms').text).toBe('took 50ms')
  })

  it('strips verbal tics', () => {
    expect(sanitize('respect the commitment but Birdge is the purest form').text).toBe('but Birdge is the purest form')
    expect(sanitize('thats just how it goes in chat').text).toBe('in chat')
    expect(sanitize('chats been absolutely unhinged today').text).toBe('today')
  })

  it('handles empty string', () => {
    expect(sanitize('').text).toBe('')
  })

  it('handles string that is only a banned opener', () => {
    const r = sanitize('alright so')
    expect(r.text).toBe('')
  })
})

describe('getBrevity', () => {
  it('returns 0 for first-time user', () => {
    expect(getBrevity('newuser_' + Date.now())).toBe(0)
  })

  it('escalates with repeated use', () => {
    const user = 'spammer_' + Date.now()
    // 0 history = normal
    expect(getBrevity(user)).toBe(0)
    recordUsage(user) // 1 entry
    // 1 entry - 1 = still 0 (first use is free)
    expect(getBrevity(user)).toBe(0)
    recordUsage(user) // 2 entries
    expect(getBrevity(user)).toBe(1)
    recordUsage(user) // 3 entries
    expect(getBrevity(user)).toBe(2)
    recordUsage(user) // 4 entries
    expect(getBrevity(user)).toBe(3)
  })

  it('caps at 3', () => {
    const user = 'maxcap_' + Date.now()
    for (let i = 0; i < 10; i++) recordUsage(user)
    expect(getBrevity(user)).toBe(3)
  })
})
