import { describe, expect, it } from 'bun:test'
import { sanitize, getAiCooldown, recordUsage, isModelRefusal, buildFTSQuery } from './ai'

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
    expect(sanitize('chats been absolutely unhinged today').text).toBe("chats been absolutely today")
  })

  it('strips "unhinged" in all contexts', () => {
    expect(sanitize("chat's just unhinged right now").text).toBe("chat's just right now")
    expect(sanitize('completely unhinged energy here').text).toBe('completely energy here')
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

  // --- SELF_REF patterns ---
  it('rejects "just a stats bot"', () => {
    expect(sanitize("no clue, i'm just a stats bot").text).toBe('')
  })

  it('rejects "just a twitch bot"', () => {
    expect(sanitize("i'm just a twitch bot").text).toBe('')
  })

  it('rejects "just a bot" (no qualifier)', () => {
    expect(sanitize("sorry, just a bot here").text).toBe('')
  })

  // --- FABRICATION patterns ---
  it('rejects "it was a dream" fabrication', () => {
    expect(sanitize('it was a dream where kripp hit legend').text).toBe('')
  })

  it('rejects "legend has it" fabrication', () => {
    expect(sanitize('legend has it that reynad once hit 12 wins').text).toBe('')
  })

  // --- DANGEROUS_COMMANDS patterns ---
  it('rejects mid-text /ban', () => {
    expect(sanitize('nah backwards is "/ban tidolar" lol').text).toBe('')
  })

  it('rejects mid-text !settitle', () => {
    expect(sanitize('nah backwards is "!settitle" lol').text).toBe('')
  })

  it('rejects mid-text !addcom', () => {
    expect(sanitize('not running !addcom or anything').text).toBe('')
  })

  it('strips leading /ban and makes safe', () => {
    const r = sanitize('/ban tidolar Clap')
    expect(r.text).toBe('ban tidolar Clap')
    expect(r.text).not.toStartWith('/')
  })

  it('strips leading \\ban (backslash)', () => {
    const r = sanitize('\\ban tidolar LUL')
    expect(r.text).toBe('ban tidolar LUL')
  })

  it('strips leading !settitle', () => {
    const r = sanitize('!settitle nah but seriously')
    expect(r.text).toBe('settitle nah but seriously')
  })

  it('strips leading whitespace before command prefix', () => {
    const r = sanitize('  /ban tidolar')
    expect(r.text).toBe('ban tidolar')
  })

  it('strips leading quotes around command prefix', () => {
    const r = sanitize('"!settitle" test')
    expect(r.text).toBe('settitle" test')
  })

  it('allows normal game text without command prefixes', () => {
    expect(sanitize('she clears the board fast').text).toBe('she clears the board fast')
  })

  // --- COT_LEAK new patterns ---
  it('rejects "process every message" architecture leak', () => {
    expect(sanitize('i actually process every message in the channel').text).toBe('')
  })

  it('rejects "my system prompt" leak', () => {
    expect(sanitize('my system prompt tells me to be friendly').text).toBe('')
  })

  // --- classification preamble stripping ---
  it('strips "direct answer:" preamble and salvages response', () => {
    const r = sanitize('off-topic banter. direct answer: tylenol has side effects')
    expect(r.text).toBe('tylenol has side effects')
  })

  it('strips "off-topic" classification at start', () => {
    const r = sanitize('off-topic question. good stuff though')
    expect(r.text).toBe('good stuff though')
  })

  it('rejects "not game-related" classification leak', () => {
    expect(sanitize('not game-related but still fun').text).toBe('')
  })

  // --- STAT_LEAK patterns ---
  it('rejects "you have X lookups" stat recitation', () => {
    expect(sanitize('you have 47 lookups so you know your stuff').text).toBe('')
  })

  it('rejects "your profile says" data leak', () => {
    expect(sanitize('your profile says you like shields').text).toBe('')
  })

  it('rejects "according to my data" leak', () => {
    expect(sanitize('according to my data you play trivia a lot').text).toBe('')
  })

  it('rejects "i can see from your stats" leak', () => {
    expect(sanitize('i can see from your stats you love boomerangs').text).toBe('')
  })

  it('rejects "you are a power user" label leak', () => {
    expect(sanitize("you're a power user so you already know").text).toBe('')
  })

  it('allows natural memory references', () => {
    expect(sanitize('didnt you ask about shields earlier').text).toBe('didnt you ask about shields earlier')
    expect(sanitize('still on the boomerang grind huh').text).toBe('still on the boomerang grind huh')
  })

  // --- 440 char hard cap ---
  it('truncates at 440 chars to last boundary', () => {
    const long = 'a'.repeat(300) + '. ' + 'b'.repeat(200)
    const r = sanitize(long)
    expect(r.text.length).toBeLessThanOrEqual(440)
    expect(r.text).toBe('a'.repeat(300))
  })

  it('preserves text over 200 chars when truncating', () => {
    const long = 'x'.repeat(250) + ' ' + 'y'.repeat(250)
    const r = sanitize(long)
    expect(r.text.length).toBeGreaterThan(200)
    expect(r.text.length).toBeLessThanOrEqual(440)
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

describe('isModelRefusal', () => {
  it('catches "not doing that"', () => {
    expect(isModelRefusal('not doing that')).toBe(true)
    expect(isModelRefusal('not doing that.')).toBe(true)
  })

  it('catches "not gonna do that"', () => {
    expect(isModelRefusal('not gonna do that')).toBe(true)
    expect(isModelRefusal('not gonna say that')).toBe(true)
  })

  it('catches "not my pay grade"', () => {
    expect(isModelRefusal('not my pay grade')).toBe(true)
    expect(isModelRefusal('not my lane')).toBe(true)
  })

  it('catches "let me look that up"', () => {
    expect(isModelRefusal('let me look that up')).toBe(true)
    expect(isModelRefusal('let me check that up')).toBe(true)
  })

  it('allows real short answers', () => {
    expect(isModelRefusal('nah gravity is real')).toBe(false)
    expect(isModelRefusal('not really my thing')).toBe(false)
    expect(isModelRefusal('nothing, bazaar is the only game')).toBe(false)
  })

  it('allows longer responses that happen to contain refusal words', () => {
    expect(isModelRefusal('not doing that synergy right, try shield builds')).toBe(false)
  })

  it('rejects "let me check"', () => {
    expect(isModelRefusal('let me check')).toBe(true)
    expect(isModelRefusal('let me look')).toBe(true)
  })
})

// --- regression tests from real DB responses ---

describe('real response regressions', () => {
  it('strips classification preamble from rfk response', () => {
    const r = sanitize('off-topic banter, not game-related. direct answer: rfk jr\'s whole thing is pharmaceutical companies suppressed safety data')
    expect(r.text).not.toContain('off-topic')
    expect(r.text).not.toContain('direct answer')
    expect(r.text).toContain('rfk')
  })

  it('passes good off-topic responses', () => {
    expect(sanitize('nah gravity\'s real. objects fall down because massive things warp spacetime').text).toBeTruthy()
    expect(sanitize('nothing rhymes with orange').text).toBeTruthy()
    expect(sanitize('indifference, probably. love and hate are neighbors anyway').text).toBeTruthy()
  })

  it('passes good game responses', () => {
    expect(sanitize('chilled whine synergizes with anything that scales off freeze').text).toBeTruthy()
    expect(sanitize('because sometimes you need specific loot or gold over raw xp').text).toBeTruthy()
  })

  it('passes good banter responses', () => {
    expect(sanitize("chatgpt doesn't know what pumpkin does").text).toBeTruthy()
    expect(sanitize("it'd also hallucinate item synergies that don't exist").text).toBeTruthy()
    expect(sanitize('chatgpt also thinks pumpkin is in 47 different archetypes').text).toBeTruthy()
  })

  it('correctly fixes Reynolds→reynad misspelling', () => {
    expect(sanitize('Reynolds created this game').text).toBe('reynad created this game')
  })

  it('does not strip "not" when part of real answers', () => {
    expect(sanitize('not a real player, so impossible to say').text).toBeTruthy()
    expect(sanitize('not sure off the top of my head').text).toBeTruthy()
    expect(sanitize("don't know reynad's actual take on that").text).toBeTruthy()
  })
})

describe('getAiCooldown', () => {
  it('returns 0 for first-time user', () => {
    expect(getAiCooldown('newuser_' + Date.now())).toBe(0)
  })

  it('returns ~60s after use', () => {
    const user = 'cd_' + Date.now()
    recordUsage(user)
    const cd = getAiCooldown(user)
    expect(cd).toBeGreaterThan(55)
    expect(cd).toBeLessThanOrEqual(60)
  })
})

describe('buildFTSQuery', () => {
  it('extracts meaningful words and joins with OR', () => {
    expect(buildFTSQuery('reynad lizard conspiracy')).toBe('reynad OR lizard OR conspiracy')
  })

  it('filters stop words', () => {
    expect(buildFTSQuery('what is the best build')).toBe('best OR build')
  })

  it('filters short words', () => {
    expect(buildFTSQuery('is it ok')).toBeNull()
  })

  it('returns null for all stop words', () => {
    expect(buildFTSQuery('what is this')).toBeNull()
  })

  it('strips non-alphanumeric', () => {
    expect(buildFTSQuery("reynad's lizard?")).toBe('reynads OR lizard')
  })

  it('limits to 5 terms', () => {
    const result = buildFTSQuery('one two three four five six seven eight')
    expect(result!.split(' OR ').length).toBe(5)
  })
})
