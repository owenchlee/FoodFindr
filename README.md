# FoodFindr

A restaurant recommendation app — Phase 0 (mock data, no API keys required).

## Run it

```bash
npm install
npm start
```

Then open http://localhost:3000

## What's here (Phase 0)

- `server/mockRestaurants.json` — 9 fake restaurants (name, cuisine, price, rating, reviews, dishes, coordinates) around a made-up "Mock City."
- `server/server.js` — Express server. Serves the frontend and two API routes:
  - `GET /api/restaurants` — returns mock restaurants filtered by price/cuisine/distance.
  - `POST /api/recommend` — takes a list of restaurants + a price, and returns one pick (highest-rated place within budget) + its cheapest dish + a reason. This is a hardcoded rule for now — Phase 1 swaps it for a real Anthropic API call.
- `public/` — the frontend: a Leaflet map (no API key needed), filters, and a "Get Recommendation" button.

No real Google Maps/Places or Anthropic API is used yet — that starts in Phase 1.
