// How big the overlay's UI should be, expressed as one number.
//
// The tooltip describes cards that are painted at the *video's* scale, so it has
// to track the video the way the game's own UI does. A fixed 310px box is a third
// of a small player and a postage stamp in fullscreen; both are wrong for the same
// reason. `--ui` is that ratio, referenced to a 720-tall video — the size this
// design was drawn at — so the standard desktop player renders exactly as before
// and only a genuinely bigger video grows.
//
// It never shrinks below 1 here. Getting smaller is the content's call, not the
// viewport's (see fitScale), because a short player is a reason to fit text, not a
// reason to make every tooltip tiny.
export const UI_REFERENCE_HEIGHT = 720

// Past this the tooltip stops reading as an overlay and starts reading as a wall.
const UI_MAX = 1.75

export function uiScale(videoHeight: number): number {
  if (!Number.isFinite(videoHeight) || videoHeight <= 0) return 1
  return Math.min(UI_MAX, Math.max(1, videoHeight / UI_REFERENCE_HEIGHT))
}

// The tooltip cannot scroll: it is pointer-events:none, so a scrollbar would be
// unreachable and the clipped tail would be text the viewer never learns exists.
// So when a card's content is taller than the frame, the text shrinks until all of
// it fits instead of being cut off.
//
// Only the type shrinks — the box keeps its width — so the fit is monotone: less
// wrapping, never more, which means one pass always lands. The floor stops a
// pathological frame from shrinking the tooltip into unreadability; past it,
// legible-and-clipped beats complete-and-invisible.
const FIT_MIN = 0.7

export function fitScale(base: number, naturalHeight: number, available: number): number {
  if (!Number.isFinite(base) || base <= 0) return 1
  if (!Number.isFinite(naturalHeight) || naturalHeight <= 0) return base
  if (!Number.isFinite(available) || available <= 0) return base
  if (naturalHeight <= available) return base
  return Math.max(FIT_MIN, base * (available / naturalHeight))
}
