const CACHE_NAME = 'astro-weather-shell-v43';
const API_CACHE_NAME = 'astro-weather-api-v1';

const SHELL_ASSETS = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './manifest.json',
    './weatherWorker.js',
    './astronomy.browser.min.js'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('[Service Worker] Caching app shell');
                return cache.addAll(SHELL_ASSETS);
            })
    );
});

self.addEventListener('message', event => {
    if (event.data && event.data.action === 'skipWaiting') {
        self.skipWaiting();
    }
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME && cacheName !== API_CACHE_NAME) {
                        console.log('[Service Worker] Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    // Never intercept external API calls
    if (new URL(event.request.url).origin !== self.location.origin) {
        return; // Let the browser handle it normally
    }

    // Cache-first for local app files
    event.respondWith(
        caches.match(event.request).then(cached => {
            return cached || fetch(event.request);
        })
    );
});
