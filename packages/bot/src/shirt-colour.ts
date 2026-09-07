// colour families for the shirt tracker (shirt.ts). the model says "navy" one stream and
// "dark blue" the next; the bet is about BLUE. counting by family is what makes the odds
// line true instead of splitting one colour across three buckets.
//
// pure and dependency-free. the family is computed at read time and never stored, so this
// map can get smarter without rewriting a single row.

export const FAMILIES = [
  'black', 'white', 'grey', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'brown', 'beige',
] as const
export type Family = (typeof FAMILIES)[number]

const FAMILY_SET: ReadonlySet<string> = new Set(FAMILIES)

// words that shade a colour without changing what it is.
const MODIFIERS = new Set([
  'dark', 'light', 'pale', 'bright', 'deep', 'off', 'very', 'slightly', 'muted', 'dull', 'faded',
  'neon', 'hot', 'baby', 'royal', 'washed', 'heather', 'heathered', 'plain', 'solid', 'matte',
])

const SYNONYMS: Record<string, Family> = {
  gray: 'grey', charcoal: 'grey', slate: 'grey', silver: 'grey', ash: 'grey', graphite: 'grey',
  gunmetal: 'grey', stone: 'grey', pewter: 'grey',
  navy: 'blue', teal: 'blue', turquoise: 'blue', denim: 'blue', sky: 'blue', indigo: 'blue',
  cobalt: 'blue', aqua: 'blue', cyan: 'blue', azure: 'blue', periwinkle: 'blue', sapphire: 'blue',
  maroon: 'red', burgundy: 'red', wine: 'red', crimson: 'red', scarlet: 'red', cherry: 'red',
  ruby: 'red', brick: 'red', cardinal: 'red',
  olive: 'green', forest: 'green', lime: 'green', mint: 'green', sage: 'green', emerald: 'green',
  army: 'green', hunter: 'green', jade: 'green', moss: 'green',
  tan: 'beige', khaki: 'beige', sand: 'beige', camel: 'beige', taupe: 'beige', oatmeal: 'beige',
  nude: 'beige', ecru: 'beige',
  cream: 'white', ivory: 'white', eggshell: 'white', bone: 'white',
  gold: 'yellow', mustard: 'yellow', lemon: 'yellow',
  salmon: 'orange', coral: 'orange', peach: 'orange', rust: 'orange', apricot: 'orange',
  tangerine: 'orange', amber: 'orange',
  lavender: 'purple', violet: 'purple', lilac: 'purple', magenta: 'purple', plum: 'purple',
  mauve: 'purple',
  rose: 'pink', blush: 'pink', fuchsia: 'pink', salmonpink: 'pink',
  chocolate: 'brown', coffee: 'brown', mocha: 'brown', chestnut: 'brown', mahogany: 'brown',
  bronze: 'brown', copper: 'brown', umber: 'brown',
}

/** a known colour word → its family; anything else null. */
export function wordFamily(word: string): Family | null {
  const w = word.toLowerCase()
  if (FAMILY_SET.has(w)) return w as Family
  return SYNONYMS[w] ?? null
}

const HEX_RE = /^#[0-9a-f]{6}$/i

function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  if (!HEX_RE.test(hex)) return null
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h = (h * 60 + 360) % 360
  return { h, s, l }
}

/**
 * The family a swatch belongs to. Only a fallback for a colour WORD we don't know: the
 * model's hex is approximate, and it misleads exactly where it matters (a burgundy at
 * L≈0.13 lands in black; a warm grey at S≈0.13 lands in beige). The word always wins.
 */
export function hexFamily(hex: string): Family | null {
  const hsl = hexToHsl(hex)
  if (!hsl) return null
  const { h, s, l } = hsl
  if (l < 0.15) return 'black'
  if (l > 0.88 && s < 0.15) return 'white'
  if (s < 0.12) return 'grey'
  if (h >= 345 || h < 15) return l > 0.7 ? 'pink' : 'red'
  if (h < 40) return l < 0.45 && s < 0.6 ? 'brown' : 'orange'
  if (h < 65) return s < 0.4 && l > 0.6 ? 'beige' : 'yellow'
  if (h < 165) return 'green'
  if (h < 255) return 'blue'
  if (h < 290) return 'purple'
  return 'pink'
}

/**
 * The family of a read: strip shading words ("dark", "off"), take the first colour word
 * we know ("black and white" is black-family, "dark navy" is blue), fall back to the hex,
 * and as a last resort let an unknown word be its own bucket so it is never silently
 * merged into the wrong one.
 */
export function toFamily(color: string, hex = ''): string {
  const words = color.toLowerCase().split(/[^a-z]+/).filter((w) => w && !MODIFIERS.has(w) && w !== 'and')
  for (const w of words) {
    const f = wordFamily(w)
    if (f) return f
  }
  return hexFamily(hex) ?? words[0] ?? color.toLowerCase().trim()
}

// synonyms safe to read out of a chat line. "stone", "wine", "sky", "rose" are everyday words
// and would turn any sentence into a colour question; these only ever mean a colour.
const CHAT_SYNONYMS = new Set([
  'gray', 'charcoal', 'navy', 'teal', 'turquoise', 'maroon', 'burgundy', 'crimson', 'olive',
  'khaki', 'tan', 'beige', 'cream', 'lavender', 'violet', 'magenta', 'fuchsia', 'indigo',
])

/** the colour families a chat line names, in order — "last time he wore white" → ['white']. */
export function familiesIn(text: string): Family[] {
  const out: Family[] = []
  for (const w of text.toLowerCase().split(/[^a-z]+/)) {
    if (!w || (!FAMILY_SET.has(w) && !CHAT_SYNONYMS.has(w))) continue
    const f = wordFamily(w)
    if (f && !out.includes(f)) out.push(f)
  }
  return out
}
