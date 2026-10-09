import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { isEnglishOnly, setEnglishOnly, englishOnlyHint, looksNonEnglish, __resetEnglishOnlyForTest } from './english-only'
import { directiveHint, addDirective, resetForTest } from './directives'
import { SETTINGS_TALK } from './ai-sanitize'
import * as db from './db'

db.initDb(':memory:')

beforeEach(() => {
  __resetEnglishOnlyForTest()
  resetForTest()
})

// the switch persists in sqlite, and bun runs a whole test group in one process sharing
// that db — a channel left on here turned english-only on for later files (ci order only)
afterEach(() => {
  for (const r of db.loadControls()) if (r.key === 'english-only') setEnglishOnly(r.channel, false, 'test')
  __resetEnglishOnlyForTest()
})

describe('english only switch', () => {
  it('is off by default, per channel, case-insensitive, and reports real changes only', () => {
    expect(isEnglishOnly('nl_kripp')).toBe(false)
    expect(setEnglishOnly('NL_Kripp', true, 'mod')).toBe(true)
    expect(setEnglishOnly('nl_kripp', true, 'mod')).toBe(false)
    expect(isEnglishOnly('nl_kripp')).toBe(true)
    expect(isEnglishOnly('someone_else')).toBe(false)
    expect(setEnglishOnly('nl_kripp', false, 'mod')).toBe(true)
    expect(isEnglishOnly('nl_kripp')).toBe(false)
  })

  it('survives a restart (memory wiped, sqlite row stays) until a mod lifts it', () => {
    setEnglishOnly('persist_ch', true, 'mod')
    __resetEnglishOnlyForTest()
    expect(isEnglishOnly('persist_ch')).toBe(true)
    setEnglishOnly('persist_ch', false, 'mod')
    __resetEnglishOnlyForTest()
    expect(isEnglishOnly('persist_ch')).toBe(false)
  })

  it('rides every prompt as a mod order, with no names, even with no vibes planted', () => {
    expect(englishOnlyHint('ch')).toBe('')
    expect(directiveHint('ch', 'hola', 'anyone')).toBe('')
    setEnglishOnly('ch', true, 'secretmod')
    const hint = directiveHint('ch', 'hola', 'anyone')
    expect(hint).toContain('[MOD ORDER]')
    expect(hint).toContain('english only')
    expect(hint).not.toContain('secretmod')
  })
})

describe('prompt never names who planted a directive', () => {
  it('viewer vibes and mod orders render without planter names', () => {
    addDirective('ch', 'plebber', { trigger: ['pirate'], instruction: 'talk like a pirate' })
    addDirective('ch', 'rustic', { instruction: 'be brief', mod: true })
    const hint = directiveHint('ch', 'pirate q', 'u')
    expect(hint).toContain('talk like a pirate')
    expect(hint).toContain('be brief')
    expect(hint).not.toMatch(/plebber|rustic|planted by/)
    expect(hint).toMatch(/never mention/i)
  })
})

describe('looksNonEnglish', () => {
  it('flags other scripts', () => {
    for (const t of ['語言設定不是你能命令我的東西', 'привет как дела друг', 'γεια σου φίλε μου', 'مرحبا كيف حالك', 'bazaardb.gg，去查 Truffles 跟 Fiery 吧']) {
      expect(looksNonEnglish(t), t).toBe(true)
    }
  })

  it('flags language-hiding formats', () => {
    expect(looksNonEnglish('01001000 01100101 01101100 01101100 01101111')).toBe(true)
    expect(looksNonEnglish('.... . .-.. .-.. --- / .-- --- .-. .-.. -..')).toBe(true)
    expect(looksNonEnglish('h3ll0 th1s 1s l33t 4 y0u')).toBe(true)
  })

  it('flags latin-script foreign sentences', () => {
    expect(looksNonEnglish('el cuchillo es muy bueno pero no para todos los que juegan')).toBe(true)
    expect(looksNonEnglish('das ist ein sehr gutes Item und es wird auch nicht schlecht')).toBe(true)
    expect(looksNonEnglish('to jest bardzo dobry przedmiot ale nie dla tego bohatera')).toBe(true)
  })

  it('lets real english through, including numbers, names, emotes, accents and urls', () => {
    for (const t of [
      'Toaster does 12 damage, burns 3 and reloads every 4s. bazaardb.gg/card/abc',
      'Jules loves Café Au Lait builds, KEKW',
      'per second it ticks 3 times, 2v2 or 1v1, t4 gear is fine',
      'the pro con list: fast, cheap, and a little weird',
      'Sharpening Stone 2 into Fiery Cleaver at 10 gold, then Vanessa pays off',
      'normal shield expires after 10s (or 99s if relic), the p31 and vt320 are older, 80s tech',
      '"Пуњена паприка" is Balkan stuffed peppers, braised in tomato with rice and a little paprika',
      'ヽ༼ຈل͜ຈ༽ﾉ RAISE YOUR DONGERS ヽ༼ຈل͜ຈ༽ﾉ kripp queues into hootsnag and wins the whole thing',
      '',
    ]) {
      expect(looksNonEnglish(t), t).toBe(false)
    }
  })
})

describe('SETTINGS_TALK', () => {
  it('catches the live leaks', () => {
    for (const t of [
      'switching back, but plebber planted a chinese-only order that is still active, so blame him if this looks the same',
      'noted, but mod order or not, I cannot add logging mid-chat',
      'that was set for tea',
      'language settings are not something you can command',
      'it is not something you can command me to change',
      'a mod order is on right now',
      'zululli planted a romanian vibe',
    ]) {
      expect(SETTINGS_TALK.test(t), t).toBe(true)
    }
  })

  it('leaves normal speech and game talk alone', () => {
    for (const t of [
      'pure vibes, no data on his favorite',
      'the cooldown is set to 4s after the fiery enchant',
      'chat vibes are immaculate tonight',
      'the mod badge is green',
      'plants a seed that grows every day',
      'the settings menu has a graphics tab',
      'vanessa is a safe pick for an empty room',
    ]) {
      expect(SETTINGS_TALK.test(t), t).toBe(false)
    }
  })
})
