require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const {
  insertVisit, listVisits, getVisitHighlights, getTopFlavors,
  getPreferences, savePreferences,
  recordDiscovered, getProgress,
  getStreaks, getBadges, getLeaderboardStats,
  createGroup, joinGroupByCode, listUserGroups, isGroupMember,
  getGroupMemberIds, getGroupMembers, leaveGroup
} = require('./db');
const {
  SESSION_COOKIE_NAME,
  isValidEmail, isValidPassword,
  signup, login,
  startSession, setSessionCookie, clearSessionCookie, endSession,
  parseCookies, requireAuth, optionalAuth
} = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;
const PLACES_SERVER_KEY = process.env.GOOGLE_PLACES_SERVER_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (process.env.NODE_ENV === 'production') {
  // Needed behind the deploy host's reverse proxy so express-rate-limit and
  // secure-cookie logic see the real client IP/protocol instead of the proxy's.
  app.set('trust proxy', 1);
}

// Fixed vocabulary (not free-form) so tags can actually be aggregated into
// "top flavors" later. Free text from Claude would fragment across
// synonyms like "tangy" vs "zesty" vs "sour".
const FLAVOR_TAGS = ['Spicy', 'Tangy', 'Sweet', 'Savory', 'Umami', 'Sour', 'Smoky', 'Creamy', 'Fresh', 'Rich', 'Herby', 'Crispy'];

// Per-person dollar ceilings for each price tier. Must match the UI hint text in
// index.html: "$ under $15 · $$ under $30 · $$$ under $60, per person (approximate)".
const PRICE_TIER_MAX_USD = { 1: 15, 2: 30, 3: 60 };

