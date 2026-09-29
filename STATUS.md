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

## Phase 1 — Capacitor Setup: **COMPLETE**

Installed `@capacitor/core`, `@capacitor/cli`, `@capacitor/ios`,
`@capacitor/geolocation`. Ran `npx cap init` (appId `tech.foodfindr.app`,
appName `FoodFindr`) and `npx cap add ios`, then `npx cap sync ios` — synced
clean, no errors. Generated `ios/App/` Xcode project, using Swift Package
Manager for the one native plugin dependency (no CocoaPods needed for this
minimal setup).

**Decision made (flag for human review before submission):** rather than
bundling `public/` into the app and rewriting every relative `/api/...` fetch
to an absolute URL, `capacitor.config.json` points at the live deployed site
via `server.url: "https://foodfindr.tech"`. This keeps one source of truth —
UI/UX fixes made to `public/` in this repo take effect for both the website
and the iOS app once deployed, with no separate app-only fork of the frontend.
**Tradeoff to flag for a human:** Apple review sometimes scrutinizes apps that
are thin wrappers around a remote website with no offline/native value-add.
This app does have native additions (geolocation plugin available, Info.plist
permission handling, iOS-specific UI fixes below) but is still fundamentally
loading remote web content — worth a deliberate go/no-go before submission,
not just an agent default. Alternative if this gets rejected: switch
`webDir` to serve `public/` bundled locally and rewrite the ~20 relative
fetch() calls in `public/js/app.js` to an absolute `API_BASE` constant.

**App ID note:** `tech.foodfindr.app` was chosen to match the deployed domain
(foodfindr.tech) since no bundle ID was specified. **This must be confirmed
against whatever bundle ID is registered (or will be registered) in App Store
Connect before submission** — changing it later requires a new Xcode project
identity and possibly a new App Store Connect app record.

**Bundle build note:** did not run `pod install`, open Xcode, or attempt any
build/sign step, per instructions. `npx cap sync ios` (the CLI-level sync
check) completed without error, which is as far as this can be verified
without macOS/Xcode.

## Phase 2 — Location Permission: **COMPLETE**

Added `NSLocationWhenInUseUsageDescription` to `ios/App/App/Info.plist`:

> "FoodFindr uses your location to find restaurants and dishes near you and
> to show distances to your recommendations. Your location is only used
> while the app is open and is never used to track you in the background."

Matches actual usage: `public/js/app.js` (`requestUserLocation`, ~line 815)
calls `navigator.geolocation.getCurrentPosition` only, no `watchPosition`,
no background location. Only the "when in use" permission is requested —
not `NSLocationAlwaysAndWhenInUseUsageDescription`, since the app never needs
always-on access.

---

## Phase 3 — iOS UI Audit: **COMPLETE**

**Safe area insets.** Added `viewport-fit=cover` to the viewport meta tag
(`public/index.html`), required for `env(safe-area-inset-*)` to resolve to
non-zero values on notched/Dynamic-Island iPhones. Added safe-area padding to
every UI element that's pinned to a viewport edge:
- `.top-bar` (top: 0, right: 0) — top+right insets, both breakpoints
- `.side-rail` (top: 0, left: 0, full height) — top+bottom insets
- `.tab-drawer-panel` (reaches viewport bottom) — bottom inset
Left/right insets on the narrow 48-56px side rail were deliberately **not**
expanded (would cramp icons in landscape on notched devices) — flagged as a
follow-up needing an actual device/simulator to verify, since this can't be
visually tested on Windows without Xcode.

**44x44pt minimum touch targets (Apple HIG).** Found and fixed ~10 controls
under the 44pt minimum: `.dish-clear-btn` (20x20), `.password-toggle-btn`
(28x28), `.drawer-close` (28x28), `.ticket-close-btn` (~27x27), `.tabs-toggle`
(40x36 / 34x32 mobile), `.rail-btn` (40px / 36px height), `.group-size-row
button` (32x32), `.group-item-actions button` (~21px tall), `.chip` (~21px
tall), `.price-toggle button` (~33px tall). Fixed via an invisible
`::before` hit-area expansion (`position: absolute; inset: -Npx`) for the
small icon buttons — keeps every visual size and layout exactly as designed,
only enlarges the tappable area — and via `min-height: 44px` for the chip/
price-toggle pill buttons where growing the actual box is the more natural
fix. Not verified on a real device/simulator (not available on this machine)
— worth a quick visual pass once someone has Xcode open.

