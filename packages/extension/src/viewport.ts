// Viewport crop — maps the game's 16:9 render area onto the Twitch player.
//
// The companion reports card positions as fractions of a full 1920x1080 game
// frame (0..1). That is only correct when the game fills the whole stream — a
// fullscreen 16:9 capture. When the broadcaster runs windowed, letterboxed, or
// cropped in OBS, the game occupies a *sub-rectangle* of the video, so every
// reported position is shifted and scaled.
//
// A Crop is that sub-rectangle, expressed in the same normalized player space:
// where the game's frame sits and how much of the player it fills. The
// broadcaster sets it once (extension config); the overlay applies it to every
// slot before painting. Default is identity — the whole player — so existing
// fullscreen streamers are completely unaffected.
//
// Both the player and the game render are 16:9, so a 16:9 sub-rectangle has the
// SAME width- and height-fraction in normalized space (see CLAUDE note in the
// config calibrator). That is why one `scale` covers both axes: cropW == cropH.

export interface Crop {
  x: number // left edge of the game area, fraction of player width [0..1]
  y: number // top edge, fraction of player height [0..1]
  scale: number // size of the game area, fraction of player (0..1], equal on both axes
}

export const IDENTITY_CROP: Crop = { x: 0, y: 0, scale: 1 }

// Below this the box is unusably small to calibrate and would collapse the
// overlay onto a few pixels — treat as a mistake and refuse it.
const MIN_SCALE = 0.05
const EPS = 1e-6

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

export function isIdentityCrop(c: Crop): boolean {
  return c.x === 0 && c.y === 0 && c.scale === 1
}

// A crop is valid only if the game rectangle sits fully inside the player. A box
// that pokes past an edge would push slots off-screen, so we reject rather than
// silently clamp — the config UI never produces one, and a corrupt stored value
// should fall back to identity, not to a lopsided guess.
export function isValidCrop(c: unknown): c is Crop {
  if (!c || typeof c !== 'object') return false
  const o = c as Record<string, unknown>
  if (!finite(o.x) || !finite(o.y) || !finite(o.scale)) return false
  if (o.scale < MIN_SCALE || o.scale > 1) return false
  if (o.x < 0 || o.y < 0) return false
  if (o.x + o.scale > 1 + EPS || o.y + o.scale > 1 + EPS) return false
  return true
}

// Coerce a rough crop (e.g. mid-drag in the calibrator) into a valid one. Keeps
// the box on-stage and the scale sane. Never throws.
export function clampCrop(c: Partial<Crop>): Crop {
  const scale = finite(c.scale) ? Math.min(1, Math.max(MIN_SCALE, c.scale)) : 1
  const x = finite(c.x) ? Math.min(1 - scale, Math.max(0, c.x)) : 0
  const y = finite(c.y) ? Math.min(1 - scale, Math.max(0, c.y)) : 0
  return { x, y, scale }
}

// Parse a stored crop (Twitch config content, a JSON string or already-parsed
// object). Anything malformed, out of range, or absent → identity. This is the
// single failure-safe boundary: the overlay trusts whatever this returns.
export function parseCrop(raw: unknown): Crop {
  let obj: unknown = raw
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (!s) return IDENTITY_CROP
    try { obj = JSON.parse(s) } catch { return IDENTITY_CROP }
  }
  if (!obj || typeof obj !== 'object') return IDENTITY_CROP
  const o = obj as Record<string, unknown>
  const c = { x: o.x, y: o.y, scale: o.scale }
  return isValidCrop(c) ? (c as Crop) : IDENTITY_CROP
}

// Serialize for storage. Rounded to keep the payload tiny and stable — sub-0.1%
// precision is below what anyone can calibrate by eye anyway.
export function serializeCrop(c: Crop): string {
  const r = (n: number) => Math.round(n * 1e4) / 1e4
  return JSON.stringify({ v: 1, x: r(c.x), y: r(c.y), scale: r(c.scale) })
}

interface Rect { x: number; y: number; w: number; h: number }

// Remap a slot from full-frame space into the cropped game area. Identity crop
// returns the slot untouched (same reference), so the whole feature is a no-op
// for fullscreen streamers — zero allocation, zero behavior change.
export function applyCrop<T extends Rect>(slot: T, c: Crop): T {
  if (isIdentityCrop(c)) return slot
  return {
    ...slot,
    x: c.x + slot.x * c.scale,
    y: c.y + slot.y * c.scale,
    w: slot.w * c.scale,
    h: slot.h * c.scale,
  }
}
