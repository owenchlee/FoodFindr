const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
process.env.DB_PATH = path.join(os.tmpdir(), `ff-loggedat-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);
const { boundedLoggedAt } = require('../server/db');

const now = Date.parse('2026-11-16T12:00:00.000Z');
const H = 3600 * 1000;

test('boundedLoggedAt accepts times within 72h back and 5 min ahead', () => {
  const back = new Date(now - 71 * H).toISOString();
  assert.strictEqual(boundedLoggedAt(back, now), back);
  const ahead = new Date(now + 4 * 60 * 1000).toISOString();
  assert.strictEqual(boundedLoggedAt(ahead, now), ahead);
});

test('boundedLoggedAt falls back to server time otherwise', () => {
  const server = new Date(now).toISOString();
  for (const bad of [new Date(now - 73 * H).toISOString(), new Date(now + 6 * 60 * 1000).toISOString(), 'junk', 12345, null, undefined, {}]) {
    assert.strictEqual(boundedLoggedAt(bad, now), server);
  }
});
