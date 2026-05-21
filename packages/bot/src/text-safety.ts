// Zero-dependency text-safety primitives. Single source of truth shared by
// ai-sanitize (model output) and twitch.say (every outgoing message) so the two
// layers can never drift on what counts as a command-trigger character.
//
// Patterns are built from numeric code points (not literal glyphs / escapes) so
// this file stays pure-ASCII and unambiguous about exactly which chars it folds.

const cc = String.fromCharCode
const span = (a: number, b: number) => cc(a) + '-' + cc(b)
const set = (...codes: number[]) => '[' + codes.map((c) => cc(c)).join('') + ']'

// invisible format chars that bypass \b boundaries and leading-command detection:
// zero-width space/joiners (200B-200F), line/para seps + bidi (2028-202F), BOM (FEFF), soft hyphen (00AD)
const INVISIBLE = new RegExp('[' + span(0x200b, 0x200f) + span(0x2028, 0x202f) + cc(0xfeff) + cc(0x00ad) + ']', 'g')

// smart quotes the model emits -> ascii (so ' and " regex patterns match downstream)
const SMART_SINGLE = new RegExp(set(0x2018, 0x2019), 'g')
const SMART_DOUBLE = new RegExp(set(0x201c, 0x201d), 'g')

// homoglyph / lookalike command prefixes -> ascii. fullwidth ! / \ and friends.
const HOMO_BANG = new RegExp(set(0xff01, 0x01c3, 0x2757), 'g')  // !
const HOMO_SLASH = new RegExp(set(0xff0f, 0x2044, 0x2215), 'g') // /
const HOMO_BACK = new RegExp(set(0xff3c), 'g')                  // \

// strip invisibles and fold lookalike punctuation to ascii. run before any
// command-prefix check so homoglyph/zero-width injection can't slip through.
export function normalizeText(text: string): string {
  return text
    .replace(INVISIBLE, '')
    .replace(SMART_SINGLE, "'")
    .replace(SMART_DOUBLE, '"')
    .replace(HOMO_BANG, '!')
    .replace(HOMO_SLASH, '/')
    .replace(HOMO_BACK, '\\')
}

// strip any leading command trigger so an outgoing message can never start a
// twitch native (/ .) or third-party mod-bot (! \) command on the bot itself.
// also peels quotes/whitespace wrapping the command. expects normalized input.
export function stripLeadingCommands(text: string): string {
  let s = text
  if (/^["'`\s]+[!\\/.]/.test(s)) s = s.replace(/^["'`\s]+/, '')
  return s.replace(/^[!\\/.\s]+/, '')
}

// full outgoing-message guard: normalize, then strip leading commands.
export function stripOutgoingCommands(text: string): string {
  return stripLeadingCommands(normalizeText(text))
}
