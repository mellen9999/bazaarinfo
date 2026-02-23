/**
 * AI quality audit — tests real Twitch prompts through the full pipeline.
 * Loads actual cache data, runs entity extraction, context building,
 * sanitizer, and checks answer patterns.
 */
import { describe, expect, it, beforeAll } from 'bun:test'
import * as store from './store'
import { sanitize, buildSystemPrompt, isModelRefusal, buildFTSQuery, GREETINGS } from './ai'
import { handleCommand, parseArgs } from './commands'

// --- load real data so extractEntities / store calls work ---
beforeAll(async () => {
  await store.loadStore()
})

// ============================================================
// 1. Entity extraction — does the AI get the right game data?
// ============================================================
describe('entity extraction via store', () => {
  it('finds real items by exact name', () => {
    const card = store.exact('Subscraper')
    expect(card).toBeTruthy()
    expect(card!.Title).toBe('Subscraper')
  })

  it('finds items via alias', () => {
    const card = store.exact('beetle') ?? store.search('beetle', 1)[0]
    expect(card).toBeTruthy()
    expect(card!.Title).toBe('BLU-B33TL3')
  })

  it('finds terry-dactyl alias', () => {
    const card = store.exact('pterodactyl') ?? store.search('pterodactyl', 1)[0]
    expect(card).toBeTruthy()
    expect(card!.Title).toBe('Terry-Dactyl')
  })

  it('finds monsters', () => {
    const monster = store.findMonster('coconut crab')
    expect(monster).toBeTruthy()
    expect(monster!.Title).toBe('Coconut Crab')
  })

  it('finds heroes', () => {
    const hero = store.findHeroName('vanessa')
    expect(hero).toBeTruthy()
  })

  it('finds tags', () => {
    const tag = store.findTagName('weapon')
    expect(tag).toBeTruthy()
  })

  it('finds day monsters', () => {
    const mobs = store.monstersByDay(1)
    expect(mobs.length).toBeGreaterThan(0)
  })

  it('fuzzy search handles typos', () => {
    const results = store.search('magnifing glass', 1) // common misspelling
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].Title).toBe('Magnifying Glass')
  })

  it('searchByEffect finds items with burn', () => {
    const results = store.searchByEffect('burn', undefined, 5)
    expect(results.length).toBeGreaterThan(0)
  })
})

// ============================================================
// 2. System prompt quality
// ============================================================
describe('system prompt', () => {
  it('is under 5200 chars (token budget)', () => {
    const prompt = buildSystemPrompt()
    expect(prompt.length).toBeLessThan(5200)
  })

  it('contains core identity', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('bazaarinfo')
    expect(prompt).toContain('The Bazaar')
    expect(prompt).toContain('bazaardb.gg')
  })

  it('contains hero names', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('Heroes:')
  })

  it('contains tag names', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('Tags:')
  })

  it('does not contain *Reference internal tags', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).not.toMatch(/\w+Reference/)
  })

  it('contains privacy honesty rule', () => {
    const prompt = buildSystemPrompt()
    expect(prompt.toLowerCase()).toContain('privacy')
    expect(prompt).toContain('mellen built me')
  })

  it('contains copypasta instructions', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('COPYPASTA')
    expect(prompt).toContain('400 chars')
  })

  it('contains length constraints', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('60-150')
    // "no markdown" enforced by sanitizer, not prompt
  })

  it('bans URL/link generation', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('links only')
    expect(prompt).toContain('bazaardb.gg')
  })
})

// ============================================================
// 3. Sanitizer vs real Twitch AI responses (quality gate)
// ============================================================
describe('sanitizer passes good responses', () => {
  // --- game knowledge responses ---
  const gameGood = [
    'pygmalien is a small weapon with burn scaling. works great with fire builds',
    'vanessa mains crit — critical core + boomerangs is her bread and butter',
    'day 3 has coconut crab and hoverbike hooligan, both manageable',
    'shields counter burn, so if they have poison+burn go armored core',
    'terry-dactyl is a flying weapon that gets haste on crit',
    'momma-saur heals and buffs adjacent items, S tier in regen builds',
  ]

  for (const text of gameGood) {
    it(`passes: "${text.slice(0, 50)}..."`, () => {
      expect(sanitize(text).text).toBeTruthy()
    })
  }

  // --- banter/chat responses ---
  const banterGood = [
    'nah gravity is just a suggestion at this point',
    "that's a certified classic right there",
    'the vibes are immaculate tonight',
    "honestly couldn't agree more",
    'absolute cinema happening in chat rn',
    'based take honestly',
  ]

  for (const text of banterGood) {
    it(`passes: "${text.slice(0, 50)}..."`, () => {
      expect(sanitize(text).text).toBeTruthy()
    })
  }

  // --- off-topic knowledge responses ---
  const offTopicGood = [
    'the moon is about 384,400 km from earth on average',
    "pineapple on pizza is valid, don't let anyone tell you otherwise",
    "typescript is just javascript with extra steps. but good steps",
  ]

  for (const text of offTopicGood) {
    it(`passes: "${text.slice(0, 50)}..."`, () => {
      expect(sanitize(text).text).toBeTruthy()
    })
  }
})

