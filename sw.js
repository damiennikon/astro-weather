const CACHE_NAME = 'astro-weather-shell-v12';
const API_CACHE_NAME = 'astro-weather-api-v1';

const SHELL_ASSETS = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './manifest.json',
    './weatherWorker.js'
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

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // Completely bypass Service Worker for satellite and proxy requests
    if (event.request.url.includes('corsproxy') || event.request.url.includes('himawari')) {
        return;
    }

    // Network-first strategy for API calls (e.g., Open-Meteo or other external APIs)
    if (url.origin !== location.origin || url.hostname.includes('open-meteo.com')) {
        event.respondWith(
            fetch(event.request)
                .then(networkResponse => {
                    // Only cache successful API responses (and strictly exclude opaque responses)
                    if (networkResponse && networkResponse.status === 200 && networkResponse.type !== 'opaque') {
                        const clonedResponse = networkResponse.clone();
                        caches.open(API_CACHE_NAME).then(cache => {
                            cache.put(event.request, clonedResponse);
                        });
                    }
                    return networkResponse;
                })
                .catch(() => {
                    // Fallback to cache if network fails (offline)
                    console.log('[Service Worker] Network failed, falling back to cache for API:', event.request.url);
                    return caches.match(event.request);
                })
        );
    }
    // Cache-first strategy for app shell assets
    else {
        event.respondWith(
            caches.match(event.request)
                .then(cachedResponse => {
                    if (cachedResponse) {
                        return cachedResponse;
                    }

                    // If not in cache, fetch from network and add to cache
                    return fetch(event.request).then(networkResponse => {
                        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
                            const clonedResponse = networkResponse.clone();
                            caches.open(CACHE_NAME).then(cache => {
                                cache.put(event.request, clonedResponse);
                            });
                        }
                        return networkResponse;
                    });
                })
        );
    }
});
