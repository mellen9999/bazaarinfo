import { test, expect, describe } from 'bun:test'
import { parseIrcLine } from './twitch'

// USERSTATE drives per-channel send-rate privilege (vip/mod/broadcaster -> 100/30s
// mod bucket; everyone else -> 20/30s user bucket). getting this parse wrong either
// throttles a vip channel or risks a 30min spam lockout on a regular channel.
describe('parseIrcLine USERSTATE privilege detection', () => {
  test('vip badge -> privileged', () => {
    const m = parseIrcLine('@badge-info=;badges=vip/1;mod=0;display-name=Bot :tmi.twitch.tv USERSTATE #nl_kripp')
    expect(m).toEqual({ type: 'userstate', channel: 'nl_kripp', privileged: true })
  })

  test('moderator badge -> privileged', () => {
    const m = parseIrcLine('@badges=moderator/1;mod=1 :tmi.twitch.tv USERSTATE #somechan')
    expect(m).toMatchObject({ type: 'userstate', channel: 'somechan', privileged: true })
  })

  test('mod=1 tag without badge -> privileged', () => {
    const m = parseIrcLine('@badges=;mod=1 :tmi.twitch.tv USERSTATE #chan')
    expect(m).toMatchObject({ type: 'userstate', privileged: true })
  })

  test('broadcaster badge -> privileged', () => {
    const m = parseIrcLine('@badges=broadcaster/1;mod=0 :tmi.twitch.tv USERSTATE #bot')
    expect(m).toMatchObject({ type: 'userstate', channel: 'bot', privileged: true })
  })

  test('no privileged badges -> NOT privileged', () => {
    const m = parseIrcLine('@badges=;mod=0 :tmi.twitch.tv USERSTATE #randomchan')
    expect(m).toEqual({ type: 'userstate', channel: 'randomchan', privileged: false })
  })

  test('subscriber-only badge is not a send-rate privilege', () => {
    const m = parseIrcLine('@badges=subscriber/12;mod=0 :tmi.twitch.tv USERSTATE #chan')
    expect(m).toMatchObject({ type: 'userstate', privileged: false })
  })

  test('still parses a normal PRIVMSG', () => {
    const m = parseIrcLine('@badges=vip/1;id=abc;user-id=42 :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #nl_kripp :hello world')
    expect(m).toMatchObject({ type: 'privmsg', channel: 'nl_kripp', login: 'viewer', text: 'hello world' })
  })
})