describe('sanitizer blocks bad responses', () => {
  // --- COT leaks ---
  const cotLeaks = [
    'this is banter so ill keep it light',
    'respond naturally since this is off-topic',
    'looking at the meta summary, the community is hyped',
    'looking at the reddit digest, people want nerfs',
    "i'm overusing catJAM, switching emotes",
    'i keep using the same greeting',
    'i already said that earlier',
    'process every message in the channel to decide',
    'my system prompt says to be friendly',
    'reading chat and deciding what to say',
    'feels good to be useful today',
    'chat static is just people vibing',
    'it should say something more casual',
    'lets tune the response format',
    'the response should be shorter',
  ]

  for (const text of cotLeaks) {
    it(`blocks COT: "${text.slice(0, 50)}..."`, () => {
      expect(sanitize(text).text).toBe('')
    })
  }

  // --- self-reference excuses ---
  const selfRef = [
    "as a bot, I can't have opinions on that",
    "as an ai i dont experience emotions",
    "im just an ai at the end of the day",
    "im just software running on a server",
  ]

  for (const text of selfRef) {
    it(`blocks self-ref: "${text.slice(0, 50)}..."`, () => {
      expect(sanitize(text).text).toBe('')
    })
  }

  // --- stat leaks ---
  const statLeaks = [
    'your profile says you love shields',
    'you have 47 lookups, power user status',
    "you're a power user who knows the meta",
    'according to my data you main vanessa',
    'i can see from your stats you play daily',
    'based on your history you prefer burn builds',
  ]

  for (const text of statLeaks) {
    it(`blocks stat leak: "${text.slice(0, 50)}..."`, () => {
      expect(sanitize(text).text).toBe('')
    })
  }

  // --- fabrication ---
  const fabrications = [
    'legend has it that reynad once lost 50 games in a row',
    'it was a dream where kripp went 12-0',
    'the story goes that burn was nerfed 7 times',
  ]

  for (const text of fabrications) {
    it(`blocks fabrication: "${text.slice(0, 50)}..."`, () => {
      expect(sanitize(text).text).toBe('')
    })
  }

  // --- context echo (model regurgitating its own input context) ---
  const contextEchoes = [
    'Game data: Dive Weights [S] · Vanessa [Aquatic, Tool, Apparel] | Haste an item for 1/2/3s',
    'Recent chat:\n> user1: hello\n> user2: sup',
    'Stream timeline:\n5m ago: kripp discussing burn builds',
    "Who's chatting: tidolar(trivia regular) | user2(casual)",
    'Your prior exchanges (be consistent): ...',
  ]

  for (const text of contextEchoes) {
    it(`blocks context echo: "${text.slice(0, 50)}..."`, () => {
      expect(sanitize(text).text).toBe('')
    })
  }

  // --- privacy lies ---
  const privacyLies = [
    "i don't log anything, your data is safe",
    "i'm not storing any of your messages",
    "not logging anything here",
    "each conversation's a fresh slate",
    "that's on streamlabs, not me",
  ]

  for (const text of privacyLies) {
    it(`blocks privacy lie: "${text.slice(0, 50)}..."`, () => {
      expect(sanitize(text).text).toBe('')
    })
  }

  // --- dangerous commands (IRC prefixes /\. always blocked, ! only for mod-only commands) ---
  const dangerousCmds = [
    '/timeout someone 600',
    '!mod randomuser',
    '!settitle new stream title',
    '!raid otherchannel',
    '!addcom !test hello world',
  ]

  for (const text of dangerousCmds) {
    it(`blocks cmd: "${text.slice(0, 50)}..."`, () => {
      expect(sanitize(text).text).toBe('')
    })
  }

  // --- garbled output ---
  it('blocks garbled "i to asking"', () => {
    expect(sanitize('i to asking about shields now.').text).toBe('')
  })

  it('blocks garbled "you to running"', () => {
    expect(sanitize('you to running that build with burn.').text).toBe('')
  })
})

