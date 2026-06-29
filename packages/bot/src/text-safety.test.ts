import { describe, expect, it } from 'bun:test'
import { normalizeText, stripLeadingCommands, stripOutgoingCommands } from './text-safety'
import { sanitize } from './ai'

describe('normalizeText', () => {
  it('strips zero-width / invisible format chars', () => {
    expect(normalizeText('​hi‍').length).toBe(2)
    expect(normalizeText('﻿hi')).toBe('hi')
    expect(normalizeText('soft­hyphen')).toBe('softhyphen')
  })
  it('folds smart quotes to ascii', () => {
    expect(normalizeText('‘a’ “b”')).toBe("'a' \"b\"")
  })
  it('folds homoglyph command prefixes to ascii', () => {
    expect(normalizeText('！ban')).toBe('!ban')
    expect(normalizeText('❗ban')).toBe('!ban')
    expect(normalizeText('／timeout')).toBe('/timeout')
    expect(normalizeText('＼ban')).toBe('\\ban')
  })
  it('leaves plain ascii untouched', () => {
    expect(normalizeText('she clears the board fast')).toBe('she clears the board fast')
  })
})

describe('stripOutgoingCommands', () => {
  it('strips leading ! (third-party mod-bot command)', () => {
    expect(stripOutgoingCommands('!timeout self 600')).toBe('timeout self 600')
    expect(stripOutgoingCommands('!ban tidolar')).toBe('ban tidolar')
  })
  it('strips leading / and . (native twitch commands)', () => {
    expect(stripOutgoingCommands('/ban tidolar')).toBe('ban tidolar')
    expect(stripOutgoingCommands('.timeout user')).toBe('timeout user')
  })
  it('strips leading backslash (IRC command vector)', () => {
    expect(stripOutgoingCommands('\\ban tidolar')).toBe('ban tidolar')
  })
  it('strips leading whitespace before a command', () => {
    expect(stripOutgoingCommands('  !ban user')).toBe('ban user')
  })
  it('strips quotes wrapping a leading command', () => {
    expect(stripOutgoingCommands('"!settitle" test')).toBe('settitle" test')
  })
  it('strips zero-width char hiding a leading command', () => {
    expect(stripOutgoingCommands('​!ban tidolar')).toBe('ban tidolar')
  })
  it('strips homoglyph leading command', () => {
    expect(stripOutgoingCommands('！ban tidolar')).toBe('ban tidolar')
    expect(stripOutgoingCommands('／timeout user')).toBe('timeout user')
  })
  it('leaves mid-text ! untouched ("type !b help")', () => {
    expect(stripOutgoingCommands('joined! type !b help')).toBe('joined! type !b help')
  })
  it('leaves normal exclamatory text untouched', () => {
    expect(stripOutgoingCommands('nice play! gg')).toBe('nice play! gg')
  })
  it('leaves plain text untouched', () => {
    expect(stripOutgoingCommands('she clears the board fast')).toBe('she clears the board fast')
  })
})

// the bot is now allowed to post harmless commands so chat can play — only dangerous
// (self-timeout / native-moderation) commands are neutralized.
describe('command policy: safe commands pass, dangerous neutralized', () => {
  it('lets harmless third-party ! commands through', () => {
    expect(stripOutgoingCommands('!uptime')).toBe('!uptime')
    expect(stripOutgoingCommands('!love @viewer')).toBe('!love @viewer')
    expect(stripOutgoingCommands('!hug')).toBe('!hug')
  })
  it('neutralizes self-timeout / self-harm customs', () => {
    expect(stripOutgoingCommands('!vanish')).toBe('vanish')
    expect(stripOutgoingCommands('!endme')).toBe('endme')
    expect(stripOutgoingCommands('!sacrifice')).toBe('sacrifice')
    expect(stripOutgoingCommands('!roulette')).toBe('roulette')
    expect(stripOutgoingCommands('!unalive')).toBe('unalive')
  })
  it('neutralizes morphological mod-command variants', () => {
    expect(stripOutgoingCommands('!banuser tidolar')).toBe('banuser tidolar')
    expect(stripOutgoingCommands('!timeoutme')).toBe('timeoutme')
  })
  it('lets allowlisted native / commands through (me/announce/color/clip)', () => {
    expect(stripOutgoingCommands('/me waves')).toBe('/me waves')
    expect(stripOutgoingCommands('/announce big news')).toBe('/announce big news')
  })
  it('still neutralizes non-allowlisted native / and . commands', () => {
    expect(stripOutgoingCommands('/ban tidolar')).toBe('ban tidolar')
    expect(stripOutgoingCommands('/clear')).toBe('clear')
    expect(stripOutgoingCommands('.timeout user')).toBe('timeout user')
  })
})

// regression: the AI sanitize layer must still reject command injection now that
// it shares normalizeText with the funnel — proves no behavioral drift from the refactor
describe('ai-sanitize parity after refactor', () => {
  it('still blocks homoglyph !ban', () => {
    expect(sanitize('！ban tidolar').text).toBe('')
  })
  it('still blocks fullwidth /timeout', () => {
    expect(sanitize('／timeout user 600').text).toBe('')
  })
  it('still folds smart quotes for pattern matching', () => {
    expect(sanitize("i don’t log anything").text).toBe('')
  })
})