**Hover-only interactions.** Audited every `:hover` rule in `style.css`
(~16 total) — all are supplementary visual feedback on already-tap-clickable
buttons (background/border color change only). Confirmed none is the *only*
way to reveal or trigger something (no `:hover { display: ... }` / hover-only
opacity-reveal patterns found). **No changes needed here.**

**Text selection / callout menus.** Added a scoped rule disabling
`-webkit-touch-callout` and `-webkit-user-select` on interactive chrome
(`button`, `svg`, `.cta`, `.chip`, `.rail-btn`, `.tabs-toggle`,
`.filters-toggle`, `.side-rail`, the wordmark, `#map`, badge/leaderboard
cards, star ratings) — this stops a long-press on a button or icon from
popping the native iOS text-selection/copy menu. Left untouched: text inputs,
the ticket reason text, and other genuine reading/copyable content, which
should stay selectable as normal.

**Browser-only navigation.** Searched for `window.location`, `history.push/
back`, and anchor-based navigation. Found exactly one: `#ticket-map-link`
("View on Google Maps →", `target="_blank"`, href set dynamically in
`app.js` to a `google.com/maps/search` URL). **This needed a real fix, not
just an audit note:** Capacitor's WKWebView doesn't open `target="_blank"`
links on its own (a well-known Capacitor gotcha — no browser tab for them to
go to, so the click would silently do nothing in the native app). Installed
`@capacitor/browser` and added a native-only click handler in `app.js`
(`init()`) that intercepts `a[target="_blank"]` clicks and routes them
through `Browser.open()` when `Capacitor.isNativePlatform()` is true; on the
plain website (not wrapped) this is a no-op and the link behaves exactly as
before. No other browser-chrome dependency (no reliance on the browser back
button, no full-page reloads) found — the app is a single-page shell that
never navigates away from itself.

---

## Phase 4 — Offline and Network Failure Audit: **COMPLETE**

Audited all ~18 `fetch()` call sites in `public/js/app.js`. Found the app
already handled most user-initiated actions (login, recommend, geocode,
groups) reasonably, but several were genuinely uncaught — `fetch()` itself
*throws* (rather than resolving with a non-ok response) when there's no
network at all, and these had no `catch`, meaning an unhandled promise
rejection and a section that just silently never populates:

- **`loadRestaurants` (critical — the primary Google-Places-backed flow)**
  had a `try/finally` with no `catch`. Fixed: added a catch showing
  `showLocationBanner("Couldn't reach the server. Check your connection and
  try again.")`, matching the existing `!response.ok` message pattern in
  the same function.
- `loadProgress`, `loadStreaks`, `loadBadges`, `loadLeaderboard`,
  `loadRecentVisits`, `loadPreferences` (background/tab-content loaders,
  called fire-and-forget from `startAppData()`) — wrapped each in try/catch
  falling back to the same empty-state each already shows for a non-ok
  response, so a real network failure degrades the same way a server error
  already does instead of throwing.
- `submitVisit`, `submitPreferences` (user-initiated form submits) —
  wrapped with a catch that shows the same
  "Couldn't reach the server..." message in their existing status element,
  matching the pattern `submitAuthForm`/`getRecommendation` already used.

**Added a global offline indicator**, since the app depends on two external
APIs and per-call error messages only fire *after* a user tries an action —
a proactive "you're offline" banner is the clearer signal the task asked
for:
- New `#offline-banner` element (`public/index.html`), styled as a
  dismiss-free top banner (`public/css/style.css`, `.offline-banner`).
- `public/js/app.js`: listens for `window` `online`/`offline` events (checked
  immediately at script load too, in case the app opens while already
  offline) and toggles the banner via `navigator.onLine`.
- Stacks below `.location-banner`/`.active-group-banner` via a `:has()`-style
  sibling selector instead of overlapping them, for the rare case more than
  one banner is visible at once.

