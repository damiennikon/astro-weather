import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'
import { StaleWhileRevalidate } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'

precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

registerRoute(
  ({ url }) => url.origin === 'https://api.open-meteo.com',
  new StaleWhileRevalidate({
    cacheName: 'open-meteo-cache',
    plugins: [new ExpirationPlugin({ maxAgeSeconds: 3600 })],
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
