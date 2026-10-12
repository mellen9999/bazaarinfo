import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportChat } from '../../../scripts/export-chat'

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'export-chat-'))
  dbPath = join(dir, 'src.db')
  const db = new Database(dbPath)
  db.run('CREATE TABLE chat_messages (id INTEGER PRIMARY KEY, channel TEXT NOT NULL, username TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL, message_id TEXT)')
  const ins = db.prepare('INSERT INTO chat_messages (channel, username, message, created_at, message_id) VALUES (?, ?, ?, ?, ?)')
  ins.run('nl_kripp', 'Bob', 'second', '2026-05-01 10:00:05', 'abc')
  ins.run('nl_kripp', 'Alice', 'first', '2026-05-01 10:00:01', null)
  ins.run('nl_kripp', 'Bob', 'next day "quoted"\nline', '2026-05-02 00:00:00', null)
  ins.run('mellen', 'mellen', 'hi', '2026-06-01 01:02:03', 'm1')
  db.close()
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const read = (p: string) => readFileSync(p, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l))

describe('export-chat', () => {
  it('writes per channel/day ndjson, sorted, lowercased users, iso timestamps', () => {
    const out = join(dir, 'out')
    const res = exportChat({ db: dbPath, out })
    expect(res.counts.get('nl_kripp')).toBe(3)
    expect(res.counts.get('mellen')).toBe(1)
    expect(readdirSync(join(out, 'nl_kripp')).sort()).toEqual(['2026-05-01.ndjson', '2026-05-02.ndjson'])
    const rows = read(join(out, 'nl_kripp', '2026-05-01.ndjson'))
    expect(rows.map((r) => r.message)).toEqual(['first', 'second'])
    expect(rows[1]).toEqual({ channel: 'nl_kripp', username: 'bob', message: 'second', timestamp: '2026-05-01T10:00:05.000Z', message_id: 'abc' })
    expect(rows[0].message_id).toBeNull()
    expect(read(join(out, 'nl_kripp', '2026-05-02.ndjson'))[0].message).toBe('next day "quoted"\nline')
  })

  it('--channel limits to one channel, --before is exclusive', () => {
    const out = join(dir, 'out')
    const res = exportChat({ db: dbPath, out, channel: 'NL_Kripp', before: '2026-05-02' })
    expect([...res.counts.keys()]).toEqual(['nl_kripp'])
    expect(res.counts.get('nl_kripp')).toBe(2)
    expect(existsSync(join(out, 'mellen'))).toBe(false)
    expect(readdirSync(join(out, 'nl_kripp'))).toEqual(['2026-05-01.ndjson'])
  })

  it('never writes to the source db (read-only)', () => {
    const before = readFileSync(dbPath)
    exportChat({ db: dbPath, out: join(dir, 'out') })
    expect(readFileSync(dbPath).equals(before)).toBe(true)
  })

  it('rejects a bad --before and counts unparseable timestamps as skipped', () => {
    expect(() => exportChat({ db: dbPath, out: join(dir, 'o'), before: 'yesterday' })).toThrow()
    const db = new Database(dbPath)
    db.run(`INSERT INTO chat_messages (channel, username, message, created_at) VALUES ('mellen', 'x', 'bad', 'garbage')`)
    db.close()
    const res = exportChat({ db: dbPath, out: join(dir, 'o2') })
    expect(res.skipped).toBe(1)
    expect(res.counts.get('mellen')).toBe(1)
  })

  it('refuses a channel name that could escape --out', () => {
    const db = new Database(dbPath)
    db.run(`INSERT INTO chat_messages (channel, username, message, created_at) VALUES ('../evil', 'x', 'y', '2026-05-01 00:00:00')`)
    db.close()
    const out = join(dir, 'out')
    const res = exportChat({ db: dbPath, out })
    expect(res.skipped).toBe(1)
    expect(existsSync(join(dir, 'evil'))).toBe(false)
  })
})
