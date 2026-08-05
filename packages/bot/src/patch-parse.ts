// parser for the official patch notes.
//
// playthebazaar.com is a Blazor app, so the page HTML carries nothing — but the app
// fetches a manifest of every patch plus a per-patch markdown/HTML document, and those
// are stable, structured, and public. this turns that document into the same shape the
// hand-written overlay uses, so a patch grounds itself with no transcription.
//
// pure — no network, no fs. fetching lives in patch.ts, the data lives in patch-notes.ts.

import type { PatchChange, PatchOverlay } from './patch-notes'

export interface PatchManifestEntry {
  version: string
  date: string
  translations: Record<string, string>
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// sections that describe the patch rather than a card — their bullets become notes
const PROSE_SECTIONS = /new content|season|tournament|general|balance philosophy|known issues/i

// a row title's parenthetical tells us what it is when the section doesn't
const KIND_RE = /\s*\((Monster|Encounter|Merchant|Skill|Item|Hero)\)\s*$/i

const ENTITIES: [RegExp, string][] = [
  [/&nbsp;/g, ' '],
  [/&amp;/g, '&'],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#39;|&apos;|&rsquo;/g, "'"],
  [/&mdash;/g, '—'],
  [/&ndash;/g, '–'],
]

/** strip markup, decode the entities the page actually uses, collapse whitespace */
export function clean(html: string): string {
  let s = html.replace(/<[^>]*>/g, ' ')
  for (const [re, to] of ENTITIES) s = s.replace(re, to)
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * normalize patch-notes phrasing into the terse form the bot speaks:
 * "[40/80/160]" → "40/80/160", "(from X)" → "(was X)", no trailing period.
 */
export function condense(text: string): string {
  return text
    .replace(/\[([^\]]*[\d/][^\]]*)\]/g, '$1')
    .replace(/\(\s*from\s+/gi, '(was ')
    .replace(/\bfrom\s+(?=[\d[])/gi, 'was ')
    .replace(/\s+([,.;])/g, '$1')
    .replace(/[.:]\s*$/, '')
    .trim()
}

/** "August 5, 2026" → { released: "2026-08-05", date: "Aug 5" } */
export function parseDate(raw: string): { released: string; date: string } | null {
  const m = /([A-Z][a-z]+)\s+(\d{1,2}),?\s+(\d{4})/.exec(raw)
  if (!m) return null
  const idx = MONTHS.findIndex((mo) => mo.toLowerCase() === m[1].toLowerCase())
  if (idx < 0) return null
  const mm = String(idx + 1).padStart(2, '0')
  const dd = String(Number(m[2])).padStart(2, '0')
  return { released: `${m[3]}-${mm}-${dd}`, date: `${MONTHS[idx].slice(0, 3)} ${Number(m[2])}` }
}

/** flatten a <ul>/<li> tree (nested detail included) into ordered bullet strings */
function bullets(html: string): string[] {
  return html
    .split(/<li[^>]*>/i)
    .slice(1)
    .map((chunk) => clean(chunk.split(/<\/li>/i)[0]))
    .filter((t) => t.length > 1)
}

/** one card's bullets → a single line that fits beside the card in a 480-char reply */
function joinBullets(list: string[], max = 230): string {
  const out: string[] = []
  let len = 0
  for (const b of list) {
    const piece = condense(b)
    if (!piece) continue
    const add = (out.length ? 2 : 0) + piece.length
    if (len + add > max) break
    out.push(piece)
    len += add
  }
  return out.join('; ')
}

/** "Chronos, Cobweb, Freiya, Hef and Knightshade" → 5 names */
function splitNames(title: string): string[] {
  if (!/,| and /i.test(title)) return [title]
  return title
    .split(/,| and /i)
    .map((s) => s.trim())
    .filter(Boolean)
}

interface Section {
  title: string
  body: string
}

function sections(doc: string): Section[] {
  const out: Section[] = []
  const re = /<h3[^>]*>([\s\S]*?)<\/h3>/gi
  const marks: { title: string; start: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(doc))) marks.push({ title: clean(m[1]), start: m.index + m[0].length })
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? doc.indexOf('<h3', marks[i].start) : doc.length
    out.push({ title: marks[i].title, body: doc.slice(marks[i].start, end < 0 ? doc.length : end) })
  }
  return out
}

