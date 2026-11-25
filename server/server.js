require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
  closeDb,
  insertVisit, listVisits, deleteVisit, getVisitHighlights, getTopFlavors,
  getPreferences, savePreferences,
  recordDiscovered, getProgress,
  getStreaks, getBadges, getLeaderboardStats, getLeaderboardOptIn, setLeaderboardOptIn,
  createGroup, joinGroupByCode, listUserGroups, isGroupMember,
  getGroupMemberIds, getGroupMembers, leaveGroup, deleteUser, exportUserData, setDisplayName, getUserById
} = require('./db');
const {
  SESSION_COOKIE_NAME,
  isValidEmail, isValidPassword,
  signup, login, changePassword,
  startSession, setSessionCookie, clearSessionCookie, endSession,
  parseCookies, requireAuth, optionalAuth
} = require('./auth');
const { isWeakPassword, WEAK_MESSAGE } = require('./lib/weak-password');

const { FLAVOR_TAGS, isValidRecommendation, normalizeRecommendation, fallbackRecommendation } = require('./lib/validate');
const { PRICE_TIER_MAX_USD, totalGroupBudget, budgetPool: pickBudgetPool } = require('./lib/budget');
const { shapeAndFilter } = require('./lib/places');
const { cleanDisplayName, publicDisplayName } = require('./lib/displayName');
const { sanitizeText, makeKnownPlaces, cleanCandidates } = require('./lib/trust');
const { pickRandomTopPool, chooseInstantPick: pickInstant } = require('./lib/pick');
const chooseInstantPick = (restaurants, favs, recent, recentPickIds) => pickInstant(restaurants, favs, recent, id => reviewsCache.get(id), recentPickIds);

const app = express();
const PORT = process.env.PORT || 3000;
const PLACES_SERVER_KEY = process.env.GOOGLE_PLACES_SERVER_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (process.env.NODE_ENV === 'production') {
  // Needed behind the deploy host's reverse proxy so express-rate-limit and
  // secure-cookie logic see the real client IP/protocol instead of the proxy's.
  app.set('trust proxy', 1);
}

// Host-based allowlist (Google's documented alternative to nonce-based CSP).
// Nonces would need per-request HTML templating, which this static-file app
// doesn't do. 'unsafe-inline'/'unsafe-eval'/blob: on script-src and the inline
// <style> injection allowance are required by the Maps JS API itself.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://*.googleapis.com', 'https://*.gstatic.com', 'blob:'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://*.googleapis.com', 'https://*.gstatic.com', 'https://*.ggpht.com', 'https://*.googleusercontent.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      connectSrc: ["'self'", 'https://*.googleapis.com', 'https://*.gstatic.com'],
      workerSrc: ["'self'", 'blob:'],
      frameSrc: ['https://*.google.com'],
    },
  },
}));
app.use(compression());
app.use(express.json());
app.use(parseCookies);
// index.html (no-cache) links the CSS/JS as /js/app.js?v=<content hash>
// (see sendIndexHtml), so those URLs never change meaning and can be cached
// for a year. Unversioned requests keep a short 1h TTL + etag. Before this,
// a deploy could pair fresh HTML with a cached old app.js for up to an hour,
// which left new markup (the phone tab bar) with no click handlers at all.
// Before express.static, which would otherwise serve the raw file for "/".
app.get(['/', '/index.html'], sendIndexHtml);
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: '1h',
  etag: true,
  setHeaders: (res, filePath) => {
    // sw.js too: a stale worker script would keep serving an old shell.
    if (filePath.endsWith('.html') || filePath.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    else if (res.req.query.v) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}));

function clientConfig() {
  const mapsBrowserKey = process.env.GOOGLE_MAPS_BROWSER_KEY || null;
  return {
    mapsBrowserKey,
    mapId: process.env.GOOGLE_MAPS_MAP_ID || null,
    mapsScriptUrl: mapsBrowserKey
      ? `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(mapsBrowserKey)}&libraries=marker&v=weekly&loading=async&callback=onGoogleMapsReady`
      : null
  };
}

