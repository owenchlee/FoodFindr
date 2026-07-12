# FoodFindr

A map-based restaurant finder that recommends one specific spot + dish for your budget, cuisine, and distance.

## Run it

```bash
npm install
npm start
```

Then open http://localhost:3000

## API keys required

This app calls three real APIs. Copy `.env.example` to `.env` and fill in:

- `GOOGLE_MAPS_BROWSER_KEY` — Google Cloud Console key restricted to the Maps JavaScript API, sent to the browser.
- `GOOGLE_MAPS_MAP_ID` — a Map ID (Maps Platform → Map Management) with a dark-mode style associated, used for the custom markers.
- `GOOGLE_PLACES_SERVER_KEY` — a separate, server-only key restricted to the Places API. Never sent to the browser.
- `ANTHROPIC_API_KEY` — from console.anthropic.com, used for the AI recommendation.

Without these, the app still runs: the map shows a placeholder message and restaurant/recommendation requests return friendly errors instead of crashing.

## How it works

- `server/server.js` — Express server with two main routes:
  - `GET /api/restaurants` — calls the Google Places API (Nearby Search, or Text Search when a cuisine is picked) around the given coordinates, filters by price ceiling and distance, and returns the results.
  - `POST /api/recommend` — takes up to 8 of the highest-rated currently-filtered restaurants, fetches each one's real reviews from Places, and asks Claude (Haiku 4.5) to pick one restaurant and suggest a specific dish based only on what the reviews actually say.
- `public/js/map.js` — Google Maps JavaScript API wrapper (dark theme via a cloud-configured Map ID, custom HTML markers via `AdvancedMarkerElement`).
- `public/js/app.js` — browser geolocation (with a dismissible fallback banner if denied), filter handling, and wiring the map/recommendation together.
- `server/mockRestaurants.json` — no longer used for restaurant data; `cityCenter` from this file is kept only as the fallback location when geolocation is denied or unavailable.

## Notes on real data

- Google Places doesn't expose menu/dish data, so dish suggestions come from Claude reading real review text — there's no guarantee a review mentions something specific, in which case Claude suggests something generic instead of inventing a dish.
- Places doesn't have a clean "cuisine" field either; the cuisine filter is used as a search-query hint (Text Search) rather than an exact match.
- Price filtering uses Google's 0–4 price scale as a ceiling (e.g. "$$" means "$2 or below"), not an exact match, since Google's scale doesn't line up one-to-one with a 3-tier $/$$/$$$ UI.
