// grounding coverage sweep CLI — see packages/bot/src/grounding-sweep.ts for the core.
//
//   bun run scripts/coverage-sweep.ts
//
// a term resolving to nothing is a grounding gap — the model would answer from vibes.
// deliberately-unglossaried terms (glossary.ts) are skipped: settled calls, not gaps.
import { loadStore } from '../packages/bot/src/store'
import { sweepVocabulary, SWEEP_KINDS } from '../packages/bot/src/grounding-sweep'

await loadStore()
const { checked, perKind, gaps } = sweepVocabulary()

console.log(`checked ${checked} terms: ${[...perKind].map(([k, n]) => `${k}=${n}`).join(' ')}`)
// a class contributing zero terms means the sweep silently skipped it — that's a
// sweep bug, not a clean bill
for (const kind of SWEEP_KINDS) {
  if (!perKind.get(kind)) {
    console.error(`sweep bug: class "${kind}" contributed 0 terms`)
    process.exitCode = 1
  }
}
if (gaps.length === 0) {
  console.log('no grounding gaps — every term resolves to real data')
} else {
  console.log(`\n${gaps.length} GAPS (term → nothing grounded):`)
  for (const g of gaps) console.log(`  [${g.kind}] ${g.term}`)
  process.exitCode = 1
}
