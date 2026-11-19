// every model the bot calls, in one place. `smart` writes chat replies, trivia, directives and
// dungeon archetypes; `fast` runs the cheap text jobs (summaries, memos, facts, channel voice,
// trivia side lenses); `vision` reads images (shirt colour off the cam, emote descriptions).
// AI_SMART_MODEL / AI_FAST_MODEL / AI_VISION_MODEL override any tier without a deploy — that
// is how a tier gets A/B'd or rolled back.
//
// 2026-11-19 A/B on real traffic: haiku 5.5 matched or beat 4.5 on memos and facts (no junk
// facts stored vs 2 in 8) at a tenth of the price, so it took the text jobs. sonnet 5.5 was
// more careful on facts but read as an assistant in chat (longer, capitalised, volunteered
// stream state and the clock), so chat stays on sonnet 5. haiku 5.5 misread a grey hoodie as
// black on cam thumbnails that 4.5 got right, so vision stays on 4.5.
export const SMART_MODEL = process.env.AI_SMART_MODEL || 'claude-sonnet-5'
export const FAST_MODEL = process.env.AI_FAST_MODEL || 'claude-haiku-5-5'
export const VISION_MODEL = process.env.AI_VISION_MODEL || 'claude-haiku-4-5-20251001'

// thinking off, spelled the way each model accepts it. sonnet 5.5 rejects 'disabled' and takes
// 'between_tools' instead (no thinking except between tool calls — chat has one search at most).
export function thinkingOff(model: string): { type: 'disabled' | 'between_tools' } {
  return model.startsWith('claude-sonnet-5-5') ? { type: 'between_tools' } : { type: 'disabled' }
}
