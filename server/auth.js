const crypto = require('crypto');
const {
  getUserByEmail, insertUser, countUsers, adoptLegacyData,
  createSession, getSessionWithUser, deleteSession
} = require('./db');

const SESSION_COOKIE_NAME = 'ff_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, fixed from login (no sliding refresh)

// N=2^14 keeps scrypt's memory use (128*N*r bytes = 16MB) comfortably under
// Node's default scrypt maxmem (32MB) — no need to pass a maxmem override.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derivedKey.toString('hex')}`);
    });
  });
}

function verifyPassword(password, stored) {
  return new Promise((resolve, reject) => {
    const parts = typeof stored === 'string' ? stored.split('$') : [];
    if (parts.length !== 6 || parts[0] !== 'scrypt') return resolve(false);
    const [, nStr, rStr, pStr, saltHex, hashHex] = parts;

    const expected = Buffer.from(hashHex, 'hex');
    crypto.scrypt(
      password,
      Buffer.from(saltHex, 'hex'),
      expected.length,
      { N: Number(nStr), r: Number(rStr), p: Number(pStr) },
      (err, derivedKey) => {
        if (err) return reject(err);
        resolve(derivedKey.length === expected.length && crypto.timingSafeEqual(derivedKey, expected));
      }
    );
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);
}

function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 128;
}

async function signup(email, password) {
  const normalizedEmail = email.trim();
  const isFirstUser = countUsers() === 0;

  const passwordHash = await hashPassword(password);
  let user;
  try {
    user = insertUser({ email: normalizedEmail, passwordHash });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return { error: 'An account with that email already exists.' };
    }
    throw err;
  }

  if (isFirstUser) {
    adoptLegacyData(user.id);
  }

  return { user };
}

async function login(email, password) {
  // Same generic failure message whether the email is unknown or the
  // password is wrong, so a login attempt can't be used to enumerate accounts.
  const genericError = 'Invalid email or password.';
  const user = getUserByEmail(email.trim());
  if (!user) return { error: genericError };

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) return { error: genericError };

  return { user };
}

function startSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  createSession({ token, userId, expiresAt });
  return { token, expiresAt };
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_MS,
    path: '/'
  };
}

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE_NAME, token, cookieOptions());
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
}

function endSession(token) {
  if (token) deleteSession(token);
}

// Express can set cookies (res.cookie) without any extra package, but reading
// incoming ones normally needs `cookie-parser` — this is that in ~10 lines,
// to keep the zero-new-dependency approach used for sessions/hashing.
function parseCookies(req, res, next) {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    header.split(';').forEach(pair => {
      const idx = pair.indexOf('=');
      if (idx === -1) return;
      const key = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      try {
        req.cookies[key] = decodeURIComponent(value);
      } catch {
        req.cookies[key] = value;
      }
    });
  }
  next();
}

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[SESSION_COOKIE_NAME];
  const session = token ? getSessionWithUser(token) : null;

  if (!session || new Date(session.expires_at).getTime() < Date.now()) {
    return res.status(401).json({ error: 'Not signed in.' });
  }

  req.user = { id: session.user_id, email: session.email };
  req.sessionToken = token;
  next();
}

// For routes guests can use too (browsing/recommendations): attaches
// req.user when a valid session exists, but never blocks the request —
// route handlers check `req.user` themselves to personalize or skip that.
function optionalAuth(req, res, next) {
  const token = req.cookies && req.cookies[SESSION_COOKIE_NAME];
  const session = token ? getSessionWithUser(token) : null;

  if (session && new Date(session.expires_at).getTime() >= Date.now()) {
    req.user = { id: session.user_id, email: session.email };
    req.sessionToken = token;
  }

  next();
}

module.exports = {
  SESSION_COOKIE_NAME,
  isValidEmail, isValidPassword,
  signup, login,
  startSession, setSessionCookie, clearSessionCookie, endSession,
  parseCookies, requireAuth, optionalAuth
};
