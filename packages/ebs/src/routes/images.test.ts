import { describe, it, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveCdnVersion } from './images'

const dir = mkdtempSync(join(tmpdir(), 'ebs-cdn-'))
const write = (name: string, body: string, mtime?: number) => {
  const p = join(dir, name)
  writeFileSync(p, body)
  if (mtime) utimesSync(p, mtime, mtime)
  return p
}

describe('resolveCdnVersion', () => {
  it('falls back when the file is missing or bad', () => {
    expect(resolveCdnVersion(join(dir, 'nope.json'), 'z17.0')).toBe('z17.0')
    expect(resolveCdnVersion(write('bad.json', '{nope'), 'z17.0')).toBe('z17.0')
    expect(resolveCdnVersion(write('junk.json', '{"cdn":"../evil"}'), 'z17.0')).toBe('z17.0')
  })

  it('follows a newer segment, and re-reads on mtime change', () => {
    const p = write('c.json', '{"cdn":"z19.0"}', 1_000_000)
    expect(resolveCdnVersion(p, 'z17.0')).toBe('z19.0')
    write('c.json', '{"cdn":"z20.0"}', 2_000_000)
    expect(resolveCdnVersion(p, 'z17.0')).toBe('z20.0')
  })

  it('never goes older than the committed segment', () => {
    expect(resolveCdnVersion(write('old.json', '{"cdn":"z11.0"}'), 'z17.0')).toBe('z17.0')
  })
})
