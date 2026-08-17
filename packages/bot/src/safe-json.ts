// Zero-dependency on purpose: emote-describe.ts keeps a db-free static import graph so it
// can run from the scraper CLI, and ai-http.ts (where these are used most) pulls in the db.
// Splitting the two pure string helpers out lets both share one implementation.

// strip orphan UTF-16 surrogate halves — twitch chat / 7TV emote names occasionally inject
// lone D800-DBFF or DC00-DFFF code units. Anthropic's JSON parser rejects them with
// "no low surrogate in string", which reads as a mystery API failure at the call site.
export function stripUnpairedSurrogates(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
}

// JSON.stringify that scrubs orphan surrogates from every string field. A bare regex over
// the stringified output can't see them — by then they are encoded as \uXXXX text.
export function safeStringify(body: unknown): string {
  return JSON.stringify(body, (_k, v) => (typeof v === 'string' ? stripUnpairedSurrogates(v) : v))
}
