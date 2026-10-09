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

// surface form (lowercase) -> canonical key, for the English words: the labels plus
// the inflections card text prints (Slows, Frozen, Poisoned…).
const SURFACE: Record<string, string> = {}
for (const k of Object.keys(KEYWORD_LABEL)) SURFACE[k] = k
for (const [form, k] of Object.entries(KEYWORD_ALIASES)) {
  if (!NOT_KEYWORD_IN_TEXT.has(form)) SURFACE[form] = k
}

export type KeywordToken = string | { kw: string; text: string }
export type Tokenizer = (s: string) => KeywordToken[]

// Scripts written without spaces between words: there is no "whole word" to anchor
// to, so a term is matched as a plain substring (longest first).
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// \b is ASCII-only and would split "Gelé" mid-word. Letters or digits on either side
// disqualify a spaced-script term instead, so "Heal" never fires inside "Healthy".
const wordBounded = (t: string) => `(?<![\\p{L}\\p{N}])${escapeRe(t)}(?![\\p{L}\\p{N}])`

// Build a tokenizer from surface form -> keyword key. `text` keeps the original
// casing ("Frozen", "HASTE") — only the styling is ours to add.
export function makeTokenizer(surface: Record<string, string>, lang = 'en'): Tokenizer {
  const norm = (s: string) => s.toLocaleLowerCase(lang)
  const forms: Record<string, string> = {}
  for (const [f, k] of Object.entries(surface)) forms[norm(f)] = k
  const alts = Object.keys(forms)
    .sort((a, b) => b.length - a.length)
    .map((t) => (UNSPACED.test(t) ? escapeRe(t) : wordBounded(t)))
  const re = new RegExp(alts.join('|'), 'giu')
  return (s) => {
    const out: KeywordToken[] = []
    let last = 0
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) out.push(s.slice(last, m.index))
      out.push({ kw: forms[norm(m[0])], text: m[0] })
      last = m.index + m[0].length
    }
    if (last < s.length) out.push(s.slice(last))
    return out
  }
}

export const tokenizeKeywords: Tokenizer = makeTokenizer(SURFACE)

// The viewer's language: every translated keyword term the map carries, on top of the
// English forms (a tooltip the map missed stays English and must still be styled).
// A term the game has no word for is skipped — that keyword just goes unstyled.
export function localizedTokenizer(lookup: (english: string) => string | undefined, lang: string): Tokenizer {
  const surface = { ...SURFACE }
  for (const [form, k] of Object.entries(SURFACE)) {
    const tr = lookup(form.charAt(0).toUpperCase() + form.slice(1))
    if (tr) surface[tr] = k
  }
  return makeTokenizer(surface, lang)
}
