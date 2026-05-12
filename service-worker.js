const CACHE_NAME = "astro-weather-v1";
const CACHE_PREFIX = "/astro-weather/";

const CORE_ASSETS = [
  `${CACHE_PREFIX}`,
  `${CACHE_PREFIX}index.html`,
  `${CACHE_PREFIX}style.css`,
  `${CACHE_PREFIX}app.js`,
  `${CACHE_PREFIX}manifest.json`,
  `${CACHE_PREFIX}engine/forecast.js`,
  `${CACHE_PREFIX}ingestion/satellite.js`,
  `${CACHE_PREFIX}ingestion/gfs.js`,
  `${CACHE_PREFIX}ingestion/icon.js`,
  `${CACHE_PREFIX}ingestion/astronomy.js`,
  `${CACHE_PREFIX}preprocessing/preprocess.js`,
  `${CACHE_PREFIX}fusion/fuse.js`,
  `${CACHE_PREFIX}override/override.js`,
  `${CACHE_PREFIX}metrics/metrics.js`
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).catch(() => cached);
    })
  );
});