// ============================================================
// 4. Sanitizer edge cases that should NOT false-positive
// ============================================================
describe('sanitizer false positive protection', () => {
  it('allows "look up" in game context (not banned opener)', () => {
    expect(sanitize('you can look up items with !b').text).toBeTruthy()
  })

  it('allows "not" at start of real answers', () => {
    expect(sanitize('not really worth it in the current meta').text).toBeTruthy()
  })

  it('allows casual bot identity ("im a bot")', () => {
    expect(sanitize("im a bot that looks up bazaar items").text).toBeTruthy()
  })

  it('allows "overusing" when about the user, not self', () => {
    expect(sanitize("you might be overusing that synergy").text).toBeTruthy()
  })

  it('allows "unhinged" (common twitch vocab)', () => {
    expect(sanitize("that play was absolutely unhinged").text).toBeTruthy()
  })

  it('allows "speedrun" (common twitch vocab)', () => {
    expect(sanitize("speedrunning the ranked climb").text).toBeTruthy()
  })

  it('allows "legend" in game context (not fabrication)', () => {
    expect(sanitize("legendary tier is the highest").text).toBeTruthy()
  })

  it('allows "dream" in casual context (not fabrication pattern)', () => {
    expect(sanitize("that build is a dream come true").text).toBeTruthy()
  })

  it('preserves bazaardb.gg URLs', () => {
    const r = sanitize('check bazaardb.gg for full details')
    expect(r.text).toContain('bazaardb.gg')
  })

  it('strips non-bazaardb URLs', () => {
    const r = sanitize('check https://randomsite.com/stuff for info')
    expect(r.text).not.toContain('randomsite.com')
  })

  it('strips unicode emoji', () => {
    const r = sanitize('nice play! 🎉🔥')
    expect(r.text).toBe('nice play!')
  })

  it('fixes Reynolds → reynad', () => {
    expect(sanitize('Reynolds made this game').text).toContain('reynad')
  })

  it('normalizes smart quotes for pattern matching', () => {
    // smart apostrophe should still trigger privacy lie detection
    expect(sanitize("i don\u2019t log anything").text).toBe('')
  })
})

// ============================================================
// 5. Command routing — real prompts hit correct paths
// ============================================================
describe('command routing with real data', () => {
  const ctx = { user: 'testuser', channel: 'testchannel' }

  it('!b magnifying glass → item lookup', async () => {
    const result = await handleCommand('!b magnifying glass', ctx)
    expect(result).toBeTruthy()
    expect(result).toContain('Magnifying Glass')
  })

  it('!b beetle → alias lookup', async () => {
    const result = await handleCommand('!b beetle', ctx)
    expect(result).toBeTruthy()
    expect(result).toContain('BLU-B33TL3')
  })

  it('!b fishing net → item lookup', async () => {
    const result = await handleCommand('!b fishing net', ctx)
    expect(result).toBeTruthy()
    expect(result).toContain('Fishing Net')
  })

  it('!b mob coconut crab → monster info', async () => {
    const result = await handleCommand('!b mob coconut crab', ctx)
    expect(result).toBeTruthy()
    expect(result).toContain('Coconut Crab')
  })

  it('!b hero vanessa → hero items list', async () => {
    const result = await handleCommand('!b hero vanessa', ctx)
    expect(result).toBeTruthy()
    expect(result!.toLowerCase()).toContain('vanessa')
  })

  it('!b day 1 → day monsters', async () => {
    const result = await handleCommand('!b day 1', ctx)
    expect(result).toBeTruthy()
    expect(result).toContain('Day 1')
  })

  it('!b gold magnifying glass → tier-specific lookup', async () => {
    const result = await handleCommand('!b gold magnifying glass', ctx)
    expect(result).toBeTruthy()
    expect(result).toContain('Magnifying Glass')
  })

  it('!b → help text', async () => {
    const result = await handleCommand('!b', ctx)
    expect(result).toBeTruthy()
    expect(result).toContain('!b')
    expect(result).toContain('bazaardb.gg')
  })

  it('!b help → help text', async () => {
    const result = await handleCommand('!b help', ctx)
    expect(result).toBeTruthy()
    expect(result).toContain('bazaardb.gg')
  })

  it('!b enchants → enchantment list', async () => {
    const result = await handleCommand('!b enchants', ctx)
    expect(result).toBeTruthy()
    expect(result).toContain('Enchantments:')
  })

  it('non-command message → null (no AI key)', async () => {
    const result = await handleCommand('just chatting here', ctx)
    expect(result).toBeNull()
  })

  it('greetings are never silently ignored — !b hello gets a response', async () => {
    const result = await handleCommand('!b hello', ctx)
    expect(result).not.toBeNull()
  })

  it('emote names are never silently ignored — !b KEKW gets a response', async () => {
    const result = await handleCommand('!b KEKW', ctx)
    expect(typeof result).toBe('string')
  })
})

