# FoodFindr

A map-based restaurant finder that recommends one specific spot + dish for
your budget, cuisine, group, and taste — then tracks where you've actually
eaten and how much of your city you've explored. Multi-user with email/password
accounts, SQLite for persistence.

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

`DB_PATH` is optional — set it to point the SQLite file at a mounted disk in
production (e.g. `/data/foodfindr.db`); defaults to `server/foodfindr.db`
locally. No session-secret env var is needed — sessions are opaque random
tokens looked up in the database, not signed/encrypted cookies.

Without these, the app still runs: the map shows a placeholder message and
restaurant/recommendation/progress requests return friendly errors or hide
themselves instead of crashing.

## Features

- **Accounts** — email/password sign-up and login (session cookie backed by
  a `sessions` table in SQLite, password hashing via Node's built-in
  `node:crypto` scrypt — no extra dependencies for either). Every visit,
  taste-profile, and exploration-progress row is scoped to the signed-in
  user. The app is unusable until you're signed in — a centered login/signup
  card blocks the rest of the UI until then.
- **Full-screen map + a persistent side rail** — the map fills the entire
  window, Google Maps-style. A slim, always-visible dark rail sits at the
  left edge with icon shortcuts to every panel (Log a Review, Past Reviews,
  Game Progress, My Taste Profile, FAQ); tapping the hamburger at its top
  expands the rail in place to show text labels. Clicking any icon slides
  the matching panel out from behind the rail and fades out the rest of the
  UI so it reads as one clean panel instead of overlapping clutter. The
  FoodFindr wordmark sits top-right; a compact search bar (craving search +
  Filters + Surprise Me) sits top-left.
- **Choose a different search location** — a location-pin control next to
  the search bar lets you either type a city/address (server-side geocoded)
  or drop a pin directly on the map to search somewhere other than where
  you actually are, with a one-click way back to your real location.
- **Filters** — price ceiling, a free-text "craving something specific?"
  search (e.g. "ramen," "pad thai") for when you want an exact dish instead
  of a broad cuisine, a cuisine dropdown, distance, group size, and
  separate-mains vs. sharing — all tucked behind the Filters button instead
  of taking up permanent screen space.
- **AI recommendation** — Claude reads each candidate's real reviews and
  picks one restaurant + a specific dish to order, honestly limited to what
  reviews actually mention (never invents a dish). Adjusts its suggestion
  for group size/sharing, and for a specific craving if you typed one, while
  staying honest if no review backs it up. For a sharing group, Claude
  suggests several specific items sized to the group's computed total
  budget — never inventing per-item prices, since Places doesn't expose
  menu pricing. A full-screen loading animation (the dog mascot waddling
  across the screen) shows while Claude or a Places search is working.
- **Personalization ("My Taste Profile")** — a dialog (skippable, reopenable
  anytime from the side rail) captures favorite cuisines, dietary
  restrictions, spice tolerance, and price tolerance — a saved profile that
  quietly informs every recommendation, separate from the per-search filters.
- **Log a Review / Past Reviews / Game Progress / FAQ panels** — each its
  own icon on the side rail. Log a Review holds the visit-logging form;
  Past Reviews lists your recent-visits history; Game Progress shows the
  exploration bar; FAQ has the "how it works" steps plus honest disclaimers
  about what the app can and can't actually verify. Only one panel shows at
  a time, sliding out over the map instead of taking up permanent space.
- **Visit logging** — log a restaurant, dish, and 1–5 star rating from a
  dropdown of restaurants currently on screen (or "Other" for anywhere
  else), stored in SQLite.
- **Exploration progress** — shows how many restaurants you've visited out
  of how many FoodFindr has surfaced to you in your current city (resolved
  via reverse geocoding).

## How it works

