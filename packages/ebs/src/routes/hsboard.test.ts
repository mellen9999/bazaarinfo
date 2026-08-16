import { test, expect, describe, beforeEach } from 'bun:test'
import { parseMinion, parseHero, parseHsState } from './hsboard-validate'
import { storeHsState, handleHsBoard, __clearHsForTest } from './hsboard'
import type { HsState } from '@bazaarinfo/shared'

const GOOD: HsState = {
  turn: 7,
  phase: 'shop',
  board: [{ id: 'BGS_071', pos: 1, atk: 3, hp: 2, tier: 3, kw: ['divine shield'] }],
  hero: { id: 'BG23_HERO_305_SKIN_B', hp: 30, armor: 9, tier: 3, place: 2 },
}

beforeEach(() => {
  __clearHsForTest()
})

describe('parseMinion — the companion is not trusted', () => {
  test('accepts a real minion', () => {
    expect(parseMinion({ id: 'BGS_071', pos: 1, atk: 3, hp: 2 })).toEqual({ id: 'BGS_071', pos: 1, atk: 3, hp: 2 })
  })

  test('rejects a card id that is not a card id', () => {
    for (const id of ['', 'a'.repeat(65), '../../etc/passwd', '<script>', 'BGS 071', 42, null]) {
      expect(parseMinion({ id, pos: 1, atk: 1, hp: 1 })).toBeNull()
    }
  })

  test('rejects an impossible board position', () => {
    for (const pos of [0, 8, -1, 1.5, '1']) {
      expect(parseMinion({ id: 'BGS_071', pos, atk: 1, hp: 1 })).toBeNull()
    }
  })

  test('rejects non-integer, infinite or absurd stats', () => {
    for (const bad of [{ atk: Infinity }, { atk: NaN }, { hp: -1 }, { atk: 1e9 }, { hp: '5' }]) {
      expect(parseMinion({ id: 'BGS_071', pos: 1, atk: 1, hp: 1, ...bad })).toBeNull()
    }
  })

  test('keeps big-but-real buffed stats', () => {
    expect(parseMinion({ id: 'BGS_071', pos: 1, atk: 4000, hp: 9000 })?.atk).toBe(4000)
  })

  test('caps keyword spam instead of storing it', () => {
    const m = parseMinion({ id: 'BGS_071', pos: 1, atk: 1, hp: 1, kw: Array(50).fill('taunt') })
    expect(m?.kw?.length).toBe(8)
  })

  test('rejects a tier outside the game', () => {
    expect(parseMinion({ id: 'BGS_071', pos: 1, atk: 1, hp: 1, tier: 9 })).toBeNull()
  })
})

describe('parseHero', () => {
  test('accepts a real hero and keeps every field it was given', () => {
    expect(parseHero({ id: 'TB_BaconShop_HERO_34', hp: 60, armor: 0, place: 8 }))
      .toEqual({ id: 'TB_BaconShop_HERO_34', hp: 60, armor: 0, place: 8 })
  })

  test('an absent field stays absent', () => {
    expect(parseHero({ id: 'X', hp: 30 })).toEqual({ id: 'X', hp: 30 })
  })

  test('rejects a place outside a lobby', () => {
    expect(parseHero({ id: 'X', hp: 1, place: 9 })).toBeNull()
  })
})

describe('parseHsState', () => {
  test('round-trips a real state', () => {
    expect(parseHsState(GOOD)).toEqual(GOOD)
  })

  test('rejects an unknown phase — the shop/combat distinction is load-bearing', () => {
    expect(parseHsState({ ...GOOD, phase: 'fighting' })).toBeNull()
    expect(parseHsState({ ...GOOD, phase: undefined })).toBeNull()
  })

  test('rejects a bad hero rather than silently dropping it', () => {
    // a hero that fails validation must fail the frame: reporting a board with no hero
    // reads as "he has no hero", which is never true
    expect(parseHsState({ ...GOOD, hero: { id: 'X', hp: 'lots' } })).toBeNull()
  })

  test('drops individual bad minions but keeps the frame', () => {
    const s = parseHsState({ ...GOOD, board: [GOOD.board[0], { id: '', pos: 1, atk: 1, hp: 1 }] })
    expect(s?.board).toHaveLength(1)
  })

  test('caps the board at seven however many are sent', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: 'BGS_071', pos: (i % 7) + 1, atk: 1, hp: 1 }))
    expect(parseHsState({ ...GOOD, board: many })?.board).toHaveLength(7)
  })

  test('caps the lobby at eight', () => {
    const many = Array.from({ length: 30 }, () => ({ id: 'X', hp: 1, place: 1 }))
    expect(parseHsState({ ...GOOD, lobby: many })?.lobby).toHaveLength(8)
  })

  test('rejects junk outright', () => {
    for (const v of [null, undefined, 'x', 42, [], {}, { turn: 1 }]) {
      expect(parseHsState(v)).toBeNull()
    }
  })
})

describe('GET /hsboard', () => {
  const url = (id: string) => new URL(`http://x/hsboard?channel_id=${id}`)
  const req = (secret?: string) =>
    new Request('http://x/hsboard', { headers: secret ? { 'x-internal-secret': secret } : {} })

  test('404s without the internal secret, even for a channel that exists', () => {
    process.env.INTERNAL_SECRET = 'topsecret'
    storeHsState('123', GOOD)
    expect(handleHsBoard(req(), url('123')).status).toBe(404)
    expect(handleHsBoard(req('wrong'), url('123')).status).toBe(404)
  })

  test('404s when the route is disabled by an unset secret', () => {
    process.env.INTERNAL_SECRET = ''
    storeHsState('123', GOOD)
    expect(handleHsBoard(req(''), url('123')).status).toBe(404)
  })

  test('serves the stored state with its age', async () => {
    process.env.INTERNAL_SECRET = 'topsecret'
    storeHsState('123', GOOD)
    const res = handleHsBoard(req('topsecret'), url('123'))
    expect(res.status).toBe(200)
    const body = await res.json() as { hs: HsState; ageMs: number }
    expect(body.hs).toEqual(GOOD)
    expect(body.ageMs).toBeGreaterThanOrEqual(0)
  })

  test('an unknown channel is a 404, never an empty board', () => {
    process.env.INTERNAL_SECRET = 'topsecret'
    expect(handleHsBoard(req('topsecret'), url('999')).status).toBe(404)
  })

  test('leaving a game clears the board rather than freezing it', () => {
    process.env.INTERNAL_SECRET = 'topsecret'
    storeHsState('123', GOOD)
    storeHsState('123', null)
    expect(handleHsBoard(req('topsecret'), url('123')).status).toBe(404)
  })
})
