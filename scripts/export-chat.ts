// export the local chat log as ndjson for the heatsync archive import:
//   bun scripts/export-chat.ts --out /tmp/chat-export [--channel nl_kripp] [--before 2026-09-12] [--db path]
// writes <out>/<channel>/<YYYY-MM-DD>.ndjson, one {channel, username, message, timestamp,
// message_id} per line, oldest first. opens the db READ-ONLY, so it is safe against the live
// bot. --before is exclusive (UTC day); default exports everything.
import { Database } from 'bun:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const TS_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/
const CHANNEL_RE = /^[a-z0-9_]{1,40}$/

export interface ExportOpts { db: string; out: string; channel?: string; before?: string }
export interface ExportResult { counts: Map<string, number>; days: number; skipped: number }

export function exportChat(opts: ExportOpts): ExportResult {
  if (opts.before && !DAY_RE.test(opts.before)) throw new Error(`--before must be YYYY-MM-DD, got "${opts.before}"`)
  if (opts.channel && !CHANNEL_RE.test(opts.channel.toLowerCase())) throw new Error(`bad channel "${opts.channel}"`)
  const db = new Database(opts.db, { readonly: true })
  const counts = new Map<string, number>()
  let days = 0
  let skipped = 0
  try {
    const want = opts.channel?.toLowerCase()
    const channels = (db.query('SELECT DISTINCT channel FROM chat_messages ORDER BY channel').all() as { channel: string }[])
      .map((r) => r.channel)
      .filter((c) => !want || c.toLowerCase() === want)
    for (const channel of channels) {
      // the channel becomes a directory name — refuse anything that could climb out of --out
      if (!CHANNEL_RE.test(channel)) { console.error(`skip channel with unsafe name: ${JSON.stringify(channel)}`); skipped++; continue }
      const dir = join(opts.out, channel)
      const rows = db.query(
        `SELECT username, message, created_at, message_id FROM chat_messages
         WHERE channel = ? ${opts.before ? 'AND created_at < ?' : ''} ORDER BY created_at, id`,
      ).iterate(...(opts.before ? [channel, opts.before] : [channel])) as IterableIterator<{ username: string; message: string; created_at: string; message_id: string | null }>
      let day = ''
      let lines: string[] = []
      const flush = () => {
        if (!lines.length) return
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, `${day}.ndjson`), lines.join('\n') + '\n')
        days++
        lines = []
      }
      let n = 0
      for (const r of rows) {
        const m = TS_RE.exec(r.created_at)
        if (!m) { skipped++; continue }
        if (m[1] !== day) { flush(); day = m[1] }
        lines.push(JSON.stringify({
          channel,
          username: r.username.toLowerCase(),
          message: r.message,
          timestamp: `${m[1]}T${m[2]}.000Z`,
          message_id: r.message_id || null,
        }))
        n++
      }
      flush()
      counts.set(channel, n)
    }
  } finally {
    db.close()
  }
  return { counts, days, skipped }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : undefined
  }
  const out = flag('out')
  if (!out) {
    console.error('usage: bun scripts/export-chat.ts --out <dir> [--channel <name>] [--before <YYYY-MM-DD>] [--db <path>]')
    process.exit(1)
  }
  try {
    const res = exportChat({ db: flag('db') ?? resolve(homedir(), '.bazaarinfo.db'), out: resolve(out), channel: flag('channel'), before: flag('before') })
    let total = 0
    for (const [c, n] of res.counts) { console.log(`${c}: ${n}`); total += n }
    console.log(`total: ${total} rows, ${res.days} day files${res.skipped ? `, ${res.skipped} SKIPPED` : ''}`)
    if (res.skipped) process.exit(1)
  } catch (e) {
    console.error(`export failed: ${e}`)
    process.exit(1)
  }
}
