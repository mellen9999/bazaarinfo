import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { notify, resetNotifyForTests } from './notify'

let dir: string
let envPath: string
const origFetch = globalThis.fetch
const origEnvPath = process.env.BAZAARINFO_ALERT_ENV

function writeEnv(contents: string) {
  writeFileSync(envPath, contents)
}

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: { url: string; init: RequestInit }[] = []
  globalThis.fetch = ((url: string, init: RequestInit) => {
    calls.push({ url, init })
    return Promise.resolve(impl(url, init))
  }) as typeof fetch
  return calls
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bazaarinfo-notify-'))
  envPath = join(dir, 'alert.env')
  process.env.BAZAARINFO_ALERT_ENV = envPath
  resetNotifyForTests()
})

afterEach(() => {
  globalThis.fetch = origFetch
  if (origEnvPath === undefined) delete process.env.BAZAARINFO_ALERT_ENV
  else process.env.BAZAARINFO_ALERT_ENV = origEnvPath
  resetNotifyForTests()
  rmSync(dir, { recursive: true, force: true })
})

describe('notify', () => {
  it('no NTFY_TOPIC configured → no fetch call, no throw', async () => {
    writeEnv('NTFY_BASE=https://example.com\n')
    const calls = stubFetch(() => new Response('ok', { status: 200 }))
    await expect(notify('k1', 'title', 'body')).resolves.toBeUndefined()
    expect(calls.length).toBe(0)
  })

  it('no config file at all → no fetch call, no throw', async () => {
    const calls = stubFetch(() => new Response('ok', { status: 200 }))
    await expect(notify('k1', 'title', 'body')).resolves.toBeUndefined()
    expect(calls.length).toBe(0)
  })

  it('configured → fetch called with correct URL/headers/body', async () => {
    writeEnv('NTFY_TOPIC=mytopic\nNTFY_BASE=https://ntfy.example.com\n')
    const calls = stubFetch(() => new Response('ok', { status: 200 }))
    await notify('k1', 'my title', 'my body', 'high')
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe('https://ntfy.example.com/mytopic')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.body).toBe('my body')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.Title).toBe('my title')
    expect(headers.Priority).toBe('high')
  })

  it('dedupe: same key twice within window → one fetch; different key → sends', async () => {
    writeEnv('NTFY_TOPIC=mytopic\n')
    const calls = stubFetch(() => new Response('ok', { status: 200 }))
    await notify('dup-key', 't1', 'b1')
    await notify('dup-key', 't2', 'b2')
    expect(calls.length).toBe(1)
    await notify('other-key', 't3', 'b3')
    expect(calls.length).toBe(2)
  })

  it('fetch rejects → no throw', async () => {
    writeEnv('NTFY_TOPIC=mytopic\n')
    stubFetch(() => Promise.reject(new Error('network down')))
    await expect(notify('k1', 'title', 'body')).resolves.toBeUndefined()
  })

  it('fetch resolves non-2xx → no throw', async () => {
    writeEnv('NTFY_TOPIC=mytopic\n')
    stubFetch(() => new Response('nope', { status: 500 }))
    await expect(notify('k1', 'title', 'body')).resolves.toBeUndefined()
  })

  it('env parsing: comments, export prefix, NTFY_BASE default', async () => {
    writeEnv(['# a comment', 'export NTFY_TOPIC=exported-topic', '', '# another'].join('\n'))
    const calls = stubFetch(() => new Response('ok', { status: 200 }))
    await notify('k1', 'title', 'body')
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe('https://ntfy.sh/exported-topic')
  })

  it('strips non-ascii from title for header safety', async () => {
    writeEnv('NTFY_TOPIC=mytopic\n')
    const calls = stubFetch(() => new Response('ok', { status: 200 }))
    await notify('k1', 'emoji \u{1F600} title', 'body')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.Title).toBe('emoji  title')
  })
})
