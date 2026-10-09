// GET /api/i18n and /api/i18n/<lang> — card text in the viewer's language
//
// Files come from the bot's extractor (cache/i18n/<lang>.json: english -> translated).
// Each is prepared once at load like the card blob. The language in the URL is
// checked against a fixed allowlist and is never joined into a path at request time:
// files are read only at load, by allowlisted name, so no request can reach the disk.

import { readFileSync } from 'fs'
import { join } from 'path'
import { LANGS } from '@bazaarinfo/data'
import { prepare, respondPrepared, type Prepared } from './encoded'

const ALLOWED = new Set(Object.keys(LANGS))
const loaded = new Map<string, Prepared>()

function isStringMap(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  return Object.values(v).every((x) => typeof x === 'string')
}

// Per-language read-then-swap: a missing, partial or corrupt file keeps the copy
// already being served (the extractor writes temp+rename, but never trust a read).
// Returns how many languages were (re)loaded.
export function loadI18n(dir: string): number {
  let n = 0
  for (const lang of ALLOWED) {
    let raw: string
    try {
      raw = readFileSync(join(dir, `${lang}.json`), 'utf-8')
    } catch {
      continue
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isStringMap(parsed)) throw new Error('not a string map')
      // re-serialise so the etag and size don't depend on how the file was formatted
      loaded.set(lang, prepare(JSON.stringify(parsed)))
      n++
    } catch (e) {
      console.error(`[ebs] bad i18n file for ${lang}, keeping current:`, e)
    }
  }
  return n
}

export function clearI18n() {
  loaded.clear()
}

export function handleI18n(lang: string, req?: Request): Response {
  const p = ALLOWED.has(lang) ? loaded.get(lang) : undefined
  if (!p) return new Response('not found', { status: 404 })
  return respondPrepared(p, req)
}

export function handleI18nList(): Response {
  return Response.json({ langs: [...loaded.keys()].sort() }, {
    headers: { 'Cache-Control': 'public, max-age=300' },
  })
}