**Verified in a real browser** (not just read the code): ran the server
locally, loaded the app as a guest, confirmed no console errors, and forced
`navigator.onLine = false` + dispatched an `offline` event via
`javascript_tool` to confirm the banner actually renders correctly
(screenshotted). Also spot-checked the collapsed/expanded side rail after
the Phase 3 touch-target and safe-area CSS changes — no visual regressions.
**Not verified:** actual airplane-mode behavior on a real iOS device/
simulator (not available on this machine).

---

## Phase 5 — App Icon and Splash Screen: **COMPLETE (placeholder)**

Generated at the exact sizes Capacitor's iOS project (`cap add ios`) already
expects — Xcode's modern single-size asset catalog auto-generates every
other icon size at build time from one 1024x1024 source, so only these
needed replacing:
- `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`
  (1024x1024, no alpha channel — required, Apple rejects icons with
  transparency)
- `ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732{,-1,-2}.png`
  (2732x2732 x3, identical — matches Capacitor's default template, which
  reuses one image across the 1x/2x/3x buckets)

Used the app's **existing** brand mark (`public/images/logo.png`, the chef
dog mascot already shown on the login screen) centered on the app's actual
`--color-char` background (`#1c1512`) — no invented branding, no design
file existed so this reuses what's already there. Generated via an HTML
canvas (loaded the logo, filled the background, centered the mark, exported
`toDataURL()`) rendered in a real Chrome tab and written to disk — this
needed a throwaway local Node server (`.taskdev/save-asset-server.js` +
`asset-gen-standalone.html`, not committed, already deleted) since the
main app server's CSP (`connect-src`/`form-action` both effectively
`'self'`) correctly blocks a page it serves from POSTing data to another
local port — a good sign the CSP is doing its job, just inconvenient for
this one-off generation step.

**Flagged as placeholder needing a real design pass**, per the task brief:
this is a functional, on-brand placeholder (no default Capacitor logo
shipping to the App Store), not a finished icon/splash design. A human
designer should still produce a proper App Store icon (Apple has specific
icon design guidelines beyond "centered logo on a color") and splash
screen before submission.

---

## Phase 6 — Privacy Manifest Scaffold: **COMPLETE (draft, needs human review)**

Created `ios/App/App/PrivacyInfo.xcprivacy` (Apple's required privacy
manifest format). Full reasoning is inline in the file's own comments;
summary:

**Plugins in use:** `@capacitor/geolocation@8.2.2`, `@capacitor/browser@8.0.4`
(plus `@capacitor/core`'s iOS runtime, always present). That's the complete
list — checked `package.json`.

**Required-Reason API check — actually done, not guessed:** grepped the
*installed* native Swift source (`node_modules/@capacitor/ios`,
`@capacitor/geolocation/ios`, `@capacitor/browser/ios`) for the signal APIs
in each of Apple's required-reason categories (UserDefaults, file-timestamp,
disk-space, system-boot-time, active-keyboard). **Found none** at the
currently pinned versions, so `NSPrivacyAccessedAPITypes` is an empty array.
This is a real finding, not a skipped step — but it's explicitly **not**
the authoritative check: a human needs to open the project in Xcode and run
Product > Archive to get Xcode's own privacy report, which sees the full
compiled dependency tree (CocoaPods/SPM transitive deps) in a way a static
source grep on Windows can't. If that report flags anything, the file has
a comment explaining exactly what to add and where to find Apple's reason
code list.

**Data collection declared** (`NSPrivacyCollectedDataTypes`), based on what
the code actually does, not assumptions:
- **Precise Location** — sent to Google Places server-side to find/rank
  nearby restaurants (`server/server.js`).
- **Email Address** — used for account signup/login (`server/auth.js`).
- **Search History** — craving/dish search terms, cuisine/dietary/price/
  distance filters; sent to the Claude API server-side to generate a
  recommendation, and stored server-side (SQLite) to build taste-profile
  data (flavor tags, preferences).

All three marked `NSPrivacyCollectedDataTypeTracking: false` (no cross-app
ad tracking) and linked to the user (tied to their account).
`NSPrivacyTracking` (top-level) is `false`, no tracking domains.

