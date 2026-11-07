const test = require('node:test');
const assert = require('node:assert');

// An in-memory DB cannot use WAL, so db.js takes its "WAL unavailable" fallback.
process.env.DB_PATH = ':memory:';
const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(' '));
const db = require('../server/db');
console.warn = realWarn;

// auth.js destructures db exports at load, so wrap insertUser before requiring it.
const realInsertUser = db.insertUser;
let failInsert = false;
db.insertUser = (args) => {
  if (failInsert) throw new Error('disk I/O error');
  return realInsertUser(args);
};
const auth = require('../server/auth');

test('db warns and keeps going when WAL is unavailable', () => {
  assert.deepStrictEqual(warnings, ['WAL unavailable, staying on memory']);
  assert.strictEqual(db.countUsers(), 0);
});

test('createGroup retries when a generated code collides', (t) => {
  const userId = realInsertUser({ email: 'grp@x.com', passwordHash: 'h' }).id;
  // Two zero-codes in a row collide, then a different code succeeds.
  const seq = [...Array(12).fill(0), ...Array(6).fill(0.5)];
  t.mock.method(Math, 'random', () => seq.shift());
  const a = db.createGroup(userId, 'A');
  const b = db.createGroup(userId, 'B');
  assert.strictEqual(a.code, 'AAAAAA');
  assert.notStrictEqual(b.code, a.code);
  assert.strictEqual(seq.length, 0);
});

test('createGroup gives up after five collisions', (t) => {
  const userId = realInsertUser({ email: 'grp2@x.com', passwordHash: 'h' }).id;
  t.mock.method(Math, 'random', () => 0);
  assert.throws(() => db.createGroup(userId, 'C'), /Could not generate a unique group code/);
});

test('createGroup rethrows non-UNIQUE errors', () => {
  const userId = realInsertUser({ email: 'grp3@x.com', passwordHash: 'h' }).id;
  assert.throws(() => db.createGroup(userId, null), /NOT NULL/);
});

test('signup rethrows insert errors other than duplicate email', async () => {
  failInsert = true;
  try {
    await assert.rejects(auth.signup('boom@x.com', 'password123'), /disk I\/O error/);
  } finally {
    failInsert = false;
  }
});
