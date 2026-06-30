const SUBSCRIBE_WORKER_URL = import.meta.env.VITE_SUBSCRIBE_WORKER_URL

export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)))
}

export async function requestAndSubscribe() {
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
  if (existing) return { ok: true, reason: 'already-subscribed' }

  const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY
  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidKey)
  })

  const location = JSON.parse(localStorage.getItem('astro-location') ?? '{}')

  const res = await fetch(`${SUBSCRIBE_WORKER_URL}/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscription,
      lat:          location.lat,
      lng:          location.lng,
      locationName: location.name
    })
  })

  return res.ok ? { ok: true } : { ok: false, reason: 'server-error' }
}

export async function unsubscribe() {
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (!sub) return

  await fetch(`${SUBSCRIBE_WORKER_URL}/unsubscribe`, {
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
