// every model the bot calls, in one place. `smart` writes chat replies, trivia, directives and
// dungeon archetypes; `fast` runs the cheap background jobs (summaries, memos, facts, voice,
// shirt reads, emote descriptions, trivia side lenses). AI_SMART_MODEL / AI_FAST_MODEL in the
// env override either without a deploy — that is how a tier gets A/B'd or rolled back.
export const SMART_MODEL = process.env.AI_SMART_MODEL || 'claude-sonnet-5'
export const FAST_MODEL = process.env.AI_FAST_MODEL || 'claude-haiku-4-5-20251001'

// thinking off, spelled the way each model accepts it. sonnet 5.5 rejects 'disabled' and takes
// 'between_tools' instead (no thinking except between tool calls — chat has one search at most).
export function thinkingOff(model: string): { type: 'disabled' | 'between_tools' } {
  return model.startsWith('claude-sonnet-5-5') ? { type: 'between_tools' } : { type: 'disabled' }
}