// index.html with the config inlined instead of a blocking <script src>
// round trip, plus a <link rel=preload> for the ~500KB Maps script so it
// starts downloading while the page is still parsing rather than after.
// The CSS/JS links get a content-hash ?v= so a deploy can never mix new HTML
// with cached old JS. Rebuilt when any of these files change, so editing
// them in dev doesn't need a restart.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const INDEX_PATH = path.join(PUBLIC_DIR, 'index.html');
const VERSIONED_ASSETS = ['/css/style.css', '/js/map.js', '/js/app.js'];
let indexCache = { signature: '', html: '' };
function sendIndexHtml(req, res, next) {
  let signature;
  try {
    signature = [INDEX_PATH, ...VERSIONED_ASSETS.map(a => path.join(PUBLIC_DIR, a))]
      .map(f => fs.statSync(f).mtimeMs).join(',');
  } catch (err) { return next(err); }
  if (signature !== indexCache.signature) {
    const config = clientConfig();
    // </script> can't appear in JSON.stringify output of these values, but
    // escape '<' anyway so no future config field can break out of the tag.
    const inline = JSON.stringify(config).replace(/</g, '\\u003c');
    const preload = config.mapsScriptUrl
      ? `<link rel="preload" as="script" href="${config.mapsScriptUrl.replace(/&/g, '&amp;')}" />
`
      : '';
    let html = fs.readFileSync(INDEX_PATH, 'utf8')
      .replace('<script src="/js/config.js"></script>', `${preload}<script>window.__FF_CONFIG = ${inline};</script>`);
    for (const asset of VERSIONED_ASSETS) {
      const hash = crypto.createHash('sha1').update(fs.readFileSync(path.join(PUBLIC_DIR, asset))).digest('hex').slice(0, 10);
      html = html.replaceAll(`"${asset}"`, `"${asset}?v=${hash}"`);
    }
    indexCache = { signature, html };
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(indexCache.html);
}

// Public privacy policy, rendered from docs/PRIVACY_POLICY.md (the single
// source) with a tiny converter: headings, paragraphs, lists, **bold**,
// [links](https://...) and '>' blockquotes. shortcut: no nesting or code spans,
// swap in a real markdown lib if the policy ever needs them.
const POLICY_PATH = path.join(__dirname, '..', 'docs', 'PRIVACY_POLICY.md');
let policyCache = { mtime: 0, html: '' };
function renderPolicy(md) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const inline = s => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let para = [], items = [], quote = [], inQuote = false;
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    if (items.length) out.push(`<ul>${items.map(i => `<li>${inline(i)}</li>`).join('')}</ul>`);
    para = []; items = [];
  };
  const flushQuote = () => { if (inQuote) { out.push('</blockquote>'); inQuote = false; } };
  for (const raw of md.split(/\r?\n/)) {
    let line = raw;
    if (line.startsWith('>')) {
      if (!inQuote) { flush(); out.push('<blockquote>'); inQuote = true; }
      line = line.replace(/^>\s?/, '');
    } else if (inQuote) { flush(); flushQuote(); }
    let m;
    if (!line.trim()) flush();
    else if ((m = line.match(/^(#{1,3})\s+(.*)/))) { flush(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
    else if ((m = line.match(/^- (.*)/))) { if (para.length) flush(); items.push(m[1]); }
    else if (items.length && /^\s+\S/.test(line)) items[items.length - 1] += ' ' + line.trim();
    else { if (items.length) flush(); para.push(line.trim()); }
  }
  flush(); flushQuote();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>FoodFindr Privacy Policy</title>
<style>
body{margin:0;background:#14110f;color:#eee;font:16px/1.6 -apple-system,system-ui,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 20px 64px;overflow-wrap:anywhere}
h1,h2,h3{line-height:1.25}a{color:#ff9d5c}
blockquote{margin:16px 0;padding:4px 16px;border-left:4px solid #ff9d5c;background:#211c19}
</style></head><body><main>
${out.join('\n')}
</main></body></html>`;
}
app.get('/privacy', (req, res, next) => {
  try {
    const mtime = fs.statSync(POLICY_PATH).mtimeMs;
    if (mtime !== policyCache.mtime) policyCache = { mtime, html: renderPolicy(fs.readFileSync(POLICY_PATH, 'utf8')) };
  } catch (err) { return next(err); }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(policyCache.html);
});

// Serves the same config the /api/config JSON endpoint does, but as a plain
// synchronous script so the client doesn't need to await a fetch before it
// can inject the Maps <script> tag (see the bootstrap in index.html).
app.get('/js/config.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(`window.__FF_CONFIG = ${JSON.stringify(clientConfig())};`);
});

// /api/restaurants and /api/recommend hit billed Google Places/Anthropic
// calls per request, so an unlimited public endpoint is a cost-abuse risk.
// 40, not 20: a normal search now issues two requests (phase-1 /api/restaurants
// plus the phase-2 /api/restaurants/rest poll), so the old per-search budget
// of 20 would start 429-ing real users after ~10 searches/minute.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  // Valid signed-in sessions get a per-user bucket so friends behind one shared
  // IP (wifi, CGNAT) don't starve each other. Everyone else, including forged
  // cookies, falls back to the IP bucket.
  keyGenerator: (req) => {
    optionalAuth(req, null, () => {}); // only sets req.user for a verified session
    return req.user ? `u:${req.user.id}` : ipKeyGenerator(req.ip);
  },
  // Requests answered from placesCache cost Google nothing, so they are free.
  skip: (req) => {
    try {
      if (req.baseUrl !== '/api/restaurants') return false;
      if (req.path === '/rest') {
        const e = typeof req.query.searchId === 'string' && placesCache.get(decodeURIComponent(req.query.searchId));
        return !!(e && e.complete);
      }
      if (req.path !== '/') return false;
      const { lat, lng, cuisine, dish, radiusMeters, dietaryHint } = resolveSearchParams(req);
      if (Number.isNaN(lat) || Number.isNaN(lng)) return false;
      const e = placesCache.get(placesCacheKey(lat, lng, radiusMeters, cuisine, dish, dietaryHint));
      return !!(e && e.complete);
    } catch { return false; }
  },
  standardHeaders: true,
  legacyHeaders: false
});
// Private per-user JSON must never sit in a shared/browser cache.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api/restaurants', apiLimiter);
app.use('/api/recommend', apiLimiter);

// Login/signup get their own stricter limiter, separate from the billed-API
// limiter above, since brute-forcing credentials isn't a cost concern, it's
// an account-security one.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false
});

// Group codes are 6 chars, so cap join attempts to make guessing impractical.
const joinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false
});

// Hands the browser-restricted Maps key + Map ID to the frontend, so the
// key never has to be hardcoded into a static HTML file.
app.get('/api/config', (req, res) => {
  res.json({
    mapsBrowserKey: process.env.GOOGLE_MAPS_BROWSER_KEY || null,
    mapId: process.env.GOOGLE_MAPS_MAP_ID || null
  });
});

app.post('/api/auth/signup', authLimiter, async (req, res) => {
  const { email, password } = req.body;

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (!isValidPassword(password)) {
    return res.status(400).json({ error: 'Password must be 8-128 characters.' });
  }
  if (isWeakPassword(password, email)) {
    return res.status(400).json({ error: WEAK_MESSAGE });
  }

  try {
    const result = await signup(email, password);
    if (result.error) {
      return res.status(409).json({ error: result.error });
    }

    const { token } = startSession(result.user.id);
    setSessionCookie(res, token);
    res.status(201).json({ user: { id: result.user.id, email: result.user.email } });
  } catch (err) {
    console.error('Signup failed:', err);
    res.status(500).json({ error: 'Could not create your account right now.' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;

  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Invalid email or password.' });
  }

  try {
    const result = await login(email, password);
    if (result.error) {
      return res.status(401).json({ error: result.error });
    }

    const { token } = startSession(result.user.id);
    setSessionCookie(res, token);
    res.json({ user: { id: result.user.id, email: result.user.email, displayName: result.user.display_name || null } });
  } catch (err) {
    console.error('Login failed:', err);
    res.status(500).json({ error: 'Could not sign you in right now.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  endSession(req.cookies && req.cookies[SESSION_COOKIE_NAME]);
  clearSessionCookie(res);
  res.status(204).end();
});

// Separate limiter so guessing the current password is capped like login.
const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false
});

app.post('/api/auth/password', requireAuth, passwordLimiter, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (typeof currentPassword !== 'string') {
    return res.status(400).json({ error: 'Enter your current password.' });
  }
  if (!isValidPassword(newPassword)) {
    return res.status(400).json({ error: 'Password must be 8-128 characters.' });
  }
  if (isWeakPassword(newPassword, req.user.email)) {
    return res.status(400).json({ error: WEAK_MESSAGE });
  }

  try {
    const result = await changePassword(req.user.id, currentPassword, newPassword, req.sessionToken);
    if (result.error) {
      return res.status(403).json({ error: result.error });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Password change failed:', err);
    res.status(500).json({ error: 'Could not change your password right now.' });

  }
});

app.delete('/api/account', requireAuth, passwordLimiter, async (req, res) => {
  const password = req.body && req.body.password;
  if (typeof password !== 'string') {
    return res.status(400).json({ error: 'Enter your password to delete your account.' });
  }

  try {
    const result = await login(req.user.email, password);
    if (result.error) {
      return res.status(403).json({ error: 'Incorrect password.' });
    }
    deleteUser(req.user.id);
    clearSessionCookie(res);
    res.status(204).end();
  } catch (err) {
    console.error('Account deletion failed:', err);
    res.status(500).json({ error: 'Could not delete your account right now.' });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: { ...req.user, displayName: getUserById(req.user.id).display_name || null } });
});

app.post('/api/profile', requireAuth, (req, res) => {
  const displayName = cleanDisplayName(req.body && req.body.displayName);
  if (!displayName) {
    return res.status(400).json({ error: 'Pick a name of 1 to 30 characters, without < or >.' });
  }
  setDisplayName(req.user.id, displayName);
  res.json({ displayName });
});

app.get('/api/account/export', requireAuth, (req, res) => {
  res.set({
    'Content-Disposition': 'attachment; filename="foodfindr-data.json"',
    'Cache-Control': 'no-store'
  });
  res.type('application/json').send(JSON.stringify(exportUserData(req.user.id), null, 2));
});

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Tier 0 instrumentation: zero-dependency request timing, surfaced both as a
// `Server-Timing` header (renders natively in Chrome DevTools -> Network ->
// Timing) and as a `[perf]` console line for server-log grepping. Set
// PERF_LOG=0 to silence the console line in production if it gets noisy;
// the header is always sent since it costs nothing to compute.
const PERF_LOG = process.env.PERF_LOG !== '0';
function timer() {
  const t0 = process.hrtime.bigint();
  let last = t0;
  const marks = [];
  return {
    mark(label) {
      const now = process.hrtime.bigint();
      marks.push([label, Number(now - last) / 1e6]);
      last = now;
    },
    total() { return Number(process.hrtime.bigint() - t0) / 1e6; },
    header() { return marks.map(([l, d]) => `${l};dur=${d.toFixed(0)}`).join(', '); },
    log(route, extra) {
      if (!PERF_LOG) return;
      console.log(`[perf] ${route} total=${this.total().toFixed(0)}ms ` +
        marks.map(([l, d]) => `${l}=${d.toFixed(0)}ms`).join(' ') +
        (extra ? ' ' + Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(' ') : ''));
    }
  };
}

// Generic TTL+LRU cache used by the Places result cache (below) and the
// Place Details/reviews cache (see fetchPlaceReviews). A Map preserves
// insertion order, so re-inserting on every get()/set() turns that into an
// LRU eviction order for free, with no extra bookkeeping structure.
function makeTtlCache({ ttlMs, maxEntries }) {
  const map = new Map();
  return {
    get(key) {
      const e = map.get(key);
      if (!e) return null;
      if (Date.now() > e.expires) { map.delete(key); return null; }
      map.delete(key); map.set(key, e);
      return e;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, { ...value, expires: Date.now() + ttlMs });
      while (map.size > maxEntries) map.delete(map.keys().next().value);
    },
    delete(key) { map.delete(key); },
    get size() { return map.size; }
  };
}

// Google returns at most 20 results per call; a `next_page_token` unlocks up
// to 2 more pages (60 total, Google's hard cap; there's no way to get
// "every" restaurant in a city from this API). Each extra page is a
// separate billed Places Search request, so this roughly triples search
// cost versus a single page.
const MAX_PLACES_PAGES = 3;

// Google reports an exhausted daily quota as OVER_QUERY_LIMIT or
// RESOURCE_EXHAUSTED in the JSON body, or as a bare HTTP 429 whose body may
// not be JSON. readGoogleJson folds the 429 into the same status field so
// callers only check one place.
const GOOGLE_QUOTA_STATUSES = new Set(['OVER_QUERY_LIMIT', 'RESOURCE_EXHAUSTED']);
const GOOGLE_QUOTA_ERROR = { code: 'GOOGLE_QUOTA', error: 'FoodFindr hit its daily search limit. Try again tomorrow.' };

async function readGoogleJson(response) {
  if (response.status === 429) return { status: 'OVER_QUERY_LIMIT' };
  return response.json();
}

// GET a Google JSON endpoint, retrying once after a short backoff on a one-off
// fault: network error, timeout, HTTP 5xx/429, unparseable body or
// UNKNOWN_ERROR. Real answers (OK, ZERO_RESULTS, REQUEST_DENIED, a quota
// status in the body...) are returned untouched. Throws if both attempts fail
// at the transport level; a persistent 429 comes back as OVER_QUERY_LIMIT.
async function googleGetJson(url) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await delay(300);
    try {
      // Node's fetch has no default timeout; a hung socket would hold the request open.
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.status === 429) { last = { status: 'OVER_QUERY_LIMIT' }; continue; }
      if (response.status >= 500) { last = new Error(`Google HTTP ${response.status}`); continue; }
      const data = await response.json();
      if (data.status === 'UNKNOWN_ERROR') { last = data; continue; }
      return data;
    } catch (err) {
      last = err;
    }
  }
  if (last instanceof Error) throw last;
  return last;
}

async function fetchPlacesPage(endpoint, params, pageToken) {
  const url = new URL(endpoint);
  if (pageToken) {
    // Per Google's docs, a pagetoken request only needs the token + key;
    // other search params are ignored anyway when it's present.
    url.searchParams.set('pagetoken', pageToken);
  } else {
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  }
  url.searchParams.set('key', PLACES_SERVER_KEY);

  return googleGetJson(url);
}

function buildPlacesQuery(lat, lng, radiusMeters, cuisine, dish, dietaryHint) {
  const useTextSearch = Boolean(cuisine || dish || dietaryHint);
  const endpoint = useTextSearch
    ? 'https://maps.googleapis.com/maps/api/place/textsearch/json'
    : 'https://maps.googleapis.com/maps/api/place/nearbysearch/json';

  const params = { location: `${lat},${lng}`, radius: String(Math.round(radiusMeters)) };
  if (useTextSearch) {
    // Folding a saved dietary restriction into the search text itself (not
    // just the later Claude prompt) means Google's own relevance ranking
    // actually surfaces places associated with that term, instead of always
    // handing Claude the same generic top candidates and hoping one of
    // their reviews happens to mention it.
    params.query = [dish, cuisine, dietaryHint, 'restaurants'].filter(Boolean).join(' ');
  } else {
    params.type = 'restaurant';
  }
  return { endpoint, params };
}

// Phase 1: fetch just the first page (20 results, already relevance/prominence
// -ranked by Google) and return immediately. This is the request handler's
// only awaited Places call - the 2000ms-per-page delays that used to make
// every search take 4.5+ extra seconds live entirely in continuePlacesFetch
// below, which runs in the background after the response has already gone out.
async function fetchPlacesFirstPage(endpoint, params) {
  let data = await fetchPlacesPage(endpoint, params, null);
  if (data.status === 'ZERO_RESULTS') return { results: [], nextPageToken: null };
  if (data.status !== 'OK') {
    const err = new Error(`Places API error: ${data.status}${data.error_message ? ': ' + data.error_message : ''}`);
    if (GOOGLE_QUOTA_STATUSES.has(data.status)) err.code = GOOGLE_QUOTA_ERROR.code;
    throw err;
  }
  return { results: data.results || [], nextPageToken: data.next_page_token || null };
}

// Phase 2: pages 2-3, run in the background (NOT awaited by the request
// handler). Google requires next_page_token to "warm up" for ~2s before it's
// valid, which is the one delay in this whole path that can't be optimized
// away - so instead of making the user wait on it, we let it run after the
// response for page 1 has already been sent.
async function continuePlacesFetch(entry, key, endpoint, params, firstPageToken) {
  const allResults = entry.places.slice();
  let pageToken = firstPageToken;
  let failed = false;
  try {
    for (let page = 1; page < MAX_PLACES_PAGES && pageToken; page++) {
      await delay(2000); // Google requires a short delay before a page token becomes valid
      let data = await fetchPlacesPage(endpoint, params, pageToken);

      if (data.status === 'INVALID_REQUEST') {
        // A fresh next_page_token isn't active immediately on Google's side. Retry once after a beat.
        await delay(1500);
        data = await fetchPlacesPage(endpoint, params, pageToken);
      }

      if (data.status === 'ZERO_RESULTS') break;
      if (data.status !== 'OK') { failed = true; break; } // keep whatever earlier pages already returned

      allResults.push(...(data.results || []));
      entry.pagesFetched++;
      pageToken = data.next_page_token || null;
    }
  } catch (err) {
    console.error('Background Places pagination failed:', err);
    failed = true;
    // fall through and resolve with whatever pages did complete
  }
  entry.places = allResults;
  entry.complete = true;
  entry.resolveDone(allResults);
  // This search still gets its partial results, but don't cache them as
  // complete for 10 minutes: the next identical search fetches again.
  if (failed && placesCache.get(key) === entry) placesCache.delete(key);
}

// Places search-result cache, keyed tightly enough (~110m/500m buckets) that
// distance math computed against the caller's actual lat/lng stays accurate,
// but loosely enough that near-repeat searches (re-panning slightly, toggling
// a filter back) hit it. Caches the RAW Google `places` array, never the
// post-filter output, so shapeAndFilter (below) can be re-run per request
// without the cache bucketing leaking into displayed distances.
const placesCache = makeTtlCache({ ttlMs: 10 * 60 * 1000, maxEntries: 200 });

// Place ids we've returned from our own searches; /api/recommend and
// /api/prewarm refuse anything else so clients can't spend Place Details quota.
const knownPlaces = makeKnownPlaces();

// Deliberately excludes `price` (filtered client-side now, see shapeAndFilter)
// and `groupId` (only affects the derived dietaryHint, already captured below).
function placesCacheKey(lat, lng, radiusMeters, cuisine, dish, dietaryHint) {
  return [
    lat.toFixed(3), lng.toFixed(3),
    Math.round(radiusMeters / 500) * 500,
    (cuisine || '').toLowerCase(),
    dish.toLowerCase(),
    dietaryHint.toLowerCase()
  ].join('|');
}

// Caches lat/lng (rounded to ~1.1km) -> city name so repeated searches in the
// same area don't re-hit the Geocoding API.
const cityCache = new Map();

function cityCacheKey(lat, lng) {
  return `${lat.toFixed(2)},${lng.toFixed(2)}`;
}

async function geocodeCity(lat, lng) {
  const key = cityCacheKey(lat, lng);
  if (cityCache.has(key)) {
    return cityCache.get(key);
  }

  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('latlng', `${lat},${lng}`);
  url.searchParams.set('key', PLACES_SERVER_KEY);

  try {
    const data = await googleGetJson(url);

    if (data.status !== 'OK') {
      console.error('Geocoding error:', data.status, data.error_message || '');
      return null;
    }

    const components = (data.results[0] && data.results[0].address_components) || [];
    const findType = type => {
      const match = components.find(c => c.types.includes(type));
      return match ? match.long_name : null;
    };
    const city = findType('locality') || findType('postal_town') || findType('administrative_area_level_2') || 'Unknown Area';

    cityCache.set(key, city);
    return city;
  } catch (err) {
    console.error('Geocoding request failed:', err);
    return null;
  }
}

// Forward geocoding (address text -> lat/lng) for the "search a location"
// picker. Client-side google.maps.Geocoder can't be used here since the
// browser Maps key is deliberately restricted to Maps JavaScript API only
// (see .env.example). This reuses the server key, which already has
// Geocoding API access for the reverse-geocoding done in geocodeCity above.
app.get('/api/geocode', optionalAuth, apiLimiter, async (req, res) => {
  if (!PLACES_SERVER_KEY) {
    return res.status(500).json({ error: 'Server is missing GOOGLE_PLACES_SERVER_KEY. Add it to .env.' });
  }

  const address = typeof req.query.address === 'string' ? req.query.address.trim().slice(0, 200) : '';
  if (!address) {
    return res.status(400).json({ error: 'address is required.' });
  }

  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', address);
  url.searchParams.set('key', PLACES_SERVER_KEY);
  // Optional search-location bias: a soft ~55 km box so local namesakes rank first.
  const biasLat = parseCoord(req.query.lat, 90);
  const biasLng = parseCoord(req.query.lng, 180);
  if (Number.isFinite(biasLat) && Number.isFinite(biasLng)) {
    const d = 0.5;
    url.searchParams.set('bounds', `${biasLat - d},${biasLng - d}|${biasLat + d},${biasLng + d}`);
  }

  try {
    const data = await googleGetJson(url);

    if (GOOGLE_QUOTA_STATUSES.has(data.status)) {
      return res.status(503).json(GOOGLE_QUOTA_ERROR);
    }
    if (data.status === 'UNKNOWN_ERROR') {
      return res.status(502).json({ error: 'Could not look up that location right now. Try again in a moment.' });
    }
    if (data.status !== 'OK' || !data.results[0]) {
      return res.status(404).json({ error: `Couldn't find "${address}".` });
    }

    const location = data.results[0].geometry.location;
    res.json({ lat: location.lat, lng: location.lng, formattedAddress: data.results[0].formatted_address });
  } catch (err) {
    console.error('Forward geocoding request failed:', err);
    res.status(502).json({ error: 'Could not look up that location right now. Try again in a moment.' });
  }
});

// Bounds how many background phase-2 Places pagination jobs can run at once,
// so a burst of first-time searches can't spawn unbounded 2000ms-delay loops.
const MAX_CONCURRENT_BACKGROUND_FILLS = 8;
let activeBackgroundFills = 0;
const backgroundFillQueue = [];

function pumpBackgroundFills() {
  while (activeBackgroundFills < MAX_CONCURRENT_BACKGROUND_FILLS && backgroundFillQueue.length) {
    activeBackgroundFills++;
    backgroundFillQueue.shift()()
      .finally(() => { activeBackgroundFills--; pumpBackgroundFills(); });
  }
}

// Shared by both /api/restaurants and /api/restaurants/rest so the two routes
// can't compute the search's identity (and therefore cache key) differently.
// Control chars become spaces, then trim and cap; non-strings become ''.
const cleanText = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max).trim() : '');

// Out-of-range or non-finite coordinates become NaN so callers' existing 400 check rejects them.
function parseCoord(value, limit) {
  const n = parseFloat(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : NaN;
}

function resolveSearchParams(req) {
  const lat = parseCoord(req.query.lat, 90);
  const lng = parseCoord(req.query.lng, 180);
  // Repeated or bracketed params arrive as arrays/objects; treat them as absent.
  const str = v => (typeof v === 'string' ? v : undefined);
  const cuisine = cleanText(str(req.query.cuisine), 60);
  // Missing, non-numeric, zero or negative distance falls back to the 3 mi default.
  const parsedMiles = Number(str(req.query.maxDistance));
  const maxDistance = Number.isFinite(parsedMiles) && parsedMiles > 0 ? req.query.maxDistance : undefined;
  const groupId = str(req.query.groupId);
  const dish = typeof req.query.dish === 'string' ? req.query.dish.trim().slice(0, 60) : '';
  const distanceMiles = maxDistance ? parsedMiles : 3;
  const radiusMeters = Math.min(distanceMiles * 1609.34, 50000);

  // When searching as a group, fold the WHOLE group's dietary restrictions
  // into the search text (not just the requesting member's own), same as
  // the solo case, so results are actually relevant before Claude ever sees them.
  let dietaryRestrictionsForHint = [];
  if (groupId && req.user && isGroupMember(Number(groupId), req.user.id)) {
    dietaryRestrictionsForHint = getCombinedGroupData(Number(groupId)).dietaryRestrictions;
  } else if (req.user) {
    const preferences = getPreferences(req.user.id);
    dietaryRestrictionsForHint = preferences ? preferences.dietaryRestrictions : [];
  } else {
    dietaryRestrictionsForHint = guestDietList(req.query.diet);
  }
  const dietaryHint = dietaryRestrictionsForHint.join(' ');

  return { lat, lng, cuisine, maxDistance, dish, radiusMeters, dietaryHint };
}

// recordDiscovered is a ~60-row batched write (see db.js); deferring it with
// setImmediate keeps it off the response path entirely so a search's perceived
// latency never includes disk I/O, at the cost of a write error becoming
// invisible to the client (hence the explicit log here).
function recordDiscoveredAsync(userId, results, city) {
  if (!(city && results.length > 0 && userId)) return;
  setImmediate(() => {
    try { recordDiscovered(userId, results, city); }
    catch (err) { console.error('recordDiscovered failed:', err); }
  });
}

app.get('/api/restaurants', optionalAuth, async (req, res) => {
  if (!PLACES_SERVER_KEY) {
    return res.status(500).json({ error: 'Server is missing GOOGLE_PLACES_SERVER_KEY. Add it to .env.', restaurants: [] });
  }

  const { lat, lng, cuisine, maxDistance, dish, radiusMeters, dietaryHint } = resolveSearchParams(req);
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return res.status(400).json({ error: 'A location (lat/lng) is required.', restaurants: [] });
  }

  const t = timer();
  const key = placesCacheKey(lat, lng, radiusMeters, cuisine, dish, dietaryHint);

  try {
    // geocodeCity never rejects, so it can run alongside the Places fetch.
    const cityPromise = geocodeCity(lat, lng);
    let entry = placesCache.get(key);
    const cacheState = entry ? (entry.complete ? 'hit' : 'partial') : 'miss';

    if (entry) {
      if (entry.inflight) await entry.inflight; // coalesce concurrent identical first-page requests
    } else {
      const { endpoint, params } = buildPlacesQuery(lat, lng, radiusMeters, cuisine, dish, dietaryHint);
      const inflight = fetchPlacesFirstPage(endpoint, params);
      entry = { places: [], complete: false, inflight, donePromise: null, resolveDone: null, pagesFetched: 0 };
      entry.donePromise = new Promise(resolve => { entry.resolveDone = resolve; });
      placesCache.set(key, entry);
      // .set() stores a shallow copy (see makeTtlCache), so re-read the actual
      // stored reference before mutating it below.
      entry = placesCache.get(key);

      let firstPage;
      try {
        firstPage = await entry.inflight;
      } catch (err) {
        // Never leave a failed Google response cached, or the next identical
        // search would replay this error for 10 minutes without retrying.
        placesCache.delete(key);
        throw err;
      }
      const { results: firstPageResults, nextPageToken } = firstPage;
      entry.places = firstPageResults;
      entry.inflight = null;
      entry.pagesFetched = 1;

      if (nextPageToken) {
        const { endpoint: bgEndpoint, params: bgParams } = buildPlacesQuery(lat, lng, radiusMeters, cuisine, dish, dietaryHint);
        // Over the cap, fills wait in FIFO order instead of being cut to page 1.
        backgroundFillQueue.push(() => continuePlacesFetch(entry, key, bgEndpoint, bgParams, nextPageToken));
        pumpBackgroundFills();
      } else {
        entry.complete = true;
        entry.resolveDone(entry.places);
      }
    }
    t.mark('places');

    const results = shapeAndFilter(entry.places, lat, lng, cuisine, maxDistance);
    knownPlaces.add(results);
    const city = await cityPromise;
    t.mark('geocode');

    recordDiscoveredAsync(req.user && req.user.id, results, city);
    t.mark('discovered');

    res.setHeader('Server-Timing', t.header());
    t.log('restaurants', { cache: cacheState, pages: entry.pagesFetched, n: results.length, phase: 1 });
    res.json({
      searchCenter: { lat, lng }, city, restaurants: results,
      searchId: encodeURIComponent(key), complete: entry.complete
    });
  } catch (err) {
    console.error('Places API request failed:', err);
    if (err.code === GOOGLE_QUOTA_ERROR.code) {
      return res.status(503).json({ ...GOOGLE_QUOTA_ERROR, restaurants: [] });
    }
    res.status(502).json({ error: 'Could not reach Google Places right now. Try again in a moment.', restaurants: [] });
  }
});

// Phase 2: resolved once background pagination (kicked off by /api/restaurants
// above) finishes, or after an 8s bound, whichever comes first. Not rate-shared
// with the phase-1 route's Places-API cost since it never issues a NEW Google
// call itself - it just waits on (or reads the finished result of) one that's
// already running.
app.get('/api/restaurants/rest', optionalAuth, async (req, res) => {
  const { lat, lng, cuisine, maxDistance } = resolveSearchParams(req);
  const searchId = typeof req.query.searchId === 'string' ? req.query.searchId : '';
  if (Number.isNaN(lat) || Number.isNaN(lng) || !searchId) {
    return res.status(400).json({ error: 'lat, lng, and searchId are required.', restaurants: [] });
  }

  let key;
  try {
    key = decodeURIComponent(searchId);
  } catch {
    return res.status(400).json({ error: 'Invalid searchId.', restaurants: [] });
  }
  const entry = placesCache.get(key);
  if (!entry) {
    // Server restarted or this entry aged out of the cache; the client keeps
    // its phase-1 results rather than treating this as an error.
    return res.status(410).json({ restaurants: [], complete: true });
  }

  const t = timer();
  try {
    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(entry.places), 8000));
    const places = entry.complete ? entry.places : await Promise.race([entry.donePromise, timeoutPromise]);
    t.mark('places');

    const results = shapeAndFilter(places, lat, lng, cuisine, maxDistance);
    knownPlaces.add(results);
    const city = await geocodeCity(lat, lng);
    t.mark('geocode');
    recordDiscoveredAsync(req.user && req.user.id, results, city);

    res.setHeader('Server-Timing', t.header());
    t.log('restaurants-rest', { cache: entry.complete ? 'hit' : 'partial', pages: entry.pagesFetched, n: results.length });
    res.json({ restaurants: results, complete: true });
  } catch (err) {
    console.error('Background Places fetch failed:', err);
    res.status(502).json({ error: 'Could not finish loading more results.', restaurants: [] });
  }
});

