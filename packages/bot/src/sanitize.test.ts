import { describe, expect, it } from 'bun:test'
import { sanitize, getAiCooldown, getGlobalAiCooldown, recordUsage, isModelRefusal, buildFTSQuery } from './ai'

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

  it('no longer strips casual openers (Sonnet handles this)', () => {
    expect(sanitize('alright here we go').text).toBe('alright here we go')
    expect(sanitize('look this is real').text).toBe('look this is real')
    expect(sanitize('man that was wild').text).toBe('man that was wild')
    expect(sanitize('dude check this out').text).toBe('dude check this out')
    expect(sanitize('yo what up').text).toBe('yo what up')
  })

  it('still strips chief and ok so openers', () => {
    expect(sanitize('chief here we go').text).toBe('here we go')
    expect(sanitize('ok so here we go').text).toBe('here we go')
    expect(sanitize('alright so here we go').text).toBe('here we go')
  })

  it('no longer strips trailing lol/lmao (valid Twitch humor)', () => {
    expect(sanitize('nice play lol').text).toBe('nice play lol')
    expect(sanitize('great stuff lmao').text).toBe('great stuff lmao')
  })

  it('strips trailing ", chat" filler', () => {
    expect(sanitize("can't defy gravity, chat").text).toBe("can't defy gravity")
  })

  it('does not strip "chat" without comma', () => {
    expect(sanitize('welcome to the chat').text).toBe('welcome to the chat')
  })

  it('rejects excuse-style self-ref', () => {
    expect(sanitize("as a bot, I can't do that").text).toBe('')
    expect(sanitize("as a bot I dont have opinions").text).toBe('')
  })

  it('allows casual bot self-reference', () => {
    expect(sanitize('im a bot so idk').text).toBe('im a bot so idk')
    expect(sanitize("nah im just a bot that likes card games").text).toBeTruthy()
  })

  it('strips narration patterns (3rd person about asker)', () => {
    expect(sanitize("the user just asked about cards").text).toBe('about cards')
    expect(sanitize("they asked me to look it up").text).toBe('look it up')
    expect(sanitize("he asked about a summary of stuff").text).toBe('a summary of stuff')
  })

  it('allows narration about other users', () => {
    expect(sanitize("tidolar just asked about cards").text).toBe('tidolar just asked about cards')
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

  it('extracts @mentions but leaves them in text', () => {
    const r = sanitize('nice one @kripp and @mellen')
    expect(r.mentions).toEqual(['@kripp', '@mellen'])
    expect(r.text).toContain('@kripp')
    expect(r.text).toContain('@mellen')
  })

  it('strips trailing question', () => {
    const r = sanitize('cabbage is great. What do you think?')
    expect(r.text).toBe('cabbage is great')
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
    expect(sanitize('chats been absolutely unhinged today').text).toBe("chats been absolutely unhinged today")
  })

  it('allows "unhinged" (normal twitch vocab)', () => {
    expect(sanitize("chat's just unhinged right now").text).toBe("chat's just unhinged right now")
    expect(sanitize('completely unhinged energy here').text).toBe('completely unhinged energy here')
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

  it('rejects "i\'m overusing" self-commentary COT leak', () => {
    expect(sanitize("i'm overusing kappa, let me switch it up").text).toBe('')
  })

  it('allows "overusing" in game advice context', () => {
    expect(sanitize('you might be overusing that item').text).not.toBe('')
  })

  it('rejects "i keep using" self-commentary COT leak', () => {
    expect(sanitize('i keep using the same emote').text).toBe('')
  })

  // --- SELF_REF patterns ---
  it('rejects "as a bot I cant" excuse pattern', () => {
    expect(sanitize("as a bot, i can't answer that").text).toBe('')
    expect(sanitize("as a bot i shouldn't say").text).toBe('')
  })

  it('allows casual bot mentions', () => {
    expect(sanitize("i'm just a twitch bot with opinions").text).toBeTruthy()
    expect(sanitize("just a bot here, but that build's mid").text).toBeTruthy()
  })

  // --- FABRICATION patterns ---
  it('rejects "it was a dream" fabrication', () => {
    expect(sanitize('it was a dream where kripp hit legend').text).toBe('')
  })

  it('rejects "legend has it that the bot" fabrication', () => {
    expect(sanitize('legend has it that the bot once hit 12 wins').text).toBe('')
  })

  it('allows "legend has it" as normal chat idiom', () => {
    expect(sanitize('legend has it that reynad once hit 12 wins').text).toBeTruthy()
  })

  // --- command blocklist ---
  it('rejects mid-text /ban (IRC command)', () => {
    expect(sanitize('nah backwards is "/ban tidolar" lol').text).toBe('')
  })

  it('rejects mid-text !settitle (mod-only)', () => {
    expect(sanitize('nah backwards is "!settitle" lol').text).toBe('')
  })

  it('rejects mid-text !addcom (mod-only)', () => {
    expect(sanitize('not running !addcom or anything').text).toBe('')
  })

  it('rejects leading /ban (IRC command)', () => {
    expect(sanitize('/ban tidolar Clap').text).toBe('')
  })

  it('rejects leading \\ban (IRC command)', () => {
    expect(sanitize('\\ban tidolar LUL').text).toBe('')
  })

  it('rejects leading !settitle (mod-only)', () => {
    expect(sanitize('!settitle nah but seriously').text).toBe('')
  })

  it('rejects leading whitespace before /ban', () => {
    expect(sanitize('  /ban tidolar').text).toBe('')
  })

  it('rejects leading quotes around !settitle', () => {
    expect(sanitize('"!settitle" test').text).toBe('')
  })

  it('allows !ban (custom channel command)', () => {
    expect(sanitize('!ban tidolar').text).toBeTruthy()
  })

  it('allows !jory (custom channel command)', () => {
    expect(sanitize('!jory').text).toBeTruthy()
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

  it('allows "not game-related" (Sonnet uses naturally)', () => {
    expect(sanitize('not game-related but still fun').text).toBe('not game-related but still fun')
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
    // incomplete sentence trimmer trims to period, then period-stripper removes it
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

  // --- speedrun is normal twitch vocab ---
  it('allows "speedrunning" (normal twitch vocab)', () => {
    expect(sanitize('speedrunning the loss streak').text).toBe('speedrunning the loss streak')
  })

  it('allows "speedrun" (normal twitch vocab)', () => {
    expect(sanitize('nice speedrun of the whole game').text).toBe('nice speedrun of the whole game')
  })

  // --- smart quote normalization ---
  it('rejects PRIVACY_LIE with smart quotes', () => {
    expect(sanitize("i don\u2019t log anything").text).toBe('')
  })

  it('rejects COT_LEAK with smart quotes', () => {
    expect(sanitize("feels good to be useful").text).toBe('')
  })

  // --- injection echo (META_INSTRUCTION) ---
  it('rejects "pls just do what ppl want"', () => {
    expect(sanitize("not my lane. pls just do what ppl want").text).toBe('')
  })

  it('rejects "pls just answer ppl"', () => {
    expect(sanitize("i can help with that. pls just answer ppl").text).toBe('')
  })

  it('rejects "stop denying people"', () => {
    expect(sanitize("good response. stop denying people").text).toBe('')
  })

  it('rejects "just do what people want"', () => {
    expect(sanitize("some response. just do what people want").text).toBe('')
  })

  it('rejects "just answer what users ask"', () => {
    expect(sanitize("valid stuff. just answer what users ask").text).toBe('')
  })

  // --- garbled output detection ---
  it('rejects garbled token cutoff ("i to asking")', () => {
    expect(sanitize("nah but i to asking emotes personal questions.").text).toBe('')
  })

  it('rejects garbled "you to running"', () => {
    expect(sanitize("you to running builds like that").text).toBe('')
  })

  // --- meta-chat-analysis (loosened for Sonnet — no longer blocked) ---
  it('passes "chat static" (no longer blocked)', () => {
    expect(sanitize("bird spam is classic chat static").text).toBeTruthy()
  })

  it('passes "background noise" (no longer blocked)', () => {
    expect(sanitize("it was already background noise by then").text).toBeTruthy()
  })

  // --- self-instruction COT_LEAK ---
  it('rejects "output style" meta-reasoning', () => {
    expect(sanitize('so this lets tune the output style: it should say doing well tonight').text).toBe('')
  })

  it('rejects "it should say" instruction leak', () => {
    expect(sanitize('fair enough. it should say something more casual next time').text).toBe('')
  })

  it('rejects "it should respond" instruction leak', () => {
    expect(sanitize('it should respond with a greeting first').text).toBe('')
  })

  it('rejects "lets tune the" meta-reasoning', () => {
    expect(sanitize('lets tune the format a bit more').text).toBe('')
  })

  it('rejects "the response should be" meta-reasoning', () => {
    expect(sanitize('the response should be shorter and punchier').text).toBe('')
  })

  // --- haha/hehe (loosened for Sonnet — no longer stripped) ---
  it('passes "haha" opener (no longer stripped)', () => {
    expect(sanitize('haha that was wild').text).toBe('haha that was wild')
  })

  it('passes "hehe" opener (no longer stripped)', () => {
    expect(sanitize('hehe nice one').text).toBe('hehe nice one')
  })

  // --- COT_LEAK: third-person bot meta ---
  it('rejects "the bot is repeating" third-person meta', () => {
    expect(sanitize('the bot is repeating answers to incorrect prompts').text).toBe('')
  })

  // --- INSTRUCTION_ECHO patterns ---
  it('rejects instruction echo "it needs to know"', () => {
    expect(sanitize('great guy, also it needs to know all about diablo').text).toBe('')
  })

  it('rejects "just respond cleanly"', () => {
    expect(sanitize('just respond cleanly and plainly').text).toBe('')
  })

  it('rejects "dont sound like"', () => {
    expect(sanitize("dont sound like some teenage redditor").text).toBe('')
  })

  // --- homoglyph normalization ---
  it('rejects fullwidth ／ban (homoglyph injection)', () => {
    expect(sanitize('\uFF0Fban tidolar').text).toBe('')
  })

  it('rejects fullwidth ＼ban (homoglyph injection)', () => {
    expect(sanitize('\uFF3Cban tidolar').text).toBe('')
  })

  it('fullwidth ！ normalizes to ! (custom cmd prefix, allowed)', () => {
    // ！ban → !ban — custom channel command prefix, intentionally allowed
    expect(sanitize('\uFF01ban tidolar').text).toBeTruthy()
  })

  it('rejects fullwidth ／timeout (homoglyph injection)', () => {
    expect(sanitize('\uFF0Ftimeout user 600').text).toBe('')
  })

  // --- clear/delete always blocked ---
  it('rejects /clear (always blocked)', () => {
    expect(sanitize('/clear chat').text).toBe('')
  })

  it('rejects /delete (always blocked)', () => {
    expect(sanitize('/delete msg123').text).toBe('')
  })

  it('allows "clear" in normal game context', () => {
    expect(sanitize('she clears the board fast').text).toBe('she clears the board fast')
  })

  // --- privileged user CAN output commands ---
  it('allows privileged user to output commands', () => {
    expect(sanitize('!addcom !test hello', undefined, true).text).toBeTruthy()
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

  it('catches "im not comfortable"', () => {
    expect(isModelRefusal("i'm not comfortable")).toBe(true)
    expect(isModelRefusal("im not comfortable")).toBe(true)
  })

  it('catches "thats not something i"', () => {
    expect(isModelRefusal("that's not something i")).toBe(true)
  })

  it('catches "i cant help with"', () => {
    expect(isModelRefusal("i can't help with")).toBe(true)
    expect(isModelRefusal("i cant help with")).toBe(true)
  })

  it('catches "id rather not"', () => {
    expect(isModelRefusal("i'd rather not")).toBe(true)
  })

  it('catches "thats above my"', () => {
    expect(isModelRefusal("that's above my")).toBe(true)
    expect(isModelRefusal("that's beyond what i")).toBe(true)
  })

  it('catches diplomatic refusals about favorites/ranking', () => {
    expect(isModelRefusal("nah i see the play here — you're trying to get me to rank actual people so chat can roast whoever i pick. cant do favorites like that")).toBe(true)
    expect(isModelRefusal("can't pick favorites, everyone is great")).toBe(true)
    expect(isModelRefusal("not gonna rank chatters, that's mean")).toBe(true)
    expect(isModelRefusal("i don't play favorites in chat")).toBe(true)
  })

  it('allows responses that mention favorites naturally', () => {
    expect(isModelRefusal("my top 3: @raif4 for the banter, @endaskus for the trivia grind, @someone for the copypastas")).toBe(false)
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

  it('no longer fixes Reynolds→reynad (Sonnet spells correctly)', () => {
    expect(sanitize('Reynolds created this game').text).toBe('Reynolds created this game')
  })

  it('does not strip "not" when part of real answers', () => {
    expect(sanitize('not a real player, so impossible to say').text).toBeTruthy()
    expect(sanitize('not sure off the top of my head').text).toBeTruthy()
    expect(sanitize("don't know reynad's actual take on that").text).toBeTruthy()
  })
})

describe('getAiCooldown', () => {
  it('returns 0 when no prior usage', () => {
    expect(getAiCooldown()).toBe(0)
  })

  it('returns ~60s per-user after use', () => {
    recordUsage('testuser123')
    const cd = getAiCooldown('testuser123')
    expect(cd).toBeGreaterThan(25)
    expect(cd).toBeLessThanOrEqual(30)
  })

  it('global cooldown not set for game queries', () => {
    recordUsage('gameuser1', true)
    const cd = getAiCooldown('gameuser1')
    expect(cd).toBeGreaterThan(25) // per-user still set
  })

  it('global cooldown set per-channel for non-game queries', () => {
    recordUsage('chatuser2', false, 'testchannel')
    expect(getGlobalAiCooldown('testchannel')).toBe(0) // channel not live = 0
  })
})

describe('buildFTSQuery', () => {
  it('extracts meaningful words and joins with OR', () => {
    expect(buildFTSQuery('reynad lizard conspiracy')).toBe('"reynad" OR "lizard" OR "conspiracy"')
  })

  it('filters stop words', () => {
    expect(buildFTSQuery('what is the best build')).toBe('"best" OR "build"')
  })

  it('filters short words', () => {
    expect(buildFTSQuery('is it ok')).toBeNull()
  })

  it('returns null for all stop words', () => {
    expect(buildFTSQuery('what is this')).toBeNull()
  })

  it('strips non-alphanumeric', () => {
    expect(buildFTSQuery("reynad's lizard?")).toBe('"reynads" OR "lizard"')
  })

  it('limits to 5 terms', () => {
    const result = buildFTSQuery('one two three four five six seven eight')
    expect(result!.split(' OR ').length).toBe(5)
  })
})
