// Glow-up perf + end-to-end harness.
//
//   node flow.mjs --label baseline [--runs 5] [--mode replay|record] [--shots before]
//
// Each run starts a fresh server (cold server caches) and a fresh browser
// context (cold HTTP cache), emulating an iPhone 15 viewport with 4x CPU
// throttling and an LTE-like network, then:
//   1. loads the app, 2. continues as guest (geolocation granted),
//   3. searches a new location, 4. presses Surprise Me,
//   5. relaunches (reload, warm caches) and repeats boot -> markers.
// The last run also executes the rest of the functional flow (drawer, sign
// up, log a visit) and takes screenshots when --shots is given.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DEFAULT = path.resolve(HERE, '..', '..', '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const LABEL = args.label || 'run';
// --root <dir>: run the app from another checkout (e.g. a worktree of the
// baseline commit) with this harness, for like-for-like before/after numbers.
const ROOT = args.root ? path.resolve(args.root) : ROOT_DEFAULT;
const RUNS = Number(args.runs || 5);
const MODE = args.mode || 'replay';
const SHOTS = args.shots || null;
const FAKE_NATIVE = Boolean(args['fake-native']);
const NO_SW = Boolean(args['no-sw']);
const REDUCED_MOTION = Boolean(args['reduced-motion']);
// --boot-only: stop each run once the first markers are up (for sampling
// the cold-launch metrics many more times than the full flow allows).
const BOOT_ONLY = Boolean(args['boot-only']);

// Stand-in for the Capacitor bridge (--fake-native): every
// Plugins.<Name>.<method>(arg) resolves and is recorded, so the flow can
// assert the web side calls native APIs at the right moments.
const FAKE_CAPACITOR = () => {
  window.__nativeCalls = [];
  const plugin = (name) => new Proxy({}, { get: (_, method) => (arg) => {
    window.__nativeCalls.push({ plugin: name, method: String(method), arg, t: performance.now() });
    return Promise.resolve({});
  } });
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
    Plugins: new Proxy({}, { get: (_, name) => plugin(String(name)) })
  };
};
const PORT = 3000;
const BASE = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SEARCH_QUERY = 'Austin, TX';
const HOME = { latitude: 40.7300, longitude: -73.9950 };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function startServer() {
  const proc = spawn(process.execPath, ['-r', path.join(HERE, 'fixture-fetch.cjs'), path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), FF_FIXTURES: MODE, PERF_LOG: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 100; i++) {
    if (log.includes('running at')) return { proc, getLog: () => log };
    await sleep(100);
  }
  proc.kill();
  throw new Error('server did not start:\n' + log);
}

// Runs in the page before any app script. Records paint-level timestamps
// (first rAF frame where a condition holds) so numbers reflect what the user
// sees, not when a fetch resolved.
const INSTRUMENT = () => {
  const M = (window.__ff = { marks: {}, longTasks: [] });
  const mark = (k) => { if (M.marks[k] == null) M.marks[k] = performance.now(); };
  new PerformanceObserver(l => l.getEntries().forEach(e => M.longTasks.push({ start: e.startTime, dur: e.duration })))
    .observe({ type: 'longtask', buffered: true });
  new PerformanceObserver(l => l.getEntries().forEach(e => { if (e.name === 'first-contentful-paint') M.marks.fcp = e.startTime; }))
    .observe({ type: 'paint', buffered: true });
  window.addEventListener('maps-loaded', () => mark('mapsLoaded'));
  const markerTitles = () => [...document.querySelectorAll('gmp-advanced-marker')]
    .filter(el => el.querySelector('.marker') && !el.querySelector('.marker--origin'))
    .map(el => el.getAttribute('title') || el.title || el.getAttribute('aria-label') || '');
  M.snapshot = null;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target && e.target.id === 'location-search-input') {
      M.snapshot = new Set(markerTitles());
      M.marks.searchSubmit = performance.now();
    }
  }, true);
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('#recommend-btn')) M.marks.surpriseClick = performance.now();
    if (e.target.closest && e.target.closest('#continue-as-guest-btn')) M.marks.guestClick = performance.now();
  }, true);
  const visible = (el) => el && !el.closest('[hidden]') && el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== 'hidden' && Number(getComputedStyle(el).opacity) > 0;
  const tick = () => {
    const gate = document.getElementById('auth-gate');
    if (gate && !gate.hidden) mark('gateVisible');
    const titles = markerTitles();
    if (titles.length > 0 && M.marks.guestClick != null) mark('bootMarkers');
    if (M.marks.searchSubmit != null && M.snapshot && titles.some(t => !M.snapshot.has(t))) mark('searchMarkers');
    if (M.marks.surpriseClick != null) {
      const ticket = document.getElementById('ticket');
      const overlay = document.getElementById('loading-overlay');
      const overlayUp = overlay && !overlay.hidden;
      if (overlayUp || (ticket && ticket.classList.contains('visible'))) mark('recoFeedback');
      const now = performance.now();
      if (overlayUp && M.marks.recoFull == null) M.overlayMs = (M.overlayMs || 0) + (now - (M.lastFrame || now));
      const name = document.getElementById('ticket-name');
      const reason = document.getElementById('ticket-reason');
      if (ticket && ticket.classList.contains('visible') && !ticket.classList.contains('ticket--error') &&
          name.textContent.trim() && visible(name)) mark('recoName');
      if (ticket && ticket.classList.contains('visible') && reason.textContent.trim().length > 20 &&
          !ticket.classList.contains('is-streaming') && visible(reason)) mark('recoFull');
    }
    M.lastFrame = performance.now();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

async function newContext(browser) {
  const context = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    geolocation: HOME,
    permissions: ['geolocation'],
    serviceWorkers: NO_SW ? 'block' : 'allow',
    reducedMotion: REDUCED_MOTION ? 'reduce' : 'no-preference'
  });
  await context.addInitScript(INSTRUMENT);
  if (FAKE_NATIVE) await context.addInitScript(FAKE_CAPACITOR);
  return context;
}

