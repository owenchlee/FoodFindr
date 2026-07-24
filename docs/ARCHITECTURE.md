# Architecture

Implementation detail moved out of the main README: full route list, backend/frontend
file breakdown, and the tradeoffs behind FoodFindr's use of the Google Places and
Claude APIs.

## Design decisions and their edge cases

- Google Places doesn't expose menu/dish data, so dish suggestions come from Claude
  reading real review text: there's no guarantee a review mentions something specific,
  in which case Claude suggests something generic instead of inventing a dish. The
  same honesty rule applies to the "craving something specific" search: if no review
  mentions a specific dish, Claude says so instead of making it up. A restaurant can
  still show up in search results even without menu evidence, since Google's own
  search relevance (not verified menu content) decides what appears.
- Places doesn't have a clean "cuisine" field either; the cuisine and specific-dish
  filters are both used as a search-query hint (Text Search) rather than an exact
  match.
- Price filtering uses Google's 0-4 price scale as a ceiling (e.g. "$$" means "$2 or
  below"), not an exact match, since Google's scale doesn't line up one-to-one with a
  3-tier $/$$/$$$ UI. The filters panel shows an approximate per-person price range
  next to each tier as a rough guide. The same per-person figures are used to compute
  a sharing group's total budget, which is real math but still an estimate, not a
  verified bill.
- Dietary restrictions are a best-effort instruction to Claude based on review text,
  not a hard filter: Places has no ingredient/allergen data.
- The exploration progress bar's denominator is **restaurants FoodFindr has shown
  you**, not every restaurant in the city: Google Places returns at most 20 results
  per search call (no pagination), so it grows as you search rather than starting at
  a true city-wide total. The UI is worded to reflect this rather than implying
  completeness.

## Backend (`server/`)

- `server/server.js`: Express server (with `helmet` security headers and rate
  limiting on the Places/Anthropic-backed routes) with the main routes:
  - `POST /api/auth/signup` / `POST /api/auth/login` / `POST /api/auth/logout` /
    `GET /api/auth/me`: account creation, session start/end, and session check. A
    separate, stricter rate limiter (10 requests / 15 min) applies to signup and
    login.
  - `GET /api/restaurants`: calls Google Places (Nearby Search, or Text Search when
    a cuisine and/or a specific-dish craving is given), filters by price ceiling and
    distance, resolves the search center's city via Geocoding, and records every
    result into the discovery log.
  - `GET /api/geocode`: forward geocodes a typed address/city into lat/lng for the
    "choose a location" search box, using the server-only Places key (the browser
    Maps key is deliberately restricted to Maps JavaScript API only, so this can't
    run client-side).
  - `POST /api/recommend`: takes up to 8 of the highest-rated currently-filtered
    restaurants, fetches each one's real reviews from Places, and asks Claude
    (Haiku 4.5) to pick one and suggest a dish (or, for a sharing group, several
    items sized to a computed total group budget), factoring in group size/sharing,
    a specific-dish craving if given, saved preferences, and recent visit history.
  - `POST/GET /api/visits`: logs and lists the signed-in user's visits.
  - `POST/GET /api/preferences`: saves and loads the signed-in user's taste profile
    ("My Taste Profile").
  - `GET /api/progress`: returns how many discovered restaurants in the current city
    have a matching logged visit, for the signed-in user.
  - `GET /api/flavors` / `GET /api/streaks` / `GET /api/badges` / `GET /api/leaderboard`:
    gamification reads derived from the same `visits` table: top logged cuisines,
    the current/longest daily visit-logging streak, earned achievement badges, and
    a friends leaderboard.
  - `POST /api/groups` / `POST /api/groups/join` / `GET /api/groups` /
    `GET /api/groups/:id/members` / `POST /api/groups/:id/leave`: persistent friend
    groups, joined by a 6-character code. Passing `groupId` to `/api/restaurants` or
    `/api/recommend` swaps in the whole group's combined data instead of just the
    caller's: dietary restrictions union as a hard "must satisfy everyone" filter,
    while cuisines and visit history pool as a softer signal. Every group route
    checks membership server-side before returning anything.

  Every route above except `/api/auth/*` and `/api/config` requires a valid session
  (`requireAuth` middleware). The frontend gates the whole app behind login for
  exactly this reason: unauthenticated access to the billed Google/Anthropic routes
  is the real risk once this is live on the internet.
- `server/auth.js`: password hashing (`node:crypto` scrypt, no extra dependency),
  session tokens (random 32-byte token stored in the `sessions` table, sent as an
  `httpOnly`/`sameSite=lax` cookie, and `secure` too once `NODE_ENV=production`), and
  a small hand-rolled cookie parser (skips adding `cookie-parser` just to read one
  cookie).
- `server/db.js`: `node:sqlite` (zero dependencies) with `users`, `sessions`,
  `visits`, `preferences`, `discovered_restaurants` (every restaurant ever
  surfaced by a search, used as the exploration-progress denominator), and
  `groups`/`group_members` (persistent friend groups, joined by a unique code).
  All but `users`/`sessions`/`groups` are scoped by `user_id`. Reads `DB_PATH` from
  the environment (defaults to `server/foodfindr.db`), so a production deploy can
  point it at a mounted persistent disk. The very first account ever created
  automatically adopts any pre-existing (pre-accounts) data instead of orphaning it.

## Frontend (`public/`)

- `public/js/map.js`: Google Maps JavaScript API wrapper: dark theme via a
  cloud-configured Map ID, custom HTML markers via `AdvancedMarkerElement` (with
  hover tooltips), auto pan/zoom + a pulse animation on the recommended pick, and a
  pin-drop mode for manually choosing a search location.
- `public/js/app.js`: filter/state handling, the loading overlay, the side rail +
  sliding drawer panel logic, the location picker (address search + map pin-drop),
  the preferences dialog, visit logging, and the exploration progress bar, all wired
  to the routes above.
- `public/index.html` / `public/css/style.css`: the map is a fixed full-viewport
  background layer; a persistent side rail and a search/brand bar float on top, and
  every other panel (filters, reviews, progress, taste profile, FAQ) lives in a
  single sliding drawer that animates out from behind the rail rather than a
  permanent sidebar column.
