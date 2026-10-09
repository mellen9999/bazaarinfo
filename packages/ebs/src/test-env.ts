// imported FIRST by test files that statically import auth/index: es imports are
// hoisted, so an assignment in the test body runs too late. hard assignment, not
// ||= — bun auto-loads .env, and tests must never run against real secrets.
process.env.TWITCH_EXTENSION_SECRET = 'dGVzdA=='
process.env.COMPANION_SECRET = 'test-master-secret-value-do-not-ship'