async function throttle(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('Network.enable');
  // LTE-ish: 100ms RTT, ~20 Mbps down, ~5 Mbps up. Same for every run.
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 100, downloadThroughput: 2.5e6, uploadThroughput: 625e3
  });
  const bytes = { firstPartyJs: 0, firstPartyCss: 0, thirdPartyJs: 0, thirdPartyCss: 0 };
  const types = new Map();
  cdp.on('Network.responseReceived', e => types.set(e.requestId, { type: e.type, url: e.response.url, fromSW: e.response.fromServiceWorker }));
  cdp.on('Network.loadingFinished', e => {
    const t = types.get(e.requestId);
    if (!t) return;
    const first = t.url.startsWith(BASE);
    const kind = t.type === 'Script' ? 'Js' : t.type === 'Stylesheet' ? 'Css' : null;
    if (!kind) return;
    bytes[(first ? 'firstParty' : 'thirdParty') + kind] += e.encodedDataLength;
  });
  return { cdp, bytes };
}

async function marks(page) { return page.evaluate(() => ({ ...window.__ff.marks })); }

async function waitMark(page, name, timeout = 30000) {
  await page.waitForFunction((n) => window.__ff && window.__ff.marks[n] != null, name, { timeout, polling: 50 });
}

async function longTasksBetween(page, from, to) {
  return page.evaluate(([a, b]) => window.__ff.longTasks.filter(t => t.start >= a && t.start <= b), [from, to]);
}

async function searchLocation(page, query) {
  await page.click('#pick-location-btn');
  await page.fill('#location-search-input', query);
  await page.press('#location-search-input', 'Enter');
}

async function waitSearchSettled(page) {
  // phase-2 (pages 2-3) finishes ~2-4s after phase 1; wait for it so Surprise
  // Me measures the recommend path, not the phase-2 wait.
  await page.waitForFunction(() => typeof pendingRestPromise !== 'undefined' && pendingRestPromise === null &&
    typeof restaurantsLoading !== 'undefined' && !restaurantsLoading, null, { timeout: 20000, polling: 100 });
  await sleep(300);
}