**Explicitly flagged as needing human review before shipping** (per the
task's own instruction — an agent should not finalize this):
1. The reason-code section above (empty now, verify with Xcode's own report).
2. **This file is not yet wired into the Xcode target.** Didn't hand-edit
   `project.pbxproj` to add it to "Copy Bundle Resources" — that file's a
   fragile, precisely-structured format with no way for me to validate the
   edit without Xcode itself to open and check it, and a bad edit could
   break the whole project loading. A human needs to open the project in
   Xcode, drag `PrivacyInfo.xcprivacy` into the `App` group, and confirm
   "Copy items if needed" is off / target membership is checked. Takes
   under a minute in Xcode; not something worth risking blind.
3. **The separate App Store Connect Privacy Nutrition Label questionnaire**
   (filled out on the App Store Connect website, not in this file) is where
   third-party data sharing with Google and Anthropic actually needs to be
   disclosed to Apple/users in the App Store listing — this `.xcprivacy`
   file covers API-usage transparency and this app's own data-collection
   summary, but the human-facing "does this app share data with third
   parties" nutrition label is a separate manual step in App Store Connect
   that only a human with account access can complete.

---

## Phase 7 — Privacy Policy Draft: **COMPLETE (draft, needs human/legal review)**

Wrote `docs/PRIVACY_POLICY.md`, based on actually reading `server/server.js`,
`server/auth.js`, and `server/db.js` — not assumptions. Covers: account
data (email + scrypt-hashed password, never plaintext), location (sent to
Google Places/Geocoding, not collected in the background), search/
preference data (sent to Anthropic's Claude API for recommendations, stored
for taste-profile matching), visit-logging and group features, and an
explicit "what we don't collect" section (no analytics/ad SDKs, confirmed
by grep — none found in `public/`). Named both third parties data is
actually shared with (Google, Anthropic) with links to their own policies,
per the task's explicit instruction that this needs to be accurate since
it's a real compliance disclosure, not a formality.

**Marked DRAFT throughout**, with inline `[DRAFT NOTE: ...]` markers at
every spot needing a human decision before publishing: effective
date/contact method/entity name, data retention specifics, children's
privacy / age rating, and policy-change process.

**Found a real gap while writing this, not just a placeholder note:** the
app has account creation (email/password signup) but **no account-deletion
flow anywhere in the codebase** (checked `server/db.js`,
`server/auth.js` — no delete-user path exists). Apple's App Store Review
Guideline 5.1.1(v) requires apps that support account creation to also
offer in-app account deletion. **This is a likely App Store rejection risk,
not just a privacy-policy wording issue** — flagged here and in the final
summary below as something to fix (or get an explicit product decision on)
before submission, separate from the privacy-policy text itself.

---

## Final Summary

All 8 phases (0–7) complete. Branch `ios-app-store-prep`, worked in an
isolated git worktree at `C:\Users\owen\Documents\GitHub\FoodFindr-ios-worktree`
(see note below on why) — one commit per phase, all pushed to that branch
only, nothing merged to `main`, nothing built/signed/submitted.

### What's actually done and verified
- **Security: GO.** Google Places and Anthropic API keys confirmed
  server-only, never reachable from the client bundle (Phase 0).
- Capacitor iOS project scaffolded from scratch and syncs clean (Phase 1).
- Location permission string added, matches actual (when-in-use only) usage
  (Phase 2).
- Real iOS UI bugs found and fixed, not just audited: safe-area insets,
  10 undersized touch targets, text-callout suppression, and a genuine
  Capacitor `target="_blank"` gotcha on the "View on Google Maps" link
  (Phase 3).
- Real network-failure bugs found and fixed: several `fetch()` calls
  (most importantly the primary restaurant-search flow) had no `catch` at
  all and would silently break on no network; added a proactive offline
  banner. Verified in an actual browser, including forcing offline state
  (Phase 4).

### What's a placeholder (functional, but needs a follow-up pass)
- **App icon / splash screen** (Phase 5): on-brand (uses the existing chef-
  dog mascot and app color scheme), correctly sized, no alpha channel — but
  a placeholder, not a real App Store icon design.
- **`PrivacyInfo.xcprivacy`** (Phase 6): data-collection section is grounded
  in the actual code; the required-reason API section was verified against
  currently-installed plugin source (found nothing) but explicitly still
  needs Xcode's own Archive privacy report as the authoritative check.
- **`docs/PRIVACY_POLICY.md`** (Phase 7): grounded in the actual code and
  actual third parties (Google, Anthropic) — but has explicit `[DRAFT
  NOTE: ...]` markers everywhere a human/legal decision is still needed
  (contact info, retention, age rating, etc.), and needs to be hosted at a
  real URL before App Store Connect submission (it's just a repo file
  today).

### Nothing was blocked from Phase 0
No blocking security issue was found, so no phase was skipped.

### An unplanned event during this run (resolved, no data lost)
Partway through, this session discovered it was sharing its working
directory with a **second, unrelated Claude Code session** doing overnight
tests/lint/export-feature work on branch
`overnight/tests-export-hardening-20260920`. A branch checkout from this
session briefly caused the other session's own commit to land on
`ios-app-store-prep` instead of its intended branch. The other session
caught it immediately and reverted it themselves before this session had to
act; this session then moved permanently into the isolated worktree above
so the two stopped sharing HEAD. No commits or work were lost on either
side. Mentioned here only so it's not mysterious if branch history looks
unusual — `git log` on `ios-app-store-prep` is otherwise a clean, linear
set of phase commits.

### Everything still needed before this can actually ship

**Requires the Apple Developer account / App Store Connect:**
1. Register the app / confirm the bundle ID — this project used
   `tech.foodfindr.app` as a placeholder (Phase 1); it must match (or be
   registered as) whatever's set up in App Store Connect.
2. Fill out the **Privacy Nutrition Label questionnaire** in App Store
   Connect — this is separate from `PrivacyInfo.xcprivacy` and is where
   sharing data with Google/Anthropic actually gets disclosed to Apple and
   shown to users on the App Store listing.
3. Host `docs/PRIVACY_POLICY.md` (after human/legal review) at a real,
   public URL — App Store Connect requires a live privacy policy link.
4. Confirm the intended App Store age rating and reconcile it with the
   privacy policy's children's-privacy section.
5. Apple Developer Program enrollment/certificates/provisioning profiles —
   not touched here at all, out of scope for a non-macOS agent session.

**Requires Xcode (macOS):**
1. Open the project, run a real build, and resolve any Swift Package
   Manager dependency issues — never attempted here (Windows, no Xcode).
2. Run **Product > Archive** and read Xcode's privacy report to confirm
   `PrivacyInfo.xcprivacy`'s `NSPrivacyAccessedAPITypes` section (currently
   empty) doesn't need any entries — see Phase 6.
3. Drag `PrivacyInfo.xcprivacy` into the `App` target's "Copy Bundle
   Resources" build phase — not done here, see Phase 6 for why (wouldn't
   hand-edit `project.pbxproj` without a way to validate it).