- `server/server.js` — Express server (with `helmet` security headers and
  rate limiting on the Places/Anthropic-backed routes) with the main routes:
  - `POST /api/auth/signup` / `POST /api/auth/login` / `POST /api/auth/logout` / `GET /api/auth/me` — account creation, session start/end, and session check. A separate, stricter rate limiter (10 requests / 15 min) applies to signup and login.
  - `GET /api/restaurants` — calls Google Places (Nearby Search, or Text Search when a cuisine and/or a specific-dish craving is given), filters by price ceiling and distance, resolves the search center's city via Geocoding, and records every result into the discovery log.
  - `GET /api/geocode` — forward geocodes a typed address/city into lat/lng for the "choose a location" search box, using the server-only Places key (the browser Maps key is deliberately restricted to Maps JavaScript API only, so this can't run client-side).
  - `POST /api/recommend` — takes up to 8 of the highest-rated currently-filtered restaurants, fetches each one's real reviews from Places, and asks Claude (Haiku 4.5) to pick one and suggest a dish (or, for a sharing group, several items sized to a computed total group budget), factoring in group size/sharing, a specific-dish craving if given, saved preferences, and recent visit history.
  - `POST/GET /api/visits` — logs and lists the signed-in user's visits.
  - `POST/GET /api/preferences` — saves and loads the signed-in user's taste profile ("My Taste Profile").
  - `GET /api/progress` — returns how many discovered restaurants in the current city have a matching logged visit, for the signed-in user.

  Every route above except `/api/auth/*` and `/api/config` requires a valid session (`requireAuth` middleware) — the frontend gates the whole app behind login for exactly this reason: unauthenticated access to the billed Google/Anthropic routes is the real risk once this is live on the internet.
- `server/auth.js` — password hashing (`node:crypto` scrypt, no extra dependency), session tokens (random 32-byte token stored in the `sessions` table, sent as an `httpOnly`/`sameSite=lax` cookie — `secure` too once `NODE_ENV=production`), and a small hand-rolled cookie parser (skips adding `cookie-parser` just to read one cookie).
- `server/db.js` — `node:sqlite` (zero dependencies) with `users`, `sessions`, `visits`, `preferences`, and `discovered_restaurants` (every restaurant ever surfaced by a search, used as the exploration-progress denominator) — the latter three are all scoped by `user_id`. Reads `DB_PATH` from the environment (defaults to `server/foodfindr.db`), so a production deploy can point it at a mounted persistent disk. The very first account ever created automatically adopts any pre-existing (pre-accounts) data instead of orphaning it.
- `public/js/map.js` — Google Maps JavaScript API wrapper: dark theme via a cloud-configured Map ID, custom HTML markers via `AdvancedMarkerElement` (with hover tooltips), auto pan/zoom + a pulse animation on the recommended pick, and a pin-drop mode for manually choosing a search location.
- `public/js/app.js` — filter/state handling, the loading overlay, the side rail + sliding drawer panel logic, the location picker (address search + map pin-drop), the preferences dialog, visit logging, and the exploration progress bar, all wired to the routes above.
- `public/index.html` / `public/css/style.css` — the map is a fixed full-viewport background layer; a persistent side rail and a search/brand bar float on top, and every other panel (filters, reviews, progress, taste profile, FAQ) lives in a single sliding drawer that animates out from behind the rail rather than a permanent sidebar column.
- `server/mockRestaurants.json` — no longer used for restaurant data; `cityCenter` from this file is kept only as the fallback location when geolocation is denied or unavailable.

## Deploying (Azure App Service, via GitHub Student Developer Pack)

This app needs a long-running Node process with **persistent storage** — the
SQLite file has to survive restarts and redeploys, which rules out
serverless hosts (Vercel/Netlify) as-is. Azure was chosen specifically
because **Azure for Students** (available through the GitHub Student
Developer Pack) grants Azure credit **without requiring a credit card** —
unlike Fly.io, Oracle Cloud, or standard Azure signup. Azure App Service
(Linux) also has a real advantage here: every Linux App Service plan
automatically persists its `/home` directory across restarts and
redeploys, so there's no separate volume/disk to create and mount (unlike
Render or Fly) — just point `DB_PATH` at a subfolder under `/home`.

