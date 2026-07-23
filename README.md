# FoodFindr

A map-based restaurant finder that recommends one specific spot and dish for
your budget, cuisine, group, and taste. It also tracks where you've actually
eaten and how much of your city you've explored. Multi-user with email/password
accounts, SQLite for persistence.

**Try it live at [foodfindr.tech](https://foodfindr.tech)**: sign up or continue as a guest, no setup required.

## How to use it

1. **Sign in, or continue as guest.** Guests can search and get recommendations
   right away; signing up unlocks saved preferences, visit logging, and
   progress tracking.
2. **Set your location.** FoodFindr uses your real location by default. Use
   the pin icon next to the search bar to type a city/address instead, or
   drop a pin anywhere on the map.
3. **Search or filter.** Type a craving (e.g. "ramen," "pad thai") and press
   Enter, or open Filters for a price ceiling, cuisine, distance, group size,
   and separate-mains vs. sharing.
4. **Get one specific pick.** Hit Surprise Me (or just press Enter after
   typing a craving) and Claude reads real reviews for the top candidates,
   then recommends one restaurant and one specific dish, grounded in what
   the reviews actually say (it never invents a dish).
5. **Log your visits.** After eating, log the restaurant, dish, and a 1-5
   star rating from the Log a Review panel. Ratings build your flavor
   profile and count toward exploration progress.
6. **Track your progress.** The Your Progress panel shows how many
   discovered restaurants you've visited in your current city, your visit
   streak, earned achievement badges, and where you rank on the friends
   leaderboard.
7. **Save your taste profile.** From the side rail, set favorite cuisines,
   dietary restrictions, and spice/price tolerance so every recommendation
   is personalized, separate from the per-search filters.

## Good to know

- Google Places doesn't expose menu/dish data, so dish suggestions come from Claude reading real review text: there's no guarantee a review mentions something specific, in which case Claude suggests something generic instead of inventing a dish. The same honesty rule applies to the "craving something specific" search: if no review mentions a specific dish, Claude says so instead of making it up. A restaurant can still show up in search results even without menu evidence, since Google's own search relevance (not verified menu content) decides what appears.
- Places doesn't have a clean "cuisine" field either; the cuisine and specific-dish filters are both used as a search-query hint (Text Search) rather than an exact match.
- Price filtering uses Google's 0-4 price scale as a ceiling (e.g. "$$" means "$2 or below"), not an exact match, since Google's scale doesn't line up one-to-one with a 3-tier $/$$/$$$ UI. The filters panel shows an approximate per-person price range next to each tier as a rough guide. The same per-person figures are used to compute a sharing group's total budget, which is real math but still an estimate, not a verified bill.
- Dietary restrictions are a best-effort instruction to Claude based on review text, not a hard filter: Places has no ingredient/allergen data.
- The exploration progress bar's denominator is **restaurants FoodFindr has shown you**, not every restaurant in the city: Google Places returns at most 20 results per search call (no pagination), so it grows as you search rather than starting at a true city-wide total. The UI is worded to reflect this rather than implying completeness.

## Built with

Node.js + Express on the backend, vanilla JS/HTML/CSS on the frontend (no
framework, no build step), SQLite via Node's built-in `node:sqlite` (zero
extra dependencies), the Google Maps JavaScript API, Google Places and
Geocoding APIs, and Anthropic's Claude for the recommendation itself.
Deployed on Azure App Service with GitHub Actions.

## Run it locally

The steps below are for running or modifying the code yourself (they're not
needed just to use the live site above).

```bash
npm install
npm start
```

Then open http://localhost:3000

### API keys

The live site already has these configured. You'd only need your own if
running the code locally or deploying your own copy. This app calls four
real APIs; copy `.env.example` to `.env` and fill in:

- `GOOGLE_MAPS_BROWSER_KEY`: Google Cloud Console key restricted to the Maps JavaScript API, sent to the browser.
- `GOOGLE_MAPS_MAP_ID`: a Map ID (Maps Platform → Map Management) with a dark-mode style associated, used for the custom markers.
- `GOOGLE_PLACES_SERVER_KEY`: a server-only key, never sent to the browser. Its API restrictions must include both **Places API** and **Geocoding API**.
- `ANTHROPIC_API_KEY`: from console.anthropic.com, used for the AI recommendation.

