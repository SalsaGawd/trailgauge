/* TrailGauge service worker
 * ─────────────────────────────────────────────────────────
 * Goals:
 * - Fix the "stuck offline" bug iOS PWAs hit when Safari's HTTP cache
 *   serves a broken/error page from a flaky first-load. The service
 *   worker takes over the fetch layer entirely, so Safari's cache is
 *   bypassed for our origin.
 * - Real offline support: app shell, last-fetched weather, map tiles,
 *   Leaflet CDN assets all cached for offline trail use.
 * - Reliable updates: bumping CACHE_VERSION invalidates old caches and
 *   forces fresh app shell on next launch.
 *
 * Cache strategies by request type:
 * - App shell (HTML, our own assets): network-first, cache fallback.
 *   We want updates to land for online users; offline users get the
 *   last-known-good version.
 * - Leaflet CDN (unpkg.com/leaflet): cache-first.
 *   Version-pinned URL, immutable artifact, never need to re-fetch.
 * - Map tiles (tile.openstreetmap.org, tile.opentopomap.org): cache-first
 *   with a size cap. Lets users review pins/trips offline near places
 *   they've already viewed.
 * - Weather API (api.open-meteo.com forecast): network-first, short cache
 *   fallback. Need fresh data when online; show stale data when offline
 *   beats showing nothing.
 * - Geocoding API: pass-through, don't cache. Each query is unique.
 * - Everything else: pass-through to network.
 */

// ↑ BUMP THIS when shipping a new version of the app. Clears old caches
//   and forces clients to fetch fresh shell on next launch.
const CACHE_VERSION = 'tg-v20-44';

const CACHE_SHELL  = `${CACHE_VERSION}-shell`;
const CACHE_VENDOR = `${CACHE_VERSION}-vendor`;
const CACHE_TILES  = `${CACHE_VERSION}-tiles`;
const CACHE_WX     = `${CACHE_VERSION}-wx`;

// Maximum number of entries to keep in caches that grow unbounded.
const TILES_MAX = 200;     // map tiles — generous since they're small
const WX_MAX    = 20;      // weather API responses

// Files that make up the app shell. Pre-cached on install so the app
// boots offline even on first launch after install.
// NOTE: paths are relative to the SW's location (/trailgauge/sw.js on
// GitHub Pages). './' resolves to /trailgauge/.
const APP_SHELL = [
  './',
  './index.html'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_SHELL);
    // Use { cache: 'reload' } to bypass any stale HTTP cache during install.
    // If we don't, an iOS browser holding a broken cached index.html would
    // bake that brokenness into the SW cache and we'd never recover.
    await cache.addAll(APP_SHELL.map(url => new Request(url, { cache: 'reload' })));
    // NOTE: We deliberately do NOT call skipWaiting() here. Doing so would
    // cause every update to activate immediately, potentially reloading the
    // page mid-use while the user is recording a trip or interacting with
    // the gauge. Instead, the app shows a "New version ready — Reload?"
    // notice, and only triggers skipWaiting via postMessage when the user
    // clicks Reload. See the message handler below.
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Delete any caches that don't match the current version. This is how
    // we guarantee a deploy actually replaces stale assets.
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => !k.startsWith(CACHE_VERSION))
          .map(k => caches.delete(k))
    );
    // Take control of all open clients (PWA windows) immediately rather
    // than waiting for them to be reloaded.
    await self.clients.claim();
  })());
});

