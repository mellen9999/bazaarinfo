#!/usr/bin/env bun
// memo-regen — one-shot regen of every active user's memo under the new concrete-and-
// observable prompt (ai-background.ts's maybeUpdateMemo, force=true). the old "warm and
// appreciative" prompt shipped HR-blurb slop for every user; this replaces what's stored
// without waiting for each user's next 5-ask interval to roll around naturally.
//
// run by hand after the memo-prompt deploy. never invoked by the bot itself.
//
//   bun scripts/memo-regen.ts          # force-regen every user w/ an ask in the last 30d
//   bun scripts/memo-regen.ts --dry    # just list who would be regenned, no api calls

import { initDb, getDb } from '../packages/bot/src/db'
import { maybeUpdateMemo } from '../packages/bot/src/ai-background'

const dry = process.argv.includes('--dry')

initDb()

const rows = getDb().query(
  `SELECT DISTINCT u.username FROM users u
   JOIN ask_queries a ON a.user_id = u.id
   WHERE a.created_at >= datetime('now', '-30 days')
   ORDER BY u.username`,
).all() as { username: string }[]

console.log(`${rows.length} users with an ask in the last 30 days`)

if (dry) {
  for (const r of rows) console.log(r.username)
  process.exit(0)
}

let n = 0
for (const r of rows) {
  await maybeUpdateMemo(r.username, true)
  n++
  if (n % 10 === 0) console.log(`${n}/${rows.length}...`)
  await Bun.sleep(300) // sequential with a small delay — a burst isn't the point, cents are cents
}

console.log(`regenned ${n} memos`)