async function oneRun(browser, i, { full }) {
  const server = await startServer();
  const context = await newContext(browser);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const { bytes } = await throttle(page);
  const r = { run: i };
  try {
    await page.goto(BASE + '/?perf=1', { waitUntil: 'load' });
    await waitMark(page, 'gateVisible');
    await page.waitForSelector('#continue-as-guest-btn', { state: 'visible' });
    await page.click('#continue-as-guest-btn');
    await waitMark(page, 'bootMarkers', 30000);
    if (BOOT_ONLY) {
      const mb = await marks(page);
      Object.assign(r, { fcp: mb.fcp, gateVisible: mb.gateVisible, mapsLoaded: mb.mapsLoaded,
        guestToMarkers: mb.bootMarkers - mb.guestClick, navToMarkers: mb.bootMarkers, flow: [['boot only', 'ok']] });
      return r;
    }
    await waitSearchSettled(page);
    let m = await marks(page);
    r.fcp = m.fcp; r.gateVisible = m.gateVisible; r.mapsLoaded = m.mapsLoaded;
    r.guestToMarkers = m.bootMarkers - m.guestClick;
    if (FAKE_NATIVE) {
      // When the native splash would lift on a cold first launch.
      r.splashHideAt = await page.evaluate(() => {
        const c = window.__nativeCalls.find(x => x.plugin === 'SplashScreen' && x.method === 'hide');
        return c ? c.t : null;
      });
    }
    if (SHOTS && full) await page.screenshot({ path: path.join(HERE, '..', SHOTS, '1-map.png') });

    await searchLocation(page, SEARCH_QUERY);
    await waitMark(page, 'searchMarkers', 30000);
    m = await marks(page);
    r.searchToMarkers = m.searchMarkers - m.searchSubmit;
    await waitSearchSettled(page);
    const lt = await longTasksBetween(page, m.searchSubmit, performance.now() + 1e9);
    r.searchLongTasks = lt.length;
    r.searchLongTaskMs = Math.round(lt.reduce((s, t) => s + t.dur, 0));
    r.searchMaxLongTaskMs = Math.round(lt.reduce((s, t) => Math.max(s, t.dur), 0));
    if (SHOTS && full) {
      await page.evaluate(() => { const b = document.getElementById('location-banner'); if (b) b.hidden = true; });
      await page.screenshot({ path: path.join(HERE, '..', SHOTS, '2-search-results.png') });
    }

    await page.click('#recommend-btn');
    if (SHOTS && full) {
      await sleep(250); // skeleton card, before the server has picked
      await page.screenshot({ path: path.join(HERE, '..', SHOTS, '3a-surprise-tapped.png') });
    }
    await waitMark(page, 'recoName', 30000);
    if (SHOTS && full) {
      await sleep(150); // restaurant known, dish/reason still streaming
      await page.screenshot({ path: path.join(HERE, '..', SHOTS, '3b-streaming.png') });
    }
    await waitMark(page, 'recoFull', 30000);
    m = await marks(page);
    r.surpriseToName = m.recoName - m.surpriseClick;
    r.surpriseToFull = m.recoFull - m.surpriseClick;
    r.surpriseToFeedback = m.recoFeedback - m.surpriseClick;
    r.surpriseOverlayMs = Math.round(await page.evaluate(() => window.__ff.overlayMs || 0));
    await sleep(400);
    if (SHOTS && full) await page.screenshot({ path: path.join(HERE, '..', SHOTS, '3-recommendation.png') });
    Object.assign(r, bytes);

    // Relaunch: same browser profile + warm server, like reopening the app.
    await page.evaluate(() => { try { localStorage.removeItem('ff_glowup_dummy'); } catch {} });
    await page.reload({ waitUntil: 'load' });
    await waitMark(page, 'gateVisible').catch(() => {});
    m = await marks(page);
    r.relaunchFcp = m.fcp;
    r.relaunchGateVisible = m.gateVisible ?? null;
    if (await page.isVisible('#continue-as-guest-btn')) {
      await page.click('#continue-as-guest-btn');
      await waitMark(page, 'bootMarkers', 30000);
      m = await marks(page);
      r.relaunchGuestToMarkers = m.bootMarkers - m.guestClick;
      // Navigation -> markers on screen. Guest -> markers alone can go UP when
      // the sign-in screen gets faster, because an earlier tap then waits on
      // the Maps download; this is the number a user actually feels.
      r.relaunchNavToMarkers = m.bootMarkers;
    }
    if (full) await functionalFlow(page, r);

  } catch (err) {
    r.error = String(err).split('\n')[0];
    await page.screenshot({ path: path.join(HERE, `fail-${LABEL}-${i}.png`) }).catch(() => {});
    console.error(server.getLog().slice(-2000));
  } finally {
    r.pageErrors = errors;
    await context.close();
    server.proc.kill();
    await sleep(300);
  }
  return r;
}

