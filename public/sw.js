// App-shell service worker. Makes a relaunch paint from local cache instead
// of waiting on the network for HTML/CSS/JS, which matters most inside the
// iOS shell because it loads https://foodfindr.tech remotely on every launch.
//
// iOS: WKWebView only runs service workers for App-Bound Domains
// (WKAppBoundDomains in Info.plist + limitsNavigationsToAppBoundDomains).
// Without that, navigator.serviceWorker is undefined there and app.js skips
// registration, so this file is simply never used. See docs/glowup/REPORT.md.
//
// Strategy: stale-while-revalidate for the shell. The cached copy answers
// immediately and a fresh copy is fetched in the background for next time,
// so a deploy reaches a user on their second launch after it. Bump
// SHELL_VERSION to drop every cached copy at once (e.g. a breaking change
// that can't tolerate one launch of old HTML with old JS).
//
// Never touched: /api/* (live data, auth), non-GET requests, and anything
// cross-origin (Google Maps/Fonts manage their own caching and terms).
const SHELL_VERSION = 'v2';
const CACHE = `ff-shell-${SHELL_VERSION}`;
const SHELL = ['/', '/css/style.css', '/js/app.js', '/js/map.js', '/images/logo.png', '/images/favicon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
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
  const cacheKey = request.mode === 'navigate' ? '/' : request;
  event.respondWith(staleWhileRevalidate(event, cacheKey, request));
});

async function staleWhileRevalidate(event, cacheKey, request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(cacheKey, { ignoreSearch: request.mode === 'navigate' });
  const network = fetch(request)
    .then(response => {
      if (response.ok && response.type === 'basic') cache.put(cacheKey, response.clone());
      return response;
    });
  if (cached) {
    // Keep the worker alive until the background refresh has been stored.
    event.waitUntil(network.catch(() => {}));
    return cached;
  }
  return network;
}
