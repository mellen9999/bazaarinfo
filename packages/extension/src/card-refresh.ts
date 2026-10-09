// A viewer who opened the stream before a data refresh keeps the old card list for
// the whole session. A broadcast naming a card we don't have is the signal it's
// stale; this decides whether to act on it. Throttled so a card that is simply
// absent from the data (not stale) can't turn every frame into a fetch.
export const CARD_REFRESH_MIN_MS = 10 * 60_000

export function shouldRefetch(missingTitle: boolean, lastAttemptMs: number | null, nowMs: number): boolean {
  if (!missingTitle) return false
  if (lastAttemptMs === null) return true
  // a backwards clock jump must not freeze refreshes until it catches up
  if (nowMs < lastAttemptMs) return true
  return nowMs - lastAttemptMs >= CARD_REFRESH_MIN_MS
}
