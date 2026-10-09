// Gives the whole tree the viewer's language. One provider per view (overlay, panel):
// it follows Twitch's context language, fetches that language's strings once per page
// and swaps them in. Anything that goes wrong leaves English on screen — translation
// is a courtesy and must never cost a viewer the card.
import { createContext } from 'preact'
import { useContext, useEffect, useRef, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { CARD_FETCH_BACKOFF, fetchI18nLangs, fetchI18nMap } from './twitch'
import { ENGLISH, makeI18n, resolveLang, type I18n } from './i18n'

const Ctx = createContext<I18n>(ENGLISH)
export const useI18n = () => useContext(Ctx)

// Memoised per page (the browser's ETag covers the rest). A failed attempt is not
// kept, so the next language change or remount may try again.
let langs: Promise<string[]> | null = null
const maps = new Map<string, Promise<Record<string, string>>>()

async function withBackoff<T>(run: () => Promise<T>): Promise<T> {
  let err: unknown
  for (const wait of CARD_FETCH_BACKOFF) {
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    try { return await run() } catch (e) { err = e }
  }
  throw err
}

function loadMap(token: string, twitchLang: string): Promise<I18n> {
  langs ??= withBackoff(() => fetchI18nLangs(token)).catch((e) => { langs = null; throw e })
  return langs.then(async (available) => {
    const lang = resolveLang(twitchLang, available)
    if (!lang) return ENGLISH
    let m = maps.get(lang)
    if (!m) {
      m = withBackoff(() => fetchI18nMap(token, lang))
      maps.set(lang, m)
      m.catch(() => maps.delete(lang))
    }
    return makeI18n(lang, await m)
  })
}

export function I18nProvider({ children }: { children: ComponentChildren }) {
  const [twitchLang, setTwitchLang] = useState<string | undefined>()
  const [token, setToken] = useState<string | null>(null)
  const [i18n, setI18n] = useState<I18n>(ENGLISH)
  const tokenRef = useRef<string | null>(null)

  useEffect(() => {
    const ext = window.Twitch?.ext
    // Twitch re-fires onAuthorized hourly; only the first token starts anything
    ext?.onAuthorized((auth) => { tokenRef.current ??= auth.token; setToken(tokenRef.current) })
    ext?.onContext?.((ctx) => setTwitchLang(ctx?.language))
  }, [])

  useEffect(() => {
    // English never fetches; until both are known there is nothing to ask for
    if (!token || !twitchLang || twitchLang.toLowerCase().startsWith('en')) {
      setI18n(ENGLISH)
      return
    }
    let live = true
    loadMap(token, twitchLang).then((v) => { if (live) setI18n(v) }).catch((e) => {
      console.error('bazaarinfo: translations unavailable', e)
      if (live) setI18n(ENGLISH)
    })
    return () => { live = false }
  }, [token, twitchLang])

  return <Ctx.Provider value={i18n}>{children}</Ctx.Provider>
}