app.get('/api/progress', requireAuth, async (req, res) => {
  if (!PLACES_SERVER_KEY) {
    return res.status(500).json({ error: 'Server is missing GOOGLE_PLACES_SERVER_KEY. Add it to .env.', city: null });
  }

  const lat = parseCoord(req.query.lat, 90);
  const lng = parseCoord(req.query.lng, 180);

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return res.status(400).json({ error: 'lat and lng are required.', city: null });
  }

  try {
    const city = await geocodeCity(lat, lng);
    if (!city) {
      return res.json({ city: null, discovered: 0, visited: 0 });
    }
    res.json(getProgress(req.user.id, city));
  } catch (err) {
    console.error('Failed to compute progress:', err);
    res.status(500).json({ error: 'Could not load progress right now.', city: null });
  }
});

// place_id is stable, globally unique, and carries no user data, so this is
// keyed and shared across all users. 24h TTL: Google returns at most 5
// reviews per place and they turn over on the scale of weeks, so a day of
// staleness is invisible to a "pick me a dish" prompt - and it's also a
// direct billing win, since Place Details is billed per call and a Surprise
// Me click fans out to 8-12 of them with otherwise zero reuse between clicks.
const reviewsCache = makeTtlCache({ ttlMs: 24 * 60 * 60 * 1000, maxEntries: 3000 });