function totalGroupBudget(groupSize, targetPrice) {
  const perPerson = PRICE_TIER_MAX_USD[targetPrice] || PRICE_TIER_MAX_USD[2];
  return groupSize * perPerson;
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
app.use(express.json());
app.use(parseCookies);
app.use(express.static(path.join(__dirname, '..', 'public')));

// /api/restaurants and /api/recommend hit billed Google Places/Anthropic
// calls per request, so an unlimited public endpoint is a cost-abuse risk.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false
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
    res.json({ user: { id: result.user.id, email: result.user.email } });
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

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

function distanceInMiles(lat1, lng1, lat2, lng2) {
  const earthRadiusMiles = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return earthRadiusMiles * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Words Places' `types` array uses that aren't useful as a displayed "cuisine"
const GENERIC_PLACE_TYPES = new Set(['restaurant', 'food', 'point_of_interest', 'establishment']);

// Venues (hotels, gyms, spas) that carry a "restaurant" type just because they
// have in-house dining, not because they are one. Filter these out.
const NON_RESTAURANT_TYPES = new Set(['lodging', 'gym', 'spa', 'night_club', 'casino']);

function titleCase(str) {
  return str.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function placeToRestaurant(place, cuisineHint) {
  const specificType = place.types && place.types.find(t => !GENERIC_PLACE_TYPES.has(t));
  return {
    id: place.place_id,
    name: place.name,
    cuisine: cuisineHint ? titleCase(cuisineHint) : (specificType ? titleCase(specificType) : 'Restaurant'),
    price: place.price_level != null ? place.price_level : null,
    rating: place.rating != null ? place.rating : null,
    lat: place.geometry.location.lat,
    lng: place.geometry.location.lng
  };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Google returns at most 20 results per call; a `next_page_token` unlocks up
// to 2 more pages (60 total, Google's hard cap; there's no way to get
// "every" restaurant in a city from this API). Each extra page is a
// separate billed Places Search request, so this roughly triples search
// cost versus a single page.
const MAX_PLACES_PAGES = 3;

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

  const response = await fetch(url);
  return response.json();
}

async function fetchPlaces(lat, lng, radiusMeters, cuisine, dish, dietaryHint) {
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

  const allResults = [];
  let pageToken = null;

  for (let page = 0; page < MAX_PLACES_PAGES; page++) {
    let data = await fetchPlacesPage(endpoint, params, pageToken);

    if (data.status === 'INVALID_REQUEST' && pageToken) {
      // A fresh next_page_token isn't active immediately on Google's side. Retry once after a beat.
      await delay(1500);
      data = await fetchPlacesPage(endpoint, params, pageToken);
    }

    if (data.status === 'ZERO_RESULTS') break;
    if (data.status !== 'OK') {
      if (page === 0) {
        throw new Error(`Places API error: ${data.status}${data.error_message ? ': ' + data.error_message : ''}`);
      }
      break; // keep whatever earlier pages already returned instead of discarding it
    }

    allResults.push(...(data.results || []));

    if (!data.next_page_token) break;
    pageToken = data.next_page_token;
    await delay(2000); // Google requires a short delay before a page token becomes valid
  }

  return allResults;
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
    const response = await fetch(url);
    const data = await response.json();

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

  try {
    const response = await fetch(url);
    const data = await response.json();

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

app.get('/api/restaurants', optionalAuth, async (req, res) => {
  if (!PLACES_SERVER_KEY) {
    return res.status(500).json({ error: 'Server is missing GOOGLE_PLACES_SERVER_KEY. Add it to .env.', restaurants: [] });
  }

  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return res.status(400).json({ error: 'A location (lat/lng) is required.', restaurants: [] });
  }
  const { price, cuisine, maxDistance, groupId } = req.query;
  const dish = typeof req.query.dish === 'string' ? req.query.dish.trim().slice(0, 60) : '';

  const distanceMiles = maxDistance ? Number(maxDistance) : 3;
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
  }
  const dietaryHint = dietaryRestrictionsForHint.join(' ');

  try {
    const places = await fetchPlaces(lat, lng, radiusMeters, cuisine, dish, dietaryHint);

    let results = places
      .filter(place => place.geometry && place.geometry.location)
      .filter(place => !(place.types || []).some(t => NON_RESTAURANT_TYPES.has(t)))
      .filter(place => !place.business_status || place.business_status === 'OPERATIONAL')
      .map(place => {
        const restaurant = placeToRestaurant(place, cuisine);
        return {
          ...restaurant,
          distance: Math.round(distanceInMiles(lat, lng, restaurant.lat, restaurant.lng) * 10) / 10
        };
      });

    if (price) {
      const targetPrice = Number(price);
      results = results.filter(r => r.price == null || r.price <= targetPrice);
    }
    if (maxDistance) {
      results = results.filter(r => r.distance <= Number(maxDistance));
    }

    const city = await geocodeCity(lat, lng);
    if (city && results.length > 0 && req.user) {
      recordDiscovered(req.user.id, results, city);
    }

    res.json({ searchCenter: { lat, lng }, city, restaurants: results });
  } catch (err) {
    console.error('Places API request failed:', err);
    res.status(502).json({ error: 'Could not reach Google Places right now. Try again in a moment.', restaurants: [] });
  }
});

app.get('/api/progress', requireAuth, async (req, res) => {
  if (!PLACES_SERVER_KEY) {
    return res.status(500).json({ error: 'Server is missing GOOGLE_PLACES_SERVER_KEY. Add it to .env.', city: null });
  }

  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);

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

async function fetchPlaceReviews(placeId) {
  const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
  url.searchParams.set('place_id', placeId);
  url.searchParams.set('fields', 'reviews');
  url.searchParams.set('key', PLACES_SERVER_KEY);

  const response = await fetch(url);
  const data = await response.json();

  if (data.status !== 'OK') {
    console.error('Place Details error:', data.status, data.error_message || '');
    return [];
  }

  return (data.result.reviews || []).map(r => r.text).filter(Boolean);
}

function groupInstruction(groupSize, sharing, targetPrice) {
  if (groupSize <= 1) {
    return 'This is for one person. Suggest a single dish for them to order.';
  }
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
    parts.push(`Their spice tolerance is: ${preferences.spiceTolerance}.`);
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

  const historyLines = members
    .flatMap(m => (m.visitHighlights || []).map(v => `${v.restaurant_name} (rated ${v.rating}/5${v.dish ? `, ordered: ${v.dish}` : ''})`))
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
  return ` The user is specifically craving "${dish}" today. Only pick a restaurant whose reviews actually support ` +
    `serving something like that, and suggest that as the dish. If NONE of the candidates' reviews support "${dish}" ` +
    `at all, do not pick one and pretend it's a fallback for it. Instead pick the best-reviewed candidate on its own ` +
    `merits, suggest a dish its reviews actually back up, and say plainly in your reason that you couldn't find ` +
    `"${dish}" nearby so you're suggesting this instead. Never describe an unrelated dish as similar to or a ` +
    `substitute for "${dish}"; that's more misleading than just admitting the craving wasn't found.${restrictionClause}`;
}

async function askClaudeForRecommendation(candidates, targetPrice, { groupSize, sharing, personalizationText, dietaryRestrictions, dish }) {
  const prompt = `Pick exactly one restaurant from this list for someone with a budget ceiling of ${'$'.repeat(targetPrice)}. ` +
    `Suggest one specific dish (or, for a sharing group, a short shareable order) to order, based only on what's ` +
    `actually mentioned in the reviews provided. Don't invent a dish that isn't referenced. ` +
    `If no review mentions a specific dish, suggest something generic like "their most popular item" instead of making one up. ` +
    `Only populate the shared_items field if the instructions below say this is a sharing group, otherwise omit it entirely. ` +
    `In your reason, never use em dashes (—) or en dashes (–); use a period or comma instead. ` +
    `Also tag the dish with exactly 3 flavor descriptors from this fixed list, picking whichever 3 best describe it ` +
    `based on the reviews/cuisine: ${FLAVOR_TAGS.join(', ')}. ` +
    `${groupInstruction(groupSize, sharing, targetPrice)}` +
    `${personalizationText || ''}` +
    `${dishCravingInstruction(dish, dietaryRestrictions)}\n\n` +
    JSON.stringify(candidates, null, 2);

  async function callClaude() {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        tools: [{
          name: 'recommend_restaurant',
          description: 'Return the single best restaurant recommendation with a specific dish suggestion.',
          input_schema: {
            type: 'object',
            properties: {
              place_id: { type: 'string', description: 'The place_id of the chosen restaurant, copied exactly from one of the candidates.' },
              dish_suggestion: { type: 'string', description: 'A specific dish or menu item to order. For a sharing group, a short one-line summary of the whole shared order (e.g. "Dumplings, mapo tofu, and scallion pancakes to share").' },
              reason: { type: 'string', description: 'A friendly 1-2 sentence explanation referencing something concrete from the reviews.' },
              flavor_tags: {
                type: 'array',
                description: 'Exactly 3 flavor descriptors for the suggested dish, from the fixed list.',
                items: { type: 'string', enum: FLAVOR_TAGS },
                minItems: 3,
                maxItems: 3
              },
              shared_items: {
                type: 'array',
                description: 'ONLY for a sharing group (the prompt will say so explicitly): 3-5 specific item names for the table to share. No prices: real menu prices aren\'t available, so never estimate or invent one. For a single diner or a group ordering individual mains, omit this field entirely; do not include an empty array.',
                items: { type: 'string', description: 'The name of a dish or menu item to share.' }
              }
            },
            required: ['place_id', 'dish_suggestion', 'reason', 'flavor_tags']
          }
        }],
        tool_choice: { type: 'tool', name: 'recommend_restaurant' },
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();

    if (data.error) {
      throw new Error(`Anthropic API error: ${data.error.type}: ${data.error.message}`);
    }

    const toolUse = data.content && data.content.find(block => block.type === 'tool_use');
    if (!toolUse) {
      throw new Error('Claude did not return a structured recommendation.');
    }

    return toolUse.input;
  }

  // Structured tool-use output occasionally malforms on a long `reason` string
  // (formatting artifacts like `</reason>` or `<parameter...>` leaking into the
  // text instead of staying in the proper fields), and separately, the reason
  // sometimes just skips disclosing dietary-fit even though it's required.
  // One retry clears either case up almost always; isValidRecommendation
  // catches it rather than letting broken or silently-noncompliant output
  // reach the client.
  let result = await callClaude();
  if (!isValidRecommendation(result, candidates, dietaryRestrictions)) {
    result = await callClaude();
    if (!isValidRecommendation(result, candidates, dietaryRestrictions)) {
      throw new Error('Claude returned a malformed recommendation twice in a row.');
    }
  }
  return result;
}

function isValidRecommendation(input, candidates, dietaryRestrictions) {
  if (!input || typeof input !== 'object') return false;
  if (typeof input.place_id !== 'string' || !candidates.some(c => c.place_id === input.place_id)) return false;
  if (typeof input.dish_suggestion !== 'string' || !input.dish_suggestion.trim()) return false;
  if (typeof input.reason !== 'string' || !input.reason.trim() || /<\/?\w+[^>]*>/.test(input.reason)) return false;
  if (!Array.isArray(input.flavor_tags) || input.flavor_tags.length !== 3) return false;
  if (!input.flavor_tags.every(tag => FLAVOR_TAGS.includes(tag))) return false;
  if (dietaryRestrictions && dietaryRestrictions.length > 0) {
    const mentionsCompliance = /vegan|vegetarian|dietary|restriction|plant-based|compliant|confirm/i.test(input.reason)
      || dietaryRestrictions.some(r => input.reason.toLowerCase().includes(r.toLowerCase()));
    if (!mentionsCompliance) return false;

    // The dish name itself must not assert a diet label ("Vegan tacos") unless a
    // review for that exact restaurant actually used that word. Otherwise the name
    // alone (more prominent in the UI than the full reason) can mislead someone
    // skimming past a hedge buried in the reason text.
    const dietLabels = ['vegan', 'vegetarian', 'plant-based', 'plant based', 'dairy-free', 'dairy free'];
    const dishText = [input.dish_suggestion, ...(Array.isArray(input.shared_items) ? input.shared_items : [])]
      .join(' ').toLowerCase();
    const namedLabels = dietLabels.filter(label => dishText.includes(label));
    if (namedLabels.length > 0) {
      const chosen = candidates.find(c => c.place_id === input.place_id);
      const reviewText = (chosen && Array.isArray(chosen.reviews) ? chosen.reviews.join(' ') : '').toLowerCase();
      const groundedInReviews = namedLabels.some(label => reviewText.includes(label));
      if (!groundedInReviews) return false;
    }

    // Naming a dish with an obvious meat/seafood ingredient for a vegan or
    // vegetarian restriction is unsafe even with a hedge in the reason text,
    // since the dish name is what someone skimming will actually trust.
    const needsMeatCheck = dietaryRestrictions.some(r => /vegan|vegetarian/i.test(r));
    if (needsMeatCheck) {
      const meatWords = ['chicken', 'beef', 'pork', 'bacon', 'ham', 'turkey', 'lamb', 'steak',
        'sausage', 'meat', 'fish', 'shrimp', 'prawn', 'calamari', 'squid', 'crab', 'lobster',
        'salmon', 'tuna', 'duck', 'veal', 'goat', 'mutton'];
      const foundMeatWord = meatWords.some(word => new RegExp(`\\b${word}\\b`, 'i').test(dishText));
      if (foundMeatWord) return false;
    }
  }
  return true;
}

// "Surprise Me" should actually surprise: asking Claude to pick the single
// "best" restaurant from the same top-8-by-rating list every time reliably
// returns the same winner call after call, since nothing about the prompt or
// candidate set changes between clicks. Sampling randomly from a wider
// top-rated slice means each click genuinely can land on a different (still
// good) restaurant, instead of relying on the model to invent variety on its
// own, which isn't a reliable way to get it.
function pickRandomTopPool(restaurants, poolSize) {
  const topN = restaurants
    .slice()
    .sort((a, b) => (b.rating || 0) - (a.rating || 0))
    .slice(0, Math.max(poolSize * 2, 15));

  for (let i = topN.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [topN[i], topN[j]] = [topN[j], topN[i]];
  }
  return topN.slice(0, poolSize);
}

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

  const { restaurants: candidates, price, groupSize, sharing, dish, groupId } = req.body;

  if (!candidates || candidates.length === 0) {
    return res.status(400).json({ error: 'No restaurants to recommend from. Try widening your filters.' });
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
  const dishCraving = typeof dish === 'string' ? dish.trim().slice(0, 60) : '';
  const preferences = req.user ? getPreferences(req.user.id) : null;

  // A group's "size" is however many people are actually in it, not
  // whatever the manual Group Size filter happens to be set to.
  const clampedGroupSize = groupData
    ? Math.min(8, Math.max(1, groupData.members.length))
    : Math.min(8, Math.max(1, Number.isInteger(groupSize) ? groupSize : 1));

  const dietaryRestrictions = groupData ? groupData.dietaryRestrictions : (preferences ? preferences.dietaryRestrictions : []);

  const personalizationText = groupData
    ? groupPersonalizationInstruction(groupData.members)
    : personalizationInstruction(preferences, req.user ? getVisitHighlights(req.user.id) : []);

  const targetPrice = price ? Number(price) : Math.max(...candidates.map(r => r.price || 0));
  const inBudget = candidates.filter(r => r.price == null || r.price <= targetPrice);
  const budgetPool = inBudget.length > 0 ? inBudget : candidates;

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
  const pool = dishCraving
    ? budgetPool.slice(0, poolSize)
    : pickRandomTopPool(budgetPool, poolSize);

  try {
    const withReviews = await Promise.all(pool.map(async r => ({
      place_id: r.id,
      name: r.name,
      cuisine: r.cuisine,
      price: r.price,
      rating: r.rating,
      reviews: await fetchPlaceReviews(r.id)
    })));

    const { place_id, dish_suggestion, reason, flavor_tags, shared_items } = await askClaudeForRecommendation(withReviews, targetPrice, {
      groupSize: clampedGroupSize,
      sharing: isSharing,
      personalizationText,
      dietaryRestrictions,
      dish: dishCraving
    });
    const pick = pool.find(r => r.id === place_id) || pool[0];

    // Only surface shared items in sharing mode, and drop any malformed entries
    // Claude might return (missing/empty name). No prices: real menu prices
    // aren't available, so we never show an invented dollar figure per item.
    const sharedItems = (isSharing && Array.isArray(shared_items))
      ? shared_items.filter(item => typeof item === 'string' && item.trim() !== '').map(item => item.trim())
      : [];

    // The prompt tells Claude to avoid em/en dashes, but that's not guaranteed;
    // strip any that slip through rather than showing them in user-facing text.
    const stripDashes = (str) => typeof str === 'string' ? str.replace(/[—–]/g, ', ').replace(/,\s*,/g, ',') : str;

    res.json({
      restaurant: pick,
      dish: { name: stripDashes(dish_suggestion), flavorTags: flavor_tags, sharedItems: sharedItems.map(stripDashes) },
      reason: stripDashes(reason)
    });
  } catch (err) {
    console.error('Recommendation failed:', err);
    res.status(502).json({ error: "Couldn't generate a recommendation right now. Try again in a moment." });
  }
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

app.post('/api/visits', requireAuth, (req, res) => {
  const { restaurantName, dish, rating, flavorTags } = req.body;

  if (!restaurantName || typeof restaurantName !== 'string' || !restaurantName.trim()) {
    return res.status(400).json({ error: 'Restaurant name is required.' });
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be a whole number from 1 to 5.' });
  }

  const cleanFlavorTags = Array.isArray(flavorTags) ? flavorTags.filter(t => FLAVOR_TAGS.includes(t)) : [];

  try {
    const visit = insertVisit({
      userId: req.user.id,
      restaurantName: restaurantName.trim(),
      dish: dish && String(dish).trim() ? String(dish).trim() : null,
      rating,
      flavorTags: cleanFlavorTags
    });
    res.status(201).json({ visit: shapeVisit(visit) });
  } catch (err) {
    console.error('Failed to save visit:', err);
    res.status(500).json({ error: 'Could not save your visit right now.' });
  }
});

app.get('/api/visits', requireAuth, (req, res) => {
  try {
    res.json({ visits: listVisits(req.user.id).map(shapeVisit) });
  } catch (err) {
    console.error('Failed to load visits:', err);
    res.status(500).json({ error: 'Could not load past visits.', visits: [] });
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
    res.json(getStreaks(req.user.id));
  } catch (err) {
    console.error('Failed to load streaks:', err);
    res.status(500).json({ error: 'Could not load your streak right now.', currentStreak: 0, longestStreak: 0, lastVisitDate: null });
  }
});

app.get('/api/badges', requireAuth, (req, res) => {
  try {
    res.json({ badges: getBadges(req.user.id) });
  } catch (err) {
    console.error('Failed to load badges:', err);
    res.status(500).json({ error: 'Could not load badges right now.', badges: [] });
  }
});

// No display_name field exists. Friends in this small, known group don't
// need identity obscured, so this derives a readable name from the email
// local-part instead of adding a profile field nobody would maintain.
function deriveDisplayName(email) {
  const localPart = email.split('@')[0];
  const words = localPart.split(/[._+-]+/).filter(Boolean);
  if (words.length === 0) return email;
  return words.map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

app.get('/api/leaderboard', requireAuth, (req, res) => {
  try {
    const stats = getLeaderboardStats();
    const leaderboard = stats.map((row, i) => ({
      rank: i + 1,
      displayName: deriveDisplayName(row.email),
      visitCount: row.visitCount,
      currentStreak: row.currentStreak,
      longestStreak: row.longestStreak,
      isYou: row.userId === req.user.id
    }));
    res.json({ leaderboard });
  } catch (err) {
    console.error('Failed to load leaderboard:', err);
    res.status(500).json({ error: 'Could not load the leaderboard right now.', leaderboard: [] });
  }
});

const SPICE_TOLERANCES = new Set(['mild', 'medium', 'hot']);

function isStringArray(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
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
      favoriteCuisines: favoriteCuisines.map(c => c.trim()).filter(Boolean).slice(0, 10),
      dietaryRestrictions: dietaryRestrictions.map(d => d.trim()).filter(Boolean).slice(0, 10),
      spiceTolerance
    });
    res.json({ preferences });
  } catch (err) {
    console.error('Failed to save preferences:', err);
    res.status(500).json({ error: 'Could not save preferences right now.' });
  }
});

app.post('/api/groups', requireAuth, (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 40) : '';
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

app.post('/api/groups/join', requireAuth, (req, res) => {
  const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
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
      displayName: deriveDisplayName(m.email),
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

app.listen(PORT, () => {
  console.log(`FoodFindr running at http://localhost:${PORT}`);
});
