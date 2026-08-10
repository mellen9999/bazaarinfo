import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'

// guards the "new test file silently never runs" failure mode: every *.test.ts
// under packages/ must be reachable from root package.json's "test" script,
// either named exactly or covered by a directory-glob argument.

const ROOT = resolve(import.meta.dir, '../../..')

function findTestFiles(dir: string): string[] {
  const entries = readdirSync(resolve(ROOT, dir), { recursive: true }) as string[]
  return entries
    .filter((f) => f.endsWith('.test.ts'))
    .filter((f) => !f.includes('node_modules') && !f.includes('/dist/') && !f.startsWith('dist/'))
    .map((f) => `${dir}/${f}`)
}

function testScriptTargets(): string[] {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
  const script: string = pkg.scripts?.test ?? ''
  // every target argument to `bun test` starts with "packages/" — pull them all
  // out regardless of which `&&`-chained invocation they belong to.
  return script.match(/packages\/[^\s"']+/g) ?? []
}

describe('test registration', () => {
  it('every packages/**/*.test.ts file is covered by package.json\'s test script', () => {
    const allTests = findTestFiles('packages')
    const targets = testScriptTargets()
    const dirGlobs = targets.filter((t) => t.endsWith('/'))
    const exactFiles = new Set(targets.filter((t) => !t.endsWith('/')))

    const uncovered = allTests.filter((file) => {
      if (exactFiles.has(file)) return false
      return !dirGlobs.some((glob) => file.startsWith(glob))
    })

    if (uncovered.length) {
      throw new Error(
        `these test files are not registered in package.json's "test" script — ` +
        `add them to an existing group (or a directory glob) or they will never run:\n` +
        uncovered.map((f) => `  ${f}`).join('\n')
      )
    }
    expect(uncovered).toEqual([])
  })
})