// In-flight fetches are shared so a recommend that arrives while a prewarm is
// still running waits for it instead of billing a second Place Details call.
const inflightReviews = new Map();

function fetchPlaceReviews(placeId) {
  const cached = reviewsCache.get(placeId);
  if (cached) return Promise.resolve(cached.reviews);
  if (!inflightReviews.has(placeId)) {
    const p = fetchPlaceReviewsUncached(placeId).finally(() => inflightReviews.delete(placeId));
    inflightReviews.set(placeId, p);
  }
  return inflightReviews.get(placeId);
}

async function fetchPlaceReviewsUncached(placeId) {

  const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
  url.searchParams.set('place_id', placeId);
  url.searchParams.set('fields', 'reviews');
  url.searchParams.set('key', PLACES_SERVER_KEY);

  let reviews = [];
  let cacheable = false;
  let quotaHit = false;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
    const data = await readGoogleJson(response);

    if (data.status === 'OK') {
      reviews = (data.result.reviews || []).map(r => r.text).filter(Boolean).map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean); // collapse whitespace: fewer prompt chars, same content
      cacheable = true;
    } else if (data.status === 'ZERO_RESULTS' || data.status === 'NOT_FOUND') {
      // NOT_FOUND (a closed or removed place) is a definite answer, not a
      // failure, so it's cached like an empty result.
      cacheable = true;
    } else {
      console.error('Place Details error:', data.status, data.error_message || '');
      if (GOOGLE_QUOTA_STATUSES.has(data.status)) quotaHit = true;
    }
  } catch (err) {
    console.error('Place Details request failed:', err);
  }

  // A successful [] (a place with no reviews) is cached too, or a dud place
  // gets re-fetched on every click. A failed response (quota, timeout) is
  // not, so reviews come back as soon as Google does.
  if (cacheable) reviewsCache.set(placeId, { reviews });
  if (quotaHit) {
    const err = new Error('Place Details quota exhausted');
    err.code = GOOGLE_QUOTA_ERROR.code;
    throw err;
  }
  return reviews;
}

function groupInstruction(groupSize, sharing, targetPrice) {
  // The one-person default is stated once in the system prompt (askClaudeForRecommendation).
  if (groupSize <= 1) return '';
  if (sharing) {
    const totalBudget = totalGroupBudget(groupSize, targetPrice);
    const perPerson = PRICE_TIER_MAX_USD[targetPrice] || PRICE_TIER_MAX_USD[2];
    return `This is for a group of ${groupSize} people who want to share dishes family-style, with a total budget ` +
      `for the table of roughly $${totalBudget} (about $${perPerson} per person). Use that budget to judge how many ` +
      `items is reasonable, but do NOT invent or state prices, since real menu prices aren't available to you. ` +
      `Suggest 3-5 specific shareable item names in the shared_items field, a mix of appetizers and mains to split, ` +
      `and set dish_suggestion to a short one-line summary of the whole shared order. Every item must be grounded in ` +
      `dishes the reviews actually mention. If the reviews only support one or two specific dishes, suggest fewer ` +
      `items (or fill out the order with something generic like "a couple of their most popular appetizers") rather ` +
      `than inventing dishes.`;
  }
  return `This is for a group of ${groupSize} people who each want their own main. Suggest one dish that ` +
    `works well as an individual order at this budget, since everyone will be ordering their own.`;
}

// Guests have no account, so their diet comes from the client. Only the fixed chip values pass; anything else is dropped.
const GUEST_DIETS = ['Vegetarian', 'Vegan', 'Gluten-Free', 'Dairy-Free', 'Nut-Free', 'Halal', 'Kosher', 'Shellfish-Free'];
function guestDietList(raw) {
  const list = typeof raw === 'string' ? raw.slice(0, 200).split(',') : raw;
  return Array.isArray(list) ? GUEST_DIETS.filter(d => list.includes(d)) : [];
}
function guestPreferences(raw) {
  const dietaryRestrictions = guestDietList(raw);
  return dietaryRestrictions.length ? { favoriteCuisines: [], dietaryRestrictions } : null;
}

