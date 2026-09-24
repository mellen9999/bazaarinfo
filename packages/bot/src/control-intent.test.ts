import { describe, expect, it } from 'bun:test'
import type { Action } from './control'
import { matchControlIntent, parseControlIntent } from './control-intent'

describe('matchControlIntent — phrase coverage', () => {
  const cases: [string, Action][] = [
    // reused mod vocabulary (commands-mod's tuned regexes) — full Action coverage for
    // callers other than chat (chat keeps its own byte-identical direct routes)
    ['stop doing trivia', { kind: 'pause', feature: 'trivia' }],
    ['pause trivia for 10m', { kind: 'pause', feature: 'trivia', minutes: 10 }],
    ['chill out', { kind: 'pause', feature: 'all', minutes: undefined }],
    ['resume trivia', { kind: 'resume', feature: 'trivia' }],
    ['wake up', { kind: 'resume', feature: 'all' }],
    ['no more digimon trivia', { kind: 'topic-ban', topic: 'digimon' }],
    ['unban digimon trivia', { kind: 'topic-unban', topic: 'digimon' }],
    // ignore / unignore (persistent per-channel)
    ['ignore @troublemaker', { kind: 'ignore', user: 'troublemaker', minutes: undefined }],
    ['ignore troublemaker for a day', { kind: 'ignore', user: 'troublemaker', minutes: 1440 }],
    ['ignore bob for 2h', { kind: 'ignore', user: 'bob', minutes: 120 }],
    ['stop responding to @bob', { kind: 'ignore', user: 'bob', minutes: undefined }],
    ["don't respond to bob", { kind: 'ignore', user: 'bob', minutes: undefined }],
    ["don't answer bob anymore", { kind: 'ignore', user: 'bob', minutes: undefined }],
    ['unignore @bob', { kind: 'unignore', user: 'bob' }],
    ['stop ignoring bob', { kind: 'unignore', user: 'bob' }],
    ['you can talk to bob again', { kind: 'unignore', user: 'bob' }],
    ['talk to bob again', { kind: 'unignore', user: 'bob' }],
    // vibe index drop
    ['drop vibe 2', { kind: 'vibe-drop', index: 2 }],
    ['remove vibe #3', { kind: 'vibe-drop', index: 3 }],
    ['kill the 2nd vibe', { kind: 'vibe-drop', index: 2 }],
    ['delete the 10th vibe', { kind: 'vibe-drop', index: 10 }],
    // vibe clear (NL — distinct from the literal "!b vibes clear")
    ['clear all vibes', { kind: 'vibe-clear' }],
    ['drop all the vibes', { kind: 'vibe-clear' }],
    // trivia queue
    ['clear the trivia queue', { kind: 'queue-clear' }],
    ['empty the queue', { kind: 'queue-clear' }],
    // depths (NL — distinct from the literal "!b depths reset")
    ['reset the depths', { kind: 'depths-reset' }],
    ['reset the dungeon', { kind: 'depths-reset' }],
    // trivia skip / start
    ['skip this question', { kind: 'trivia-skip' }],
    ['skip the round', { kind: 'trivia-skip' }],
    ['start trivia', { kind: 'trivia-start' }],
    ['start a trivia about cats', { kind: 'trivia-start', topic: 'cats' }],
    ['begin a quiz about happy gilmore', { kind: 'trivia-start', topic: 'happy gilmore' }],
    // raid on/off
    ['turn the raid on', { kind: 'raid', on: true }],
    ['turn raid off', { kind: 'raid', on: false }],
    ['enable the raid game', { kind: 'raid', on: true }],
    ['disable raid', { kind: 'raid', on: false }],
    ['stop the raid', { kind: 'raid', on: false }],
    ['start the raid game', { kind: 'raid', on: true }],
    // raid pace
    ['slow the raid down', { kind: 'raid-pace', pace: 'slow' }],
    ['speed up the raid', { kind: 'raid-pace', pace: 'fast' }],
    ['raid pace fast', { kind: 'raid-pace', pace: 'fast' }],
    ['set raid pace to slow', { kind: 'raid-pace', pace: 'slow' }],
    ['make the raid normal', { kind: 'raid-pace', pace: 'normal' }],
    // ai channel toggle (qualifier required — see near-miss table)
    ['turn ai off for this channel', { kind: 'ai', on: false }],
    ['turn ai on completely', { kind: 'ai', on: true }],
    ['disable ai permanently', { kind: 'ai', on: false }],
    ['enable ai for good', { kind: 'ai', on: true }],
    // deliberate collisions with the OLD, unchanged mod vocabulary — "resume"/"disable ai"
    // keep meaning the existing temporary suppress/resume, never the new raid/ai actions
    ['resume the raid game', { kind: 'resume', feature: 'all' }],
    ['disable ai', { kind: 'pause', feature: 'ai', minutes: undefined }],
    // say (panel command bar only — never wired to chat)
    ['say hello chat', { kind: 'say', text: 'hello chat' }],
    ['say gg well played in chat', { kind: 'say', text: 'gg well played' }],
  ]

  for (const [text, expected] of cases) {
    it(`"${text}" -> ${JSON.stringify(expected)}`, () => {
      expect(matchControlIntent(text)).toEqual(expected)
    })
  }
})

describe('matchControlIntent — near-miss (must return null)', () => {
  const cases = [
    // questions
    'is the ai on',
    'is trivia paused',
    'why did you stop doing trivia',
    'what does skip do',
    'was the raid disabled',
    'are vibes cleared',
    'when does the raid pace change',
    'why did you ignore me',
    // past tense / narration, not a command
    'the raid was fun last night',
    'kripp turned the raid off yesterday',
    'someone dropped vibe 2 earlier',
    'chat cleared the queue already',
    'mods reset the depths last stream',
    'bob got ignored yesterday',
    // third-party mentions, not an imperative
    'bob wants to skip this question',
    'kripp said turn ai off for this channel',
    'chat is asking to slow the raid down',
    // vague/pronoun targets — never a real ignore target
    'ignore that',
    'ignore him lol',
    'ignore this',
    "don't respond to me",
    'ignore everyone',
    // bare/ambiguous — not enough to act on
    'raid',
    'vibe 2',
    'ai off',
    'skip',
    'trivia',
    'ignore',
    // politeness/modal forms this tight layer deliberately does not cover (anchored
    // imperative-at-start only — see control-intent.ts comments)
    'can you turn the raid off',
    'could you slow the raid down',
    // ai toggle without the required qualifier — falls through to nothing actionable
    // ("turn ai off" alone isn't SUPPRESS_RE's contiguous "turn off ai" shape either)
    'turn ai off',
  ]

  for (const text of cases) {
    it(`"${text}" -> null`, () => {
      expect(matchControlIntent(text)).toBeNull()
    })
  }
})

describe('parseControlIntent', () => {
  it('returns the deterministic match without touching the AI path', async () => {
    const a = await parseControlIntent('drop vibe 2', '#nonexistent-channel-xyz')
    expect(a).toEqual({ kind: 'vibe-drop', index: 2 })
  })

  it('skips the AI call and returns null when there are no control-ish words', async () => {
    const a = await parseControlIntent('what is the weather like today', '#nonexistent-channel-xyz')
    expect(a).toBeNull()
  })

  it('falls through to null when control-ish but nothing deterministic matches and AI is unavailable', async () => {
    // no ANTHROPIC_API_KEY in the test env -> parseDirective's own guard returns null
    const prevKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const a = await parseControlIntent('you are being too much right now', '#nonexistent-channel-xyz')
      expect(a).toBeNull()
    } finally {
      if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey
    }
  })
})
