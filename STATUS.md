# FoodFindr iOS App Store Prep — STATUS

Branch: `ios-app-store-prep`
Started: 2026-09-20 (session resumed 2026-09-21 after a usage-limit pause)

This file is the resume point. If this session is interrupted, read this file
before redoing any work — check each phase's status before repeating it.

---

## Phase 0 — Security and Deployment Assessment: **COMPLETE — GO**

**No blocking issue.** Verified via full-repo search (source, `.env`/`.env.example`,
git history, and the served `public/` output — there is no separate build step,
so `public/` *is* the shipped client bundle):

- `GOOGLE_PLACES_SERVER_KEY` and `ANTHROPIC_API_KEY` are read only via
  `process.env` in `server/server.js` (lines 24-25) and used only in
  server-initiated `fetch` calls (Places/Geocoding at lines ~220-430, Anthropic
  at line ~589). Neither is referenced anywhere under `public/`.
- The only Google-related value sent to the browser is `GOOGLE_MAPS_BROWSER_KEY`,
  exposed intentionally via `GET /api/config` (server.js:92-97) for the Maps
  JavaScript API embed (`public/index.html:445`). This key is meant to be public
  and should be HTTP-referrer-restricted in Google Cloud Console — **confirm
  that restriction is actually set (human action, not verifiable from the repo)**.
- `helmet` CSP (server.js:51-64) further restricts `connectSrc` to `'self'` and
  `*.googleapis.com`/`*.gstatic.com`, so the frontend couldn't call
  `api.anthropic.com` directly even if someone tried.
- `.env` (with real key values) is gitignored and confirmed never committed
  (`git log --all -p -- .env` is empty).

**Backend deployment status: LIVE, not localhost-only.** Deployed on Azure App
Service (Basic B1) at **https://foodfindr.tech**, auto-deployed from `main` via
`.github/workflows/main_foodfinder.yml`. See `docs/DEPLOYING.md` for why Azure
was chosen (persistent disk for the SQLite file). This means the iOS app has a
real backend to talk to — no new infrastructure needed.

**Existing native wrapper: NONE FOUND.** No `capacitor.config.*`, no `ios/` or
`android/` directory, no Capacitor packages in `package.json`, no prior
capacitor/ios/app-store branches or commits. This is a from-scratch wrap.

**Architecture note (corrects an assumption in the original task brief):** the
frontend is **not React** — it's vanilla HTML/CSS/JS served statically from
`public/` by Express, with zero build step (`public/js/app.js`, `public/js/map.js`,
`public/css/style.css`). All frontend `fetch()` calls in `app.js` use
**relative paths** (`/api/...`), which only work because frontend and backend
are same-origin today. This has a direct consequence for Phase 1.

---

## Phase 1 — Capacitor Setup: IN PROGRESS

Decision needed and made (logged here, flag for human review): rather than
bundling `public/` into the app and rewriting every relative `/api/...` fetch
to an absolute URL, point Capacitor at the live deployed site via
`server.url: 'https://foodfindr.tech'` in `capacitor.config`. This keeps one
source of truth and requires no frontend code changes to the fetch calls.
**Tradeoff to flag for a human:** Apple review sometimes scrutinizes apps that
are thin wrappers around a remote website with no offline/native value-add —
worth a deliberate human decision before submission, not just an agent default.

Status will be updated below as this phase completes.

---

## Phases 2-7: NOT STARTED YET

(To be filled in as work proceeds.)