function personalizationInstruction(preferences, visitHighlights) {
  const parts = [];

  if (preferences) {
    if (preferences.favoriteCuisines.length > 0) {
      parts.push(`They especially enjoy these cuisines: ${preferences.favoriteCuisines.join(', ')}.`);
    }
    if (preferences.dietaryRestrictions.length > 0) {
      parts.push(
        `They have these dietary restrictions: ${preferences.dietaryRestrictions.join(', ')}. Only suggest a ` +
        `dish as compliant if a review explicitly supports each restriction specifically, not a related one: ` +
        `"vegetarian" in a review does NOT confirm "vegan" (vegan is stricter, no dairy/eggs/honey either), ` +
        `though "vegan" does satisfy a vegetarian restriction. Don't infer compliance just because a place seems ` +
        `flexible or diverse. If no candidate's reviews support a compliant dish, don't name any specific dish, ` +
        `compliant or not, especially not one the reviews describe with obviously conflicting ingredients (e.g. ` +
        `meat or seafood for a vegan restriction); use a generic placeholder like "their most popular item" for ` +
        `dish_suggestion instead, and say plainly in your reason why no specific dish could be confirmed, rather ` +
        `than guessing, since menu/ingredient data isn't available and inventing one is never allowed.`
      );
    }
    if (preferences.spiceTolerance) parts.push(`Their spice tolerance is: ${preferences.spiceTolerance}.`);
  }

  if (visitHighlights.length > 0) {
    const summary = visitHighlights
      .map(v => `${v.restaurant_name} (rated ${v.rating}/5${v.dish ? `, ordered: ${v.dish}` : ''})`)
      .join('; ');
    parts.push(`Their recent dining history: ${summary}. Use this to gauge what they tend to like or dislike.`);
  }

  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

// The group equivalent of personalizationInstruction: instead of one
// person's preferences, combines every member's into a single instruction.
// Dietary restrictions are a union that ALL must satisfy (strictest wins,
// since any member could end up ordering the suggested dish), while
// cuisines/history are pooled as loose signal rather than a requirement.
function groupPersonalizationInstruction(members) {
  const parts = [`This order is for a group of ${members.length} friends searching together, not just one person.`];

  const allCuisines = [...new Set(members.flatMap(m => (m.preferences ? m.preferences.favoriteCuisines : [])))];
  if (allCuisines.length > 0) {
    parts.push(
      `Across the group, these cuisines are favorites for at least one person: ${allCuisines.join(', ')}. Weight ` +
      `toward these when it doesn't conflict with anyone's dietary restrictions, but this is a preference, not a requirement.`
    );
  }

  const allRestrictions = [...new Set(members.flatMap(m => (m.preferences ? m.preferences.dietaryRestrictions : [])))];
  if (allRestrictions.length > 0) {
    parts.push(
      `Combined dietary restrictions across the WHOLE group: ${allRestrictions.join(', ')}. Since any of these ` +
      `people could end up ordering the suggested dish, it must be compliant with EVERY restriction listed, not ` +
      `just some of them. Only suggest a dish as compliant if a review explicitly supports each restriction ` +
      `specifically, not a related one: "vegetarian" in a review does NOT confirm "vegan" (vegan is stricter, no ` +
      `dairy/eggs/honey either), though "vegan" does satisfy a vegetarian restriction. If no candidate's reviews ` +
      `support a dish compliant with ALL of these restrictions at once, don't name any specific dish, compliant or ` +
      `not, especially not one the reviews describe with obviously conflicting ingredients (e.g. meat or seafood ` +
      `when anyone in the group is vegan); use a generic placeholder like "their most popular item" for ` +
      `dish_suggestion instead, and say plainly in your reason why no specific dish could be confirmed for the whole group.`
    );
  }

  // Strictest wins, like dietary restrictions: the mildest tolerance in the group.
  const spiceOrder = ['mild', 'medium', 'hot'];
  const spiceLevels = members.filter(m => m.preferences).map(m => m.preferences.spiceTolerance);
  if (spiceLevels.length > 0) {
    const mildest = spiceLevels.reduce((a, b) => (spiceOrder.indexOf(b) < spiceOrder.indexOf(a) ? b : a));
    parts.push(
      `The group's spice tolerance is: ${mildest}, the mildest of any member's, so pick a dish everyone can handle ` +
      `with regard to spice.`
    );
  }

  // Round-robin (everyone's newest visit first) so the cap never drops later members.
  const lists = members.map(m => m.visitHighlights || []);
  const rounds = Math.max(0, ...lists.map(l => l.length));
  const historyLines = Array.from({ length: rounds }, (_, i) => lists.map(l => l[i]).filter(Boolean))
    .flat()
    .map(v => `${v.restaurant_name} (rated ${v.rating}/5${v.dish ? `, ordered: ${v.dish}` : ''})`)
    .slice(0, 12);
  if (historyLines.length > 0) {
    parts.push(`Recent dining history across the group: ${historyLines.join('; ')}. Use this to gauge what the group tends to like.`);
  }

  return ' ' + parts.join(' ');
}

function dishCravingInstruction(dish, dietaryRestrictions) {
  if (!dish) return '';
  const restrictionClause = dietaryRestrictions && dietaryRestrictions.length > 0
    ? ` Their dietary restrictions are: ${dietaryRestrictions.join(', ')}. Those restrictions apply to this ` +
      `craving too. Only suggest "${dish}" if a review explicitly supports each stated restriction specifically, ` +
      `not just a related one: a review calling something "vegetarian" does NOT confirm it's "vegan" (vegan is ` +
      `stricter, no dairy/eggs/honey either), though a review calling something "vegan" does satisfy a ` +
      `"vegetarian" restriction. Match the specific word (or a named meat-free/dairy-free/etc. item) to the ` +
      `specific restriction rather than treating any diet-adjacent word as good enough. Do not infer or assume a ` +
      `compliant version exists just because a restaurant seems flexible, accommodating, or diverse; guessing at ` +
      `a dish that isn't explicitly in the reviews is inventing a dish, which is never allowed, restrictions or ` +
      `not. Check every candidate for this kind of explicit evidence, not just the highest-rated one. Your reason ` +
      `must always end by stating plainly whether review evidence confirms this dish fits their dietary ` +
      `restrictions, or whether that could not be confirmed either way; never leave this unaddressed. If NONE of ` +
      `the candidates' reviews explicitly describe a compliant "${dish}", treat that exactly like "${dish}" not ` +
      `being available nearby: pick the best-reviewed candidate on its own merits, but don't name a specific dish ` +
      `that the reviews describe with obviously conflicting ingredients for their restrictions (e.g. meat or ` +
      `seafood for a vegan restriction); use a generic placeholder like "their most popular item" for ` +
      `dish_suggestion instead, and say plainly in your reason that none of the nearby options had review ` +
      `evidence of a "${dish}" that fit their dietary restrictions. Never put a diet label like "vegan" or ` +
      `"vegetarian" in the dish name itself unless a review for that exact restaurant used that word; the name ` +
      `is what someone reading quickly will trust most, so it can't claim something the reason then hedges on.`
    : '';
  // The craving rules themselves are static and live in CRAVING_RULES (system prompt).
  return ` The user is specifically craving "${dish}" today.${restrictionClause}`;
}

const CRAVING_RULES = ` If the user says they are craving a specific dish, only pick a restaurant whose reviews actually ` +
  `support serving something like that, and suggest that as the dish. If NONE of the candidates' reviews support the ` +
  `craved dish at all, do not pick one and pretend it's a fallback for it. Instead pick the best-reviewed candidate on ` +
  `its own merits, suggest a dish its reviews actually back up, and say plainly in your reason that you couldn't find ` +
  `the craved dish (by name) nearby so you're suggesting this instead. Never describe an unrelated dish as similar to ` +
  `or a substitute for the craved dish; that's more misleading than just admitting the craving wasn't found.`;

// The prompt tells Claude to avoid em/en dashes, but that's not guaranteed;
// strip any that slip through rather than showing them in user-facing text.
function stripDashesText(str) {
  // A dash between numbers is a range ("20-30"); elsewhere it becomes a comma. (?=\d|$) keeps a
  // streamed "$12–" prefix-stable with the final "$12-15".
  return typeof str === 'string'
    ? str.replace(/(\d)\s*[—–]\s*(?=\d|$)/g, '$1-').replace(/\s*[—–]\s*/g, ', ')
      .replace(/,\s*,/g, ',').replace(/,(\s*[.!?])/g, '$1')
    : str;
}

// The unsuffixed ID is the documented current one; the old date-suffixed
// string (claude-haiku-4-5-20251001) still works but pins to a snapshot.
const CLAUDE_HAIKU_MODEL = 'claude-haiku-4-5';

function recommendationToolDef(requireDietaryNote) {
  const required = ['place_id', 'dish_suggestion', 'reason', 'flavor_tags'];
  if (requireDietaryNote) required.push('dietary_note');

  return {
    name: 'recommend_restaurant',
    description: 'Return the single best restaurant recommendation with a specific dish suggestion.',
    // strict mode constrains decoding so the output is guaranteed schema-valid,
    // which directly targets the most common malformation (formatting artifacts
    // like `</reason>` leaking into a field instead of staying properly closed).
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        place_id: { type: 'string', description: 'The place_id of the chosen restaurant, copied exactly from one of the candidates.' },
        dish_suggestion: { type: 'string', description: 'A specific dish or menu item to order. For a sharing group, a short one-line summary of the whole shared order (e.g. "Dumplings, mapo tofu, and scallion pancakes to share").' },
        reason: { type: 'string', description: 'A friendly 1-2 sentence explanation referencing something concrete from the reviews.' },
        flavor_tags: {
          type: 'array',
          // strict:true rejects minItems/maxItems values other than 0 or 1
          // (Anthropic API constraint on strict array schemas), so the exact
          // count of 3 is enforced only by isValidRecommendation below rather
          // than the schema itself.
          description: 'An array of EXACTLY 3 flavor descriptors for the suggested dish, from the fixed list. Not 2, not 4 - exactly 3.',
          items: { type: 'string', enum: FLAVOR_TAGS }
        },
        shared_items: {
          type: 'array',
          description: 'ONLY for a sharing group (the prompt will say so explicitly): 3-5 specific item names for the table to share. No prices: real menu prices aren\'t available, so never estimate or invent one. For a single diner or a group ordering individual mains, omit this field entirely; do not include an empty array.',
          items: { type: 'string', description: 'The name of a dish or menu item to share.' }
        },
        dietary_note: {
          type: 'string',
          description: 'Required whenever the user/group has a dietary restriction: state plainly whether review evidence confirms the suggested dish fits it, or that this could not be confirmed. Omit entirely when there is no dietary restriction to address.'
        }
      },
      required,
      additionalProperties: false
    }
  };
}

// Best-effort parse of a JSON object prefix, as it arrives in a streamed
// tool_use input (input_json_delta fragments). Only handles what the
// recommend_restaurant schema produces: string values and arrays of strings.
// Returns every completed key in `values`, plus the in-progress string (if
// the prefix ends mid-string) under its key in `partial`.
function parsePartialToolInput(src) {
  const values = {};
  const partial = {};
  let i = 0;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  // Reads a JSON string starting at src[i] === '"'. Returns { value, done }.
  const str = () => {
    const start = i;
    i++;
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '"') { i++; return { value: JSON.parse(src.slice(start, i)), done: true }; }
      i++;
    }
    // Unterminated: drop a dangling escape (e.g. a lone `\` or partial \uXX)
    // before closing it off so JSON.parse can read what we have so far.
    const raw = src.slice(start).replace(/\\(u[0-9a-fA-F]{0,3})?$/, '');
    try { return { value: JSON.parse(raw + '"'), done: false }; } catch { return { value: '', done: false }; }
  };
  ws();
  if (src[i] !== '{') return { values, partial };
  i++;
  while (i < src.length) {
    ws();
    if (src[i] === '}' || src[i] !== '"') break;
    const key = str();
    if (!key.done) break;
    ws();
    if (src[i] !== ':') break;
    i++; ws();
    if (src[i] === '"') {
      const v = str();
      if (v.done) values[key.value] = v.value; else { partial[key.value] = v.value; break; }
    } else if (src[i] === '[') {
      i++;
      const arr = [];
      let closed = false;
      while (i < src.length) {
        ws();
        if (src[i] === ']') { i++; closed = true; break; }
        if (src[i] === ',') { i++; continue; }
        if (src[i] !== '"') break;
        const v = str();
        if (!v.done) break;
        arr.push(v.value);
      }
      if (closed) values[key.value] = arr; else { partial[key.value] = arr; break; }
    } else {
      break;
    }
    ws();
    if (src[i] === ',') i++;
  }
  return { values, partial };
}

// 400/401 and other non-429 4xx will fail the same way again; everything else is worth one more try.
function anthropicError(e, response) {
  const err = new Error(`Anthropic API error: ${e.type}: ${e.message}`);
  const status = response ? response.status : 0;
  err.permanent = ['invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error'].includes(e.type) ||
    (status >= 400 && status < 500 && status !== 429);
  const ra = response && Number(response.headers.get('retry-after'));
  err.retryAfterMs = ra > 0 ? Math.min(ra * 1000, 2000) : 500;
  return err;
}

