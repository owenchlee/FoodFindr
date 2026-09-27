# FoodFindr glow-up: performance numbers

Raw per-run data: `harness/results-<label>.json`. Harness: `harness/flow.mjs` + `harness/fixture-fetch.cjs`.

## Method

- **Browser:** system Chrome 153 (headless) driven by `playwright-core` 1.63. The brief said Chromium lives at
  `/opt/pw-browsers`, but this machine runs Windows and that path doesn't exist, so no browser was downloaded.
- **Device:** iPhone 15 viewport (393x852 @3x, touch, mobile), **4x CPU throttling** (CDP
  `Emulation.setCPUThrottlingRate`), plus an **LTE-like network** (100ms RTT, ~20 Mbps down, ~5 Mbps up) on every
  request. The brief only asked for CPU throttling. I added the network profile because the iOS app loads
  `https://foodfindr.tech` over the network, and on localhost with zero RTT, render-blocking and caching fixes
  would look like they do nothing.
- **External APIs:** real keys are available, but every run replays **recorded fixtures** so the numbers stay
  comparable and repeated runs don't bill anyone. A single `--mode record` pass captured real Google Places,
  Geocoding and Place Details responses plus one real Claude Haiku 4.5 response. Replay applies fixed
  latencies: Places search 600ms, Geocoding 250ms, Place Details 350ms, Claude 700ms to first token and 3000ms
  in total. That record pass measured 403ms for real Places and 3823ms from click to card for real Claude, so
  the model is realistic. `Math.random` is seeded, so the Surprise Me candidate pool is the same on every run.
  The fixtures are git-ignored, because the Places terms restrict storing their content.
- **Google Maps JS** is the real thing (real browser key, real tiles), so it's the one source of network
  variance I couldn't remove.
- **Each run** starts a fresh server (cold server caches) and a fresh browser profile (cold HTTP cache). **5 runs,
  median reported.** Timestamps are paint-level: the first `requestAnimationFrame` in which the thing is actually
  on screen, not the moment a fetch resolved.

### Metric definitions

| Metric | Start | End |
|---|---|---|
| FCP | navigation | first-contentful-paint |
| First interactive paint (`gateVisible`) | navigation | first frame with the sign-in/guest screen showing and its handlers bound (the first screen anyone can act on) |
| Maps ready | navigation | `maps-loaded` event (map initialised, app `init()` ran) |
| Guest -> markers | tap on Continue as Guest | first frame with restaurant markers on the map (geolocation granted) |
| **Search -> first markers** | Enter in the location search ("Austin, TX") | first frame showing a marker from the new result set |
| Long tasks during search | Enter | phase-2 results merged (~4s later); count, sum and max of `longtask` entries |
| **Surprise Me -> first recommendation text** | tap on Surprise Me | first frame where the card is visible with the restaurant name |
| Surprise Me -> full card | tap on Surprise Me | reason text fully rendered |
| JS/CSS bytes | whole session up to the first recommendation | encoded (on-the-wire) bytes, first-party vs third-party |
| Relaunch * | same profile reloaded with warm server (like reopening the app) | as above |

## Baseline (commit 3ca2447, merge of main + ios-app-store-prep)

`node flow.mjs --label baseline --runs 5 --shots before`

| Metric | Median |
|---|---|
| FCP | 580 ms |
| First interactive paint | 703 ms |
| Maps ready | 1358 ms |
| Guest -> markers | 1240 ms |
| **Search -> first markers** | **1376 ms** |
| Long tasks during search | 2 tasks, 150 ms total, 78 ms max |
| **Surprise Me -> restaurant name** | **3565 ms** |
| Surprise Me -> full card | 3566 ms (everything arrives at once) |
| First-party JS / CSS (encoded) | 19.7 KB / 11.9 KB |
| Third-party JS / CSS (Maps, fonts) | 517 KB / 5.5 KB |
| Relaunch FCP | 404 ms |
| Relaunch first interactive paint | 613 ms |
| Relaunch guest -> markers | 505 ms |

Baseline notes:
- Run 3 of 5 timed out on relaunch because Google Maps never finished loading (blank map, no tiles). That's
  third-party flakiness, so the medians use the runs that finished each step.
- The functional flow **failed on the baseline** at "log a visit". This is a real, pre-existing bug: when a guest
  taps a locked rail tab, they're sent to the sign-up screen but the side rail stays expanded, and after signing
  up it covers the Log a Visit drawer, so the star rating can't be tapped. Fixed in this branch (see REPORT.md).
