/*
 * Service worker — offline support for use at sea, where there's often no
 * signal. Strategy per resource type:
 *
 *   - App shell (/, manifest, icons): network-first, cache fallback, so a
 *     deploy is picked up on the next online load but the app still opens
 *     offline.
 *   - Pinned CDN deps (unpkg React/Babel/Leaflet/d3, Google Fonts):
 *     cache-first — the URLs carry exact versions, so a cached copy can
 *     never be stale.
 *   - Data (Open-Meteo weather/marine/geocoding, our own /api/* GETs):
 *     network-first, falling back to the last good response, keyed by full
 *     URL — so each saved location keeps its own last-known forecast.
 *   - NEVER cached: /api/tide-events — the Admiralty Discovery tier's
 *     terms prohibit caching the tidal predictions themselves. Offline,
 *     the tide card falls back to the (cacheable) modeled Open-Meteo
 *     curve, clearly labeled as such.
 *   - Map tiles (OSM/OpenSeaMap): not intercepted. Caching enough tiles to
 *     be useful offline would balloon storage; the maps are online-only.
 *
 * Bump VERSION to invalidate the shell/CDN caches wholesale.
 */
const VERSION = 'v1';
const SHELL_CACHE = `barometer-shell-${VERSION}`;
const CDN_CACHE = `barometer-cdn-${VERSION}`;
const DATA_CACHE = `barometer-data-${VERSION}`;

const SHELL_URLS = ['/', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

const CDN_HOSTS = ['unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const DATA_HOSTS = ['api.open-meteo.com', 'marine-api.open-meteo.com', 'geocoding-api.open-meteo.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  const keep = [SHELL_CACHE, CDN_CACHE, DATA_CACHE];
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Opaque (no-cors) responses report status 0 / ok:false but are still
// perfectly cacheable — the unpkg <script> tags without crossorigin
// produce these.
function cacheable(res) {
  return res && (res.ok || res.type === 'opaque');
}

function networkFirst(request, cacheName) {
  return caches.open(cacheName).then((cache) =>
    fetch(request)
      .then((res) => {
        if (cacheable(res)) cache.put(request, res.clone());
        return res;
      })
      .catch(() =>
        cache.match(request, { ignoreVary: true }).then((hit) => {
          if (hit) return hit;
          throw new Error('offline and not cached');
        })
      )
  );
}

function cacheFirst(request, cacheName) {
  return caches.open(cacheName).then((cache) =>
    cache.match(request, { ignoreVary: true }).then(
      (hit) =>
        hit ||
        fetch(request).then((res) => {
          if (cacheable(res)) cache.put(request, res.clone());
          return res;
        })
    )
  );
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return; // POST/PUT/DELETE pass straight through

  const url = new URL(request.url);

  // Admiralty tidal predictions: never cached (Discovery tier terms).
  if (url.pathname.startsWith('/api/tide-events/')) return;

  // App navigations and same-origin static files → shell cache.
  if (url.origin === self.location.origin) {
    if (request.mode === 'navigate') {
      event.respondWith(networkFirst(new Request('/'), SHELL_CACHE));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      event.respondWith(networkFirst(request, DATA_CACHE));
      return;
    }
    event.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }

  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(request, CDN_CACHE));
    return;
  }

  if (DATA_HOSTS.includes(url.hostname)) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  // Everything else (map tiles etc.): default browser behaviour.
});
