require('dotenv').config();
const express = require('express');
const path = require('path');
const { cityCenter } = require('./mockRestaurants.json');
const { insertVisit, listVisits, getVisitHighlights, getPreferences, savePreferences } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const PLACES_SERVER_KEY = process.env.GOOGLE_PLACES_SERVER_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Hands the browser-restricted Maps key + Map ID to the frontend, so the
// key never has to be hardcoded into a static HTML file.
app.get('/api/config', (req, res) => {
  res.json({
    mapsBrowserKey: process.env.GOOGLE_MAPS_BROWSER_KEY || null,
    mapId: process.env.GOOGLE_MAPS_MAP_ID || null
  });
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
// have in-house dining, not because they are one — filter these out.
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

async function fetchPlaces(lat, lng, radiusMeters, cuisine) {
  const url = new URL(cuisine
    ? 'https://maps.googleapis.com/maps/api/place/textsearch/json'
    : 'https://maps.googleapis.com/maps/api/place/nearbysearch/json');

  if (cuisine) {
    url.searchParams.set('query', `${cuisine} restaurants`);
  } else {
    url.searchParams.set('type', 'restaurant');
  }
  url.searchParams.set('location', `${lat},${lng}`);
  url.searchParams.set('radius', String(Math.round(radiusMeters)));
  url.searchParams.set('key', PLACES_SERVER_KEY);

  const response = await fetch(url);
  const data = await response.json();

  if (data.status === 'ZERO_RESULTS') {
    return [];
  }
  if (data.status !== 'OK') {
    throw new Error(`Places API error: ${data.status}${data.error_message ? ' — ' + data.error_message : ''}`);
  }

  return data.results || [];
}

app.get('/api/restaurants', async (req, res) => {
  if (!PLACES_SERVER_KEY) {
    return res.status(500).json({ error: 'Server is missing GOOGLE_PLACES_SERVER_KEY — add it to .env.', restaurants: [] });
  }

  const lat = parseFloat(req.query.lat) || cityCenter.lat;
  const lng = parseFloat(req.query.lng) || cityCenter.lng;
  const { price, cuisine, maxDistance } = req.query;

  const distanceMiles = maxDistance ? Number(maxDistance) : 3;
  const radiusMeters = Math.min(distanceMiles * 1609.34, 50000);

  try {
    const places = await fetchPlaces(lat, lng, radiusMeters, cuisine);

    let results = places
      .filter(place => place.geometry && place.geometry.location)
      .filter(place => !(place.types || []).some(t => NON_RESTAURANT_TYPES.has(t)))
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

    res.json({ cityCenter: { lat, lng }, restaurants: results });
  } catch (err) {
    console.error('Places API request failed:', err);
    res.status(502).json({ error: 'Could not reach Google Places right now. Try again in a moment.', restaurants: [] });
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

function groupInstruction(groupSize, sharing) {
  if (groupSize <= 1) {
    return 'This is for one person — suggest a single dish for them to order.';
  }
  if (sharing) {
    return `This is for a group of ${groupSize} people who want to share — suggest a shareable order ` +
      `(e.g. a couple of appetizers plus a main or two to split) that works for the whole group within the budget.`;
  }
  return `This is for a group of ${groupSize} people who each want their own main — suggest one dish that ` +
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
        `They have these dietary restrictions: ${preferences.dietaryRestrictions.join(', ')}. ` +
        `Avoid suggesting a dish that clearly conflicts with these based on what the reviews say — ` +
        `but menu/ingredient data isn't available, so this is best-effort, not a guarantee.`
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

async function askClaudeForRecommendation(candidates, targetPrice, { groupSize, sharing, preferences, visitHighlights }) {
  const prompt = `Pick exactly one restaurant from this list for someone with a budget ceiling of ${'$'.repeat(targetPrice)}. ` +
    `Suggest one specific dish (or, for a sharing group, a short shareable order) to order, based only on what's ` +
    `actually mentioned in the reviews provided — don't invent a dish that isn't referenced. ` +
    `If no review mentions a specific dish, suggest something generic like "their most popular item" instead of making one up. ` +
    `${groupInstruction(groupSize, sharing)}` +
    `${personalizationInstruction(preferences, visitHighlights)}\n\n` +
    JSON.stringify(candidates, null, 2);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      tools: [{
        name: 'recommend_restaurant',
        description: 'Return the single best restaurant recommendation with a specific dish suggestion.',
        input_schema: {
          type: 'object',
          properties: {
            place_id: { type: 'string', description: 'The place_id of the chosen restaurant, copied exactly from one of the candidates.' },
            dish_suggestion: { type: 'string', description: 'A specific dish or menu item to order.' },
            reason: { type: 'string', description: 'A friendly 1-2 sentence explanation referencing something concrete from the reviews.' }
          },
          required: ['place_id', 'dish_suggestion', 'reason']
        }
      }],
      tool_choice: { type: 'tool', name: 'recommend_restaurant' },
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(`Anthropic API error: ${data.error.type} — ${data.error.message}`);
  }

  const toolUse = data.content && data.content.find(block => block.type === 'tool_use');
  if (!toolUse) {
    throw new Error('Claude did not return a structured recommendation.');
  }

  return toolUse.input;
}

app.post('/api/recommend', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY — add it to .env.' });
  }

  const { restaurants: candidates, price, groupSize, sharing } = req.body;

  if (!candidates || candidates.length === 0) {
    return res.status(400).json({ error: 'No restaurants to recommend from. Try widening your filters.' });
  }

  const clampedGroupSize = Math.min(8, Math.max(1, Number.isInteger(groupSize) ? groupSize : 1));
  const isSharing = sharing === true;

  const targetPrice = price ? Number(price) : Math.max(...candidates.map(r => r.price || 0));
  const inBudget = candidates.filter(r => r.price == null || r.price <= targetPrice);
  const pool = (inBudget.length > 0 ? inBudget : candidates)
    .slice()
    .sort((a, b) => (b.rating || 0) - (a.rating || 0))
    .slice(0, 8);

  try {
    const withReviews = await Promise.all(pool.map(async r => ({
      place_id: r.id,
      name: r.name,
      cuisine: r.cuisine,
      price: r.price,
      rating: r.rating,
      reviews: await fetchPlaceReviews(r.id)
    })));

    const { place_id, dish_suggestion, reason } = await askClaudeForRecommendation(withReviews, targetPrice, {
      groupSize: clampedGroupSize,
      sharing: isSharing,
      preferences: getPreferences(),
      visitHighlights: getVisitHighlights()
    });
    const pick = pool.find(r => r.id === place_id) || pool[0];

    res.json({
      restaurant: pick,
      dish: { name: dish_suggestion },
      reason
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

app.post('/api/visits', (req, res) => {
  const { restaurantName, dish, rating } = req.body;

  if (!restaurantName || typeof restaurantName !== 'string' || !restaurantName.trim()) {
    return res.status(400).json({ error: 'Restaurant name is required.' });
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be a whole number from 1 to 5.' });
  }

  try {
    const visit = insertVisit({
      restaurantName: restaurantName.trim(),
      dish: dish && String(dish).trim() ? String(dish).trim() : null,
      rating
    });
    res.status(201).json({ visit: shapeVisit(visit) });
  } catch (err) {
    console.error('Failed to save visit:', err);
    res.status(500).json({ error: 'Could not save your visit right now.' });
  }
});

app.get('/api/visits', (req, res) => {
  try {
    res.json({ visits: listVisits().map(shapeVisit) });
  } catch (err) {
    console.error('Failed to load visits:', err);
    res.status(500).json({ error: 'Could not load past visits.', visits: [] });
  }
});

const SPICE_TOLERANCES = new Set(['mild', 'medium', 'hot']);

function isStringArray(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

app.get('/api/preferences', (req, res) => {
  try {
    res.json({ preferences: getPreferences() });
  } catch (err) {
    console.error('Failed to load preferences:', err);
    res.status(500).json({ error: 'Could not load preferences right now.', preferences: null });
  }
});

app.post('/api/preferences', (req, res) => {
  const { favoriteCuisines, dietaryRestrictions, spiceTolerance, priceTolerance } = req.body;

  if (!isStringArray(favoriteCuisines) || !isStringArray(dietaryRestrictions)) {
    return res.status(400).json({ error: 'favoriteCuisines and dietaryRestrictions must both be arrays of text.' });
  }
  if (!SPICE_TOLERANCES.has(spiceTolerance)) {
    return res.status(400).json({ error: 'spiceTolerance must be one of: mild, medium, hot.' });
  }
  if (!Number.isInteger(priceTolerance) || priceTolerance < 1 || priceTolerance > 3) {
    return res.status(400).json({ error: 'priceTolerance must be a whole number from 1 to 3.' });
  }

  try {
    const preferences = savePreferences({
      favoriteCuisines: favoriteCuisines.map(c => c.trim()).filter(Boolean).slice(0, 10),
      dietaryRestrictions: dietaryRestrictions.map(d => d.trim()).filter(Boolean).slice(0, 10),
      spiceTolerance,
      priceTolerance
    });
    res.json({ preferences });
  } catch (err) {
    console.error('Failed to save preferences:', err);
    res.status(500).json({ error: 'Could not save preferences right now.' });
  }
});

app.listen(PORT, () => {
  console.log(`FoodFindr running at http://localhost:${PORT}`);
});
