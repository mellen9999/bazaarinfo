import { test, expect, describe } from 'bun:test'
import { repairTruncation, isStub } from './ai-truncate'

// hardCaps used in doAiCall, for reference: creative 400, game data 250, remember 120,
// short 60, ordinary chat 150.
const CHAT = 150
const PASTA = 400

describe('repairTruncation — a max_tokens stop that lands under the cap', () => {
  // these are real replies the bot shipped to live chat, cut mid-word. before the fix the
  // repair block was gated on length > hardCap alone, so a short fragment skipped it whole.
  const shipped = [
    'kripp knees kripp buckle kripp under kripp both kripp knees kripp exploding kripp mid-t',
    'lordscab nlkripp Kappa ab',
  ]

  test('a mid-word fragment under the cap gets trimmed, not shipped', () => {
    for (const raw of shipped) {
      expect(raw.length).toBeLessThan(CHAT) // the exact condition that used to skip repair
      const out = repairTruncation(raw, CHAT, true)
      expect(out).not.toBe(raw)
      expect(raw.startsWith(out)).toBe(true) // repair only ever trims
      // the dangling partial word is gone
      expect(out.endsWith('mid-t')).toBe(false)
      expect(out.endsWith(' ab')).toBe(false)
    }
  })

  test('a complete short reply is never touched', () => {
    // stop_reason was end_turn — the model chose to stop, so every word is intentional
    const done = "she's the best take here"
    expect(repairTruncation(done, CHAT, false)).toBe(done)
  })

  test('a complete reply slightly over the cap keeps its last words', () => {
    // regression: this one-liner must not be clipped to a fragment just for being over
    const over = 'a'.repeat(CHAT - 4) + ' tail'
    expect(repairTruncation(over, CHAT, false)).toBe(over)
  })
})

describe('repairTruncation — prefers the cleanest stopping point', () => {
  test('trims back to a finished sentence when the break is late enough to keep', () => {
    // the break must sit past 40% of the cap — otherwise walking back to it would throw
    // away more good text than the dangling word costs
    const raw = 'the build is fine and the curve is right and the tempo holds. the real problem is that yo'
    expect(repairTruncation(raw, CHAT, true)).toBe('the build is fine and the curve is right and the tempo holds.')
  })

  test('an early sentence break is NOT worth walking back to — drop the partial word instead', () => {
    const raw = 'the build is fine. the real problem is you never sold the starter and now yo'
    const out = repairTruncation(raw, CHAT, true)
    expect(out).toBe('the build is fine. the real problem is you never sold the starter and now')
    expect(out.endsWith('yo')).toBe(false)
  })

  test('falls back to a clause break when it is late enough and no sentence ends', () => {
    const raw = 'solid pick if you actually hit the tier and keep the board wide, otherwise it just rots in your bag and you los'
    const out = repairTruncation(raw, CHAT, true)
    expect(out).toBe('solid pick if you actually hit the tier and keep the board wide')
  })

  test('long creative output trims to a sentence inside the pasta cap', () => {
    const raw = `${'dear diary, the boulder spoke to me today and i listened. '.repeat(8)}then it said the build was`
    const out = repairTruncation(raw, PASTA, true)
    expect(out.length).toBeLessThanOrEqual(PASTA)
    expect(out.endsWith('.')).toBe(true)
  })
})

describe('repairTruncation — cleans up what the cut left behind', () => {
  test('closes or drops an orphan quote', () => {
    const raw = 'he called it "the boulder and then the whole lobby went quiet about it'
    const out = repairTruncation(raw, CHAT, true)
    expect((out.match(/"/g) || []).length % 2).toBe(0)
  })

  test('drops a dangling list ordinal', () => {
    const raw = 'top picks: 1. dooley 2. vanessa 3'
    expect(repairTruncation(raw, CHAT, true)).toBe('top picks: 1. dooley 2. vanessa')
  })

  test('a title is not a sentence end', () => {
    // real cut-off reply: breaking at "Dr. " threw away the whole payload and left a
    // shorter, worse fragment than the one we started with
    const raw = "bee movie's copyrighted, and even Dr. Limestone couldn't clear those residuals — but"
    const out = repairTruncation(raw, 400, true)
    expect(out).toContain('Limestone')
    expect(out.endsWith('— but')).toBe(false)
  })

  test('a reply that ends on a terminator is left alone even when the API cut it', () => {
    // landing exactly on the token ceiling is not proof the thought was unfinished
    const done = 'sell the starter, buy the board, win the day.'
    expect(repairTruncation(done, CHAT, true)).toBe(done)
  })

  test('never returns more than it was given', () => {
    const raw = 'some reply that got cut off somewhe'
    expect(repairTruncation(raw, CHAT, true).length).toBeLessThanOrEqual(raw.length)
  })
})

describe('isStub — when trimming leaves nothing worth sending', () => {
  test('a one-word survivor is a stub', () => {
    // the real case: "tell me facts about Forsen" came back as the 3-character reply "for"
    expect(isStub('for')).toBe(true)
    expect(isStub('kripp')).toBe(true)
    expect(isStub('  ')).toBe(true)
  })

  test('a real short answer is not a stub', () => {
    expect(isStub('yeah, that build rips')).toBe(false)
    expect(isStub('no idea honestly mate')).toBe(false)
  })
})
