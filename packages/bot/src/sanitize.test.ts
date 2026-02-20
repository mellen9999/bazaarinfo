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

  it('strips trailing ", chat" filler', () => {
    expect(sanitize("can't defy gravity, chat").text).toBe("can't defy gravity")
  })

  it('does not strip "chat" without comma', () => {
    expect(sanitize('welcome to the chat').text).toBe('welcome to the chat')
  })

  it('rejects self-referencing bot talk', () => {
    expect(sanitize('im a bot so idk').text).toBe('')
    expect(sanitize('as a bot I think').text).toBe('')
  })

  it('strips narration patterns', () => {
    expect(sanitize("he just asked about cards").text).toBe('cards')
    expect(sanitize("is asking me to look it up").text).toBe('look it up')
    expect(sanitize("asked for a summary of stuff").text).toBe('a summary of stuff')
  })

  it('strips asker name from body', () => {
    const r = sanitize('hey topkawaii nice play there', 'topkawaii')
    expect(r.text).not.toContain('topkawaii')
  })

  it('strips asker possessive from body', () => {
    const r = sanitize("coaoaba's been spamming commands", 'coaoaba')
    expect(r.text).not.toContain('coaoaba')
    expect(r.text).not.toStartWith("'s")
    expect(r.text).toBe('been spamming commands')
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
    expect(sanitize('thats just how it goes in ranked').text).toBe('in ranked')
    expect(sanitize('chats been absolutely unhinged today').text).toBe('today')
  })

  it('handles empty string', () => {
    expect(sanitize('').text).toBe('')
  })

  it('handles string that is only a banned opener', () => {
    const r = sanitize('alright so')
    expect(r.text).toBe('')
  })

  // --- COT_LEAK patterns ---
  it('rejects "respond naturally" COT leak', () => {
    expect(sanitize('I should respond naturally to this banter').text).toBe('')
  })

  it('rejects "this is banter" COT leak', () => {
    expect(sanitize('this is banter so ill play along').text).toBe('')
  })

  it('rejects "is an emote" COT leak without parens', () => {
    expect(sanitize('krippBelly is an emote that means hes full').text).toBe('')
  })

  it('rejects "is an emote(" COT leak with paren', () => {
    expect(sanitize('krippBelly is an emote(round belly)').text).toBe('')
  })

  it('rejects "chain of thought" COT leak', () => {
    expect(sanitize('my chain of thought says this is a joke').text).toBe('')
  })

  it('rejects "looking at the meta summary" COT leak', () => {
    expect(sanitize('looking at the meta summary, lunar new year event').text).toBe('')
  })

  it('rejects "looking at the reddit digest" COT leak', () => {
    expect(sanitize('looking at the reddit digest, people are saying').text).toBe('')
  })

  it('rejects "overusing" self-commentary COT leak', () => {
    expect(sanitize('nice play overusing kappa now').text).toBe('')
  })

  it('rejects "i keep using" self-commentary COT leak', () => {
    expect(sanitize('i keep using the same emote').text).toBe('')
  })

  // --- FABRICATION patterns ---
  it('rejects "it was a dream" fabrication', () => {
    expect(sanitize('it was a dream where kripp hit legend').text).toBe('')
  })

  it('rejects "legend has it" fabrication', () => {
    expect(sanitize('legend has it that reynad once hit 12 wins').text).toBe('')
  })

  // --- 150 char hard cap ---
  it('truncates at 150 chars to last boundary', () => {
    const long = 'a'.repeat(80) + '. ' + 'b'.repeat(80)
    const r = sanitize(long)
    expect(r.text.length).toBeLessThanOrEqual(150)
    expect(r.text).toBe('a'.repeat(80))
  })

  it('preserves text over 60 chars when truncating', () => {
    const long = 'x'.repeat(70) + ' ' + 'y'.repeat(90)
    const r = sanitize(long)
    expect(r.text.length).toBeGreaterThan(60)
    expect(r.text.length).toBeLessThanOrEqual(150)
  })

  it('strips trailing garbage from token cutoff', () => {
    expect(sanitize('great response here k,,').text).toBe('great response here')
    expect(sanitize('solid take,').text).toBe('solid take')
  })

  it('does not truncate at exactly 150 chars', () => {
    const exact = 'a'.repeat(150)
    const r = sanitize(exact)
    expect(r.text).toBe(exact)
  })

  // --- speedrun verbal tic ---
  it('strips "speedrunning" verbal tic', () => {
    expect(sanitize('speedrunning the loss streak').text).toBe('the loss streak')
  })

  it('strips "speedrun" verbal tic', () => {
    expect(sanitize('nice speedrun of the whole game').text).toBe('nice of the whole game')
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
