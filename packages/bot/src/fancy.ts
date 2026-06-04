// fancy.ts — deterministic ascii -> unicode "fancy font" transcoder.
//
// the model writes a plain-ascii pasta (~70-120 tokens, ~1s) and we apply the
// font here in code: instant, exact, and it can never truncate a glyph mid-word.
// the old path let the model hand-type fancy glyphs directly — every glyph is a
// 3-5 token supplementary-plane codepoint, so a 400-char fancy pasta cost ~800
// tokens and 10-12s of latency (the "Dearly beloved" truncation bug lived here too).

export type FancyStyle =
  | 'fraktur' | 'boldFraktur' | 'script' | 'boldScript'
  | 'bold' | 'italic' | 'boldItalic' | 'doubleStruck'
  | 'monospace' | 'fullwidth'

// each style: contiguous Math-Alphanumeric block bases + per-char "holes" where
// unicode reused pre-existing Letterlike-Symbols codepoints instead of a fresh one.
interface StyleDef {
  upper: number             // codepoint of 'A'
  lower: number             // codepoint of 'a'
  digit?: number            // codepoint of '0' (undefined → keep ascii digits)
  holesUpper?: Record<string, number>
  holesLower?: Record<string, number>
  space?: number            // override space (fullwidth uses U+3000)
}

const STYLES: Record<FancyStyle, StyleDef> = {
  bold:        { upper: 0x1d400, lower: 0x1d41a, digit: 0x1d7ce },
  italic:      { upper: 0x1d434, lower: 0x1d44e, holesLower: { h: 0x210e } },
  boldItalic:  { upper: 0x1d468, lower: 0x1d482 },
  script:      { upper: 0x1d49c, lower: 0x1d4b6,
    holesUpper: { B: 0x212c, E: 0x2130, F: 0x2131, H: 0x210b, I: 0x2110, L: 0x2112, M: 0x2133, R: 0x211b },
    holesLower: { e: 0x212f, g: 0x210a, o: 0x2134 } },
  boldScript:  { upper: 0x1d4d0, lower: 0x1d4ea },
  fraktur:     { upper: 0x1d504, lower: 0x1d51e,
    holesUpper: { C: 0x212d, H: 0x210c, I: 0x2111, R: 0x211c, Z: 0x2128 } },
  boldFraktur: { upper: 0x1d56c, lower: 0x1d586 },
  doubleStruck:{ upper: 0x1d538, lower: 0x1d552, digit: 0x1d7d8,
    holesUpper: { C: 0x2102, H: 0x210d, N: 0x2115, P: 0x2119, Q: 0x211a, R: 0x211d, Z: 0x2124 } },
  monospace:   { upper: 0x1d670, lower: 0x1d68a, digit: 0x1d7f6 },
  fullwidth:   { upper: 0xff21, lower: 0xff41, digit: 0xff10, space: 0x3000 },
}

// map a request to a style. returns null when the query isn't asking for fancy text.
const STYLE_KEYWORDS: [RegExp, FancyStyle][] = [
  [/\bbold\s*(fraktur|gothic|black\s*letter|blackletter)\b/i, 'boldFraktur'],
  [/\b(fraktur|gothic|old\s*english|black\s*letter|blackletter)\b/i, 'fraktur'],
  [/\bbold\s*(script|cursive|calligraph\w*)\b/i, 'boldScript'],
  [/\b(cursive|script|calligraph\w*|handwriting|handwritten)\b/i, 'script'],
  [/\b(full\s*width|fullwidth|aesthetic|vaporwave|vapor\s*wave)\b/i, 'fullwidth'],
  [/\b(double[-\s]*struck|blackboard|outline\s*font|bubble\s*outline)\b/i, 'doubleStruck'],
  [/\bmono(space)?\b/i, 'monospace'],
  [/\bbold\s*italic\b/i, 'boldItalic'],
  [/\bitalic\b/i, 'italic'],
  [/\bbold\b/i, 'bold'],
]

// generic "make it fancy" intent — no specific font named. classic "fancy" = cursive script.
const FANCY_INTENT = /\b(fancy|stylized?|stylish|aesthetic|drip|spicy|cult\w*|ritual\w*)\s*(font|text|letters?|type|writing|style)?\b|\b(font|lettering)\b/i

// the model occasionally pastes fancy unicode the user typed — supplementary-plane
// math-alphanumeric / enclosed / fullwidth ranges. echo that intent.
const FANCY_UNICODE = /[\u{1d400}-\u{1d7ff}\u{2460}-\u{24ff}\u{ff00}-\u{ffef}]/u

export function detectFancyStyle(query: string): FancyStyle | null {
  for (const [re, style] of STYLE_KEYWORDS) if (re.test(query)) return style
  if (FANCY_INTENT.test(query) || FANCY_UNICODE.test(query)) return 'script'
  return null
}

const A = 0x41, Z = 0x5a, a = 0x61, z = 0x7a, ZERO = 0x30, NINE = 0x39, SPACE = 0x20

// transcode ascii letters/digits to the chosen font. spaces, punctuation, emoji,
// and any already-non-ascii codepoints pass through untouched.
export function toFancy(text: string, style: FancyStyle): string {
  const s = STYLES[style]
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp >= A && cp <= Z) {
      out += s.holesUpper?.[ch] != null
        ? String.fromCodePoint(s.holesUpper[ch])
        : String.fromCodePoint(s.upper + (cp - A))
    } else if (cp >= a && cp <= z) {
      out += s.holesLower?.[ch] != null
        ? String.fromCodePoint(s.holesLower[ch])
        : String.fromCodePoint(s.lower + (cp - a))
    } else if (cp >= ZERO && cp <= NINE && s.digit != null) {
      out += String.fromCodePoint(s.digit + (cp - ZERO))
    } else if (cp === SPACE && s.space != null) {
      out += String.fromCodePoint(s.space)
    } else {
      out += ch
    }
  }
  return out
}
