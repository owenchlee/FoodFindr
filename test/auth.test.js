const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
process.env.DB_PATH = path.join(os.tmpdir(), `ff-auth-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);
fs.rmSync(process.env.DB_PATH, { force: true });
const db = require('../server/db');
const auth = require('../server/auth');

function fakeRes() {
  return {
    statusCode: 200, body: undefined, cookies: {}, cleared: [],
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    cookie(name, value, opts) { this.cookies[name] = { value, opts }; },
    clearCookie(name, opts) { this.cleared.push({ name, opts }); }
  };
}
const reqWith = (token) => ({ cookies: token ? { [auth.SESSION_COOKIE_NAME]: token } : {} });
const run = (mw, req) => { const res = fakeRes(); let called = false; mw(req, res, () => { called = true; }); return { res, called }; };

test('email and password validation', () => {
  assert.ok(auth.isValidEmail('a@b.co'));
  assert.ok(!auth.isValidEmail('no-at-sign'));
  assert.ok(!auth.isValidEmail('a b@c.d'));
  assert.ok(!auth.isValidEmail(42));
  assert.ok(!auth.isValidEmail('a@b.' + 'c'.repeat(260)));
  assert.ok(auth.isValidPassword('12345678'));
  assert.ok(!auth.isValidPassword('1234567'));
  assert.ok(!auth.isValidPassword('x'.repeat(129)));
  assert.ok(!auth.isValidPassword(undefined));
});

test('signup, duplicate signup, login success and generic failures', async () => {
  const { user } = await auth.signup('  first@x.com ', 'password1');
  assert.strictEqual(user.email, 'first@x.com');
  assert.deepStrictEqual(await auth.signup('first@x.com', 'other-pass'), { error: 'An account with that email already exists.' });

  const ok = await auth.login(' first@x.com', 'password1');
  assert.strictEqual(ok.user.id, user.id);
  const generic = { error: 'Invalid email or password.' };
  assert.deepStrictEqual(await auth.login('first@x.com', 'wrong-pass'), generic);
  assert.deepStrictEqual(await auth.login('nobody@x.com', 'password1'), generic);
});

test('login with a malformed stored hash fails instead of throwing', async () => {
  db.insertUser({ email: 'legacy@x.com', passwordHash: 'not-a-scrypt-hash' });
  assert.deepStrictEqual(await auth.login('legacy@x.com', 'whatever1'), { error: 'Invalid email or password.' });
});

test('session lifecycle through requireAuth and optionalAuth', () => {
  const user = db.insertUser({ email: 'sess@x.com', passwordHash: 'x' });
  const { token, expiresAt } = auth.startSession(user.id);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.ok(new Date(expiresAt).getTime() > Date.now() + 29 * 24 * 3600 * 1000);

  const req = reqWith(token);
  const r1 = run(auth.requireAuth, req);
  assert.ok(r1.called);
  assert.deepStrictEqual(req.user, { id: user.id, email: 'sess@x.com' });
  assert.strictEqual(req.sessionToken, token);

  const req2 = reqWith(token);
  assert.ok(run(auth.optionalAuth, req2).called);
  assert.strictEqual(req2.user.id, user.id);

  auth.endSession(token);
  auth.endSession(undefined); // no-op without a token
  const r2 = run(auth.requireAuth, reqWith(token));
  assert.ok(!r2.called);
  assert.strictEqual(r2.res.statusCode, 401);
  assert.deepStrictEqual(r2.res.body, { error: 'Not signed in.' });
});

test('missing cookie: requireAuth rejects, optionalAuth passes as guest', () => {
  const r = run(auth.requireAuth, reqWith(null));
  assert.ok(!r.called);
  assert.strictEqual(r.res.statusCode, 401);
  assert.ok(!run(auth.requireAuth, {}).called);

  const req = reqWith('unknown-token');
  assert.ok(run(auth.optionalAuth, req).called);
  assert.strictEqual(req.user, undefined);
});

test('expired session is rejected by both middlewares', () => {
  const user = db.insertUser({ email: 'old@x.com', passwordHash: 'x' });
  const token = 'expired-token';
  db.createSession({ token, userId: user.id, expiresAt: new Date(Date.now() - 1000).toISOString() });
  const r = run(auth.requireAuth, reqWith(token));
  assert.ok(!r.called);
  assert.strictEqual(r.res.statusCode, 401);
  const req = reqWith(token);
  assert.ok(run(auth.optionalAuth, req).called);
  assert.strictEqual(req.user, undefined);
});

test('session cookie set and clear', () => {
  const res = fakeRes();
  auth.setSessionCookie(res, 'tok');
  const c = res.cookies[auth.SESSION_COOKIE_NAME];
  assert.strictEqual(c.value, 'tok');
  assert.strictEqual(c.opts.httpOnly, true);
  assert.strictEqual(c.opts.sameSite, 'lax');
  assert.strictEqual(c.opts.path, '/');
  assert.strictEqual(c.opts.maxAge, 30 * 24 * 60 * 60 * 1000);
  auth.clearSessionCookie(res);
  assert.deepStrictEqual(res.cleared, [{ name: auth.SESSION_COOKIE_NAME, opts: { path: '/' } }]);
});

test('parseCookies decodes values, skips bare pairs, tolerates bad encoding', () => {
  const req = { headers: { cookie: 'ff_session=abc%20d; flag; other = x=y ; bad=%E0%A4%A' } };
  let called = false;
  auth.parseCookies(req, {}, () => { called = true; });
  assert.ok(called);
  assert.deepStrictEqual(req.cookies, { ff_session: 'abc d', other: 'x=y', bad: '%E0%A4%A' });

  const empty = { headers: {} };
  auth.parseCookies(empty, {}, () => {});
  assert.deepStrictEqual(empty.cookies, {});
});
