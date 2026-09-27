import { describe, expect, it } from 'bun:test'

import * as db from './db'

// the panel and chat share one action layer — a pause from the web must be the same
// pause chat sees, and nothing untrusted gets past parseAction.
db.initDb(':memory:')
;(await import('./raid/state')).setDb(db.getDb())
;(await import('./dungeon')).initDungeonDb()
const { act, parseAction, describe: say, snapshot, fmtMins, onControlChange, ADMIN_KINDS } = await import('./control')
const { isSuppressed } = await import('./suppress')
const { isMuted, addDirective, listDirectives } = await import('./directives')

describe('control actions', () => {
  it('pause/resume land in the same suppress state chat reads', async () => {
    expect((await act('ctl', 'mod1', { kind: 'pause', feature: 'trivia', minutes: 30 }, false)).ok).toBe(true)
    expect(isSuppressed('ctl', 'trivia')).toBe(true)
    expect((await act('ctl', 'mod1', { kind: 'resume', feature: 'trivia' }, false)).ok).toBe(true)
    expect(isSuppressed('ctl', 'trivia')).toBe(false)
    expect((await act('ctl', 'mod1', { kind: 'resume', feature: 'trivia' }, false)).ok).toBe(false)
  })

  it('ignore bites through the chat mute gate', async () => {
    await act('ctl', 'mod1', { kind: 'ignore', user: 'baiter' }, false)
    expect(isMuted('ctl', 'baiter', true)).toBe(true)
    await act('ctl', 'mod1', { kind: 'unignore', user: 'baiter' }, false)
    expect(isMuted('ctl', 'baiter', true)).toBe(false)
  })

  it('drops a vibe by its listed number', async () => {
    addDirective('ctl', 'v', { instruction: 'talk like a pirate' })
    expect((await act('ctl', 'mod1', { kind: 'vibe-drop', index: 1 }, false)).ok).toBe(true)
    expect(listDirectives('ctl')).toHaveLength(0)
  })

  it('notifies listeners only on a real change', async () => {
    const seen: string[] = []
    const off = onControlChange((ch) => seen.push(ch))
    await act('ctl', 'mod1', { kind: 'vibe-clear' }, false) // nothing to clear → not ok
    await act('ctl', 'mod1', { kind: 'raid-pace', pace: 'slow' }, false)
    off()
    expect(seen).toEqual(['ctl'])
  })
})

describe('parseAction (untrusted input)', () => {
  it('accepts well-formed actions', () => {
    expect(parseAction({ kind: 'pause', feature: 'ai', minutes: 60 })).toEqual({ kind: 'pause', feature: 'ai', minutes: 60 })
    expect(parseAction({ kind: 'ignore', user: '@Troll' })).toEqual({ kind: 'ignore', user: 'troll' })
    expect(parseAction({ kind: 'join', target: '#SomeChan' })).toEqual({ kind: 'join', target: 'somechan' })
  })

  it('rejects junk, out-of-range and smuggled lines', () => {
    for (const bad of [
      null, 'pause', {}, { kind: 'nope' },
      { kind: 'pause', feature: 'everything' },
      { kind: 'pause', feature: 'ai', minutes: 0 },
      { kind: 'pause', feature: 'ai', minutes: 1.5 },
      { kind: 'pause', feature: 'ai', minutes: 99999 },
      { kind: 'vibe-drop', index: '1' },
      { kind: 'say', text: 'hi\r\nPRIVMSG #x :pwned' },
      { kind: 'say', text: 'x'.repeat(451) },
      { kind: 'ignore', user: 'two words' },
      { kind: 'join', target: '../etc' },
      { kind: 'raid', on: 'yes' },
    ]) expect(parseAction(bad)).toBeNull()
  })

  it('previews read like a person wrote them', () => {
    expect(say({ kind: 'ignore', user: 'x', minutes: 1440 })).toBe('ignore @x for 1d')
    expect(say({ kind: 'ignore', user: 'x' })).toBe('ignore @x until lifted')
    expect([fmtMins(90), fmtMins(120), fmtMins(10080)]).toEqual(['90m', '2h', '7d'])
  })
})

