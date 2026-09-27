# FoodFindr glow-up: performance numbers

Raw per-run data lives in `harness/results-<label>.json` (every run, not just medians). Harness:
`harness/flow.mjs` + `harness/fixture-fetch.cjs`. Summary and interpretation: `REPORT.md`.

## Method

- **Browser:** system Chrome 153 (headless), driven by `playwright-core` 1.63. The brief said Chromium lives at
  `/opt/pw-browsers`, but this machine runs Windows and that path doesn't exist. No browser was downloaded.
- **Device:** iPhone 15 viewport (393x852 @3x, touch, mobile UA), **4x CPU throttling** (CDP
  `Emulation.setCPUThrottlingRate`), plus an **LTE-like network** (100ms RTT, ~20 Mbps down, ~5 Mbps up) on every
  request. The brief only asked for CPU throttling. I added the network profile because the iOS app loads
  `https://foodfindr.tech` over the network, and on localhost with zero RTT, render-blocking and caching work would
  look like it does nothing.
- **External APIs:** real keys are available, but every run replays **recorded fixtures** so runs are comparable and
  don't bill anyone. A single `--mode record` pass captured real Google Places / Geocoding / Place Details responses
  and one real Claude Haiku 4.5 answer. Replay applies fixed latencies:

  | Call | Modelled | Measured live (Sept 2026) |
  |---|---|---|
  | Places search | 600 ms | 310-400 ms |
  | Geocoding | 250 ms | ~235-270 ms |
  | Place Details (reviews) | 350 ms | 200-280 ms for 8 in parallel |
  | Claude, first tool-input token | 2000 ms | 2.2-2.3 s (eager streaming), ~2.7 s (default buffered) |
  | Claude, whole tool call | 3000 ms | 3.2-3.5 s |

  The first Claude model used 700 ms to first token. Live testing showed that was optimistic, so I recalibrated to
  2000 ms and re-measured everything from the `stream-eager` commit on. The `stream` row below is under the old,
  optimistic model; don't compare it with the others. `Math.random` is seeded **only** inside `pickRandomTopPool`,
  so the Surprise Me pool (and therefore the recorded Claude answer) is identical every run. Fixtures are
  git-ignored, because Google's Places terms restrict storing their content.
- **Google Maps JS** is the real thing (real key, real tiles). It's the one source of network variance I couldn't
  remove.
- **Each run** starts a fresh server (cold server caches) and a fresh browser profile (cold HTTP cache and no
  service worker), then relaunches once in the same profile. **5 runs, median reported** unless noted. Timestamps are
  paint-level: the first `requestAnimationFrame` in which the thing is actually on screen.
- **Like-for-like before/after:** the final "before" column is the **final harness run against the baseline code**
  (a git worktree at `4bcd90b`), so metrics added during the work have a real baseline too
  (`results-final-before*.json`). The original baseline run (`results-baseline.json`) agrees with it within noise.

### Metric definitions

| Metric | Start | End |
|---|---|---|
| FCP | navigation | first-contentful-paint |
| First interactive paint | navigation | first frame with the sign-in / guest screen showing, handlers bound (the first screen anyone can act on) |
| Maps ready | navigation | `maps-loaded` (map initialised, app `init()` ran) |
| Guest -> markers | tap on Continue as Guest | first frame with restaurant markers (geolocation granted) |
| **Search -> first markers** | Enter in the location search ("Austin, TX") | first frame showing a marker from the new result set |
| Long tasks during search | Enter | phase-2 results merged (~4 s later): count / total / max `longtask` |
| Surprise Me -> first feedback | tap | first frame with *any* response on screen (old: loading overlay; new: skeleton card) |
| Map covered during Surprise Me | tap | total time the blocking overlay was on screen |
| **Surprise Me -> restaurant name** | tap | first frame where the card is visible with the restaurant name |
| Surprise Me -> full card | tap | reason text rendered and the card out of its streaming state |
| JS / CSS bytes | whole session up to the first recommendation | encoded (on-the-wire) bytes, first-party vs third-party |
| Relaunch * | same profile reloaded against a warm server (reopening the app) | as above |
| Relaunch nav -> markers | navigation | first frame with markers (after the guest tap) |
| Native splash lifts | navigation | `SplashScreen.hide()` call, via a fake Capacitor bridge in the page (`--fake-native`) |