const ROW_RE = /<div class="item-description">([\s\S]*?)<\/div>/gi

/**
 * card entries come in two shapes: an illustrated `item-row` (most items), and a bare
 * `<strong>Name</strong><ul>…</ul>` group (skills, and merchants listed together).
 * both are real changes — reading only the first shape silently dropped every skill.
 */
function rows(body: string): { title: string; html: string }[] {
  const out: { title: string; html: string }[] = []
  let m: RegExpExecArray | null
  const re = new RegExp(ROW_RE.source, 'gi')
  while ((m = re.exec(body))) {
    const inner = m[1]
    const t = /<strong>([\s\S]*?)<\/strong>/i.exec(inner)
    if (!t) continue
    out.push({ title: clean(t[1]), html: inner.slice((t.index ?? 0) + t[0].length) })
  }

  // bare groups — only outside item-rows, so nothing is counted twice
  const bare = body.replace(new RegExp(ROW_RE.source, 'gi'), ' ')
  const gre = /<strong>([\s\S]*?)<\/strong>\s*(<ul>[\s\S]*?<\/ul>)/gi
  while ((m = gre.exec(bare))) {
    const title = clean(m[1])
    if (title && title.length < 80) out.push({ title, html: m[2] })
  }
  return out
}

/** possessive drift: notes say "Dragon's Tooth", the card database says "Dragon Tooth" */
function nameVariants(name: string): string[] {
  const out = [name]
  if (/'s\b/i.test(name)) out.push(name.replace(/'s\b/gi, ''))
  if (/'\B/.test(name)) out.push(name.replace(/'/g, ''))
  return out
}

/**
 * prose sections outside item-rows also use "<strong>heading</strong><ul><li>…":
 * keep the heading with its bullets so a note reads as one statement.
 */
function proseNotes(body: string): string[] {
  const stripped = body.replace(/<div class="item-row">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi, '')
  const out: string[] = []
  for (const p of stripped.match(/<p>[\s\S]*?<\/p>/gi) ?? []) {
    const t = clean(p)
    if (t.length > 20) out.push(t)
  }
  const re = /<strong>([\s\S]*?)<\/strong>\s*((?:<ul>[\s\S]*?<\/ul>)?)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped))) {
    const head = clean(m[1])
    if (!head || head.length < 3) continue
    const list = m[2] ? bullets(m[2]) : []
    const line = list.length ? `${head}: ${list.map(condense).join('; ')}` : head
    if (line.length > 12) out.push(line.slice(0, 480))
  }
  for (const ul of stripped.match(/<ul>[\s\S]*?<\/ul>/gi) ?? []) {
    for (const b of bullets(ul)) {
      const t = condense(b)
      if (t.length > 25 && !out.some((o) => o.includes(t))) out.push(t)
    }
  }
  return [...new Set(out)]
}

/**
 * a brand-new hero has no balance section, so it only shows up in New Content prose.
 * require the name to be repeated — one stray capitalized phrase is not evidence.
 */
function detectNewHero(newContent: string | undefined): string[] {
  if (!newContent) return []
  const text = clean(newContent)
  if (!/new(ly)?\s+(playable\s+)?hero/i.test(text)) return []
  const counts = new Map<string, number>()
  for (const m of text.matchAll(/\bThe [A-Z][a-z]+(?:\s[A-Z][a-z]+)?/g)) {
    const name = m[0].trim()
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const best = [...counts.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1])[0]
  return best ? [best[0]] : []
}