describe('snapshot', () => {
  it('is json-safe and carries no trivia answer field', () => {
    const snap = snapshot('ctl')
    const json = JSON.stringify(snap)
    expect(json).not.toMatch(/"answer"|"accepted"/)
    expect(snap.raid.pace).toBe('slow')
  })

  it('carries the new read-only fields, all json-safe', () => {
    const snap = snapshot('ctl')
    expect(Array.isArray(snap.spark)).toBe(true)
    expect(snap.spark).toHaveLength(60)
    expect(typeof snap.goals).toBe('boolean')
    expect(snap.health).toBeNull() // no health provider injected in tests
    expect(snap.ai.queueMax).toBeGreaterThan(0)
    expect(snap.ai.hardStopUntil).toBeNull()
    expect(Array.isArray(snap.misses)).toBe(true)
    expect(Array.isArray(snap.topUsers)).toBe(true)
    expect(Array.isArray(snap.timedOut)).toBe(true)
  })
})

describe('new panel actions', () => {
  it('goals toggles the world cup announcer switch and shows up in the snapshot', async () => {
    const wc = await import('./worldcup-goals')
    expect(wc.isGoalsEnabled('goalschan')).toBe(true) // default on
    expect((await act('goalschan', 'mod1', { kind: 'goals', on: false }, false)).ok).toBe(true)
    expect(wc.isGoalsEnabled('goalschan')).toBe(false)
    expect(snapshot('goalschan').goals).toBe(false)
    expect((await act('goalschan', 'mod1', { kind: 'goals', on: true }, false)).ok).toBe(true)
    expect(wc.isGoalsEnabled('goalschan')).toBe(true)
  })

  it('cap-reset zeroes one user\'s ai budget for today, and no one else\'s', async () => {
    const ai = await import('./ai-cache')
    ai.noteUserAiRequest('capuser', 5)
    ai.noteUserAiRequest('bystander', 5)
    expect(db.getUserAiUnits('capuser')).toBe(5)
    expect(parseAction({ kind: 'cap-reset', user: 'two words' })).toBeNull()
    expect(parseAction({ kind: 'cap-reset', user: '@CapUser' })).toEqual({ kind: 'cap-reset', user: 'capuser' })
    expect((await act('ctl', 'mod1', { kind: 'cap-reset', user: 'capuser' }, false)).ok).toBe(true)
    expect(db.getUserAiUnits('capuser')).toBe(0)
    expect(db.getUserAiUnits('bystander')).toBe(5)
  })

  it('ai-trivia is ADMIN_KINDS-gated and flips the persisted global override', async () => {
    expect(ADMIN_KINDS.has('ai-trivia')).toBe(true)
    const ai = await import('./ai-cache')
    expect((await act('ctl', 'owner', { kind: 'ai-trivia', on: true }, false)).ok).toBe(true)
    expect(ai.aiTriviaEnabled()).toBe(true)
    expect(snapshot('ctl').ai.aiTrivia).toBe(true)
    expect((await act('ctl', 'owner', { kind: 'ai-trivia', on: false }, false)).ok).toBe(true)
    expect(ai.aiTriviaEnabled()).toBe(false)
  })

  it('ask-purge deletes a row only within the acting channel, and evicts it from the voice-example cache', async () => {
    const raw = db.getDb()
    raw.run(`INSERT INTO users (username) VALUES ('purgeasker')`)
    const uid = (raw.query(`SELECT id FROM users WHERE username = 'purgeasker'`).get() as { id: number }).id
    raw.run(`INSERT INTO ask_queries (user_id, channel, query, response) VALUES (?, 'purgechan', 'bad q', 'a bad reply')`, [uid])
    const id = (raw.query(`SELECT id FROM ask_queries WHERE query = 'bad q'`).get() as { id: number }).id
    const ai = await import('./ai-cache')
    ai.cacheExchange('purgeasker', 'bad q', 'a bad reply', 'purgechan')
    expect(ai.getChannelRecentResponses('purgechan')).toContain('a bad reply')

    expect(parseAction({ kind: 'ask-purge', id: -1 })).toBeNull()
    expect(parseAction({ kind: 'ask-purge', id: 1.5 })).toBeNull()
    // wrong channel can't purge someone else's question
    expect((await act('someotherchan', 'mod1', { kind: 'ask-purge', id }, false)).ok).toBe(false)
    expect(raw.query(`SELECT 1 FROM ask_queries WHERE id = ?`).get(id)).not.toBeNull()

    expect((await act('purgechan', 'mod1', { kind: 'ask-purge', id }, false)).ok).toBe(true)
    expect(raw.query(`SELECT 1 FROM ask_queries WHERE id = ?`).get(id)).toBeNull()
    expect(ai.getChannelRecentResponses('purgechan')).not.toContain('a bad reply')
    // re-purging the same id now fails cleanly
    expect((await act('purgechan', 'mod1', { kind: 'ask-purge', id }, false)).ok).toBe(false)
  })
})