// The usual 20s timeout, plus the client-gone signal when there is one.
const anthropicSignal = (abortSignal) => abortSignal
  ? AbortSignal.any([AbortSignal.timeout(20000), abortSignal])
  : AbortSignal.timeout(20000);

// Streams one Messages API call (stream:true) and returns the same
// { input, toolUseId } shape as the non-streamed call, calling onPartial with
// parsePartialToolInput's output each time more tool input arrives.
async function streamClaudeToolCall(requestBody, onPartial, abortSignal) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    signal: anthropicSignal(abortSignal),
    // eager_input_streaming turns off the API's per-parameter buffering, so
    // place_id arrives as soon as it's generated instead of after the whole
    // key/value is done (measured: ~2.7s -> first byte otherwise). The trade
    // is that the API no longer validates this input against the schema -
    // strict:true's guarantee doesn't hold for the streamed call - which is
    // fine here because every result goes through isValidRecommendation and
    // the (non-streamed, strict) repair retry anyway.
    body: JSON.stringify({
      ...requestBody,
      stream: true,
      tools: requestBody.tools.map(t => ({ ...t, eager_input_streaming: true }))
    })
  });

  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || !contentType.includes('text/event-stream')) {
    const data = await response.json().catch(() => ({}));
    const e = data.error || { type: `http_${response.status}`, message: 'unexpected response' };
    throw anthropicError(e, response);
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffered = '';
  let json = '';
  let toolUseId = null;
  let stopReason = null;
  let complete = null;
  while (!complete) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered = (buffered + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
    let sep;
    while ((sep = buffered.indexOf('\n\n')) !== -1) {
      const rawEvent = buffered.slice(0, sep);
      buffered = buffered.slice(sep + 2);
      const dataLine = rawEvent.split('\n').find(l => l.startsWith('data:'));
      if (!dataLine) continue;
      const event = JSON.parse(dataLine.slice(5).trim());
      if (event.type === 'error') {
        throw anthropicError(event.error);
      }
      if (event.type === 'message_delta' && event.delta && event.delta.stop_reason) {
        stopReason = event.delta.stop_reason;
      } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        toolUseId = event.content_block.id;
      } else if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
        json += event.delta.partial_json;
        if (onPartial) { try { onPartial(parsePartialToolInput(json)); } catch { /* partial display is best-effort */ } }
        // A fully closed top-level object can't be extended or truncated, so
        // stop here instead of waiting for the trailing stop events.
        if (toolUseId && json.trimEnd().endsWith('}')) {
          try { complete = JSON.parse(json); break; } catch { /* not finished yet */ }
        }
      }
    }
  }

  if (complete) {
    reader.cancel().catch(() => {});
    return { input: complete, toolUseId };
  }
  if (!toolUseId) throw new Error('Claude did not return a structured recommendation.');
  // Unvalidated eager input can be invalid JSON, or cut off by max_tokens.
  // Either way hand back an empty object: isValidRecommendation rejects it
  // and the repair retry takes over, same as any other malformed answer.
  let input = {};
  if (stopReason !== 'max_tokens') {
    try { input = JSON.parse(json); } catch { input = {}; }
  }
  return { input, toolUseId };
}

// Compact line format instead of JSON.stringify: same fields, about 70 fewer
// prompt characters per candidate (no repeated keys or per-review quoting).
// The place_id stays JSON-quoted so it can be returned exactly as given.
function formatCandidatesForPrompt(candidates) {
  const field = (v) => (v === undefined || v === null || v === '') ? '?' : String(v).replace(/\s+/g, ' ').trim();
  return candidates.map(c =>
    `"place_id":${JSON.stringify(String(c.place_id))} | ${field(c.name)} | ${field(c.cuisine)} | ${field(c.price)} | ${field(c.rating)}` +
    c.reviews.map(r => `\n${field(r)}`).join('')
  ).join('\n');
}

async function askClaudeForRecommendation(candidates, targetPrice, { groupSize, sharing, personalizationText, dietaryRestrictions, dish }, perfCounters, onPartial, abortSignal) {
  // Static instructions live in the system prompt so the per-request user
  // turn only carries what varies, and tools + system form a stable prefix.
  // One candidate = the instant path in /api/recommend already chose it.
  const system = `The user's message gives a budget ceiling and a list of candidate restaurants with their reviews. ` +
    `Each candidate starts with a line "place_id":"<id>" | name | cuisine | price level (0-4) | rating (out of 5), ` +
    `followed by its reviews, one per line (each review is collapsed onto a single line). ` +
    `If the list holds exactly one restaurant, it has already been chosen: return its place_id exactly as given. ` +
    `Otherwise pick exactly one restaurant from the list. ` +
    `Unless the user's message says it's for a group, this is for one person: suggest a single dish for them to order. ` +
    `Suggest one specific dish (or, for a sharing group, a short shareable order) to order, based only on what's ` +
    `actually mentioned in the reviews provided. Don't invent a dish that isn't referenced. ` +
    `If no review mentions a specific dish, suggest something generic like "their most popular item" instead of making one up. ` +
    `Only populate the shared_items field if the user's instructions say this is a sharing group, otherwise omit it entirely. ` +
    `In your reason, never use em dashes (—) or en dashes (–); use a period or comma instead. ` +
    `Also tag the dish with exactly 3 flavor descriptors from this fixed list, picking whichever 3 best describe it ` +
    `based on the reviews/cuisine: ${FLAVOR_TAGS.join(', ')}.` + CRAVING_RULES;
  const prompt = `Budget ceiling: ${'$'.repeat(targetPrice)}. ` +
    `${groupInstruction(groupSize, sharing, targetPrice)}` +
    `${personalizationText || ''}` +
    `${dishCravingInstruction(dish, dietaryRestrictions)}\n\n` +
    formatCandidatesForPrompt(candidates);

  const requireDietaryNote = Boolean(dietaryRestrictions && dietaryRestrictions.length > 0);
  const tool = recommendationToolDef(requireDietaryNote);

  // At most 3 Anthropic calls per request: a failed stream falls back to the
  // non-streamed call, which gets one retry on a transient fault.
  let calls = 0;
  async function callClaude(extraMessages) {
    abortSignal?.throwIfAborted(); // client left: don't pay for an answer nobody sees
    const requestBody = {
      model: CLAUDE_HAIKU_MODEL,
      max_tokens: 1024,
      tools: [tool],
      tool_choice: { type: 'tool', name: 'recommend_restaurant' },
      system,
      messages: [{ role: 'user', content: prompt }, ...(extraMessages || [])]
    };
    // Only the first call streams: a repair retry replaces whatever was
    // streamed, so there's nothing useful to show from it early.
    let lastErr;
    if (onPartial && !extraMessages) {
      calls++;
      if (perfCounters) perfCounters.claudeCalls++;
      try { return await streamClaudeToolCall(requestBody, onPartial, abortSignal); } catch (err) {
        if (err.permanent || abortSignal?.aborted) throw err;
        lastErr = err;
      }
    }
    for (;;) {
      if (lastErr) {
        if (calls >= 3) throw lastErr;
        await new Promise(r => setTimeout(r, lastErr.retryAfterMs || 500));
        abortSignal?.throwIfAborted();
      }
      calls++;
      if (perfCounters) perfCounters.claudeCalls++;
      try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
          },
          signal: anthropicSignal(abortSignal),
          body: JSON.stringify(requestBody)
        });
        // HTML error pages (proxies, outages) must become a retryable error, not a JSON throw.
        const data = await response.json().catch(() => ({}));
        if (data.error || !response.ok) {
          throw anthropicError(data.error || { type: `http_${response.status}`, message: 'unexpected response' }, response);
        }
        const toolUse = data.content && data.content.find(block => block.type === 'tool_use');
        if (!toolUse) throw new Error('Claude did not return a structured recommendation.');
        return { input: toolUse.input, toolUseId: toolUse.id };
      } catch (err) {
        if (err.permanent || lastErr || abortSignal?.aborted) throw err; // second failure in this call, or client gone: give up
        lastErr = err;
      }
    }
  }

  // strict:true plus the required dietary_note field should make malformed or
  // silently-noncompliant output rare; isValidRecommendation still catches it
  // rather than letting broken output reach the client. On a failure, the
  // retry is a short repair call (previous tool_use + what failed) instead of
  // blindly resending the whole candidate JSON, since it's both cheaper and
  // more likely to succeed than repeating the identical prompt verbatim.
  let { input: result, toolUseId } = await callClaude();
  const rawFirst = result;
  result = normalizeRecommendation(result);
  let failureReason = isValidRecommendation(result, candidates, dietaryRestrictions, true);
  if (failureReason) {
    const repair = await callClaude([
      { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'recommend_restaurant', input: rawFirst }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: `That response was invalid: ${failureReason}. Please try again.` }] }
    ]);
    result = normalizeRecommendation(repair.input);
    failureReason = isValidRecommendation(result, candidates, dietaryRestrictions, true);
    if (failureReason) {
      console.warn(`Claude returned a malformed recommendation twice in a row: ${failureReason}; using fallback`);
      result = fallbackRecommendation(candidates, result, dietaryRestrictions);
    }
  }
  return result;
}

function cleanRecentPickIds(ids) {
  return Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && id.length <= 200).slice(0, 5) : [];
}

function instantPickFor(groupData, preferences, visitHighlights, budgetPool, recentPickIds) {
  const members = groupData ? groupData.members : [{ preferences, visitHighlights }];
  return chooseInstantPick(
    budgetPool,
    [...new Set(members.flatMap(m => (m.preferences ? m.preferences.favoriteCuisines : [])))],
    members.flatMap(m => (m.visitHighlights || []).map(v => v.restaurant_name)),
    cleanRecentPickIds(recentPickIds)
  );
}

// The place /api/prewarm chose and warmed, per user (or IP for guests), so
// the next instant /api/recommend picks that same, already-cached place.
const warmedPicks = new Map();
const pickKey = req => (req.user ? 'u' + req.user.id : 'ip' + req.ip);

// Combines every group member's saved preferences and recent visit
// highlights into one dataset, used for both search-query enrichment
// (see /api/restaurants) and the recommendation prompt, so a group search
// is genuinely informed by everyone's data rather than just whoever
// clicked the button.
function getCombinedGroupData(groupId) {
  const members = getGroupMemberIds(groupId).map(id => ({
    preferences: getPreferences(id),
    visitHighlights: getVisitHighlights(id, 3)
  }));
  const dietaryRestrictions = [...new Set(members.flatMap(m => (m.preferences ? m.preferences.dietaryRestrictions : [])))];
  return { members, dietaryRestrictions };
}