1. Activate the **Azure for Students** offer (via the GitHub Student
   Developer Pack or education.github.com) — verify with your school email;
   no payment method needed.
2. In the Azure Portal, create a **Web App**: Linux, Node 20 LTS runtime,
   region near you. **Use the Basic (B1) plan, not the Free (F1) tier** — F1
   can't use custom domains and sleeps after ~20 minutes idle; B1 costs a
   few dollars a month, comfortably covered by the $100 credit, and
   supports "Always On" (no sleep) plus custom domains with a free
   Azure-managed TLS certificate.
3. In the app's **Configuration → Application settings**, add:
   `GOOGLE_MAPS_BROWSER_KEY`, `GOOGLE_MAPS_MAP_ID`, `GOOGLE_PLACES_SERVER_KEY`,
   `ANTHROPIC_API_KEY`, `NODE_ENV=production`, and
   `DB_PATH=/home/data/foodfindr.db` (Azure supplies `PORT` itself).
4. Turn on **Always On** under Configuration → General settings (only
   available on Basic tier and up).
5. **Deployment Center** → connect this GitHub repo → Azure sets up a
   GitHub Actions workflow that builds and deploys automatically on every
   push to `main`.
6. Once deployed, verify on the `*.azurewebsites.net` URL Azure gives you:
   sign up, log a visit, **restart the Web App from the Portal, and confirm
   the visit is still there** (the real test that `/home` persistence is
   working).
7. In Google Cloud Console, add the `azurewebsites.net` URL to the Maps
   browser key's allowed HTTP referrers (it's referrer-restricted).
8. Only once that's all verified working: hand over a custom domain — if
   it's the free Namecheap `.me` domain from the Student Pack, or one you
   already own, either way I'll need (a) the domain name and (b) for you to
   add the DNS records Azure's **Custom domains** blade gives you at your
   registrar (a `TXT` record for verification, then a `CNAME` for `www`
   or an `A` record at the apex). Azure then issues a free managed
   certificate automatically once DNS resolves. I never need registrar
   credentials, just the record values to hand back to you.

Two things worth re-checking once a real domain is live: Helmet's
`contentSecurityPolicy` is currently disabled in `server/server.js` (a
comment there says to revisit this once the production domain is final —
loading Maps/Fonts scripts from a real CSP needs to be tested against the
live domain), and the Maps browser key's referrer allowlist should be
updated to the custom domain.

## Notes on real data

- Google Places doesn't expose menu/dish data, so dish suggestions come from Claude reading real review text — there's no guarantee a review mentions something specific, in which case Claude suggests something generic instead of inventing a dish. The same honesty rule applies to the "craving something specific" search: if no review mentions a specific dish, Claude says so instead of making it up. A restaurant can still show up in search results even without menu evidence, since Google's own search relevance (not verified menu content) decides what appears.
- Places doesn't have a clean "cuisine" field either; the cuisine and specific-dish filters are both used as a search-query hint (Text Search) rather than an exact match.
- Price filtering uses Google's 0–4 price scale as a ceiling (e.g. "$$" means "$2 or below"), not an exact match, since Google's scale doesn't line up one-to-one with a 3-tier $/$$/$$$ UI — the filters panel shows an approximate per-person price range next to each tier as a rough guide. The same per-person figures are used to compute a sharing group's total budget, which is real math but still an estimate, not a verified bill.
- Dietary restrictions are a best-effort instruction to Claude based on review text, not a hard filter — Places has no ingredient/allergen data.
- The exploration progress bar's denominator is **restaurants FoodFindr has shown you**, not every restaurant in the city — Google Places returns at most 20 results per search call (no pagination), so it grows as you search rather than starting at a true city-wide total. The UI is worded to reflect this rather than implying completeness.