`DB_PATH` is optional: set it to point the SQLite file at a mounted disk in
production (e.g. `/data/foodfindr.db`); defaults to `server/foodfindr.db`
locally. No session-secret env var is needed: sessions are opaque random
tokens looked up in the database, not signed or encrypted cookies.

Without these, the app still runs: the map shows a placeholder message and
restaurant/recommendation/progress requests return friendly errors or hide
themselves instead of crashing.

## How it works

- `server/server.js`: Express server (with `helmet` security headers and
  rate limiting on the Places/Anthropic-backed routes) with the main routes:
  - `POST /api/auth/signup` / `POST /api/auth/login` / `POST /api/auth/logout` / `GET /api/auth/me`: account creation, session start/end, and session check. A separate, stricter rate limiter (10 requests / 15 min) applies to signup and login.
  - `GET /api/restaurants`: calls Google Places (Nearby Search, or Text Search when a cuisine and/or a specific-dish craving is given), filters by price ceiling and distance, resolves the search center's city via Geocoding, and records every result into the discovery log.
  - `GET /api/geocode`: forward geocodes a typed address/city into lat/lng for the "choose a location" search box, using the server-only Places key (the browser Maps key is deliberately restricted to Maps JavaScript API only, so this can't run client-side).
  - `POST /api/recommend`: takes up to 8 of the highest-rated currently-filtered restaurants, fetches each one's real reviews from Places, and asks Claude (Haiku 4.5) to pick one and suggest a dish (or, for a sharing group, several items sized to a computed total group budget), factoring in group size/sharing, a specific-dish craving if given, saved preferences, and recent visit history.
  - `POST/GET /api/visits`: logs and lists the signed-in user's visits.
  - `POST/GET /api/preferences`: saves and loads the signed-in user's taste profile ("My Taste Profile").
  - `GET /api/progress`: returns how many discovered restaurants in the current city have a matching logged visit, for the signed-in user.

  Every route above except `/api/auth/*` and `/api/config` requires a valid session (`requireAuth` middleware). The frontend gates the whole app behind login for exactly this reason: unauthenticated access to the billed Google/Anthropic routes is the real risk once this is live on the internet.
- `server/auth.js`: password hashing (`node:crypto` scrypt, no extra dependency), session tokens (random 32-byte token stored in the `sessions` table, sent as an `httpOnly`/`sameSite=lax` cookie, and `secure` too once `NODE_ENV=production`), and a small hand-rolled cookie parser (skips adding `cookie-parser` just to read one cookie).
- `server/db.js`: `node:sqlite` (zero dependencies) with `users`, `sessions`, `visits`, `preferences`, and `discovered_restaurants` (every restaurant ever surfaced by a search, used as the exploration-progress denominator). The latter three are all scoped by `user_id`. Reads `DB_PATH` from the environment (defaults to `server/foodfindr.db`), so a production deploy can point it at a mounted persistent disk. The very first account ever created automatically adopts any pre-existing (pre-accounts) data instead of orphaning it.
- `public/js/map.js`: Google Maps JavaScript API wrapper: dark theme via a cloud-configured Map ID, custom HTML markers via `AdvancedMarkerElement` (with hover tooltips), auto pan/zoom + a pulse animation on the recommended pick, and a pin-drop mode for manually choosing a search location.
- `public/js/app.js`: filter/state handling, the loading overlay, the side rail + sliding drawer panel logic, the location picker (address search + map pin-drop), the preferences dialog, visit logging, and the exploration progress bar, all wired to the routes above.
- `public/index.html` / `public/css/style.css`: the map is a fixed full-viewport background layer; a persistent side rail and a search/brand bar float on top, and every other panel (filters, reviews, progress, taste profile, FAQ) lives in a single sliding drawer that animates out from behind the rail rather than a permanent sidebar column.


The app is live at [foodfindr.tech](https://foodfindr.tech). Helmet's
`contentSecurityPolicy` is enabled with a host-based allowlist scoped to
Google's Maps/Fonts domains (see `server/server.js`), and the Maps browser
key's referrer allowlist includes the custom domain.
