# FoodFindr

A map-based restaurant finder that recommends one specific spot + dish for
your budget, cuisine, group, and taste — then tracks where you've actually
eaten and how much of your city you've explored. Single-user, no accounts,
SQLite for persistence.

## Run it

```bash
npm install
npm start
```

Then open http://localhost:3000

## API keys required

This app calls four real APIs. Copy `.env.example` to `.env` and fill in:

- `GOOGLE_MAPS_BROWSER_KEY` — Google Cloud Console key restricted to the Maps JavaScript API, sent to the browser.
- `GOOGLE_MAPS_MAP_ID` — a Map ID (Maps Platform → Map Management) with a dark-mode style associated, used for the custom markers.
- `GOOGLE_PLACES_SERVER_KEY` — a server-only key, never sent to the browser. Its API restrictions must include both **Places API** and **Geocoding API**.
- `ANTHROPIC_API_KEY` — from console.anthropic.com, used for the AI recommendation.

Without these, the app still runs: the map shows a placeholder message and
restaurant/recommendation/progress requests return friendly errors or hide
themselves instead of crashing.

## Features

- **Map + filters** — real geolocation (with a dismissible fallback banner
  if denied), live Google Places results filtered by price ceiling, cuisine,
  and distance.
- **AI recommendation** — Claude reads each candidate's real reviews and
  picks one restaurant + a specific dish to order, honestly limited to what
  reviews actually mention (never invents a dish). Adjusts its suggestion
  for group size and whether you're sharing or ordering separate mains.
- **Personalization** — an onboarding dialog (skippable, reopenable anytime)
  captures favorite cuisines, dietary restrictions, spice tolerance, and
  price tolerance. Recommendations factor these in along with your 5 most
  recent logged visits.
- **Visit logging** — log a restaurant, dish, and 1–5 star rating from a
  dropdown of restaurants currently on screen (or "Other" for anywhere
  else), stored in SQLite.
- **Exploration progress** — a sidebar bar showing how many restaurants
  you've visited out of how many FoodFindr has surfaced to you in your
  current city (resolved via reverse geocoding).

## How it works

- `server/server.js` — Express server with the main routes:
  - `GET /api/restaurants` — calls Google Places (Nearby Search, or Text Search when a cuisine is picked), filters by price ceiling and distance, resolves the search center's city via Geocoding, and records every result into the discovery log.
  - `POST /api/recommend` — takes up to 8 of the highest-rated currently-filtered restaurants, fetches each one's real reviews from Places, and asks Claude (Haiku 4.5) to pick one and suggest a dish, factoring in group size/sharing, saved preferences, and recent visit history.
  - `POST/GET /api/visits` — logs and lists visits.
  - `POST/GET /api/preferences` — saves and loads the single-user preference profile.
  - `GET /api/progress` — returns how many discovered restaurants in the current city have a matching logged visit.
- `server/db.js` — `node:sqlite` (zero dependencies) with four tables: `visits`, `preferences`, and `discovered_restaurants` (every restaurant ever surfaced by a search, used as the exploration-progress denominator).
- `public/js/map.js` — Google Maps JavaScript API wrapper: dark theme via a cloud-configured Map ID, custom HTML markers via `AdvancedMarkerElement` (with hover tooltips), auto pan/zoom + a pulse animation on the recommended pick.
- `public/js/app.js` — filter/state handling, the preferences dialog, visit logging, and the exploration progress bar, all wired to the routes above.
- `server/mockRestaurants.json` — no longer used for restaurant data; `cityCenter` from this file is kept only as the fallback location when geolocation is denied or unavailable.

## Notes on real data

- Google Places doesn't expose menu/dish data, so dish suggestions come from Claude reading real review text — there's no guarantee a review mentions something specific, in which case Claude suggests something generic instead of inventing a dish.
- Places doesn't have a clean "cuisine" field either; the cuisine filter is used as a search-query hint (Text Search) rather than an exact match.
- Price filtering uses Google's 0–4 price scale as a ceiling (e.g. "$$" means "$2 or below"), not an exact match, since Google's scale doesn't line up one-to-one with a 3-tier $/$$/$$$ UI.
- Dietary restrictions are a best-effort instruction to Claude based on review text, not a hard filter — Places has no ingredient/allergen data.
- The exploration progress bar's denominator is **restaurants FoodFindr has shown you**, not every restaurant in the city — Google Places returns at most 20 results per search call (no pagination), so it grows as you search rather than starting at a true city-wide total. The UI is worded to reflect this rather than implying completeness.
