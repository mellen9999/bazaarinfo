// Public redirect targets for the stable URLs baked into the reviewed extension
// artifact (manifest privacy/terms links + the config page's download link).
//
// Everything the extension points at lives under this one origin on purpose: the
// destinations below can move — repo rename, GitHub → self-hosted page, new
// release host — by editing this map and redeploying the EBS. The reviewed
// artifact never changes, so none of it ever forces another Twitch review.
// If a link must change, change it HERE, not in the extension.

const REPO = 'https://github.com/mellen9999/bazaarinfo'

export const REDIRECTS: Record<string, string> = {
  '/privacy': `${REPO}/blob/master/PRIVACY.md`,
  '/terms': `${REPO}/blob/master/TERMS.md`,
  '/download': `${REPO}/releases/latest`,
}

export function redirectTarget(path: string): string | null {
  return REDIRECTS[path] ?? null
}
