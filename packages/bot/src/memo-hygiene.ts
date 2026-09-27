// a memo is what makes the bot useful to someone, never a file on how they treat it.
// "disputes memo accuracy", "repeats song requests to see if I'll catch it", "spam
// emotes" sat in memos and came straight back as dunks ("take it up with past you",
// "the paper trail says otherwise"). the prompt already says context is not ammo; the
// memo writer kept producing it, so the clause is removed rather than argued with.
const META_TRAIT = new RegExp(
  [
    '\\bdisput\\w*',
    '\\b(?:tests?|testing|checks?|checking)\\s+(?:me|the bot|if i|whether i|boundaries|my)\\b',
    '\\bto see if i\\b',
    '\\bpush(?:es|ing)? back\\b',
    '\\bargu\\w*\\s+with\\b',
    '\\bcorrects?\\s+me\\b',
    '\\bcalls?\\s+me\\s+out\\b',
    '\\bspam\\w*',
    '\\brepeat\\w*\\b(?=[^;,]{0,30}\\b(?:requests?|questions?|asks?|to see)\\b)',
    '\\bpattern repeating\\b',
    '\\b(?:asks?|asked|asking)\\s+(?:the same|again|repeatedly)\\b',
  ].join('|'),
  'i',
)

// split on , and ; at the top level only: a comma inside parens or quotes belongs to its
// clause ("music videos (late 90s, current)", 'calls things "unf," ...')
function clauses(memo: string): { text: string; sep: string }[] {
  const out: { text: string; sep: string }[] = []
  let depth = 0, quoted = false, start = 0
  for (let i = 0; i < memo.length; i++) {
    const c = memo[i]
    if (c === '"' || c === '“' || c === '”') quoted = !quoted
    else if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if ((c === ',' || c === ';') && !depth && !quoted) {
      out.push({ text: memo.slice(start, i).trim(), sep: c })
      start = i + 1
    }
  }
  out.push({ text: memo.slice(start).trim(), sep: '' })
  return out
}

export function stripMetaTraits(memo: string): string {
  const parts = clauses(memo)
  const kept = parts.filter((p) => p.text && !META_TRAIT.test(p.text))
  // untouched memos come back byte-identical
  if (kept.length === parts.filter((p) => p.text).length) return memo
  const out = kept.map((p, i) => p.text + (i < kept.length - 1 ? (p.sep === ';' ? '; ' : ', ') : '')).join('').replace(/[\s;,]+$/, '')
  if (!out) return ''
  // a dropped trailing clause took the full stop with it
  return /[.!?]$/.test(out) || !/[.!?]$/.test(memo.trim()) ? out : out + '.'
}