// Trim a cache to a maximum number of entries (oldest-first eviction).
async function trimCache(cacheName, maxEntries){
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if(keys.length <= maxEntries) return;
  // Cache.keys() returns in insertion order, so keys[0] is the oldest.
  const toDelete = keys.slice(0, keys.length - maxEntries);
  await Promise.all(toDelete.map(req => cache.delete(req)));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only handle GET. POST/PUT/DELETE go straight to network.
  if(req.method !== 'GET') return;

  const url = new URL(req.url);

  // ─── Vendor: Leaflet CDN ─────────────────────────────────
  // Cache-first since the URL is version-pinned (leaflet@1.9.4).
  if(url.hostname === 'unpkg.com' && url.pathname.includes('/leaflet@')){
    event.respondWith(cacheFirst(req, CACHE_VENDOR));
    return;
  }

  // ─── Map tiles ────────────────────────────────────────────
  // Cache-first, size-capped. After the user has viewed a region,
  // those tiles work offline.
  if(url.hostname.endsWith('tile.openstreetmap.org') ||
     url.hostname.endsWith('tile.opentopomap.org')){
    event.respondWith(cacheFirstWithLimit(req, CACHE_TILES, TILES_MAX));
    return;
  }

  // ─── Weather API ──────────────────────────────────────────
  // Network-first so online users see fresh data. Falls back to last-known
  // cached response when offline. Same URL params = same cache key, which
  // means rapid repeat fetches for the same lat/lon also get cached.
  if(url.hostname === 'api.open-meteo.com'){
    event.respondWith(networkFirstWithLimit(req, CACHE_WX, WX_MAX));
    return;
  }

  // ─── Geocoding ────────────────────────────────────────────
  // Don't cache — each query is unique to a moment. Pass through.
  if(url.hostname === 'geocoding-api.open-meteo.com'){
    return;   // default browser behavior
  }

  // ─── App shell (our own origin) ───────────────────────────
  // Network-first so deploys land for online users; cache fallback for
  // offline. This is the critical fix for the "stuck offline" bug —
  // the SW always tries the network first, and only serves from cache
  // when network actually fails.
  if(url.origin === self.location.origin){
    event.respondWith(networkFirstAppShell(req));
    return;
  }

  // ─── Everything else ──────────────────────────────────────
  // Default browser behavior. Don't intercept third-party requests we
  // don't have a strategy for.
});

async function cacheFirst(request, cacheName){
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if(cached) return cached;
  try {
    const response = await fetch(request);
    if(response.ok) cache.put(request, response.clone());
    return response;
  } catch(err){
    // No network and no cache — return a synthesized error response so
    // the page can handle it gracefully.
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function cacheFirstWithLimit(request, cacheName, maxEntries){
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if(cached){
    // Re-insert this entry so LRU-ish eviction keeps recently-used tiles
    // (delete + put moves it to end of cache key list).
    cache.delete(request).then(() => cache.put(request, cached.clone()));
    return cached;
  }
  try {
    const response = await fetch(request);
    if(response.ok){
      cache.put(request, response.clone()).then(() => trimCache(cacheName, maxEntries));
    }
    return response;
  } catch(err){
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function networkFirstWithLimit(request, cacheName, maxEntries){
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if(response.ok){
      cache.put(request, response.clone()).then(() => trimCache(cacheName, maxEntries));
    }
    return response;
  } catch(err){
    // Offline or network failure — fall back to cached response if available.
    const cached = await cache.match(request);
    if(cached) return cached;
    throw err;   // let the calling code see the network failure
  }
}

async function networkFirstAppShell(request){
  const cache = await caches.open(CACHE_SHELL);
  try {
    const response = await fetch(request);
    // Only cache successful responses. A 404 or 500 from GitHub Pages
    // shouldn't replace a known-good cached shell.
    if(response.ok) cache.put(request, response.clone());
    return response;
  } catch(err){
    // Network failed. Try the cache.
    const cached = await cache.match(request);
    if(cached) return cached;
    // No cache either — try the root shell URL as last-ditch fallback.
    // This handles the case where the user navigated to a deep URL that
    // was never cached, but the app itself is single-page.
    const shellRoot = await cache.match('./');
    if(shellRoot) return shellRoot;
    // Truly nothing. Return a minimal offline page so the user sees
    // something useful instead of Safari's generic "no internet" screen.
    return new Response(
      '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">'+
      '<title>TrailGauge — Offline</title>'+
      '<style>body{background:#0a0c0f;color:#3ddc97;font-family:system-ui,sans-serif;'+
      'display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:20px}'+
      'h1{font-weight:700;letter-spacing:2px;margin-bottom:8px}p{color:#8899aa;font-size:14px;line-height:1.6}'+
      'button{background:#3ddc97;color:#000;border:none;padding:10px 24px;border-radius:24px;font-weight:700;'+
      'letter-spacing:1px;text-transform:uppercase;cursor:pointer;margin-top:16px;font-family:inherit}</style></head><body>'+
      '<div><h1>⬡ TRAILGAUGE</h1><p>You\'re offline.<br>Reconnect to load the app for the first time.</p>'+
      '<button onclick="location.reload()">Retry</button></div></body></html>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 200 }
    );
  }
}

// Allow the page to send a SKIP_WAITING message — used by the "new version
// available" notice to apply updates immediately on user click.
self.addEventListener('message', (event) => {
  if(event.data && event.data.type === 'SKIP_WAITING'){
    self.skipWaiting();
  }
});
