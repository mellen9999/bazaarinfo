// Card text in the viewer's language, as plain data. The EBS serves one
// english-string -> translated-string map per language; everything here is a pure
// function of that map, so each rule is testable without a network or a DOM.
import { localizedTokenizer, tokenizeKeywords, type Tokenizer } from './keywords'

export interface I18n {
  // '' = English: nothing was fetched and nothing is translated
  lang: string
  // translated, or the English string back: a miss is never a hole
  t: (english: string) => string
  // a UI word the overlay prints lowercase, in the viewer's language
  word: (english: string) => string
  // whether the map has this string — for labels that keep English when it doesn't
  has: (english: string) => boolean
  tokenize: Tokenizer
}

export const ENGLISH: I18n = {
  lang: '',
  t: (s) => s,
  word: (s) => s.toLowerCase(),
  has: () => false,
  tokenize: tokenizeKeywords,
}

// Twitch hands over "fr", "pt-br", "zh-cn"; the EBS speaks two-letter codes. Null =
// English: not offered, not a language we hold, or English itself.
export function resolveLang(twitchLang: string | undefined, available: readonly string[]): string | null {
  const base = twitchLang?.toLowerCase().split(/[-_]/)[0]
  if (!base || base === 'en') return null
  return available.includes(base) ? base : null
}

export function makeI18n(lang: string, map: Record<string, string>): I18n {
  const own = (s: string): string | undefined => (Object.hasOwn(map, s) ? map[s] : undefined)
  const t = (s: string) => own(s) ?? s
  return {
    lang,
    t,
    // lowercase in the language's own rules (Turkish İ/ı); scripts without case pass through
    word: (s) => t(s).toLocaleLowerCase(lang),
    has: (s) => own(s) !== undefined,
    tokenize: localizedTokenizer(own, lang),
  }
}
