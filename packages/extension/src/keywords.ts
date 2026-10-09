import { KEYWORD_ALIASES, KEYWORD_LABEL } from '@bazaarinfo/shared/src/keywords'

// Keyword styling for ability text: a coloured glyph, then the word in bold white.
// The glyph carries the colour so the word itself stays readable at a glance and the
// hue never touches body text. Colours are the 8-colour palette, nothing else.
//
// Glyphs are picked from what common monospace fonts (DejaVu Sans Mono, Consolas,
// Menlo) actually ship. Anything with an emoji form ends in U+FE0E (text
// presentation) so a browser can't swap it for a colour emoji and break the palette.
const TEXT = '\uFE0E'

export interface KeywordStyle { glyph: string; color: string }

export const KEYWORD_STYLE: Record<string, KeywordStyle> = {
  damage: { glyph: `✖${TEXT}`, color: '#ff0000' },
  burn: { glyph: `♨${TEXT}`, color: '#ff0000' },
  lifesteal: { glyph: `♥${TEXT}`, color: '#ff0000' },
  poison: { glyph: `☠${TEXT}`, color: '#00ff00' },
  heal: { glyph: '✚', color: '#00ff00' },
  regen: { glyph: '≈', color: '#00ff00' },
  shield: { glyph: '◆', color: '#ffff00' },
  crit: { glyph: '✦', color: '#ffff00' },
  freeze: { glyph: `❄${TEXT}`, color: '#00ffff' },
  haste: { glyph: '»', color: '#00ffff' },
  slow: { glyph: '◐', color: '#8888ff' },
  charge: { glyph: '↯', color: '#ff00ff' },
  multicast: { glyph: '≡', color: '#ffffff' },
  ammo: { glyph: `▪${TEXT}`, color: '#ffffff' },
  reload: { glyph: '↻', color: '#ffffff' },
  flying: { glyph: '▲', color: '#ffffff' },
}

// "Shielded" is an enchantment name in card text ("Enchant it with Shielded"), not
// the Shield effect — styling it would tag a name as a mechanic.
const NOT_KEYWORD_IN_TEXT = new Set(['shielded'])

// Every surface form that names a keyword: the labels themselves plus the
// inflections card text prints (Slows, Frozen, Poisoned…). Word-bounded, so "Heal"
// never fires inside "Healthy" and "Slow" never inside "Slowly". Longest first so a
// longer form always wins over a prefix of itself.
const SURFACE: Record<string, string> = {}
for (const k of Object.keys(KEYWORD_LABEL)) SURFACE[k] = k
for (const [form, k] of Object.entries(KEYWORD_ALIASES)) {
  if (!NOT_KEYWORD_IN_TEXT.has(form)) SURFACE[form] = k
}
const RE_KEYWORD = new RegExp(
  `\\b(${Object.keys(SURFACE).sort((a, b) => b.length - a.length).join('|')})\\b`,
  'gi',
)

export type KeywordToken = string | { kw: string; text: string }

// Split plain text into strings and keyword tokens. `text` keeps the original casing
// ("Frozen", "HASTE") — only the styling is ours to add.
export function tokenizeKeywords(s: string): KeywordToken[] {
  const out: KeywordToken[] = []
  let last = 0
  RE_KEYWORD.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = RE_KEYWORD.exec(s)) !== null) {
    if (m.index > last) out.push(s.slice(last, m.index))
    out.push({ kw: SURFACE[m[1].toLowerCase()], text: m[0] })
    last = m.index + m[0].length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}
