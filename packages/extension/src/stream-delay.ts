// The streamer-declared stream delay, stored beside the crop in the one broadcaster
// config segment. Twitch's own delay reaches the overlay through the player context;
// a delay added in OBS does not, so the broadcaster states it here.
//
// One segment, one JSON object: the config service has a single writable
// 'broadcaster' segment, so every write must carry every field or it erases the
// others. serializeConfig is that one writer; parseCrop and parseDelay each read
// only their own keys, so old values without "delay" simply mean none.

import { cropFields } from './viewport'
import type { Crop } from './viewport'

export const MAX_DELAY_S = 600

// Stored seconds. Anything that is not a whole number in range — absent, corrupt,
// hand-edited — reads as no delay: holding the board back on a bad number is worse
// than showing it on time.
export function parseDelay(raw: unknown): number {
  let obj: unknown = raw
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw) } catch { return 0 }
  }
  if (!obj || typeof obj !== 'object') return 0
  const d = (obj as Record<string, unknown>).delay
  return typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= MAX_DELAY_S ? d : 0
}

// What the config field accepts: blank is 0, otherwise whole seconds in range.
// null = reject (the caller says why and refuses to save).
export function parseDelayInput(text: string): number | null {
  const t = text.trim()
  if (!t) return 0
  if (!/^\d+$/.test(t)) return null
  const n = Number(t)
  return n <= MAX_DELAY_S ? n : null
}

export function serializeConfig(crop: Crop, delay: number): string {
  return JSON.stringify({ ...cropFields(crop), delay })
}