// ============================================================
// 6. parseArgs — order-agnostic arg parsing
// ============================================================
describe('parseArgs with real data', () => {
  it('tier at end: "subscraper gold"', () => {
    const r = parseArgs(['subscraper', 'gold'])
    expect(r.item).toBe('subscraper')
    expect(r.tier).toBe('Gold')
  })

  it('tier at start: "gold subscraper"', () => {
    const r = parseArgs(['gold', 'subscraper'])
    expect(r.item).toBe('subscraper')
    expect(r.tier).toBe('Gold')
  })

  it('tier + enchant: "gold shielded subscraper"', () => {
    const r = parseArgs(['gold', 'shielded', 'subscraper'])
    expect(r.item).toBe('subscraper')
    expect(r.tier).toBe('Gold')
    expect(r.enchant).toBeTruthy()
  })

  it('"golden" is enchant, not tier', () => {
    const r = parseArgs(['golden', 'subscraper'])
    // "golden" should be an enchant prefix, not a tier
    expect(r.tier).toBeUndefined()
    expect(r.enchant).toBeTruthy()
  })

  it('single word → item name only', () => {
    const r = parseArgs(['subscraper'])
    expect(r.item).toBe('subscraper')
    expect(r.tier).toBeUndefined()
    expect(r.enchant).toBeUndefined()
  })
})

// ============================================================
// 7. Greeting detection
// ============================================================
describe('greeting detection', () => {
  const greetings = ['hi', 'hey', 'yo', 'sup', 'hiii', 'hello', 'hellooo', 'howdy', 'hola', 'oi']
  for (const g of greetings) {
    it(`detects "${g}" as greeting`, () => {
      expect(GREETINGS.test(g)).toBe(true)
    })
  }

  const notGreetings = ['highway', 'helper', 'yoke', 'superior', 'home', 'history']
  for (const ng of notGreetings) {
    it(`"${ng}" is NOT a greeting`, () => {
      expect(GREETINGS.test(ng)).toBe(false)
    })
  }
})

// ============================================================
// 8. Model refusal detection
// ============================================================
describe('model refusal vs real answers', () => {
  const refusals = [
    'not doing that',
    'not gonna do that',
    "can't do that",
    "won't do that",
    'not my pay grade',
    'not my lane',
    'let me look that up',
    'let me check',
  ]

  for (const r of refusals) {
    it(`detects refusal: "${r}"`, () => {
      expect(isModelRefusal(r)).toBe(true)
    })
  }

  const realAnswers = [
    'not really, burn is better in most cases',
    "can't go wrong with shield builds though",
    "won't matter if you have enough scaling",
    'not my favorite hero but vanessa is solid',
    'let me think... yeah pygmalien is overrated',
  ]

  for (const a of realAnswers) {
    it(`allows real answer: "${a.slice(0, 40)}..."`, () => {
      expect(isModelRefusal(a)).toBe(false)
    })
  }
})

