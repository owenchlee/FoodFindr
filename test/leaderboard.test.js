const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
process.env.DB_PATH = path.join(os.tmpdir(), `ff-test-${process.pid}.db`);
const db = require('../server/db');

test('leaderboard shows only you and people who share a group with you', () => {
  const mk = (email) => db.insertUser({ email, passwordHash: 'x' }).id;
  const a = mk('a@x.com'), b = mk('b@x.com'), c = mk('c@x.com');
  assert.deepStrictEqual(db.getLeaderboardStats(a).map(r => r.userId), [a]);
  const g = db.createGroup(a, 'Lunch');
  db.joinGroupByCode(b, g.code);
  assert.deepStrictEqual(db.getLeaderboardStats(a).map(r => r.userId).sort(), [a, b].sort());
  assert.ok(!db.getLeaderboardStats(b).some(r => r.userId === c));
});
