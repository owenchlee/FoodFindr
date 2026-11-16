// Trust boundary for client-supplied restaurant data. Pure + offline.
const MAX_CANDIDATES = 60; // Google returns at most 60 results per search
const MAX_PREWARM_IDS = 15;
const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;

// Strips markup and control chars so a name can't smuggle instructions or tags
// into the Claude prompt. shortcut: tag-stripping is regex-based, fine for a
// plain-text prompt; revisit if this text is ever rendered as HTML.
function sanitizeText(s, max) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/<[^>]*>?/g, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ') // control, zero-width/bidi, line separators
    .replace(/[<>`{}[\]\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const finite = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null);

// Returns a clean candidate holding only the fields the app uses, or null.
function sanitizeCandidate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.id !== 'string' || !PLACE_ID_RE.test(raw.id)) return null;
  const name = sanitizeText(raw.name, 100);
  if (!name) return null;
  const lat = finite(raw.lat, -90, 90);
  const lng = finite(raw.lng, -180, 180);
  if (lat == null || lng == null) return null;
  const price = finite(raw.price, 0, 4);
  return {
    id: raw.id,
    name,
    cuisine: sanitizeText(raw.cuisine, 50) || 'Restaurant',
    price: price == null ? null : Math.round(price),
    rating: finite(raw.rating, 0, 5),
    ratingCount: finite(raw.ratingCount, 0, 1e7),
    lat, lng,
    distance: finite(raw.distance, 0, 1000),
    openNow: typeof raw.openNow === 'boolean' ? raw.openNow : null
  };
}

// Remembers place ids this server returned from its own searches, so billed
// Place Details calls can only be spent on real, recently-seen places.
function makeKnownPlaces({ ttlMs = 2 * 60 * 60 * 1000, maxEntries = 5000, now = Date.now } = {}) {
  const map = new Map();
  return {
    add(restaurants) {
      const t = now() + ttlMs;
      for (const r of restaurants) {
        if (!r || typeof r.id !== 'string') continue;
        map.delete(r.id);
        map.set(r.id, t);
      }
      while (map.size > maxEntries) map.delete(map.keys().next().value);
    },
    has(id) {
      const exp = map.get(id);
      if (exp === undefined) return false;
      if (now() > exp) { map.delete(id); return false; }
      return true;
    },
    get size() { return map.size; }
  };
}

// Whole /api/recommend candidate list -> capped, sanitised, known-only, de-duplicated.
function cleanCandidates(raw, known) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw.slice(0, MAX_CANDIDATES)) {
    const c = sanitizeCandidate(item);
    if (!c || seen.has(c.id) || !known.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

function cleanPlaceIds(raw, known) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.slice(0, MAX_PREWARM_IDS * 4))]
    .filter(id => typeof id === 'string' && PLACE_ID_RE.test(id) && known.has(id))
    .slice(0, MAX_PREWARM_IDS);
}

module.exports = { MAX_CANDIDATES, MAX_PREWARM_IDS, sanitizeText, sanitizeCandidate, makeKnownPlaces, cleanCandidates, cleanPlaceIds };
