const SUBSCRIBE_WORKER_URL = import.meta.env.VITE_SUBSCRIBE_WORKER_URL
const NOTIFICATION_REQUEST_TIMEOUT_MS = 10_000

async function fetchWithTimeout(url, options = {}, timeoutMs = NOTIFICATION_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)))
}

function currentLocation(location) {
  if (location) return location
  try {
    return JSON.parse(localStorage.getItem('astro-location') ?? '{}')
  } catch {
    return {}
  }
}

function locationPayload(location) {
  const value = currentLocation(location)
  if (!Number.isFinite(value.lat) || !Number.isFinite(value.lng)) return null

  return {
    lat: value.lat,
    lng: value.lng,
    locationName: value.name,
    timezone: value.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  }
}

async function registerSubscription(subscription, location) {
  const forecastLocation = locationPayload(location)
  if (!forecastLocation) return { ok: false, reason: 'location-missing' }

  try {
    const res = await fetchWithTimeout(`${SUBSCRIBE_WORKER_URL}/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription, ...forecastLocation }),
    })

    return res.ok ? { ok: true } : { ok: false, reason: 'server-error' }
  } catch {
    return { ok: false, reason: 'server-error' }
  }
}

export async function requestAndSubscribe(location) {
  if (!('Notification' in window) || !('PushManager' in window)) {
    return { ok: false, reason: 'unsupported' }
  }

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
  const isStandalone = window.navigator.standalone === true
  if (isIOS && !isStandalone) {
    return { ok: false, reason: 'ios-not-installed' }
  }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    return { ok: false, reason: 'denied' }
  }

  const reg = await navigator.serviceWorker.ready
  const existing = await reg.pushManager.getSubscription()
  if (existing) {
    const result = await registerSubscription(existing, location)
    return result.ok ? { ok: true, reason: 'already-subscribed' } : result
  }

  const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY
  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidKey)
  })

  return registerSubscription(subscription, location)
}

export async function syncSubscriptionLocation(location) {
  if (!('PushManager' in window)) return { ok: false, reason: 'unsupported' }

  try {
    const reg = await navigator.serviceWorker.ready
    const existing = await reg.pushManager.getSubscription()
    if (!existing) return { ok: false, reason: 'unsubscribed' }
    return registerSubscription(existing, location)
  } catch {
    return { ok: false, reason: 'server-error' }
  }
}

export async function unsubscribe() {
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (!sub) return

  await fetchWithTimeout(`${SUBSCRIBE_WORKER_URL}/unsubscribe`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint })
  })

  await sub.unsubscribe()
}

export async function getSubscriptionStatus() {
  if (!('PushManager' in window)) return 'unsupported'
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  return sub ? 'subscribed' : 'unsubscribed'
}
