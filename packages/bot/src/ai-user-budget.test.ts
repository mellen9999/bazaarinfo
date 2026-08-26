import { describe, expect, it, beforeEach } from 'bun:test'

import * as db from './db'

// The per-user daily AI budget is the brake every other one deliberately isn't: user
// cooldown, global cooldown and channel cap are all 0 so busy-chat asks flow, which
// left a single chatter free to fan out four unattended days of trivia generation
// before the monthly console wall caught it. One account must run out of AI for the
// day long before the whole bot does.
// hard-set before import (module-load read) — bun auto-loads .env, and prod boxes
// deliberately run with the cap OFF (0); the test must exercise the default, not prod cfg
delete process.env.USER_DAILY_AI_CAP
// the budget is write-through to sqlite, so the counter needs a real db to survive a restart
db.initDb(':memory:')
const { USER_DAILY_AI_CAP, noteUserAiRequest, isUserOverDailyAiCap, resetUserAiBudgetForTests } = await import('./ai-cache')

describe('per-user daily AI budget', () => {
  beforeEach(() => resetUserAiBudgetForTests())

  it('has a real cap by default — the whole point is surviving an unattended night', () => {
    expect(USER_DAILY_AI_CAP).toBeGreaterThan(0)
  })

  it('a fresh user is under the cap', () => {
    expect(isUserOverDailyAiCap('newperson')).toBe(false)
  })

  it('a normal day of asks never trips it', () => {
    for (let i = 0; i < 10; i++) noteUserAiRequest('casual')
    expect(isUserOverDailyAiCap('casual')).toBe(false)
  })

  it('a spam loop dies at the cap', () => {
    for (let i = 0; i < USER_DAILY_AI_CAP; i++) noteUserAiRequest('spammer')
    expect(isUserOverDailyAiCap('spammer')).toBe(true)
  })

  it('heavy surfaces bill more than one unit — 4 custom trivia rounds hit a 40 cap', () => {
    for (let i = 0; i < Math.ceil(USER_DAILY_AI_CAP / 10); i++) noteUserAiRequest('triviahead', 10)
    expect(isUserOverDailyAiCap('triviahead')).toBe(true)
  })

  it('the counter is case-insensitive — recasing a name is not a reset', () => {
    for (let i = 0; i < USER_DAILY_AI_CAP; i++) noteUserAiRequest('PeYtOn')
    expect(isUserOverDailyAiCap('peyton')).toBe(true)
  })

  it('one user at the cap does not touch anyone else', () => {
    for (let i = 0; i < USER_DAILY_AI_CAP; i++) noteUserAiRequest('spammer')
    expect(isUserOverDailyAiCap('bystander')).toBe(false)
  })

  it('spend is written through to sqlite, weights included', () => {
    noteUserAiRequest('triviahead', 10)
    noteUserAiRequest('triviahead')
    expect(db.getUserAiUnits('triviahead')).toBe(11)
  })

  it('a restart does not refill — the count rehydrates from sqlite', () => {
    // what a previous process left on disk; this process has never seen the name
    db.bumpUserAiUnits('ghost', USER_DAILY_AI_CAP)
    expect(isUserOverDailyAiCap('ghost')).toBe(true)
  })

  it('rehydration is case-insensitive too', () => {
    db.bumpUserAiUnits('GhOsT2', USER_DAILY_AI_CAP)
    expect(isUserOverDailyAiCap('ghost2')).toBe(true)
  })

  it('a persisted row from another day is not today\'s budget', () => {
    db.bumpUserAiUnits('yesterdayspammer', USER_DAILY_AI_CAP)
    expect(db.getUserAiUnits('yesterdayspammer', '1999-01-01')).toBe(0)
  })
})
