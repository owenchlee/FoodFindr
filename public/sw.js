// App-shell service worker. Makes a relaunch paint from local cache instead
// of waiting on the network for HTML/CSS/JS, which matters most inside the
// iOS shell because it loads https://foodfindr.tech remotely on every launch.
//
// iOS: WKWebView only runs service workers for App-Bound Domains
// (WKAppBoundDomains in Info.plist + limitsNavigationsToAppBoundDomains).
// Without that, navigator.serviceWorker is undefined there and app.js skips
// registration, so this file is simply never used. See docs/glowup/REPORT.md.
//
// Strategy: stale-while-revalidate for the HTML. The cached copy answers
// immediately and a fresh copy is fetched in the background for next time,
// so a deploy reaches a user on their second launch after it. The HTML links
// its CSS/JS by content hash (?v=, added by the server), so whichever HTML
// is served always gets the exact CSS/JS it was built with: those versioned
// URLs are cache-first and never revalidated. Bump SHELL_VERSION to drop
// every cached copy at once.
//
// Never touched: /api/* (live data, auth), non-GET requests, and anything
// cross-origin (Google Maps/Fonts manage their own caching and terms).
const SHELL_VERSION = 'v3';
const CACHE = `ff-shell-${SHELL_VERSION}`;
const SHELL = ['/', '/images/logo.png', '/images/favicon.png'];
const ASSET_REF = /"(\/(?:css|js)\/[^"?]+\?v=[^"]+)"/g;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // cache: 'reload' skips the HTTP cache, which may still hold old copies.
      .then(cache => cache.addAll(SHELL.map(url => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('ff-shell-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js' || url.pathname === '/js/config.js') return;

  // All navigations share one cache entry: this is a single-page app, and
  // query strings (?perf=1) don't change the document.
  if (request.mode === 'navigate') {
    event.respondWith(staleWhileRevalidate(event, '/', request, precacheAssetsOf));
  } else if (url.searchParams.has('v')) {
    event.respondWith(cacheFirst(request));
  } else {
    event.respondWith(staleWhileRevalidate(event, request, request));
  }
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') cache.put(request, response.clone());
  return response;
}

// After a fresh HTML copy is stored: fetch the CSS/JS it links, so the next
// launch (which serves this HTML from cache) has them offline too, and drop
// versioned files no longer referenced so the cache doesn't grow per deploy.
async function precacheAssetsOf(cache, response) {
  const html = await response.text();
  const wanted = new Set([...html.matchAll(ASSET_REF)].map(m => new URL(m[1], self.location.origin).href));
  await Promise.all([...wanted].map(async href => {
    if (!(await cache.match(href))) {
      const r = await fetch(href);
      if (r.ok) await cache.put(href, r);
    }
  }));
  const keys = await cache.keys();
  await Promise.all(keys
    .filter(req => new URL(req.url).searchParams.has('v') && !wanted.has(req.url))
    .map(req => cache.delete(req)));
}

async function staleWhileRevalidate(event, cacheKey, request, afterStore) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(cacheKey, { ignoreSearch: request.mode === 'navigate' });
  const network = fetch(request)
    .then(async response => {
      if (response.ok && response.type === 'basic') {
        await cache.put(cacheKey, response.clone());
        if (afterStore) await afterStore(cache, response.clone()).catch(() => {});
      }
      return response;
    });
  if (cached) {
    // Keep the worker alive until the background refresh has been stored.
    event.waitUntil(network.catch(() => {}));
    return cached;
  }
  return network;
}
