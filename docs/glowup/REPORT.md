# FoodFindr glow-up report

Branch: `glowup/native-feel-20260926` (pushed). Nothing was pushed to `main`. `docs/glowup/` is on this branch
only; **run `git rm -r docs/glowup` before merging to main**.

Raw numbers, method and per-commit progression: [`PERF.md`](PERF.md). Screenshots: [`before/`](before) and
[`after/`](after). The after set also has `3a-surprise-tapped.png` (skeleton card) and `3b-streaming.png` (card
filling in while Claude is still writing).

## Before / after

Median of 5 runs, iPhone 15 viewport, 4x CPU, LTE-like network, recorded API fixtures (Places 600 ms, Claude ~2 s
to first token and 3 s total). "Before" is the **same final harness run against the baseline code**, so every
row compares like with like.

| Metric | Before | After | Change |
|---|---|---|---|
| FCP | 576 ms | 532 ms | -8% |
| First interactive paint (sign-in / guest screen usable) | 694 ms | 666 ms | -4% |
| Maps ready | 1306 ms | 1047 ms | **-20%** |
| Native splash lifts (iOS shell, first launch) | 1267 ms | 577 ms | **-54%** |
| Guest -> first markers (12 runs each) | 1953 ms | 1979 ms | unchanged, explained below |
| **Search submitted -> first markers** | 1371 ms | 1296 ms | -5% |
| Long tasks during a search | 2 / 132 ms | 0 / 0 ms | **gone** |
| Surprise Me -> first feedback on screen | 18 ms | 53 ms | +35 ms, explained below |
| Map covered by a blocking overlay during Surprise Me | 3446 ms | 0 ms | **gone** |
| **Surprise Me -> restaurant name visible** | 3552 ms | 2617 ms | **-26%** |
| Surprise Me -> full card | 3552 ms | 3756 ms | +6%, explained below |
| Relaunch FCP | 388 ms | 180 ms | **-54%** |
| Relaunch first interactive paint | 601 ms | 378 ms | **-37%** |
| Relaunch navigation -> markers | 1844 ms | 1137 ms | **-38%** |
| First-party JS / CSS (gzip) | 19.7 / 11.9 KB | 24.3 / 13.3 KB | +4.6 / +1.4 KB |
| Third-party JS | 517 KB | 478 KB | -39 KB |
| Playwright flow | fails at "log a visit" | 14/14 pass | bug fixed |

The metrics that got worse or didn't move:
- **Guest -> markers:** no change on either side, and bimodal on both. Runs land at ~1.15 s or ~2.0 s, in the same
  4:8 ratio before and after. A step trace of the same path is a steady ~1.15 s, almost all of it modelled
  Places/Geocoding latency (850 ms). No change touched that path; I didn't find the source of the slow mode in the
  time I gave it (PERF.md, note 1).
- **First feedback, +35 ms:** the old full-screen overlay was one fixed element and painted in a single frame. The
  skeleton card lays out inside the left column and takes about two more frames at 4x CPU. Both are well under the
  ~100 ms "instant" threshold, and the old overlay then hid the map for 3.4 s. I think the trade is right, but it
  is a regression on that one number.
- **Full card, +6%:** the fixture paces streamed JSON in small chunks, and each chunk costs a little client work.
  Live against the real API, the full card arrived at ~3.5 s either way.
- **"Name in under 1 s" was not reached.** Live, Haiku 4.5 takes ~2.2 s to emit its first tool-input token for
  this prompt (8 candidates with their reviews), even with eager streaming. That's model time-to-first-token, and
  the ways to shrink it (fewer reviews, pre-picking the restaurant) would change the recommendation logic, which
  was out of bounds. What the user now sees is a skeleton card within ~50 ms, the restaurant name ~0.9 s sooner
  than before, and the dish and reason typing in rather than appearing all at once.

## What shipped, ranked by impact