app.post('/api/recommend', optionalAuth, async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY. Add it to .env.' });
  }

  const { price, groupSize, sharing, dish, groupId, recentPickIds } = req.body;
  const candidates = cleanCandidates(req.body.restaurants, knownPlaces);

  if (candidates.length === 0) {
    return res.status(400).json({ error: 'No restaurants to recommend from. Try widening your filters or searching again.' });
  }

  let groupData = null;
  if (groupId) {
    if (!req.user) return res.status(401).json({ error: 'Sign in to search as a group.' });
    if (!isGroupMember(Number(groupId), req.user.id)) {
      return res.status(403).json({ error: "You're not a member of that group." });
    }
    groupData = getCombinedGroupData(Number(groupId));
  }

  const isSharing = sharing === true;
  const dishCraving = sanitizeText(dish, 60);
  const preferences = req.user ? getPreferences(req.user.id) : guestPreferences(req.body.dietaryRestrictions);

  // A group's "size" is however many people are actually in it, not
  // whatever the manual Group Size filter happens to be set to.
  const clampedGroupSize = groupData
    ? Math.min(8, Math.max(1, groupData.members.length))
    : Math.min(8, Math.max(1, Number.isInteger(groupSize) ? groupSize : 1));

  const dietaryRestrictions = groupData ? groupData.dietaryRestrictions : (preferences ? preferences.dietaryRestrictions : []);

  const visitHighlights = !groupData && req.user ? getVisitHighlights(req.user.id) : [];
  const personalizationText = groupData
    ? groupPersonalizationInstruction(groupData.members)
    : personalizationInstruction(preferences, visitHighlights);

  const targetPrice = [1, 2, 3, 4].includes(Number(price)) ? Number(price) : Math.max(...candidates.map(r => r.price || 0));
  // Never send anyone to a place known to be closed; fall back only if everything is.
  const openCandidates = candidates.filter(r => r.openNow !== false);
  const budgetPool = pickBudgetPool(openCandidates.length > 0 ? openCandidates : candidates, targetPrice);

  // A dietary restriction (solo, or pooled across a group) means only some
  // candidates will have review text Claude can actually point to as
  // evidence, so give it more real reviews to search through instead of the
  // usual top 8.
  const hasDietaryRestriction = dietaryRestrictions.length > 0;
  const poolSize = hasDietaryRestriction ? 12 : 8;

  // When there's a specific-dish craving, `candidates` already arrives ranked
  // by Google's Text Search relevance to that dish, and re-sorting by star
  // rating here would throw that relevance away and let an unrelated but
  // highly-rated restaurant crowd out actually-relevant ones. Only randomize
  // and re-rank by rating for the generic (no-craving, "Surprise Me") case.
  //
  // Plain Surprise Me (no craving, no dietary restriction) takes the instant
  // path: the restaurant is chosen server-side right away and Claude only
  // writes the dish and reason for that one place, from its reviews alone
  // (1 review fetch and a much shorter prompt instead of 8). A craving or a
  // restriction still lets Claude compare every candidate's reviews, since
  // picking the right place there depends on what the reviews say.
  const instant = !dishCraving && !hasDietaryRestriction;
  let pool;
  if (instant) {
    // Use the pick /api/prewarm already warmed, if it is still a candidate.
    const warmed = warmedPicks.get(pickKey(req));
    warmedPicks.delete(pickKey(req));
    const warmedPick = warmed && Date.now() - warmed.at < 120000
      ? budgetPool.find(r => r.id === warmed.id) : null;
    pool = [warmedPick || instantPickFor(groupData, preferences, visitHighlights, budgetPool, recentPickIds)];
  } else {
    pool = dishCraving ? budgetPool.slice(0, poolSize) : pickRandomTopPool(budgetPool, poolSize);
  }

  // Streaming mode (Accept: text/event-stream): same pipeline, but sends the
  // chosen restaurant the moment Claude has emitted its place_id, then the
  // dish/reason text as it's generated, then the fully validated result.
  // The final `result` event is always authoritative - it's produced by the
  // exact same validation + repair path as the JSON response, and may even
  // name a different restaurant if the repair retry picked another one.
  const wantsStream = (req.get('accept') || '').includes('text/event-stream');
  // Aborted when the client disconnects before we finish answering.
  const clientGone = new AbortController();
  res.on('close', () => { if (!res.writableEnded) clientGone.abort(); });
  const send = (event, data) => {
    if (clientGone.signal.aborted) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    // compression() buffers until flushed; without this nothing reaches the
    // client until the response ends, which defeats the point.
    if (typeof res.flush === 'function') res.flush();
  };
  if (wantsStream) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
  }

  // The dish name and reason are only validated once the whole tool call has
  // arrived (isValidRecommendation). With a dietary restriction that
  // validation can reject the dish itself (a diet label the reviews don't
  // support, meat for a vegan), so in that case only the restaurant - whose
  // place_id is checked against the pool right here - is sent early, and the
  // dish/reason wait for the validated result. Without one, the only checks
  // on those fields are non-empty/no-markup, so streaming them is safe; stray
  // markup is stripped from partial text below as well.
  const streamText = !hasDietaryRestriction;
  const stripMarkup = (s) => typeof s === 'string' ? s.replace(/<\/?[a-zA-Z][^>]*>/g, '') : s;
  let sentPickId = null;
  let lastPartialJson = '';
  const onPartial = wantsStream ? ({ values, partial }) => {
    const placeId = values.place_id;
    if (placeId && placeId !== sentPickId) {
      const pickNow = pool.find(r => r.id === placeId);
      if (!pickNow) return; // not a real candidate; the repair path will handle it
      sentPickId = placeId;
      t.mark('first-pick');
      send('pick', { restaurant: pickNow });
    }
    if (!streamText || !sentPickId || isSharing) return;
    const dishText = values.dish_suggestion ?? partial.dish_suggestion;
    const reasonText = values.reason ?? partial.reason;
    const payload = {
      dish: dishText ? stripDashesText(stripMarkup(dishText)) : null,
      reason: reasonText ? stripDashesText(stripMarkup(reasonText)) : null
    };
    const serialized = JSON.stringify(payload);
    if (serialized !== lastPartialJson) {
      lastPartialJson = serialized;
      send('partial', payload);
    }
  } : null;

  const t = timer();
  if (wantsStream && instant) {
    sentPickId = pool[0].id;
    t.mark('first-pick');
    send('pick', { restaurant: pool[0] });
  }
  try {
    let reviewsCached = 0, reviewsFetched = 0, quotaHit = false;
    const withReviews = await Promise.all(pool.map(async r => {
      const wasCached = Boolean(reviewsCache.get(r.id));
      let reviews = [];
      try {
        reviews = await fetchPlaceReviews(r.id);
      } catch (err) {
        if (err.code !== GOOGLE_QUOTA_ERROR.code) throw err;
        quotaHit = true;
      }
      if (wasCached) reviewsCached++; else reviewsFetched++;
      return { place_id: r.id, name: r.name, cuisine: r.cuisine, price: r.price, rating: r.rating, reviews };
    }));
    // Out of quota with no cached reviews to fall back on: say so, rather
    // than letting Claude make a generic pick with nothing to go on.
    if (quotaHit && withReviews.every(r => r.reviews.length === 0)) {
      const err = new Error('Place Details quota exhausted for the whole pool');
      err.code = GOOGLE_QUOTA_ERROR.code;
      throw err;
    }
    t.mark('reviews');

    const perfCounters = { claudeCalls: 0 };
    const { place_id, dish_suggestion, reason, flavor_tags, shared_items, dietary_note } = await askClaudeForRecommendation(withReviews, targetPrice, {
      groupSize: clampedGroupSize,
      sharing: isSharing,
      personalizationText,
      dietaryRestrictions,
      dish: dishCraving
    }, perfCounters, onPartial, clientGone.signal);
    t.mark('claude');
    const pick = pool.find(r => r.id === place_id) || pool[0];

    // Only surface shared items in sharing mode, and drop any malformed entries
    // Claude might return (missing/empty name). No prices: real menu prices
    // aren't available, so we never show an invented dollar figure per item.
    const sharedItems = (isSharing && Array.isArray(shared_items))
      ? shared_items.filter(item => typeof item === 'string' && item.trim() !== '').map(item => item.trim())
      : [];

    // dietary_note is a separate structured field (see recommendationToolDef)
    // so it can't be silently omitted the way a regex-sniffed sentence inside
    // `reason` could; append it here so the user-facing text is unchanged.
    const fullReason = dietary_note ? `${reason} ${dietary_note}` : reason;

    const payload = {
      restaurant: pick,
      dish: { name: stripDashesText(dish_suggestion), flavorTags: flavor_tags, sharedItems: sharedItems.map(stripDashesText) },
      reason: stripDashesText(fullReason)
    };
    t.log('recommend', { reviewsCached, reviewsFetched, claudeCalls: perfCounters.claudeCalls, poolSize: pool.length, stream: wantsStream, instant });
    if (wantsStream) {
      send('result', payload);
      res.end();
    } else {
      res.setHeader('Server-Timing', t.header());
      res.json(payload);
    }
  } catch (err) {
    if (clientGone.signal.aborted) return; // client left; nothing to log or send
    console.error('Recommendation failed:', err);
    const quota = err.code === GOOGLE_QUOTA_ERROR.code;
    const body = quota ? GOOGLE_QUOTA_ERROR : { error: "Couldn't generate a recommendation right now. Try again in a moment." };
    if (wantsStream) {
      send('error', body);
      res.end();
    } else {
      res.status(quota ? 503 : 502).json(body);
    }
  }
});

// Intent-triggered warm-up for the reviews cache (item 12 in the plan): fired
// from a hover/focus on the Surprise Me button, before the click itself, so
// the fan-out in /api/recommend above can hit a warm cache. Deliberately NOT
// called automatically after every search - Place Details is billed per call,
// and most searches never lead to a Surprise Me click.

app.post('/api/prewarm', optionalAuth, apiLimiter, async (req, res) => {
  const { price, dish, groupId, recentPickIds } = req.body;
  // Same trust boundary as /api/recommend: only places this server returned.
  const candidates = cleanCandidates(req.body.restaurants, knownPlaces);
  let groupData = null;
  if (groupId && req.user && isGroupMember(Number(groupId), req.user.id)) {
    groupData = getCombinedGroupData(Number(groupId));
  }
  const preferences = req.user ? getPreferences(req.user.id) : guestPreferences(req.body.dietaryRestrictions);
  const restrictions = groupData ? groupData.dietaryRestrictions : (preferences ? preferences.dietaryRestrictions : []);
  const targetPrice = [1, 2, 3, 4].includes(Number(price)) ? Number(price) : Math.max(0, ...candidates.map(r => r.price || 0));
  // Never send anyone to a place known to be closed; fall back only if everything is.
  const openCandidates = candidates.filter(r => r.openNow !== false);
  const budgetPool = pickBudgetPool(openCandidates.length > 0 ? openCandidates : candidates, targetPrice);

  // Mirror /api/recommend: plain Surprise Me needs one place's reviews (the
  // pick, remembered for the recommend); a craving or restriction warms its pool.
  let placeIds = [];
  if (budgetPool.length > 0) {
    if (sanitizeText(dish, 60) || restrictions.length > 0) {
      placeIds = budgetPool.slice(0, restrictions.length > 0 ? 12 : 8).map(r => r.id);
    } else {
      const visitHighlights = !groupData && req.user ? getVisitHighlights(req.user.id) : [];
      const pick = instantPickFor(groupData, preferences, visitHighlights, budgetPool, recentPickIds);
      if (warmedPicks.size > 1000) warmedPicks.clear();
      warmedPicks.set(pickKey(req), { id: pick.id, at: Date.now() });
      placeIds = [pick.id];
    }
  }
  Promise.allSettled(placeIds.map(id => fetchPlaceReviews(id))).catch(() => {});
  res.status(202).json({ warming: placeIds.length });
});