describe('audit trail — one door for panel and chat', () => {
  it('tags a panel action \'panel\' and a chat action \'chat\', both landing in the same log', async () => {
    await act('audchan', 'panelmod', { kind: 'raid-pace', pace: 'fast' }, false) // 'panel' default
    await act('audchan', 'chatmod', { kind: 'raid', on: true }, false, 'chat')
    const rows = db.recentPanelActions('audchan', 5)
    expect(rows.find((r) => r.login === 'chatmod')?.source).toBe('chat')
    expect(rows.find((r) => r.login === 'panelmod')?.source).toBe('panel')
    expect(snapshot('audchan').audit.some((r) => r.source === 'chat')).toBe(true)
  })

  it('a failed action is never audited', async () => {
    const before = db.recentPanelActions('nopchan', 20).length
    await act('nopchan', 'mod1', { kind: 'resume', feature: 'trivia' }, false) // nothing paused -> fails
    expect(db.recentPanelActions('nopchan', 20).length).toBe(before)
  })
})

describe('persistence — survives a simulated restart', () => {
  it('a pause written through act() reloads from sqlite after memory is wiped', async () => {
    const suppress = await import('./suppress')
    expect((await act('persistchan', 'mod1', { kind: 'pause', feature: 'trivia', minutes: 45 }, false)).ok).toBe(true)
    expect(suppress.isSuppressed('persistchan', 'trivia')).toBe(true)
    suppress.__simulateRestartForTest()
    expect(suppress.isSuppressed('persistchan', 'trivia')).toBe(true)
    expect(suppress.listSuppressions('persistchan')[0]?.by).toBe('mod1')
  })

  it('a trivia topic ban reloads from sqlite after memory is wiped', async () => {
    const mod = await import('./commands-mod')
    expect((await act('persistchan2', 'mod1', { kind: 'topic-ban', topic: 'digimon' }, false)).ok).toBe(true)
    mod.__simulateRestartForTest()
    expect(mod.bannedTriviaTopic('persistchan2', 'digimon trivia')).toBe('digimon')
  })

  it('the ai channel toggle reloads from sqlite after memory is wiped', async () => {
    const ai = await import('./ai-cache')
    expect((await act('persistchan3', 'mod1', { kind: 'ai', on: true }, false)).ok).toBe(true)
    expect(ai.isAiChannelEnabled('persistchan3')).toBe(true)
    // simulate a restart: the in-memory set is gone, only the persisted row remains
    ai.AI_CHANNELS.delete('persistchan3')
    ai.__resetAiTogglesForTest()
    expect(ai.isAiChannelEnabled('persistchan3')).toBe(true)
  })

  it('the goals switch reloads from sqlite after memory is wiped', async () => {
    const wc = await import('./worldcup-goals')
    expect((await act('persistchan4', 'mod1', { kind: 'goals', on: false }, false)).ok).toBe(true)
    wc.__resetGoalsForTest()
    // reload picks the persisted 'off' row back up (fresh module state would otherwise
    // default to enabled)
    expect(wc.isGoalsEnabled('persistchan4')).toBe(false)
  })
})
