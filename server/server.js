require('dotenv').config();
const express = require('express');
const path = require('path');
const { restaurants, cityCenter } = require('./mockRestaurants.json');

const app = express();
const PORT = process.env.PORT || 3000;

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

app.get('/api/restaurants', (req, res) => {
  const lat = parseFloat(req.query.lat) || cityCenter.lat;
  const lng = parseFloat(req.query.lng) || cityCenter.lng;
  const { price, cuisine, maxDistance } = req.query;

  let results = restaurants.map(r => ({
    ...r,
    distance: Math.round(distanceInMiles(lat, lng, r.lat, r.lng) * 10) / 10
  }));

  if (price) {
    results = results.filter(r => r.price === Number(price));
  }
  if (cuisine) {
    results = results.filter(r => r.cuisine.toLowerCase() === cuisine.toLowerCase());
  }
  if (maxDistance) {
    results = results.filter(r => r.distance <= Number(maxDistance));
  }

  res.json({ cityCenter, restaurants: results });
});

app.post('/api/recommend', (req, res) => {
  const { restaurants: candidates, price } = req.body;

  if (!candidates || candidates.length === 0) {
    return res.status(400).json({ error: 'No restaurants to recommend from. Try widening your filters.' });
  }

  const targetPrice = price ? Number(price) : Math.max(...candidates.map(r => r.price));
  const inBudget = candidates.filter(r => r.price <= targetPrice);
  const pool = inBudget.length > 0 ? inBudget : candidates;

  const pick = pool.reduce((best, r) => (r.rating > best.rating ? r : best), pool[0]);
  const dish = pick.dishes.reduce((cheapest, d) => (d.price < cheapest.price ? d : cheapest), pick.dishes[0]);

  res.json({
    restaurant: pick,
    dish,
    reason: `Highest-rated ${pick.cuisine} spot in your price range (${'$'.repeat(pick.price)}) — ${dish.name} is a solid, budget-friendly pick here.`
  });
});

app.listen(PORT, () => {
  console.log(`FoodFindr running at http://localhost:${PORT}`);
});