function shapeVisit(row) {
  return {
    id: row.id,
    restaurantName: row.restaurant_name,
    dish: row.dish,
    rating: row.rating,
    loggedAt: row.logged_at
  };
}

const savedVisitsByKey = new Map();

app.post('/api/visits', requireAuth, (req, res) => {
  const { restaurantName, dish, rating, flavorTags } = req.body;

  const name = cleanText(restaurantName, 200);
  if (!name) {
    return res.status(400).json({ error: 'Restaurant name is required.' });
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be a whole number from 1 to 5.' });
  }

  const cleanFlavorTags = Array.isArray(flavorTags) ? [...new Set(flavorTags.filter(t => FLAVOR_TAGS.includes(t)))] : [];
  const cleanDish = cleanText(dish, 200);

  const idemKey = typeof req.body.idempotencyKey === 'string' && req.body.idempotencyKey.length <= 100
    ? `${req.user.id}:${req.body.idempotencyKey}` : null;
  if (idemKey && savedVisitsByKey.has(idemKey)) {
    return res.status(201).json({ visit: savedVisitsByKey.get(idemKey) });
  }

  try {
    const tz = typeof req.body.tz === 'string' ? req.body.tz : undefined;
    const earnedBefore = new Set(getBadges(req.user.id, tz).filter(b => b.earned).map(b => b.id));
    const visit = insertVisit({
      userId: req.user.id,
      restaurantName: name,
      dish: cleanDish || null,
      rating,
      flavorTags: cleanFlavorTags,
      loggedAt: req.body.loggedAt
    });
    const shaped = shapeVisit(visit);
    if (idemKey) {
      savedVisitsByKey.set(idemKey, shaped);
      // shortcut: in-memory, lost on restart and capped at 1000 keys; move to a table if multi-process.
      if (savedVisitsByKey.size > 1000) savedVisitsByKey.delete(savedVisitsByKey.keys().next().value);
    }
    const newBadges = getBadges(req.user.id, tz).filter(b => b.earned && !earnedBefore.has(b.id)).map(b => b.name);
    res.status(201).json({ visit: shaped, newBadges, currentStreak: getStreaks(req.user.id, tz).currentStreak });
  } catch (err) {
    console.error('Failed to save visit:', err);
    res.status(500).json({ error: 'Could not save your visit right now.' });
  }
});

app.get('/api/visits', requireAuth, (req, res) => {
  try {
    const beforeId = Number(req.query.beforeId);
    const before = req.query.beforeLoggedAt && Number.isInteger(beforeId)
      ? { loggedAt: String(req.query.beforeLoggedAt), id: beforeId }
      : undefined;
    res.json({ visits: listVisits(req.user.id, before).map(shapeVisit) });
  } catch (err) {
    console.error('Failed to load visits:', err);
    res.status(500).json({ error: 'Could not load past visits.', visits: [] });
  }
});

app.delete('/api/visits/:id', requireAuth, (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid visit id.' });
  try {
    // Someone else's visit looks the same as a missing one: 404.
    if (!deleteVisit(req.user.id, Number(req.params.id))) {
      return res.status(404).json({ error: 'Visit not found.' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to delete visit:', err);
    res.status(500).json({ error: 'Could not delete that visit right now.' });
  }
});

app.get('/api/flavors', requireAuth, (req, res) => {
  try {
    res.json({ topFlavors: getTopFlavors(req.user.id) });
  } catch (err) {
    console.error('Failed to load top flavors:', err);
    res.status(500).json({ error: 'Could not load top flavors right now.', topFlavors: [] });
  }
});

app.get('/api/streaks', requireAuth, (req, res) => {
  try {
    res.json(getStreaks(req.user.id, req.query.tz));
  } catch (err) {
    console.error('Failed to load streaks:', err);
    res.status(500).json({ error: 'Could not load your streak right now.', currentStreak: 0, longestStreak: 0, lastVisitDate: null });
  }
});

app.get('/api/badges', requireAuth, (req, res) => {
  try {
    res.json({ badges: getBadges(req.user.id, req.query.tz) });
  } catch (err) {
    console.error('Failed to load badges:', err);
    res.status(500).json({ error: 'Could not load badges right now.', badges: [] });
  }
});

app.get('/api/leaderboard', requireAuth, (req, res) => {
  try {
    const stats = getLeaderboardStats(req.user.id, req.query.tz, { optInOnly: true });
    const leaderboard = stats.map((row, i) => ({
      rank: i + 1,
      displayName: publicDisplayName(getUserById(row.userId)),
      visitCount: row.visitCount,
      currentStreak: row.currentStreak,
      longestStreak: row.longestStreak,
      isYou: row.userId === req.user.id
    }));
    res.json({ leaderboard, optIn: getLeaderboardOptIn(req.user.id) });
  } catch (err) {
    console.error('Failed to load leaderboard:', err);
    res.status(500).json({ error: 'Could not load the leaderboard right now.', leaderboard: [] });
  }
});

app.post('/api/leaderboard/optin', requireAuth, (req, res) => {
  if (typeof (req.body || {}).optIn !== 'boolean') return res.status(400).json({ error: 'optIn must be true or false.' });
  try {
    setLeaderboardOptIn(req.user.id, req.body.optIn);
    res.json({ optIn: req.body.optIn });
  } catch (err) {
    console.error('Failed to save leaderboard opt-in:', err);
    res.status(500).json({ error: 'Could not save that right now.' });
  }
});

const SPICE_TOLERANCES = new Set(['mild', 'medium', 'hot']);

function isStringArray(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

// trim, cap at 60 chars, drop case-insensitive duplicates, keep first 10
function cleanPrefList(list) {
  const seen = new Set();
  return list.map(x => cleanText(x, 60)).filter(x => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase())).slice(0, 10);
}

app.get('/api/preferences', requireAuth, (req, res) => {
  try {
    res.json({ preferences: getPreferences(req.user.id) });
  } catch (err) {
    console.error('Failed to load preferences:', err);
    res.status(500).json({ error: 'Could not load preferences right now.', preferences: null });
  }
});

app.post('/api/preferences', requireAuth, (req, res) => {
  const { favoriteCuisines, dietaryRestrictions, spiceTolerance } = req.body;

  if (!isStringArray(favoriteCuisines) || !isStringArray(dietaryRestrictions)) {
    return res.status(400).json({ error: 'favoriteCuisines and dietaryRestrictions must both be arrays of text.' });
  }
  if (!SPICE_TOLERANCES.has(spiceTolerance)) {
    return res.status(400).json({ error: 'spiceTolerance must be one of: mild, medium, hot.' });
  }

  try {
    const preferences = savePreferences(req.user.id, {
      favoriteCuisines: cleanPrefList(favoriteCuisines),
      dietaryRestrictions: cleanPrefList(dietaryRestrictions),
      spiceTolerance
    });
    res.json({ preferences });
  } catch (err) {
    console.error('Failed to save preferences:', err);
    res.status(500).json({ error: 'Could not save preferences right now.' });
  }
});

app.post('/api/groups', requireAuth, (req, res) => {
  const name = cleanText(req.body.name, 40);
  if (!name) {
    return res.status(400).json({ error: 'A group name is required.' });
  }

  try {
    const group = createGroup(req.user.id, name);
    res.json({ group: { id: group.id, name: group.name, code: group.code, memberCount: 1 } });
  } catch (err) {
    console.error('Failed to create group:', err);
    res.status(500).json({ error: 'Could not create the group right now.' });
  }
});

app.post('/api/groups/join', joinLimiter, requireAuth, (req, res) => {
  const code = typeof req.body.code === 'string' ? req.body.code.replace(/[^A-Za-z0-9]/g, '') : '';
  if (!code) {
    return res.status(400).json({ error: 'A group code is required.' });
  }

  try {
    const group = joinGroupByCode(req.user.id, code);
    if (!group) {
      return res.status(404).json({ error: 'No group found with that code.' });
    }
    res.json({ group: { id: group.id, name: group.name, code: group.code } });
  } catch (err) {
    console.error('Failed to join group:', err);
    res.status(500).json({ error: 'Could not join the group right now.' });
  }
});

app.get('/api/groups', requireAuth, (req, res) => {
  try {
    const groups = listUserGroups(req.user.id).map(g => ({
      id: g.id, name: g.name, code: g.code, memberCount: g.member_count
    }));
    res.json({ groups });
  } catch (err) {
    console.error('Failed to load groups:', err);
    res.status(500).json({ error: 'Could not load your groups right now.', groups: [] });
  }
});

app.get('/api/groups/:id/members', requireAuth, (req, res) => {
  const groupId = Number(req.params.id);
  if (!isGroupMember(groupId, req.user.id)) {
    return res.status(403).json({ error: "You're not a member of that group." });
  }

  try {
    const members = getGroupMembers(groupId).map(m => ({
      id: m.id,
      displayName: publicDisplayName(m),
      isYou: m.id === req.user.id
    }));
    res.json({ members });
  } catch (err) {
    console.error('Failed to load group members:', err);
    res.status(500).json({ error: 'Could not load group members right now.', members: [] });
  }
});

app.post('/api/groups/:id/leave', requireAuth, (req, res) => {
  const groupId = Number(req.params.id);
  try {
    leaveGroup(groupId, req.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to leave group:', err);
    res.status(500).json({ error: 'Could not leave the group right now.' });
  }
});

const httpServer = app.listen(PORT, () => {
  console.log(`FoodFindr running at http://localhost:${PORT}`);
});

// Graceful shutdown: let in-flight requests finish, then close the DB (checkpoints the WAL).
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Hard deadline so a hung stream cannot block exit forever.
  setTimeout(() => process.exit(1), 10000).unref();
  httpServer.close(() => {
    try { closeDb(); } catch (err) { console.error('DB close failed:', err); }
    process.exit(0);
  });
  httpServer.closeIdleConnections();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
