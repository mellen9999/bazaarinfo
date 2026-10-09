// POST /companion/link — one-click companion setup.
//
// The companion signs the streamer in with twitch's device-code flow (a public
// client: no secret ships in the exe) and hands us the resulting access token.
// Twitch tells us whose token it is; that user id IS the channel id, so we
// return the channel's derived companion secret. The token is revoked straight
// after and nothing is stored — the secret is derived, never kept.

// public client id of the "bazaarinfo companion" twitch app. not a secret: it
// ships in the companion too (logwatch.py TWITCH_CLIENT_ID) and must match it.
export const COMPANION_CLIENT_ID = 'o36v0i410neguati8o1jbkbwbnod0b'

const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate'
const REVOKE_URL = 'https://id.twitch.tv/oauth2/revoke'
const TIMEOUT_MS = 10_000
// twitch access tokens are 30 lowercase alnum chars; allow headroom, nothing else
const TOKEN_RE = /^[a-z0-9]{20,64}$/

interface Deps {
  derive: (channelId: string) => string
  fetch?: typeof fetch
  clientId?: string
}

function fail(status: number, error: string): Response {
  return Response.json({ error }, { status })
}

export async function handleLink(req: Request, deps: Deps): Promise<Response> {
  const doFetch = deps.fetch ?? fetch
  const clientId = deps.clientId ?? COMPANION_CLIENT_ID

  let token: unknown
  try {
    token = ((await req.json()) as { token?: unknown })?.token
  } catch {
    return fail(400, 'bad request')
  }
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return fail(400, 'bad request')

  let res: Response
  try {
    res = await doFetch(VALIDATE_URL, {
      headers: { Authorization: `OAuth ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    return fail(502, 'twitch did not answer, try again')
  }
  if (res.status === 401) return fail(401, 'twitch sign-in expired, try again')
  if (!res.ok) return fail(502, 'twitch did not answer, try again')

  let info: { client_id?: unknown; user_id?: unknown; login?: unknown }
  try {
    info = await res.json()
  } catch {
    return fail(502, 'twitch did not answer, try again')
  }

  // a token minted for any other app proves nothing about intent to link
  if (info.client_id !== clientId) return fail(403, 'wrong app')
  const channelId = info.user_id
  if (typeof channelId !== 'string' || !/^\d{1,20}$/.test(channelId)) return fail(502, 'twitch did not answer, try again')
  const login = typeof info.login === 'string' ? info.login : ''

  // best-effort: the token is useless to anyone after this, and expires in 4h regardless
  doFetch(REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, token }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => {})

  console.log(`[ebs] companion linked for channel ${channelId}`)
  return Response.json({ channelId, login, secret: deps.derive(channelId) })
}
