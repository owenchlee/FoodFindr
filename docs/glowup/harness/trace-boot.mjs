// One-off diagnostic: where does guest -> markers time go on a cold launch?
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
const ROOT = path.resolve('../../..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
for (let i = 0; i < 6; i++) {
  const srv = spawn(process.execPath, ['-r', './docs/glowup/harness/fixture-fetch.cjs', 'server/server.js'], { cwd: ROOT, env: { ...process.env, PORT: '3000', PERF_LOG: '0' }, stdio: 'ignore' });
  await sleep(1500);
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, geolocation: { latitude: 40.73, longitude: -73.995 }, permissions: ['geolocation'] });
  await ctx.addInitScript(() => {
    window.__t = {};
    const orig = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
    navigator.geolocation.getCurrentPosition = (ok, err, opts) => { window.__t.geoAsk = performance.now(); orig((p) => { window.__t.geoOk = performance.now(); ok(p); }, err, opts); };
    window.addEventListener('maps-loaded', () => { window.__t.maps = performance.now(); });
    document.addEventListener('click', e => { if (e.target.closest('#continue-as-guest-btn')) window.__t.guest = performance.now(); }, true);
    const tick = () => { if (!window.__t.markers && document.querySelector('gmp-advanced-marker .marker:not(.marker--origin)')) window.__t.markers = performance.now(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 100, downloadThroughput: 2.5e6, uploadThroughput: 625e3 });
  await page.goto('http://localhost:3000/');
  await page.click('#continue-as-guest-btn');
  await page.waitForFunction(() => window.__t.markers, null, { timeout: 20000 });
  const t = await page.evaluate(() => {
    const r = performance.getEntriesByType('resource').find(e => e.name.includes('/api/restaurants?'));
    return { ...window.__t, reqStart: r && r.startTime, reqEnd: r && r.responseEnd };
  });
  const f = (k) => Math.round(t[k]);
  console.log(`guest ${f('guest')} maps ${f('maps')} geoAsk ${f('geoAsk')} geoOk ${f('geoOk')} req ${f('reqStart')}->${f('reqEnd')} markers ${f('markers')}  => guest->markers ${f('markers') - f('guest')}`);
  await ctx.close(); srv.kill(); await sleep(300);
}
await browser.close();
