import { describe, expect, it } from 'bun:test'
import { readJson, extractFirstJson } from './http'

describe('extractFirstJson', () => {
  it('extracts a bare object', () => {
    expect(extractFirstJson('{"ok":true,"x":1}')).toBe('{"ok":true,"x":1}')
  })
  it('ignores trailing prose / a second corrected object (the live regression)', () => {
    const out = 'Here: {"ok":true,"trigger":["topology"]}\n\nWait, let me fix that:\n{"ok":false}'
    expect(extractFirstJson(out)).toBe('{"ok":true,"trigger":["topology"]}')
  })
  it('handles nested objects and braces inside strings', () => {
    expect(extractFirstJson('noise {"a":{"b":2},"s":"}{"} tail')).toBe('{"a":{"b":2},"s":"}{"}')
  })
  it('returns null when there is no object', () => {
    expect(extractFirstJson('sorry I cannot')).toBeNull()
  })
})

// the bug this guards against: a 200 response with an empty or truncated body made
// res.json() throw "Unexpected end of JSON input", silently dropping the in-flight
// reply. readJson must NEVER throw — it returns a result object the caller branches on.

describe('readJson', () => {
  it('parses a valid JSON body on a 2xx', async () => {
    const r = await readJson<{ a: number }>(new Response('{"a":1}', { status: 200 }))
    expect(r.ok).toBe(true)
    expect(r.empty).toBe(false)
    expect(r.status).toBe(200)
    expect(r.data).toEqual({ a: 1 })
  })

  it('empty 200 body → empty=true (retryable), never throws', async () => {
    const r = await readJson(new Response('', { status: 200 }))
    expect(r.ok).toBe(false)
    expect(r.empty).toBe(true) // signals caller to retry as transient
    expect(r.data).toBeNull()
  })

  it('whitespace-only 200 body → treated as empty', async () => {
    const r = await readJson(new Response('   \n\t ', { status: 200 }))
    expect(r.empty).toBe(true)
    expect(r.data).toBeNull()
  })

  it('truncated/malformed JSON on a 200 → empty=true (retryable), never throws', async () => {
    const r = await readJson(new Response('{"content":[{"text":"hel', { status: 200 }))
    expect(r.ok).toBe(false)
    expect(r.empty).toBe(true)
    expect(r.data).toBeNull()
  })

  it('empty body on a non-2xx → empty=false (do NOT retry as transient)', async () => {
    const r = await readJson(new Response('', { status: 500 }))
    expect(r.ok).toBe(false)
    expect(r.empty).toBe(false) // res.ok was false, so not a transient-empty
    expect(r.status).toBe(500)
  })

  it('malformed body on a non-2xx → empty=false', async () => {
    const r = await readJson(new Response('<html>503</html>', { status: 503 }))
    expect(r.ok).toBe(false)
    expect(r.empty).toBe(false)
    expect(r.data).toBeNull()
  })

  it('valid JSON on a non-2xx → ok=false (status gates it)', async () => {
    const r = await readJson(new Response('{"error":"x"}', { status: 429 }))
    expect(r.ok).toBe(false)
    expect(r.empty).toBe(false)
    expect(r.data).toEqual({ error: 'x' })
  })

  it('handles a JSON array body (digest APIs return arrays)', async () => {
    const r = await readJson<number[]>(new Response('[1,2,3]', { status: 200 }))
    expect(r.ok).toBe(true)
    expect(r.data).toEqual([1, 2, 3])
  })

  it('empty array body is valid, not empty', async () => {
    const r = await readJson<number[]>(new Response('[]', { status: 200 }))
    expect(r.ok).toBe(true)
    expect(r.empty).toBe(false)
    expect(r.data).toEqual([])
  })

  it('never throws even when the body stream errors', async () => {
    // a Response whose body read rejects — readJson must swallow and report empty
    const broken = { ok: true, status: 200, text: () => Promise.reject(new Error('stream reset')) } as unknown as Response
    const r = await readJson(broken)
    expect(r.data).toBeNull()
    expect(r.empty).toBe(true)
  })
})