## Before / after (final)

`node flow.mjs --label final-before --root <worktree@4bcd90b> --runs 5` vs `node flow.mjs --label final-after --runs 5 --shots after`

| Metric | Before | After | Change |
|---|---|---|---|
| FCP | 576 ms | 532 ms | -8% |
| First interactive paint | 694 ms | 666 ms | -4% |
| Maps ready | 1306 ms | 1047 ms | **-20%** |
| Guest -> markers (12 runs each, `--boot-only`) | 1953 ms | 1979 ms | no change (see note 1) |
| **Search -> first markers** | 1371 ms | 1296 ms | -5% |
| Long tasks during search (count / total / max) | 2 / 132 ms / 73 ms | 0 / 0 / 0 | **-100%** (see note 2) |
| Surprise Me -> first feedback | 18 ms | 53 ms | +35 ms (see note 3) |
| Map covered by overlay during Surprise Me | 3446 ms | 0 ms | **-100%** |
| **Surprise Me -> restaurant name** | 3552 ms | 2617 ms | **-26%** |
| Surprise Me -> full card | 3552 ms | 3756 ms | +6% (see note 4) |
| First-party JS / CSS | 19.7 / 11.9 KB | 24.3 / 13.3 KB | +4.6 / +1.4 KB |
| Third-party JS / CSS | 517 / 5.5 KB | 478 / 5.5 KB | -39 KB JS |
| Relaunch FCP | 388 ms | 180 ms | **-54%** |
| Relaunch first interactive paint | 601 ms | 378 ms | **-37%** |
| Relaunch nav -> markers | 1844 ms | 1137 ms | **-38%** |
| Native splash lifts (3 runs, fake bridge) | 1267 ms | 577 ms | **-54%** |
| Playwright flow | fails at "log a visit" | 14/14 steps pass | fixed |

Notes:
1. **Guest -> markers is bimodal in both versions:** runs land at ~1.15 s or ~2.0 s, the same 4:8 split before and
   after across 12 runs each (`results-boot-*.json`). A step trace (`harness/trace-boot.mjs`) of the same path is a
   steady ~1.15 s: geolocation ~40 ms, the search request ~920 ms (850 ms of that is modelled Places + Geocoding
   latency), render ~150 ms. I didn't find the source of the slow mode within the time box. It's in the harness
   environment or Maps, not in a changed code path, because it's identical on the baseline code.
2. The one long task left after marker pooling sits right around the 50 ms threshold. Across the last three
   5-run sets it was 1 task / 56 ms in one and 0 in two.
3. The old overlay was a single fixed element and appeared in one frame. The skeleton card has to lay out in the
   left column, which takes about two more frames under 4x CPU. Both are under the ~100 ms "instant" threshold, and
   the old overlay then covered the map for 3.4 s.
4. The fixture paces the streamed tool input in 12-character chunks across the last 1000 ms, and each chunk costs
   a little client work. Live, full-card time was ~3.5 s either way.

### Real-API spot checks (not fixtures)

`harness/live-stream.mjs` against the real APIs, NYC, 8-candidate pool:
- Default (buffered) tool streaming: `pick` event 2972 ms after the request, full result 4554 ms (reviews 204 ms,
  so ~2.7 s of Claude before `place_id` arrived).
- With `eager_input_streaming: true`: `pick` at 2493 ms / 2340 ms, full result 3527 ms / 3532 ms (reviews 268 / 0 ms,
  so ~2.2-2.3 s of Claude before `place_id`).
- One earlier run (on the old code) took 11.5 s to the first token, which is ordinary API tail latency. Streaming
  doesn't change that tail; it just makes the wait show something.

