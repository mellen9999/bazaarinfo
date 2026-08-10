import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import * as db from './db'
import { backfillVods, parseVodDuration } from './vod-backfill'

const CH = 'vodtest_channel'

describe('parseVodDuration', () => {
  test.each([
    ['3h8m33s', (3 * 3600 + 8 * 60 + 33) * 1000],
    ['45m', 45 * 60_000],
    ['1h2s', 3600_000 + 2000],
    ['59s', 59_000],
  ])('%s', (s, ms) => expect(parseVodDuration(s)).toBe(ms))

  test.each(['', 'garbage', '3x9y'])('rejects: %s', (s) => expect(parseVodDuration(s)).toBeNull())
})

describe('backfillVods', () => {
  const realFetch = globalThis.fetch
  let vods: { created_at: string; duration: string; type: string }[] = []

  beforeEach(() => {
    db.initDb(':memory:')
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: vods }), { status: 200 })) as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('inserts past broadcasts as sessions with real durations', async () => {
    vods = [
      { created_at: '2026-08-01T20:00:00Z', duration: '6h30m', type: 'archive' },
      { created_at: '2026-08-02T21:00:00Z', duration: '5h', type: 'archive' },
      { created_at: '2026-08-03T19:30:00Z', duration: '10m', type: 'highlight' }, // wrong type — skipped
    ]
    const added = await backfillVods(CH, '123', 'tok', 'cid')
    expect(added).toBe(2)
    const s = db.getStreamSessions(CH)
    expect(s.length).toBe(2)
    expect(s[0].lastSeenAt - s[0].startedAt).toBe(6.5 * 3600_000)
  })

  test('skips a VOD whose start sits within 10min of a polled session', async () => {
    const polled = Date.parse('2026-08-05T20:00:00Z')
    db.recordStreamSession(CH, polled, polled + 3600_000)
    vods = [
      { created_at: '2026-08-05T20:00:12Z', duration: '4h', type: 'archive' }, // same stream, 12s off
      { created_at: '2026-08-04T20:00:00Z', duration: '4h', type: 'archive' }, // genuinely new
    ]
    const added = await backfillVods(CH, '123', 'tok', 'cid')
    expect(added).toBe(1)
    expect(db.getStreamSessions(CH).length).toBe(2)
  })

  test('garbage rows are skipped, never inserted as zero-length sessions', async () => {
    vods = [
      { created_at: 'not-a-date', duration: '4h', type: 'archive' },
      { created_at: '2026-08-06T20:00:00Z', duration: 'nonsense', type: 'archive' },
    ]
    expect(await backfillVods(CH, '123', 'tok', 'cid')).toBe(0)
    expect(db.getStreamSessions(CH).length).toBe(0)
  })

  test('API failure fails soft — zero rows, no throw', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    expect(await backfillVods(CH, '123', 'tok', 'cid')).toBe(0)
  })
})
