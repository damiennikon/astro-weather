import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'
import { NetworkFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import { markCachedForecast } from './forecastCache.js'

precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// Without claiming open clients, a skipWaiting()'d SW activates but never takes
// control of the already-open tab — 'controllerchange' never fires, so the
// update-banner reload flow in main.js waits forever and appears to do nothing.
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

registerRoute(
  ({ url }) => url.origin === 'https://api.open-meteo.com' && url.pathname === '/v1/forecast',
  new NetworkFirst({
    cacheName: 'open-meteo-cache',
    fetchOptions: { cache: 'no-store' },
    plugins: [
      new ExpirationPlugin({ maxAgeSeconds: 3600 }),
      { cachedResponseWillBeUsed: markCachedForecast },
    ],
  })
)

self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? {}
  event.waitUntil(
    self.registration.showNotification(data.title ?? 'Astro Weather', {
      body: data.body ?? "Check tonight's forecast",
      icon: '/astro-weather/icons/icon-192.png',
      badge: '/astro-weather/icons/icon-96.png',
      tag: 'astro-weather-forecast',
      renotify: true,
      data: { url: data.url ?? '/astro-weather/' },
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(clients.openWindow(event.notification.data.url))
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})