export interface ParseResult extends Omit<PatchOverlay, 'headline'> {
  /** sections that produced no rows — surfaced so a silent format change is visible */
  emptySections: string[]
  /** parsed names with no card in the database — new cards, or naming drift worth seeing */
  unmatchedCards: string[]
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

/**
 * parse one patch document. `heroes` is the live hero list (dump-derived): a section
 * whose title is a known hero attributes its rows to that hero, everything else is
 * classified by the row's own "(Monster)"/"(Encounter)" suffix.
 */
export function parsePatchDoc(doc: string, heroes: string[], knownCards: string[] = []): ParseResult | null {
  const head = /##\s*Patch\s+(\d+(?:\.\d+)*)\s*:?\s*([^<\n]*)<span>([^<]*)<\/span>/i.exec(doc)
    ?? /##\s*Patch\s+(\d+(?:\.\d+)*)\s*:?\s*([^<\n]*)()/i.exec(doc)
  if (!head) return null
  const version = head[1]
  const name = clean(head[2]).replace(/:$/, '').trim()
  const when = parseDate(head[3] || '')
  if (!when) return null

  const heroSet = new Map(heroes.map((h) => [h.toLowerCase(), h]))
  const cardIndex = new Map(knownCards.map((c) => [norm(c), c]))
  // resolve to the database's spelling so a lookup can actually find the entry
  const resolve = (name: string): string | null => {
    for (const v of nameVariants(name)) {
      const hit = cardIndex.get(norm(v))
      if (hit) return hit
    }
    return null
  }
  const changes: PatchChange[] = []
  const notes: string[] = []
  const emptySections: string[] = []
  const unmatchedCards: string[] = []
  let newContent: string | undefined

  for (const sec of sections(doc)) {
    const hero = heroSet.get(sec.title.toLowerCase())
    const isProse = !hero && PROSE_SECTIONS.test(sec.title)
    if (/new content/i.test(sec.title)) newContent = sec.body

    const found = rows(sec.body)
    if (!hero && !isProse && found.length === 0) emptySections.push(sec.title)

    for (const row of found) {
      const kind = KIND_RE.exec(row.title)?.[1]
      const bare = row.title.replace(KIND_RE, '').trim()
      const list = bullets(row.html)
      const text = joinBullets(list)
      if (!text || !bare) continue

      // "Golden Enchant / Added missing golden enchants to the following items: / <names>"
      // — a lead-in followed by nothing but real card names. attach the lead-in to each
      // one. gated on the heading NOT being a card itself, so a monster's board listing
      // (Yerdan: "Gained a new setup:" + its items) is never re-attributed.
      if (!isProse && cardIndex.size > 0 && !resolve(bare) && list.length > 2 && /:$/.test(list[0])) {
        const names = list.slice(1).map(resolve)
        if (names.length > 1 && names.every(Boolean)) {
          const lead = condense(list[0])
          for (const n of names) changes.push({ card: n!, hero: hero ?? 'Common', text: lead })
          continue
        }
      }
      // new-content rows describe things that don't exist in the card db yet — they're
      // notes, not per-card deltas, so a lookup can never attach them to the wrong card
      if (isProse) {
        notes.push(`${row.title}: ${text}`)
        continue
      }
      const attributed = hero ?? (kind === 'Monster' ? 'Monster' : kind === 'Skill' ? 'Common' : 'Encounter')
      for (const one of splitNames(bare)) {
        const resolved = resolve(one)
        if (!resolved && cardIndex.size > 0) unmatchedCards.push(one)
        changes.push({ card: resolved ?? one, hero: attributed, text })
      }
    }

    if (isProse) notes.push(...proseNotes(sec.body))
  }

  if (changes.length === 0 && notes.length === 0) return null

  return {
    version,
    name,
    date: when.date,
    released: when.released,
    newHeroes: detectNewHero(newContent),
    notes: [...new Set(notes)].filter((n) => n.length < 600),
    changes,
    emptySections,
    unmatchedCards: [...new Set(unmatchedCards)],
  }
}

/** newest English patch from the manifest the site's app fetches */
export function pickLatest(manifest: unknown): { version: string; path: string } | null {
  if (!Array.isArray(manifest)) return null
  const entries = manifest.filter(
    (e): e is PatchManifestEntry =>
      !!e && typeof e.version === 'string' && /^\d+(\.\d+)*$/.test(e.version) && !!e.translations,
  )
  if (!entries.length) return null
  const cmp = (a: string, b: string) => {
    const pa = a.split('.').map(Number)
    const pb = b.split('.').map(Number)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0)
      if (d) return d
    }
    return 0
  }
  const newest = entries.reduce((best, e) => (cmp(e.version, best.version) > 0 ? e : best))
  const path = newest.translations.English ?? Object.values(newest.translations)[0]
  return typeof path === 'string' && path ? { version: newest.version, path } : null
}
