require('dotenv').config();
const express = require('express');
const path = require('path');
const { cityCenter } = require('./mockRestaurants.json');

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

async function askClaudeForRecommendation(candidates, targetPrice) {
  const prompt = `Pick exactly one restaurant from this list for someone with a budget ceiling of ${'$'.repeat(targetPrice)}. ` +
    `Suggest one specific dish to order, based only on what's actually mentioned in the reviews provided — don't invent a dish that isn't referenced. ` +
    `If no review mentions a specific dish, suggest something generic like "their most popular item" instead of making one up.\n\n` +
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

  const { restaurants: candidates, price } = req.body;

  if (!candidates || candidates.length === 0) {
    return res.status(400).json({ error: 'No restaurants to recommend from. Try widening your filters.' });
  }

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

    const { place_id, dish_suggestion, reason } = await askClaudeForRecommendation(withReviews, targetPrice);
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

app.listen(PORT, () => {
  console.log(`FoodFindr running at http://localhost:${PORT}`);
});
