import { homedir } from 'os'
import { resolve } from 'path'
import { log } from './log'
import { writeAtomic } from './fs-util'

const TOKEN_PATH = resolve(homedir(), '.bazaarinfo-tokens.json')
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate'
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token'
const FETCH_TIMEOUT = 10_000

interface TokenStore {
  accessToken: string
  refreshToken: string
}

let tokens: TokenStore | null = null

async function loadTokens(): Promise<TokenStore> {
  try {
    return await Bun.file(TOKEN_PATH).json()
  } catch {
    const accessToken = process.env.TWITCH_TOKEN?.replace(/^oauth:/, '') ?? ''
    const refreshToken = process.env.TWITCH_REFRESH_TOKEN ?? ''
    if (!accessToken || !refreshToken) {
      throw new Error('no token store and missing TWITCH_TOKEN / TWITCH_REFRESH_TOKEN env')
    }
    const store = { accessToken, refreshToken }
    await saveTokens(store)
    return store
  }
}

async function saveTokens(store: TokenStore) {
  await writeAtomic(TOKEN_PATH, JSON.stringify(store, null, 2))
}

async function validate(accessToken: string): Promise<number> {
  try {
    const res = await fetch(VALIDATE_URL, {
      headers: { Authorization: `OAuth ${accessToken}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    })
    if (!res.ok) return 0
    const data = (await res.json()) as { expires_in: number }
    return data.expires_in
  } catch (e) {
    log('token validation failed:', e)
    return 0
  }
}

export async function refreshToken(clientId: string, clientSecret: string): Promise<string> {
  if (!tokens) tokens = await loadTokens()

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`token refresh failed: ${res.status} ${err}`)
  }

  const data = (await res.json()) as { access_token: string; refresh_token: string }
  tokens = { accessToken: data.access_token, refreshToken: data.refresh_token }
  await saveTokens(tokens)
  log('token refreshed')
  return tokens.accessToken
}

export async function ensureValidToken(clientId: string, clientSecret: string): Promise<string> {
  if (!tokens) tokens = await loadTokens()

  const remaining = await validate(tokens.accessToken)
  if (remaining > 600) {
    log(`token valid, ${remaining}s remaining`)
    return tokens.accessToken
  }

  log('token expired or expiring soon, refreshing...')
  return refreshToken(clientId, clientSecret)
}

export function getAccessToken(): string {
  if (!tokens) throw new Error('tokens not loaded — call ensureValidToken first')
  return tokens.accessToken
}