### Service worker A/B (same code, SW blocked vs allowed)

| Relaunch metric | SW blocked | SW allowed |
|---|---|---|
| FCP | 280 ms | 176 ms |
| First interactive paint | 522 ms | 365 ms |
| Nav -> markers | 1373 ms | 1140 ms |

Relaunch *guest -> markers* goes **up** with the SW (305 -> 527 ms). That's not a slowdown. The sign-in screen
appears ~160 ms earlier, so the tap lands before Maps has finished loading and the interval absorbs the Maps wait.
Nav -> markers is the number a user feels, which is why it was added.

## Progression (medians per commit, 5 runs each)

| run | fcp | gate | maps | search->markers | long tasks ms | feedback | overlay ms | ->name | ->full | relaunch fcp | relaunch gate | relaunch nav->markers |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline | 580 | 703 | 1358 | 1376 | 150 | - | - | 3565 | 3566 | 404 | 613 | - |
| stream (700 ms TTFT model, not comparable) | 568 | 710 | 1327 | 1352 | 144 | - | - | 1461 | 3581 | 372 | 584 | - |
| stream-eager (2000 ms TTFT) | 552 | 702 | 1301 | 1370 | 127 | - | - | 2666 | 3730 | 380 | 638 | - |
| skeleton | 568 | 697 | 1310 | 1347 | 120 | 53 | 0 | 2622 | 3739 | 384 | 637 | - |
| swr | 580 | 699 | 1398 | 1385 | 149 | 46 | 0 | 2630 | 3757 | 400 | 639 | - |
| native-css | 568 | 699 | 1324 | 1345 | 129 | 49 | 0 | 2616 | 3770 | 384 | 612 | - |
| render-blocking | 536 | 656 | 1050 | 1352 | 129 | 44 | 0 | 2622 | 3717 | 304 | 547 | - |
| service-worker | 532 | 673 | 1058 | 1358 | 123 | 52 | 0 | 2628 | 3763 | 180 | 362 | - |
| marker-pool | 524 | 667 | 1057 | 1306 | 56 | 44 | 0 | 2602 | 3740 | 184 | 380 | 1194 |
| drawer-drag | 528 | 681 | 1059 | 1296 | 0 | 53 | 0 | 2605 | 3730 | 168 | 359 | 1137 |
| **final-before** (baseline code, final harness) | 576 | 694 | 1306 | 1371 | 132 | 18 | 3446 | 3552 | 3552 | 388 | 601 | 1844 |
| **final-after** | 532 | 666 | 1047 | 1296 | 0 | 53 | 0 | 2617 | 3756 | 180 | 378 | 1137 |

Other runs: `swr` measured relaunch guest -> markers 505 -> 307 ms before the SW existed (cached markers paint
immediately). `results-splash-{before,after}.json` hold the splash timing on the commit that moved it.

## Baseline (as first recorded, commit 3ca2447)

`node flow.mjs --label baseline --runs 5 --shots before` (harness at the time: no feedback, overlay or
nav->markers metrics yet).

| Metric | Median |
|---|---|
| FCP | 580 ms |
| First interactive paint | 703 ms |
| Maps ready | 1358 ms |
| Guest -> markers | 1240 ms |
| Search -> first markers | 1376 ms |
| Long tasks during search | 2 tasks, 150 ms total, 78 ms max |
| Surprise Me -> restaurant name | 3565 ms |
| Surprise Me -> full card | 3566 ms |
| First-party JS / CSS | 19.7 KB / 11.9 KB |
| Third-party JS / CSS | 517 KB / 5.5 KB |
| Relaunch FCP | 404 ms |
| Relaunch first interactive paint | 613 ms |
| Relaunch guest -> markers | 505 ms |

Baseline notes: run 3 of 5 timed out on relaunch because Google Maps never finished loading (third-party
flakiness; medians use the runs that finished). The functional flow failed at "log a visit" because of a real bug,
since fixed (REPORT.md, item 10).
