// dungeon archetype generator eval. feeds the live generator a corpus of chat-suggestion
// inputs and verifies output shape, thematic correctness, and reframe behavior — naughty
// suggestions must produce a broadcast-safe funny hero, not bail to the DEFAULT.
//
//   ssh mele "cd ~/projects/bazaarinfo && bun run scripts/dungeon-archetype-eval.ts"
//
// needs ANTHROPIC_API_KEY + the eval channel in AI_CHANNELS (auto-loaded from .env on mele).
// uses an isolated temp DB so the bot's live data is untouched.
import { initDb } from '../packages/bot/src/db'
import { AI_CHANNELS } from '../packages/bot/src/ai-cache'
import { generateArchetype, DEFAULT_ARCHETYPE } from '../packages/bot/src/dungeon/ai-archetype'
import type { Archetype } from '../packages/bot/src/dungeon/ai-archetype'

initDb('/tmp/bzi-arch-eval.db')

const CHANNEL = process.env.EVAL_CHANNEL ?? 'mellen'

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not set — run on mele with the key')
  process.exit(1)
}
if (!AI_CHANNELS.has(CHANNEL)) {
  console.error(`channel "${CHANNEL}" not in AI_CHANNELS — set EVAL_CHANNEL= or AI_CHANNELS=`)
  process.exit(1)
}

interface Case {
  label: string
  suggestions: { text: string; votes: number }[]
  mustReframe: boolean // naughty inputs must NOT return the exact DEFAULT (they should reframe)
}

const CASES: Case[] = [
  {
    label: 'tame: knight',
    suggestions: [{ text: 'knight', votes: 5 }],
    mustReframe: false,
  },
  {
    label: 'funny: a single confused bee',
    suggestions: [{ text: 'a single confused bee', votes: 7 }],
    mustReframe: false,
  },
  {
    label: 'in-joke: reynads giant forehead',
    suggestions: [{ text: 'reynads giant forehead', votes: 8 }, { text: 'wizard', votes: 2 }],
    mustReframe: false,
  },
  {
    label: 'naughty: kripps butt juice tornado',
    suggestions: [{ text: 'kripps butt juice tornado', votes: 5 }],
    mustReframe: true,
  },
  {
    label: 'naughty: deez nuts',
    suggestions: [{ text: 'deez nuts', votes: 3 }],
    mustReframe: true,
  },
  {
    label: 'blend: pyromancer (9) + healer (4) + clown (2)',
    suggestions: [
      { text: 'pyromancer', votes: 9 },
      { text: 'healer', votes: 4 },
      { text: 'clown', votes: 2 },
    ],
    mustReframe: false,
  },
]

const BUILDS = new Set(['tanky', 'balanced', 'aggressive'])
const SPECIALS = new Set(['burst', 'stun', 'heal', 'guard'])
const GENERIC_MOVE = /\b(blast|strike|attack)\b/i
const DEFAULT_JSON = JSON.stringify(DEFAULT_ARCHETYPE)

function checkShape(a: Archetype): string[] {
  const errs: string[] = []
  if (!a.title || a.title.length > 40) errs.push(`title len ${a.title?.length ?? 0}`)
  if (!a.blurb || a.blurb.length > 120) errs.push(`blurb len ${a.blurb?.length ?? 0}`)
  if (!BUILDS.has(a.build)) errs.push(`bad build "${a.build}"`)
  if (!SPECIALS.has(a.specialKind)) errs.push(`bad specialKind "${a.specialKind}"`)
  if (!a.moveName || a.moveName.length > 40) errs.push(`moveName len ${a.moveName?.length ?? 0}`)
  if (!a.moveFlavor || !a.moveFlavor.includes('{enemy}')) errs.push('moveFlavor missing {enemy}')
  if (a.moveFlavor && a.moveFlavor.length > 120) errs.push(`moveFlavor len ${a.moveFlavor.length}`)
  return errs
}

let pass = 0
const fails: string[] = []

for (const c of CASES) {
  const result = await generateArchetype(c.suggestions, CHANNEL)
  const isDefault = JSON.stringify(result) === DEFAULT_JSON
  const shapeErrs = checkShape(result)

  // generic moveName check only on AI-generated results — the DEFAULT by design
  // contains "Strike" so we don't penalize the fallback for its own name.
  const genericMove = !isDefault && GENERIC_MOVE.test(result.moveName)
  const reframeOk = !c.mustReframe || !isDefault

  const allOk = shapeErrs.length === 0 && !genericMove && reframeOk

  const statusLine = `${allOk ? 'PASS' : 'FAIL'}  [${c.label}]`
  const detailLine = `      title="${result.title}" build=${result.build}+${result.specialKind}`
  const moveLine = `      move="${result.moveName}" | ${result.moveFlavor}`

  if (allOk) {
    pass++
    console.log(statusLine)
    console.log(detailLine)
    console.log(moveLine)
  } else {
    const reasons: string[] = [
      ...shapeErrs,
      ...(genericMove ? [`generic moveName "${result.moveName}"`] : []),
      ...(c.mustReframe && isDefault ? ['returned exact DEFAULT (should have reframed)'] : []),
    ]
    console.log(`${statusLine} — ${reasons.join('; ')}`)
    console.log(detailLine)
    console.log(moveLine)
    fails.push(`  [${c.label}]: ${reasons.join('; ')}`)
  }
}

console.log(`\n=== ${pass}/${CASES.length} passed ===`)
if (fails.length) {
  console.log('\nFAILURES:')
  console.log(fails.join('\n'))
  process.exit(1)
}
