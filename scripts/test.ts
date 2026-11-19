#!/usr/bin/env bun
// runs every *.test.ts under packages/ in its own `bun test` process, one after another.
// own process = no module mocks or db state leaking between files. a failure doesn't stop
// the run: every file reports, then the failed ones are listed and the exit code is 1.
//
//   bun run test                  # everything
//   bun run test sanitize ai-     # only files whose path contains one of these
import { Glob } from 'bun'

const filters = process.argv.slice(2)
const files = [...new Glob('packages/**/*.test.ts').scanSync('.')]
  .filter((f) => !f.includes('node_modules') && !f.includes('/dist/'))
  .filter((f) => filters.length === 0 || filters.some((s) => f.includes(s)))
  .sort()

if (files.length === 0) {
  console.error(`no test files match ${filters.join(' ')}`)
  process.exit(1)
}

const failed: string[] = []
const t0 = performance.now()
for (const f of files) {
  const r = Bun.spawnSync(['bun', 'test', `./${f}`], { stdout: 'inherit', stderr: 'inherit' })
  if (r.exitCode !== 0) failed.push(f)
}
const secs = ((performance.now() - t0) / 1000).toFixed(0)
console.log(`\n${files.length - failed.length}/${files.length} test files passed in ${secs}s`)
if (failed.length) {
  console.log(`failed:\n${failed.map((f) => `  ${f}`).join('\n')}`)
  process.exit(1)
}