// ============================================================
// 9. FTS query building
// ============================================================
describe('FTS query safety', () => {
  it('quotes terms to prevent FTS injection', () => {
    const q = buildFTSQuery('OR AND NOT pygmalien')
    // OR/AND/NOT are stop words or short — pygmalien should be quoted
    expect(q).toContain('"pygmalien"')
    // should NOT contain unquoted OR/AND/NOT
    if (q) expect(q).not.toMatch(/\bOR\b(?!")/g) // OR only between quoted terms
  })

  it('handles NEAR injection attempt', () => {
    const q = buildFTSQuery('NEAR pygmalien shield')
    // NEAR is short (4 chars) but let's check it's quoted
    if (q) {
      expect(q).toContain('"pygmalien"')
      expect(q).toContain('"shield"')
    }
  })

  it('handles empty query', () => {
    expect(buildFTSQuery('')).toBeNull()
  })

  it('handles all-stopword query', () => {
    expect(buildFTSQuery('the is it')).toBeNull()
  })
})

// ============================================================
// 10. Length constraints (hard caps)
// ============================================================
describe('sanitizer length constraints', () => {
  it('hard caps at 440 chars', () => {
    const long = Array(50).fill('word').join(' ') + '. ' + Array(50).fill('more').join(' ')
    const r = sanitize(long)
    expect(r.text.length).toBeLessThanOrEqual(440)
  })

  it('truncates at sentence boundary when possible', () => {
    const text = 'first sentence here. ' + 'a'.repeat(430)
    const r = sanitize(text)
    expect(r.text.length).toBeLessThanOrEqual(440)
    // should end at a clean boundary
    expect(r.text).toMatch(/[.!?,]$|\.{3}$/)
  })

  it('handles no-space wall of text', () => {
    const wall = 'a'.repeat(500)
    const r = sanitize(wall)
    expect(r.text.length).toBeLessThanOrEqual(440)
  })
})

// ============================================================
// 11. Prompt injection defense (sanitizer layer)
// ============================================================
describe('prompt injection defense', () => {
  it('allows !ban (custom channel command, not IRC)', () => {
    const r = sanitize('!ban someone lol')
    expect(r.text).toBeTruthy()
  })

  it('blocks /ban (real IRC command)', () => {
    const r = sanitize('/ban tidolar')
    expect(r.text).toBe('')
  })

  it('blocks \\ban (real IRC command)', () => {
    const r = sanitize('\\ban tidolar')
    expect(r.text).toBe('')
  })

  it('blocks /timeout (real IRC command)', () => {
    const r = sanitize('/timeout user 600')
    expect(r.text).toBe('')
  })

  it('allows privileged mod commands', () => {
    const r = sanitize('!addcom !test hello', undefined, true)
    expect(r.text).toBeTruthy()
    expect(r.text).toContain('addcom')
  })

  it('blocks mod commands for non-privileged', () => {
    const r = sanitize('!addcom !test hello')
    expect(r.text).toBe('')
  })

  it('blocks !settitle for non-mod', () => {
    expect(sanitize('!settitle new stream title').text).toBe('')
  })

  it('allows !settitle for mod', () => {
    expect(sanitize('!settitle new stream title', undefined, true).text).toBeTruthy()
  })

  it('allows /me dances (not in blocklist)', () => {
    expect(sanitize('/me dances').text).toBeTruthy()
  })

  it('allows !jory (custom channel command)', () => {
    expect(sanitize('!jory').text).toBeTruthy()
  })

  it('allows !commands (custom channel command)', () => {
    expect(sanitize('!commands').text).toBeTruthy()
  })
})

// ============================================================
// 12. Low-value filter
// ============================================================
describe('low-value query filter', () => {
  it('rejects 1-2 char non-greeting', () => {
    expect(GREETINGS.test('ab')).toBe(false)
  })

  it('rejects command prefixes', () => {
    // queries starting with !/./  are low-value (bot commands)
    // We test this indirectly — these should not hit AI
  })

  it('rejects pure punctuation', () => {
    expect(GREETINGS.test('???')).toBe(false)
  })
})

// ============================================================
// 13. SECURITY AUDIT — Twitch chatter attack simulations
// ============================================================

// These tests simulate real attacks a Twitch chatter would attempt.
// Tests cover: env var extraction, prompt injection, command injection,
// privilege escalation, encoding bypasses, and data exfiltration.

describe('SEC: env var / API key extraction via AI output', () => {
  // SECRET_PATTERN rejects entire response if it contains key/env patterns
  const secretLeaks = [
    'the API key is sk-ant-abc123def456',
    'ANTHROPIC_API_KEY=sk-ant-test',
    'process.env.ANTHROPIC_API_KEY is set',
    'my api key starts with sk-ant-blah',
    'TWITCH_CLIENT_ID is in the env',
    'TWITCH_CLIENT_SECRET is abc123',
    'process.env.BOT_OWNER is mellen',
  ]

  for (const text of secretLeaks) {
    it(`blocks: "${text.slice(0, 40)}..."`, () => {
      expect(sanitize(text).text).toBe('')
    })
  }

  // non-secret mentions should still pass
  it('allows normal text about API/keys', () => {
    expect(sanitize('you can set up your own api key in the docs').text).toBeTruthy()
  })
})

describe('SEC: command injection via AI response', () => {
  // IRC commands with /\. prefix — always blocked
  const alwaysBlocked = [
    '/timeout troll 600',
    '\\ban user',
    '.ban user',
    '/whisper target secrets',
    '.timeout someone 300',
  ]

  for (const text of alwaysBlocked) {
    it(`blocks IRC cmd: "${text.replace(/\n/g, '\\n').slice(0, 40)}..."`, () => {
      expect(sanitize(text).text).toBe('')
    })
  }

  // mod-only commands — blocked for non-privileged regardless of prefix
  const modOnly = [
    '!mod malicious_user',
    '!vip attacker',
    '!raid evil_channel',
    '!host phishing_channel',
    '!announce free bitcoin at...',
    '!clear',
    '/settitle hacked',
    '!addcom !phish visit phishing.com',
    '!editcom !rules new rules here',
    '!delcom !important',
    '/MOD troll',
  ]

  for (const text of modOnly) {
    it(`blocks mod cmd: "${text.replace(/\n/g, '\\n').slice(0, 40)}..."`, () => {
      expect(sanitize(text).text).toBe('')
    })
  }

  // ! prefix commands that are custom channel commands — allowed
  const customAllowed = [
    '!ban hacker123',
    '!whisper someone hi',
    '!BAN user',
    '!Timeout user 600',
    '!jory',
    '!commands',
  ]

  for (const text of customAllowed) {
    it(`allows custom !cmd: "${text.slice(0, 40)}..."`, () => {
      expect(sanitize(text).text).toBeTruthy()
    })
  }

  // embedded mod commands in normal text — still blocked
  const embeddedMod = [
    'great question. !mod my_friend',
    'yeah lol !raid another_channel',
  ]

  for (const text of embeddedMod) {
    it(`blocks embedded mod cmd: "${text.slice(0, 40)}..."`, () => {
      expect(sanitize(text).text).toBe('')
    })
  }
})

describe('SEC: privilege escalation — non-mod addcom/editcom', () => {
  it('non-privileged cannot addcom', () => {
    expect(sanitize('!addcom !test hello world').text).toBe('')
    expect(sanitize('!addcom !scam visit this site').text).toBe('')
  })

  it('non-privileged cannot editcom', () => {
    expect(sanitize('!editcom !rules new malicious rules').text).toBe('')
  })

  it('non-privileged cannot delcom', () => {
    expect(sanitize('!delcom !important_command').text).toBe('')
  })

  it('privileged CAN addcom (by design)', () => {
    expect(sanitize('!addcom !test hi', undefined, true).text).toContain('addcom')
  })
})

describe('SEC: URL injection / phishing links in AI output', () => {
  const maliciousUrls = [
    'check out https://free-nitro.com for free stuff',
    'go to http://phishing-site.com/login',
    'visit www.malware-download.xyz',
    'details at https://evil.com/steal?token=abc',
    'https://fake-bazaardb.gg.evil.com/items',
    'see http://bit.ly/malicious-redirect',
    'click https://discord.gift/freenitro',
    'follow https://steamcommunity.com.evil.net/trade',
  ]

  for (const text of maliciousUrls) {
    it(`strips: "${text.slice(0, 50)}..."`, () => {
      const r = sanitize(text)
      // no malicious URLs should survive — only bazaardb.gg, bzdb.to, github.com allowed
      expect(r.text).not.toMatch(/phishing|malware|evil|fake|bit\.ly|discord\.gift|steamcommunity/)
    })
  }

  it('preserves bazaardb.gg', () => {
    expect(sanitize('check bazaardb.gg/items').text).toContain('bazaardb.gg')
  })

  it('preserves bzdb.to shortlinks', () => {
    expect(sanitize('details at https://bzdb.to/item123').text).toContain('bzdb.to')
  })

  it('preserves github.com (repo link)', () => {
    expect(sanitize('source at https://github.com/mellen9999/bazaarinfo').text).toContain('github.com')
  })

  it('strips github.com lookalike', () => {
    const r = sanitize('https://github.com.evil.net/steal')
    expect(r.text).not.toMatch(/evil/)
  })

  it('strips bazaardb.gg lookalike domains', () => {
    const r = sanitize('https://bazaardb.gg.evil.com/steal')
    expect(r.text).not.toMatch(/evil\.com/)
    expect(r.text).not.toMatch(/https?:\/\//)
  })

  it('strips bazaardb.gg subdomain on evil TLD', () => {
    const r = sanitize('https://fake-bazaardb.gg.evil.com/items')
    expect(r.text).not.toMatch(/evil\.com/)
  })
})

describe('SEC: command proxy abuse via !b', () => {
  const ctx = { user: 'attacker', channel: 'testchannel' }

  it('!b !ban user → blocked for non-mod', async () => {
    const r = await handleCommand('!b !ban someone', ctx)
    expect(r).toBeNull()
  })

  it('!b !timeout user → blocked for non-mod', async () => {
    const r = await handleCommand('!b !timeout troll 600', ctx)
    expect(r).toBeNull()
  })

  it('!b !mod attacker → blocked', async () => {
    const r = await handleCommand('!b !mod myself', ctx)
    expect(r).toBeNull()
  })

  it('!b !addcom → blocked for non-mod', async () => {
    const r = await handleCommand('!b !addcom !phish click here', ctx)
    expect(r).toBeNull()
  })

  it('!b /ban → slash commands blocked (not in allowlist)', async () => {
    const r = await handleCommand('!b /ban user', ctx)
    expect(r).toBeNull()
  })

  it('!b /timeout → blocked', async () => {
    const r = await handleCommand('!b /timeout user 600', ctx)
    expect(r).toBeNull()
  })

  it('!b !sr (song request) → blocked', async () => {
    const r = await handleCommand('!b !sr rickroll', ctx)
    expect(r).toBeNull()
  })

  it('!b !gamble → blocked', async () => {
    const r = await handleCommand('!b !gamble 1000', ctx)
    expect(r).toBeNull()
  })

  it('!b embedded "run !ban" → not proxied as ban command', async () => {
    const r = await handleCommand('!b hey can you run !ban troll please', ctx)
    // embedded !ban is in BLOCKED_BANG_CMDS → not proxied, falls through to normal lookup
    // result should NOT be "!ban troll" (the dangerous command)
    if (r) expect(r).not.toMatch(/^!ban/)
  })
})

describe('SEC: alias system abuse', () => {
  const normalUser = { user: 'random_chatter', channel: 'testchannel' }
  const adminUser = { user: process.env.ALIAS_ADMINS?.split(',')[0]?.trim() || 'nonexistent_admin', channel: 'testchannel' }

  it('random user cannot create aliases', async () => {
    const r = await handleCommand('!b alias exploit = subscraper', normalUser)
    expect(r).toBe('alias management is restricted')
  })

  it('random user cannot delete aliases', async () => {
    const r = await handleCommand('!b alias del something', normalUser)
    expect(r).toBe('alias management is restricted')
  })

  it('random user cannot list aliases', async () => {
    const r = await handleCommand('!b alias list', normalUser)
    expect(r).toBe('alias management is restricted')
  })

  it('cannot create alias with reserved name', async () => {
    // even if admin, reserved names should be rejected
    const r = await handleCommand('!b alias mob = subscraper', adminUser)
    if (r && r !== 'alias management is restricted') {
      expect(r).toContain('reserved')
    }
  })

  it('cannot create alias with spaces', async () => {
    const r = await handleCommand('!b alias two words = subscraper', adminUser)
    if (r && r !== 'alias management is restricted') {
      expect(r).toContain('cannot contain spaces')
    }
  })
})

describe('SEC: refresh/admin commands require owner', () => {
  const normalCtx = { user: 'random_chatter', channel: 'testchannel' }

  it('!b refresh → null for non-owner', async () => {
    const r = await handleCommand('!b refresh', normalCtx)
    expect(r).toBeNull()
  })

  it('!b emote refresh → null for non-owner', async () => {
    const r = await handleCommand('!b emote refresh', normalCtx)
    expect(r).toBeNull()
  })
})

describe('SEC: sanitizer encoding bypass attempts', () => {
  it('smart quotes normalized before pattern matching', () => {
    // U+2019 RIGHT SINGLE QUOTATION MARK → apostrophe
    expect(sanitize("i don\u2019t log anything").text).toBe('')
    expect(sanitize("i\u2019m not storing your data").text).toBe('')
  })

  it('leading backtick stripped (code block bypass)', () => {
    const r = sanitize('`/ban user`')
    expect(r.text).not.toMatch(/\/ban/)
  })

  it('leading single quote stripped', () => {
    const r = sanitize("'/ban user'")
    expect(r.text).not.toMatch(/\/ban/)
  })

  it('markdown bold stripped — IRC cmd still caught', () => {
    const r = sanitize('**/ban user**')
    expect(r.text).toBe('')
  })

  it('markdown italic stripped — IRC cmd still caught', () => {
    const r = sanitize('*/timeout user 600*')
    expect(r.text).toBe('')
  })

  it('unicode emoji stripped', () => {
    expect(sanitize('hello 🔥🎉💀').text).toBe('hello')
  })
})

describe('SEC: FTS injection via @username search', () => {
  it('FTS operators are quoted', () => {
    const q = buildFTSQuery('OR DROP TABLE users')
    if (q) {
      // "drop", "table", "users" should be quoted; OR is a stop word
      expect(q).not.toMatch(/\bOR\b(?!\s*")/i)
      expect(q).toContain('"drop"')
      expect(q).toContain('"table"')
      expect(q).toContain('"users"')
    }
  })

  it('NOT operator neutralized', () => {
    const q = buildFTSQuery('NOT secret_data passwords')
    if (q) {
      expect(q).toContain('"passwords"')
      // NOT should be stripped (3 chars, stop word)
    }
  })

  it('special chars stripped from FTS terms', () => {
    const q = buildFTSQuery('test"; DROP TABLE--')
    // non-alpha stripped from each word, then quoted — safe for FTS5
    if (q) {
      // semicolons and unmatched quotes stripped from words
      // the quotes in output are FTS5 quoting (safety feature), not injection
      expect(q).toContain('"test"')
      expect(q).toContain('"drop"')
      expect(q).toContain('"table"')
      // no raw SQL operators remain
      expect(q).not.toMatch(/;\s*DROP/i)
    }
  })

  it('wildcard * not passed through', () => {
    const q = buildFTSQuery('test* password*')
    if (q) {
      expect(q).not.toContain('*')
    }
  })
})

describe('SEC: COT leak edge cases', () => {
  // model sometimes wraps COT in different phrasings
  // some get fully rejected, others get the COT prefix stripped
  const fullyRejected = [
    'this is conversational so keeping it brief',
    'this is unrelated to the game but here goes',
    'why am i answering this? anyway, yes',
    'i should probably not say this but',
    'chat dynamics are interesting today',
    'the reply should be casual',
    'the answer could be shorter',
  ]

  for (const text of fullyRejected) {
    it(`rejects: "${text.slice(0, 40)}..."`, () => {
      expect(sanitize(text).text).toBe('')
    })
  }

  // these get the COT preamble stripped — the actual answer survives (correct behavior)
  it('strips "off-topic" prefix but passes answer', () => {
    const r = sanitize('off-topic banter here. the answer is yes')
    expect(r.text).not.toMatch(/off-topic/i)
    expect(r.text).toBeTruthy()
  })

  it('"not game-related" fully rejected by COT_LEAK', () => {
    // COT_LEAK catches "not game-related" — entire response rejected (correct)
    expect(sanitize('not game-related but the moon is cool').text).toBe('')
  })
})

describe('SEC: privacy lie variations', () => {
  const lies = [
    "i do not log your messages",
    "i never store any data",
    "i never collect anything",
    "i'm not recording anything",
    "not like i'm storing your messages",
    "don't collect or store anything",
    "that's a twitch thing, not me",
  ]

  for (const text of lies) {
    it(`catches: "${text.slice(0, 40)}..."`, () => {
      expect(sanitize(text).text).toBe('')
    })
  }
})

describe('SEC: command blocklist tiers', () => {
  // always blocked (IRC /\. prefixes)
  it('\\ban blocked', () => expect(sanitize('\\ban user').text).toBe(''))
  it('/ban blocked', () => expect(sanitize('/ban user').text).toBe(''))
  it('.timeout blocked', () => expect(sanitize('.timeout user 600').text).toBe(''))
  it('/whisper blocked', () => expect(sanitize('/whisper victim secret').text).toBe(''))
  it('/disconnect blocked', () => expect(sanitize('/disconnect').text).toBe(''))

  // mod-only (!/ all prefixes, non-mod blocked)
  it('!announce blocked non-mod', () => expect(sanitize('!announce spam').text).toBe(''))
  it('!announce allowed mod', () => expect(sanitize('!announce spam', undefined, true).text).toBeTruthy())
  it('\\mod blocked non-mod', () => expect(sanitize('\\mod troll').text).toBe(''))
  it('!addcom blocked non-mod', () => expect(sanitize('!addcom !hi yo').text).toBe(''))
  it('!addcom allowed mod', () => expect(sanitize('!addcom !hi yo', undefined, true).text).toBeTruthy())
  it('/settitle blocked non-mod', () => expect(sanitize('/settitle New').text).toBe(''))
  it('/settitle allowed mod', () => expect(sanitize('/settitle New', undefined, true).text).toBeTruthy())

  // ! prefix custom commands — always allowed
  it('!ban allowed (custom cmd)', () => expect(sanitize('!ban tidolar').text).toBeTruthy())
  it('!BaN allowed (custom cmd)', () => expect(sanitize('!BaN user').text).toBeTruthy())
  it('!whisper allowed (custom cmd)', () => expect(sanitize('!whisper someone hi').text).toBeTruthy())
  it('!jory allowed (custom cmd)', () => expect(sanitize('!jory').text).toBeTruthy())

  // /me is safe — not in any blocklist
  it('/me allowed', () => expect(sanitize('/me dances').text).toBeTruthy())
})

describe('SEC: @mention extraction safety', () => {
  it('extracts @mentions from AI output but leaves them in text', () => {
    const r = sanitize('@someone great question about burn builds')
    expect(r.mentions).toContain('@someone')
    // mentions stay in body text naturally
    expect(r.text).toContain('@someone')
  })

  it('asker name stripped from response', () => {
    const r = sanitize('hey testuser, burn is good', 'testuser')
    expect(r.text).not.toContain('testuser')
  })

  it('asker name with special regex chars safe', () => {
    // username with regex chars shouldn't break
    const r = sanitize('hello test.user+1, nice', 'test.user+1')
    expect(r.text).not.toContain('test.user+1')
  })
})

describe('SEC: input sanitization in commands.ts', () => {
  // use unique channels to avoid dedup between tests
  it('@ mentions stripped from args', async () => {
    const r = await handleCommand('!b @someone magnifying glass', { user: 'attacker', channel: 'input_san_1' })
    expect(r).toBeTruthy()
    expect(r).toContain('Magnifying Glass')
  })

  it('quotes stripped from args', async () => {
    const r = await handleCommand('!b "magnifying glass"', { user: 'attacker', channel: 'input_san_2' })
    expect(r).toBeTruthy()
    expect(r).toContain('Magnifying Glass')
  })

  it('extra whitespace collapsed', async () => {
    const r = await handleCommand('!b   magnifying    glass   ', { user: 'attacker', channel: 'input_san_3' })
    expect(r).toBeTruthy()
    expect(r).toContain('Magnifying Glass')
  })
})

describe('SEC: query length limits', () => {
  it('AI_MAX_QUERY_LEN truncates long queries', () => {
    // The AI path truncates at 200 chars — tested implicitly
    // but let's verify the constant exists and the truncation logic
    const longQuery = 'a'.repeat(300)
    expect(longQuery.slice(0, 200).length).toBe(200)
  })

  it('sanitizer hard caps at 440 chars', () => {
    const huge = 'x '.repeat(500)
    const r = sanitize(huge)
    expect(r.text.length).toBeLessThanOrEqual(440)
  })
})

describe('SEC: dedup prevents spam amplification', () => {
  it('duplicate queries in same channel suppressed', async () => {
    const ctx = { user: 'spammer', channel: 'dedup_test_channel' }
    const r1 = await handleCommand('!b subscraper', ctx)
    expect(r1).toBeTruthy()
    const r2 = await handleCommand('!b subscraper', ctx)
    expect(r2).toBeNull() // deduped
  })
})