// The rest of the product flow, run once per label as a regression check:
// drawer -> sign up -> log a visit.
let nativeCallsBeforeLogout = [];
async function functionalFlow(page, r) {
  const steps = [];
  const step = async (name, fn) => {
    try { await fn(); steps.push([name, 'ok']); }
    catch (e) {
      steps.push([name, 'FAIL: ' + String(e).split('\n')[0]]);
      await page.screenshot({ path: path.join(HERE, `fail-${LABEL}-step.png`) }).catch(() => {});
      throw e;
    }
  };
  try {
    await step('Surprise Me (after relaunch)', async () => {
      await waitSearchSettled(page);
      await page.click('#recommend-btn');
      await page.waitForFunction(() => {
        const t = document.getElementById('ticket');
        return t.classList.contains('visible') && !t.classList.contains('ticket--error') &&
          document.getElementById('ticket-reason').textContent.length > 20 && !t.classList.contains('is-streaming');
      }, null, { timeout: 20000 });
    });
    await step('exactly one highlighted pick marker, matching the card', async () => {
      const res = await page.evaluate(() => {
        const picks = [...document.querySelectorAll('.marker--pick')];
        const host = picks[0] && picks[0].closest('gmp-advanced-marker');
        return { n: picks.length, title: host ? (host.getAttribute('title') || '') : '', name: document.getElementById('ticket-name').textContent };
      });
      if (res.n !== 1 || !res.title.startsWith(res.name)) throw new Error(JSON.stringify(res));
    });
    await step('open drawer (Filters)', async () => {
      await page.click('#filters-toggle');
      await page.waitForSelector('#tab-drawer.open', { timeout: 5000 });
      await sleep(500);
      if (SHOTS) await page.screenshot({ path: path.join(HERE, '..', SHOTS, '4-drawer.png') });
    });
    await step('close drawer', async () => {
      await page.click('#drawer-close-btn');
      await page.waitForSelector('#tab-drawer', { state: 'hidden', timeout: 5000 });
    });
    const dragDrawer = async (fraction) => {
      const box = await page.locator('#drawer-title').boundingBox();
      const width = (await page.locator('#tab-drawer').boundingBox()).width;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      // ~16ms per step, i.e. a deliberate (not flicked) drag.
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(x - (width * fraction * i) / steps, y);
        await sleep(16);
      }
      await sleep(120); // come to rest before letting go, so velocity ~0
      await page.mouse.up();
    };
    await step('short drawer drag springs back open', async () => {
      await page.click('#filters-toggle');
      await page.waitForSelector('#tab-drawer.open', { timeout: 5000 });
      await sleep(400);
      await dragDrawer(0.15);
      await sleep(500);
      const state = await page.evaluate(() => {
        const d = document.getElementById('tab-drawer');
        return { open: d.classList.contains('open'), hidden: d.hidden, x: new DOMMatrix(getComputedStyle(d).transform).m41 };
      });
      if (!state.open || state.hidden || Math.abs(state.x) > 1) throw new Error(JSON.stringify(state));
    });
    await step('long drawer drag dismisses it', async () => {
      await dragDrawer(0.6);
      await page.waitForSelector('#tab-drawer', { state: 'hidden', timeout: 3000 });
    });
    await step('guest tab bounces to sign-up gate', async () => {
      await page.click('#tabs-toggle');
      await page.click('.rail-btn[data-tab="log-review"]');
      await page.waitForSelector('#auth-gate:not([hidden])', { timeout: 5000 });
    });
    const email = `glowup+${Date.now()}@example.com`;
    await step('sign up test account', async () => {
      await page.click('#auth-toggle-mode');
      await page.fill('#auth-email', email);
      await page.fill('#auth-password', 'glowup-test-pass');
      await page.click('#auth-submit-btn');
      await page.waitForSelector('#auth-gate', { state: 'hidden', timeout: 10000 });
      await page.waitForSelector('#rail-account:not([hidden])', { timeout: 5000 });
    });
    await step('skip taste-profile prompt', async () => {
      await page.waitForSelector('#prefs-dialog[open]', { state: 'attached', timeout: 15000 });
      await page.click('#prefs-skip-btn');
      await page.waitForSelector('#prefs-dialog:not([open])', { state: 'attached', timeout: 5000 });
    });
    await step('log a visit from the recommendation', async () => {
      await page.click('#ticket-log-btn');
      await page.waitForSelector('#tab-panel-log-review:not([hidden])', { timeout: 5000 });
      const prefilled = await page.inputValue('#visit-restaurant');
      if (!prefilled) throw new Error('visit form not prefilled');
      await page.click('#visit-rating button[data-star="5"]');
      await page.click('#visit-form button[type="submit"]');
      await page.waitForFunction(() => document.getElementById('visit-status').textContent.includes('Visit logged'), null, { timeout: 8000 });
    });
    await step('visit shows in Past Reviews', async () => {
      await page.click('#drawer-close-btn');
      await page.waitForSelector('#tab-drawer', { state: 'hidden', timeout: 5000 });
      await page.click('#tabs-toggle');
      await page.click('.rail-btn[data-tab="past-reviews"]');
      await page.waitForSelector('#visit-list .visit-item', { timeout: 5000 });
    });
    await step('badges + leaderboard render', async () => {
      await page.click('#drawer-close-btn');
      await page.waitForSelector('#tab-drawer', { state: 'hidden', timeout: 5000 });
      await page.click('#tabs-toggle');
      await page.click('.rail-btn[data-tab="progress"]');
      await page.waitForSelector('#badge-grid .badge-card', { timeout: 5000 });
      await page.waitForSelector('#leaderboard-list .leaderboard-row', { timeout: 5000 });
      await page.click('#drawer-close-btn');
    });
    await step('groups: create one', async () => {
      await page.click('#tabs-toggle');
      await page.click('.rail-btn[data-tab="group"]');
      await page.fill('#create-group-name', 'Glowup');
      await page.click('#create-group-form button[type="submit"]');
      await page.waitForSelector('#group-list .group-item', { timeout: 5000 });
      await page.click('#drawer-close-btn');
      await page.waitForSelector('#tab-drawer', { state: 'hidden', timeout: 5000 });
    });
    if (FAKE_NATIVE) nativeCallsBeforeLogout = await page.evaluate(() => window.__nativeCalls);
    await step('log out', async () => {
      await page.click('#tabs-toggle');
      await Promise.all([page.waitForNavigation({ timeout: 10000 }), page.click('#logout-btn')]);
      await page.waitForSelector('#auth-gate:not([hidden])', { timeout: 10000 });
    });
  } catch { /* recorded in steps */ }
  if (FAKE_NATIVE) {
    // Collected before logout reloads the page (the log survives within the page only).
    r.nativeCalls = nativeCallsBeforeLogout;
  }
  r.flow = steps;
}

