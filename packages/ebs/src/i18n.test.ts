import './test-env'
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { handleI18n, handleI18nList, loadI18n, clearI18n } from './routes/i18n'
import { handleRequest } from './index'

let dir: string
beforeEach(() => {
  clearI18n()
  dir = mkdtempSync(join(tmpdir(), 'ebs-i18n-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const put = (name: string, body: unknown) =>
  writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body))

describe('loadI18n', () => {
  it('loads only allowlisted languages that exist and parse', () => {
    put('de.json', { Fang: 'Reißzahn' })
    put('xx.json', { a: 'b' })
    expect(loadI18n(dir)).toBe(1)
    expect(handleI18n('de').status).toBe(200)
    expect(handleI18n('xx').status).toBe(404)
  })

  it('a corrupt or wrongly-shaped file keeps the copy already served', async () => {
    put('de.json', { Fang: 'Reißzahn' })
    loadI18n(dir)
    for (const bad of ['{"half":', '[]', '{"a":1}', 'null']) {
      put('de.json', bad)
      expect(loadI18n(dir)).toBe(0)
      expect(await handleI18n('de').json()).toEqual({ Fang: 'Reißzahn' })
    }
  })

  it('a missing dir loads nothing and does not throw', () => {
    expect(loadI18n(join(dir, 'nope'))).toBe(0)
  })

  it('picks up a rewritten file', async () => {
    put('de.json', { a: 'b' })
    loadI18n(dir)
    put('de.json', { a: 'c' })
    loadI18n(dir)
    expect(await handleI18n('de').json()).toEqual({ a: 'c' })
  })
})

describe('handleI18n', () => {
  beforeEach(() => {
    put('de.json', { Fang: 'Reißzahn' })
    put('fr.json', { Fang: 'Croc' })
    loadI18n(dir)
  })

  it('serves json with cache headers and a content-addressed etag', () => {
    const res = handleI18n('de')
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
    expect(res.headers.get('Vary')).toBe('Accept-Encoding')
    expect(res.headers.get('ETag')).toBeTruthy()
    expect(res.headers.get('ETag')).not.toBe(handleI18n('fr').headers.get('ETag'))
  })

  it('answers a matching If-None-Match with 304', () => {
    const etag = handleI18n('de').headers.get('ETag')!
    const res = handleI18n('de', new Request('https://ebs.test/api/i18n/de', { headers: { 'If-None-Match': etag } }))
    expect(res.status).toBe(304)
  })

  it('compresses when the client accepts it', () => {
    const res = handleI18n('de', new Request('https://ebs.test/api/i18n/de', { headers: { 'Accept-Encoding': 'br' } }))
    expect(res.headers.get('Content-Encoding')).toBe('br')
  })

  it('404s anything off the allowlist, including traversal and prototype keys', () => {
    const attempts = [
      '', 'xx', 'DE', 'de ', 'de.json', 'de/', '../de', '..%2Fde', '../../etc/passwd', '..\\de',
      'de\0', 'de%00', '/etc/passwd', 'constructor', '__proto__', 'toString', 'hasOwnProperty',
    ]
    for (const a of attempts) expect(handleI18n(a).status).toBe(404)
  })

  it('a known language that is not loaded is 404, not an error', () => {
    expect(handleI18n('ko').status).toBe(404)
  })
})

describe('handleI18nList', () => {
  it('lists loaded languages, sorted', async () => {
    put('fr.json', { a: 'b' })
    put('de.json', { a: 'b' })
    loadI18n(dir)
    expect(await handleI18nList().json()).toEqual({ langs: ['de', 'fr'] })
  })

  it('is empty when nothing is loaded', async () => {
    expect(await handleI18nList().json()).toEqual({ langs: [] })
  })
})

describe('routing', () => {
  const get = (path: string, headers: Record<string, string> = {}) =>
    handleRequest(new Request(`https://ebs.test${path}`, { headers: { 'CF-Connecting-IP': '203.0.113.7', ...headers } }))

  it('is behind the twitch jwt gate, like /api/cards', async () => {
    expect((await get('/api/i18n')).status).toBe(401)
    expect((await get('/api/i18n/de')).status).toBe(401)
    expect((await get('/api/i18n/../cards')).status).toBe(401)
  })
})
