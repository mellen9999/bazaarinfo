// Twitch Extension JWT verification (HS256)
// See: https://dev.twitch.tv/docs/extensions/reference/#jwt-schema

const EXTENSION_SECRET = process.env.TWITCH_EXTENSION_SECRET ?? ''
const COMPANION_SECRET = process.env.COMPANION_SECRET ?? ''

if (!EXTENSION_SECRET) {
  console.error('[auth] TWITCH_EXTENSION_SECRET is not set — refusing to start')
  process.exit(1)
}
if (!COMPANION_SECRET) {
  console.error('[auth] COMPANION_SECRET is not set — refusing to start')
  process.exit(1)
}

// Cache imported crypto keys to avoid per-request importKey overhead
let verifyKeyCache: CryptoKey | null = null
let signKeyCache: CryptoKey | null = null

interface TwitchJwtPayload {
  exp: number
  opaque_user_id: string
  channel_id: string
  role: string
  pubsub_perms?: { send?: string[] }
}

function base64UrlDecode(str: string): ArrayBuffer {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer as ArrayBuffer
}

async function getVerifyKey(secret: string): Promise<CryptoKey> {
  if (verifyKeyCache) return verifyKeyCache
  const secretBytes = base64UrlDecode(secret)
  verifyKeyCache = await crypto.subtle.importKey(
    'raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
  )
  return verifyKeyCache
}

async function hmacVerify(token: string, secret: string): Promise<TwitchJwtPayload | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  const key = await getVerifyKey(secret)

  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  const signature = base64UrlDecode(parts[2])
  const valid = await crypto.subtle.verify('HMAC', key, signature, data)
  if (!valid) return null

  const payload = JSON.parse(new TextDecoder().decode(new Uint8Array(base64UrlDecode(parts[1]))))
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null

  return payload as TwitchJwtPayload
}

export async function verifyTwitchJwt(authHeader: string | null): Promise<TwitchJwtPayload | null> {
  if (!authHeader?.startsWith('Bearer ')) return null
  if (!EXTENSION_SECRET) return null
  return hmacVerify(authHeader.slice(7), EXTENSION_SECRET)
}

export function verifyCompanionSecret(secret: string): boolean {
  if (!COMPANION_SECRET) return false
  const a = new TextEncoder().encode(secret)
  const b = new TextEncoder().encode(COMPANION_SECRET)
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

export function createServerJwt(channelId: string): Promise<string> {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  const payload = btoa(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 60,
    channel_id: channelId,
    role: 'external',
    pubsub_perms: { send: ['broadcast'] },
  })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  return signJwt(`${header}.${payload}`)
}

async function getSignKey(): Promise<CryptoKey> {
  if (signKeyCache) return signKeyCache
  const secretBytes = base64UrlDecode(EXTENSION_SECRET)
  signKeyCache = await crypto.subtle.importKey(
    'raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  return signKeyCache
}

async function signJwt(headerPayload: string): Promise<string> {
  const key = await getSignKey()
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(headerPayload))
  const sigStr = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${headerPayload}.${sigStr}`
}