function median(xs) {
  const v = xs.filter(x => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
if (SHOTS) fs.mkdirSync(path.join(HERE, '..', SHOTS), { recursive: true });
const results = [];
for (let i = 1; i <= RUNS; i++) {
  const r = await oneRun(browser, i, { full: i === RUNS });
  results.push(r);
  console.log(JSON.stringify(r));
}
await browser.close();

const keys = ['navToMarkers', 'fcp', 'gateVisible', 'mapsLoaded', 'guestToMarkers', 'searchToMarkers', 'searchLongTasks', 'searchLongTaskMs',
  'searchMaxLongTaskMs', 'surpriseToFeedback', 'surpriseOverlayMs', 'surpriseToName', 'surpriseToFull', 'firstPartyJs', 'firstPartyCss', 'thirdPartyJs', 'thirdPartyCss',
  'relaunchFcp', 'relaunchGateVisible', 'relaunchGuestToMarkers', 'relaunchNavToMarkers', 'splashHideAt'];
const summary = Object.fromEntries(keys.map(k => [k, median(results.map(r => r[k]))]));
const out = { label: LABEL, date: new Date().toISOString(), runs: RUNS, mode: MODE, summary, results };
fs.writeFileSync(path.join(HERE, `results-${LABEL}.json`), JSON.stringify(out, null, 2));
console.log('\nMEDIANS', LABEL);
for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(24)} ${v == null ? '-' : Math.round(v)}`);
const flow = results[results.length - 1].flow || [];
if (FAKE_NATIVE) {
  const calls = results[results.length - 1].nativeCalls || [];
  const tally = {};
  calls.forEach(c => { const k = `${c.plugin}.${c.method}(${JSON.stringify(c.arg)})`; tally[k] = (tally[k] || 0) + 1; });
  console.log('\nNATIVE CALLS (functional flow page)');
  Object.entries(tally).forEach(([k, n]) => console.log(`  ${n}x ${k}`));
}
console.log('\nFLOW');
flow.forEach(([n, s]) => console.log(`  ${s === 'ok' ? 'PASS' : 'FAIL'} ${n}${s === 'ok' ? '' : ' ' + s}`));
const failed = results.some(r => r.error) || flow.some(([, s]) => s !== 'ok') || flow.length === 0;
process.exitCode = failed ? 1 : 0;
