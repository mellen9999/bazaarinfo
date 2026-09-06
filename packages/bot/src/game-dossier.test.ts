import { describe, it, expect, beforeEach } from 'bun:test'
import {
  isGameCategory, isUngroundedGame, canonicalGameName, pickSteamHit,
  formatGameDossier, getGameDossierLine, __setGameDossierForTest, type GameDossier,
} from './game-dossier'

const diablo: GameDossier = {
  name: 'Diablo IV', fetchedAt: Date.now(), newsAt: Date.now(), steamId: 2344520,
  blurb: 'Join the fight for Sanctuary in Diablo IV, the ultimate action RPG adventure.',
  genres: ['action', 'rpg'], devs: ['Blizzard Entertainment'], released: '17 Oct, 2023', price: '$49.99', metacritic: 86,
  news: [{ title: 'Season 10 patch notes', date: 'Sep 2' }, { title: 'Hotfix 2.4.1', date: 'Aug 29' }],
  source: 'steam',
}

describe('game-dossier', () => {
  beforeEach(() => __setGameDossierForTest(null))

  it('a twitch category is a game unless it is a non-game category', () => {
    expect(isGameCategory('Diablo IV')).toBe(true)
    expect(isGameCategory('Just Chatting')).toBe(false)
    expect(isGameCategory('Games + Demos')).toBe(false)
    expect(isGameCategory('')).toBe(false)
    expect(isGameCategory(undefined)).toBe(false)
  })

  it('the three games with their own data are never dossiered', () => {
    expect(isUngroundedGame('The Bazaar')).toBe(false)
    expect(isUngroundedGame('Hearthstone')).toBe(false)
    expect(isUngroundedGame('Guildrun')).toBe(false)
    expect(isUngroundedGame('Guild Run')).toBe(false)
    expect(isUngroundedGame('Path of Exile 2')).toBe(true)
    expect(isUngroundedGame('Just Chatting')).toBe(false)
  })

  it('chat short forms map to the searchable title', () => {
    expect(canonicalGameName('poe')).toBe('Path of Exile')
    expect(canonicalGameName('D4')).toBe('Diablo IV')
    expect(canonicalGameName('bg3')).toBe("Baldur's Gate 3")
    expect(canonicalGameName('Elden Ring')).toBe('Elden Ring')
  })

  it('picks the store hit that IS the title, never a soundtrack or dlc', () => {
    const items = [
      { type: 'app', id: 1, name: 'Diablo IV Soundtrack' },
      { type: 'app', id: 2, name: 'Diablo IV: Vessel of Hatred' },
      { type: 'app', id: 3, name: 'Diablo IV' },
    ]
    expect(pickSteamHit('Diablo IV', items)?.id).toBe(3)
    expect(pickSteamHit('diablo iv', items)?.id).toBe(3)
    expect(pickSteamHit('Hades II', [{ type: 'app', id: 9, name: 'Hades II Soundtrack' }])).toBeNull()
    expect(pickSteamHit('Hades II', [{ type: 'app', id: 9, name: 'Hades II: Nocturne Edition' }])?.id).toBe(9)
    expect(pickSteamHit('Hades', [{ type: 'app', id: 9, name: 'Hades II' }])?.id).toBe(9)
  })

  it('formats a compact anchor line with meta, blurb and news', () => {
    const line = formatGameDossier(diablo, 'on stream')
    expect(line.startsWith('Game on stream: Diablo IV (action/rpg; Blizzard Entertainment; 17 Oct, 2023; $49.99; metacritic 86)')).toBe(true)
    expect(line).toContain('Join the fight for Sanctuary')
    expect(line).toContain('steam news: "Season 10 patch notes" (Sep 2); "Hotfix 2.4.1" (Aug 29)')
    expect(line.length).toBeLessThanOrEqual(520)
  })

  it('a wiki-only dossier still formats, without empty parens', () => {
    const line = formatGameDossier({ ...diablo, steamId: undefined, genres: [], devs: [], released: '', price: '', metacritic: undefined, news: [], source: 'wiki' }, 'asked about')
    expect(line.startsWith('Game asked about: Diablo IV — Join')).toBe(true)
    expect(line).not.toContain('()')
    expect(line).not.toContain('steam news')
  })

  it('reads the cache by canonical name and hides a negative-cache miss', () => {
    __setGameDossierForTest({
      'Diablo IV': diablo,
      'Nothing Game': { ...diablo, name: 'Nothing Game', source: 'none', blurb: '' },
    })
    expect(getGameDossierLine('d4', 'on stream')).toContain('Diablo IV')
    expect(getGameDossierLine('DIABLO IV', 'on stream')).toContain('Diablo IV')
    expect(getGameDossierLine('Nothing Game', 'on stream')).toBe('')
    expect(getGameDossierLine('unknown', 'on stream')).toBe('')
    expect(getGameDossierLine(undefined, 'on stream')).toBe('')
  })
})

// the section actually lands in the built user message: on-stream game when the channel
// is live on an ungrounded title, a named title on demand, never for the bazaar itself.
import { beforeAll } from 'bun:test'
import { initDb } from './db'
import { buildUserMessage } from './ai-build'
import { loadStore } from './store'
import { markLiveStateKnown, setChannelLive, setChannelOffline } from './ai-cache'

describe('gameNow section', () => {
  beforeAll(async () => { initDb(':memory:'); await loadStore() })
  beforeEach(() => {
    __setGameDossierForTest({ 'Diablo IV': diablo, 'Elden Ring': { ...diablo, name: 'Elden Ring', steamId: 1245620 } })
    markLiveStateKnown()
  })

  it('the on-stream game rides in while live on it, and drops when the stream ends', () => {
    setChannelLive('dossier-ch', 'Diablo IV')
    const live = buildUserMessage('is this game any good', { user: 'alice', channel: 'dossier-ch' } as any)
    expect(live.text).toContain('Game on stream: Diablo IV')
    expect(live.contextSections.some((s) => s.name === 'gameNow')).toBe(true)
    setChannelOffline('dossier-ch')
    const off = buildUserMessage('is this game any good', { user: 'alice', channel: 'dossier-ch' } as any)
    expect(off.text).not.toContain('Game on stream')
  })

  it('a named title gets its own dossier, and is not doubled when it is the live game', () => {
    setChannelLive('dossier-ch', 'Diablo IV')
    const named = buildUserMessage('is elden ring worth it', { user: 'alice', channel: 'dossier-ch' } as any)
    expect(named.text).toContain('Game on stream: Diablo IV')
    expect(named.text).toContain('Game asked about: Elden Ring')
    const same = buildUserMessage('is d4 worth it', { user: 'alice', channel: 'dossier-ch' } as any)
    expect(same.text.match(/Diablo IV/g)!.length).toBeGreaterThan(0)
    expect(same.text).not.toContain('Game asked about')
  })

  it('the bazaar on stream never gets a dossier line', () => {
    setChannelLive('dossier-ch', 'The Bazaar')
    const r = buildUserMessage('is this game any good', { user: 'alice', channel: 'dossier-ch' } as any)
    expect(r.text).not.toContain('Game on stream')
  })
})