**1. Streamed recommendations** (`60b9b73`, `ab47ce1`). `/api/recommend` now calls Claude with `stream: true` and
sends Server-Sent Events over a `fetch` body. The browser's `EventSource` can't POST, so there's a small reader in
`app.js`. The server incrementally parses the tool input as it arrives (`parsePartialToolInput`). As soon as
`place_id` is complete **and** matches a real candidate, it sends a `pick` event: the card shows the restaurant and
the map flies to it. Dish and reason text stream after that, but **only when the user has no dietary
restrictions**. With restrictions, `isValidRecommendation` can reject the dish itself (a diet label the reviews
don't support, meat for a vegan), so those fields wait for validation and no unvalidated dish can reach the screen.
The final `result` event goes through exactly the old path, including validation and the strict non-streamed
repair retry, and it's authoritative: if the repair picks a different restaurant, the card and map update. Clients
that don't send `Accept: text/event-stream` get the old JSON response unchanged. The second commit adds
`eager_input_streaming: true` on the streamed call: without it, the API buffers each tool parameter, and live
tests put `place_id` at ~2.7 s instead of ~2.2 s. The trade is that the API stops schema-validating that input, so
the final parse is guarded, and invalid or `max_tokens`-truncated input falls through to the existing repair path.
Measured: name visible 3552 -> 2617 ms. A real-API spot check confirmed the SSE shape and the timings
(`harness/live-stream.mjs`).

**2. Skeleton card instead of the blocking overlay** (`0c8b352`). Tapping Surprise Me used to throw a full-screen
dimmed overlay over the map for the whole ~3.5 s. Now a skeleton card appears where the answer will land, with
shimmer bars sized like the real text, and the streamed content fills it in place with no layout jump. The map
stays visible and pannable (0 ms covered, down from 3446 ms), links stay hidden until the validated result, and
closing the card mid-stream keeps it closed. Together with (1), this is what makes the recommendation feel
responsive rather than fast in a stopwatch sense.

**3. Render-blocking cleanup and an early Maps download** (`08d79e4`, `ad8284d`). Three serial costs came off the
critical path:
- The server now inlines the client config into `index.html` instead of a blocking `<script src=/js/config.js>`
  round trip.
- It emits `<link rel=preload>` for the exact Maps script URL, so the ~480 KB download starts during parse rather
  than after it.
- Google Fonts CSS no longer blocks first paint (`display=swap` was already there).

Two smaller fixes: the Maps preconnect was `crossorigin`, which the non-CORS script request can't reuse, and
`fonts.gstatic.com` had no preconnect. Maps now uses `loading=async` per Google's guidance, which also shaved
39 KB. Result: Maps ready 1306 -> 1047 ms, relaunch FCP 388 -> 304 ms before the service worker.

**4. App-shell service worker (web side)** (`83196d4`). `public/sw.js` does stale-while-revalidate for `/`, CSS, JS
and images. `/api/*`, non-GET requests, and everything cross-origin (Maps, Fonts) pass straight through.
Registration is feature-detected and happens after load. A/B on the same code: relaunch FCP 280 -> 176 ms,
relaunch first interactive paint 522 -> 365 ms, relaunch navigation -> markers 1373 -> 1140 ms. **In the iOS app
this does nothing until App-Bound Domains are enabled** (see the shell steps below); in Safari and desktop browsers
it works now. Trade-off: a deploy reaches a given user on their second launch after it. `SHELL_VERSION` in `sw.js`
force-drops old caches.

**5. Native shell: earlier splash hide, dark status bar, keyboard, plugins** (`feded2d`). The native splash used
to be hidden inside `init()`, which waits for the Maps script, so the app sat behind the splash with a
fully-usable sign-in screen already painted underneath. Setup now runs as soon as `app.js` boots: the splash lifts
at 577 ms instead of 1267 ms, it sets `SystemBars` DARK (light status-bar text; `SystemBars` ships in
`@capacitor/core` 8, so there's no status-bar plugin), and it adds keyboard listeners that scroll the focused
field into view. Since the Capacitor project lives in this repo (from `ios-app-store-prep`), I installed
`@capacitor/haptics@8.0.2` and `@capacitor/keyboard@8.0.5`, ran `npx cap sync ios` (it updated
`CapApp-SPM/Package.swift`), and updated `capacitor.config.json`:
- Keyboard: `resize: native`, dark keyboard.
- `ios.allowsLinkPreview: false`.
- A themed `ios.backgroundColor`.
- `ios.contentInset: "never"`, so the web view runs edge-to-edge and the existing `env(safe-area-inset-*)` padding
  takes effect. That last one needs checking on a device; see Risks.

**6. Stale-while-revalidate search results** (`c479a04`). Results are cached in localStorage, keyed on ~110 m
location buckets (matching the server cache) plus cuisine, distance, dish, group and account. The account matters
because the server folds a signed-in user's dietary restrictions into the query. The cache has a 30-minute TTL and
keeps 8 entries. Reopening the app in the same spot paints markers immediately, then reconciles with the diffing
`renderMarkers`, so unchanged markers don't flicker. Surprise Me still waits for fresh data, so it never picks
from a stale list. Relaunch guest -> markers went 505 -> 307 ms when it landed; the service worker later moved
that interval, see PERF.md.

**7. Haptics** (`a5d9d1a`). A small wrapper over `Capacitor.Plugins.Haptics` that only acts in the native shell
and swallows the rejection a missing plugin produces. Plain browsers are untouched.
- **Light impact:** selection controls (price/sharing toggles, chips, stars, rail tabs, stepper, marker taps).
- **Success:** at the reveal (the streamed `pick`) and on "Visit logged!".
- **Warning:** on the error card and whenever any form's status line turns into an error.

Verified with a fake Capacitor bridge in the harness (`--fake-native`): over the full flow, 11 light impacts and
2 successes fired.

**8. Web tells removed, iOS press states and motion** (`73b97ee`).
- **Gone:** the tap highlight, and text selection and the long-press callout on UI chrome. Inputs and the
  recommendation/FAQ text stay selectable.
- **No stray focus rings** after a tap (keyboard users keep `:focus-visible`).
- **No double-tap-zoom wait** (`touch-action: manipulation`).
- **No page zoom when the search field is focused.** The field is 13.6 px, so iOS zoomed the whole page on focus;
  `maximum-scale=1` stops that without changing the design.
- **Press states:** `scale: 0.97` on buttons and chips (0.92 on icon buttons). It uses the individual `scale`
  property so it stacks on existing transforms.
- **Motion:** iOS curve tokens (`--ease-ios` is UIKit's sheet curve). The drawer uses it at 300 ms, and the card
  eases in, transform and opacity only. The existing `prefers-reduced-motion` rule is untouched and still wins;
  the full flow passes with reduced motion on.

**9. Map marker reuse** (`13e50e3`). Markers that leave the result set go into a pool and are re-pointed at the
next search's restaurants instead of building new `AdvancedMarkerElement`s. Clicks use `gmp-click`, as Google's
console warning asked. `highlightPick` used to rebuild every marker's content element through an O(n²) `find` just
to restyle one; now it toggles a class on the old and new pick. Long tasks during a search: 2 / 129 ms -> 1 / 56 ms
on that commit, 0 in the final median.

**10. Drawer follows the finger** (`9380a38`). A horizontal drag moves the drawer 1:1 (transform only;
`touch-action: pan-y` keeps vertical scrolling native, with an 8 px direction lock). It closes past 35% of its
width or on a >0.5 px/ms flick, and otherwise springs back from where it was let go. This commit also fixes two
latent `closeDrawer` bugs:
- It finished on *any* bubbled `transitionend`, so after the press-state change, a button's own transition could
  hide the drawer mid-slide.
- With reduced motion there is no `transitionend` at all, so the drawer never actually became `hidden`.

**11. Rail covering the Log a Visit drawer** (`b78cc82`). A real bug the baseline flow hit. A guest tapping a
locked tab got the sign-up screen, but the side rail stayed expanded. After signing up it covered the drawer, and
the star rating couldn't be tapped.

**Branch setup** (`3ca2447`). The "already done" list in the brief only holds on `main` and `ios-app-store-prep`
combined. `main` has the search-latency work; the iOS shell, scroll lock and native splash were only on
`ios-app-store-prep` (two of those commits were local-only). This branch starts by merging `ios-app-store-prep`
into `main`'s tip, with three small `app.js` conflicts resolved (kept `main`'s sequence-guarded search and the iOS
branch's fetch hardening). So this branch also carries that branch's `STATUS.md`, `docs/PRIVACY_POLICY.md` and
`ios/` project.

## Researched and rejected

- **Prewarming reviews after every search, or on dish-input focus.** Place Details is billed per call, and a
  search would fan out to ~15 of them whether or not the user ever taps Surprise Me. On dish-input focus the
  craving changes the result set anyway, so the warmed IDs mostly miss. The existing intent-based prewarm
  (hover/focus/touchstart on the button) stays.
- **Prefetching searches when the map pans.** Every pan would be a billed Places search, and the app only searches
  at an explicitly chosen location. Not worth the cost for a speculative hit.
- **Getting the name under 1 s by changing inputs.** Trimming reviews, shrinking the pool, or choosing the
  restaurant server-side before Claude would all cut time-to-first-token. Each changes what the recommendation is
  grounded on, which the brief ruled out.
- **Not waiting for phase-2 results before Surprise Me.** It would help taps within ~4 s of a search, but it
  shrinks the candidate pool from ~57 to 20. That was a deliberate choice in the search-latency work.
- **Prompt caching the recommendation prompt.** The stable prefix (instructions) is far below the minimum
  cacheable size, and the candidate block changes every call.
- **Adding a bundler/minifier.** First-party JS is 24 KB gzipped. Minification would save a few KB, well under one
  round trip, and it adds a build step to a no-build app. Not clearly worth it.
- **View Transitions / a framework.** Out of scope per the brief. There are no route changes for view transitions
  to help with.
- **`@capacitor/status-bar`.** `SystemBars` in `@capacitor/core` 8 covers it with no extra native dependency.
- **`ios.scrollEnabled: false`.** The CSS scroll lock from `ios-app-store-prep` already stops the bounce; disabling
  the native scroll view is riskier for the drawer's inner scrolling and can't be verified without a device.
- **A skeleton "results list".** There isn't a list: results are map markers. The one full-screen overlay left is
  the very first load, which mostly waits on geolocation. The streamed card and the SWR cache cover the cases a
  skeleton would.
- **Edge-swipe to open the drawer.** It competes with iOS's own edge gestures, and the rail button is already one
  tap away.

## Follow-up in the Capacitor shell

The shell lives in this repo (`ios/`, `capacitor.config.json`). Already done on this branch:
`npm i @capacitor/haptics@^8.0.2 @capacitor/keyboard@^8.0.5`, `npx cap sync ios` (`Package.swift` updated) and the
config changes above. Web changes go live with the next deploy of `main` to foodfindr.tech, because the app loads
the site remotely. Everything native needs a new binary:

```bash
# on a Mac with Xcode
git checkout glowup/native-feel-20260926
npm ci
npx cap sync ios
npx cap open ios        # build to a device, check the items under "Risks", then archive
```

Optional, to let the service worker run inside the app (App-Bound Domains). I haven't applied this; test it on a
device first:

```xml
<!-- ios/App/App/Info.plist, inside the top-level <dict> -->
<key>WKAppBoundDomains</key>
<array>
  <string>foodfindr.tech</string>
</array>
```

```jsonc
// capacitor.config.json -> "ios"
"limitsNavigationsToAppBoundDomains": true
```

Then `npx cap sync ios` and rebuild. What to check on the device:
- `navigator.serviceWorker` exists.
- The map still loads. Maps' scripts, tiles and XHR are subresources, not navigations, so they shouldn't be
  affected, but confirm it.
- "View on Google Maps" still opens. It goes through the Browser plugin (SFSafariViewController), not a web-view
  navigation.
- Geolocation still works.

Apple caps App-Bound Domains at 10.

Order is safe either way: every web change is feature-detected, so shipping the web before the new binary (or
never shipping the binary) degrades to today's behaviour.

## Assumptions I made without asking

- **Branch base.** I merged `ios-app-store-prep` (including its two unpushed local commits) into a new branch off
  `main`, because the brief's "already done" list assumed both. Neither source branch was modified.
- **Browser.** Used the installed Chrome 153 through `playwright-core` instead of `/opt/pw-browsers` (this machine
  is Windows) and didn't install any browsers.
- **Network throttling.** Added an LTE-like network profile on top of the requested 4x CPU, because the iOS app
  loads its web code remotely.
- **Fixtures and spend.** Real keys existed, but I used recorded fixtures for all measurement runs. I made a
  handful of real API calls: one recording pass and three live streaming checks (a few Places / Place Details
  searches and five Claude Haiku calls). Fixtures stay local and git-ignored because of Google's content-storage
  terms.
- **Fixture latency.** I corrected the Claude time-to-first-token model from 700 ms to 2000 ms after live runs
  showed the first number was optimistic, and re-measured from that point.
- **Screenshots.** "Search results" means the map with markers, since the app has no list view.
- **Test data.** Test accounts (`glowup+<timestamp>@example.com`), visits and "Glowup" groups were created in the
  local SQLite DB only (`server/foodfindr.db`, git-ignored).

## Flaky, risky or half-done

- **`ios.contentInset: "never"` is unverified on a device.** It's the setting that lets the map run under the
  status bar and makes the existing `env(safe-area-inset-*)` padding real. If the top bar ends up under the notch
  or Dynamic Island, revert that one line to `"always"` and re-sync. Keyboard `resize: native` with the fixed-height
  drawer is also untested on a device.
- **SSE through Azure App Service is untested in production.** The server sets `no-transform`,
  `X-Accel-Buffering: no` and flushes through `compression`. If a proxy still buffers, the client just receives
  every event at once at the end, which is the old behaviour, not a failure.
- **Streaming text is only as validated as the old flow.** Dish and reason stream before the final validation
  when there are no dietary restrictions. The only checks on them in that case are "non-empty" and "no markup";
  markup is stripped from partial text, and the final result replaces what was streamed. If a repair retry
  happens, the user may briefly see the first attempt's text before it's replaced.
- **Service-worker staleness.** A deploy reaches each user one launch late. In local development the SW also caches
  `localhost`, so an edit shows on the second reload. Use DevTools "Update on reload", or bump `SHELL_VERSION`.
- **Harness quirks.** Guest -> markers is bimodal for reasons I didn't pin down (identical before and after).
  Google Maps occasionally never finishes loading in headless Chrome (once in roughly 100 runs). The Surprise Me feedback
  and full-card numbers carry the fixture pacing caveats above.
- **Not done.** No real-device testing of anything native (haptics, keyboard, status bar, splash, safe areas) and
  no App-Bound Domains change. The web side is feature-detected and verified with a fake bridge, and the plugins
  are installed and synced, but nobody has felt the haptics on a phone yet.
