import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { RETENTION_DAYS } from './db'

// PRIVACY.md is a promise to chatters. its retention table must say exactly what the daily
// prune does — this once drifted to "30 days" in the policy while the code kept 180.
const POLICY = readFileSync(resolve(import.meta.dir, '../../../PRIVACY.md'), 'utf8')

const ROWS: Record<string, keyof typeof RETENTION_DAYS> = {
  'Chat messages': 'chat',
  'AI ask queries': 'askQueries',
  'Trivia games + answers': 'triviaGames',
  'Chat summaries': 'summaries',
  'Stream events (subs, gifts, raids, cheers)': 'userEvents',
  'User facts': 'userFacts',
  'User memos': 'userMemos',
}

function policyDays(label: string): number | undefined {
  const row = POLICY.split('\n').find((l) => l.startsWith(`| ${label} |`))
  const m = row?.match(/\|\s*(\d+) days?\b/)
  return m ? Number(m[1]) : undefined
}

describe('privacy policy retention', () => {
  for (const [label, key] of Object.entries(ROWS)) {
    it(`${label} matches the prune`, () => {
      expect(policyDays(label)).toBe(RETENTION_DAYS[key])
    })
  }
})