4. Visually verify the Phase 3 safe-area and touch-target CSS fixes on a
   real device/simulator with a notch/Dynamic Island — approximated
   correctly by reasoning about the CSS, but never actually seen on an iOS
   screen.
5. Test actual airplane-mode behavior on a device/simulator (Phase 4 was
   verified by forcing `navigator.onLine` in desktop Chrome, not on iOS).
6. Code-sign and submit — explicitly out of scope per the task's own
   instructions ("do not attempt to build, sign, or submit anything").

**Requires a human product/business decision:**
1. **The remote-vs-bundled loading decision** (Phase 1) — currently loads
   `https://foodfindr.tech` live via `server.url`, which is the pragmatic
   choice given the codebase has no build step, but carries some App Store
   review risk as a "thin wrapper" app. Revisit if review pushes back.
2. **No account-deletion flow exists** (found while writing Phase 7) —
   Apple's guideline 5.1.1(v) requires one for apps with account creation.
   This needs either a real feature (add a delete-account endpoint + UI) or
   an explicit decision about how account deletion will be handled, before
   submission.
3. Real design pass on the app icon/splash screen (Phase 5).
4. Legal review and finalization of the privacy policy (Phase 7) and the
   `PrivacyInfo.xcprivacy` data-collection entries (Phase 6).
5. Confirm the `GOOGLE_MAPS_BROWSER_KEY` is actually HTTP-referrer-restricted
   in Google Cloud Console (Phase 0 — can't be verified from the repo).
