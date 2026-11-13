import { lookupLightning } from './lightning.js'

const SUBSCRIPTION_TTL = 60 * 60 * 24 * 365
const MAX_LOCATION_NAME_LENGTH = 120
const MAX_TIMEZONE_LENGTH = 100

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  }
}

function jsonResponse(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  })
}

function isAllowedOrigin(request, env) {
  return Boolean(env.ALLOWED_ORIGIN) && request.headers.get('Origin') === env.ALLOWED_ORIGIN
}

async function readJson(request) {
  try {
    return { ok: true, body: await request.json() }
  } catch {
    return { ok: false, error: 'Request body must be valid JSON' }
  }
}

function validEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 2048) return false
  try {
    return new URL(endpoint).protocol === 'https:'
  } catch {
    return false
  }
}

function validTimezone(timezone) {
  if (timezone == null) return true
  if (typeof timezone !== 'string' || timezone.length === 0 || timezone.length > MAX_TIMEZONE_LENGTH) return false

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
    return true
  } catch {
    return false
  }
}

export function validateSubscribePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be an object' }
  }

  const { subscription, lat, lng, locationName, timezone } = body
  if (!subscription || typeof subscription !== 'object' || !validEndpoint(subscription.endpoint)) {
    return { ok: false, error: 'A valid HTTPS subscription endpoint is required' }
  }
  if (!subscription.keys || typeof subscription.keys !== 'object' ||
      typeof subscription.keys.p256dh !== 'string' || subscription.keys.p256dh.length === 0 ||
      typeof subscription.keys.auth !== 'string' || subscription.keys.auth.length === 0) {
    return { ok: false, error: 'Subscription keys are required' }
  }
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
      typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return { ok: false, error: 'Latitude and longitude must be valid coordinates' }
  }
  if (locationName != null &&
      (typeof locationName !== 'string' || locationName.trim().length === 0 ||
       locationName.length > MAX_LOCATION_NAME_LENGTH)) {
    return { ok: false, error: 'Location name is invalid' }
  }
  if (!validTimezone(timezone)) {
    return { ok: false, error: 'Timezone is invalid' }
  }

  return {
    ok: true,
    value: {
      subscription,
      lat,
      lng,
      locationName: locationName?.trim() || 'Unknown',
      timezone: timezone ?? null,
    },
  }
}

export function validateUnsubscribePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !validEndpoint(body.endpoint)) {
    return { ok: false, error: 'A valid HTTPS endpoint is required' }
  }
  return { ok: true, endpoint: body.endpoint }
}

export async function subscriptionKey(endpoint) {
  const keyBuffer = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(endpoint)
  )
  const keyHex = Array.from(new Uint8Array(keyBuffer))
    .map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 16)
  return `sub:${keyHex}`
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(env)
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return isAllowedOrigin(request, env)
        ? new Response(null, { headers })
        : new Response('Forbidden', { status: 403 })
    }

    if ((request.method === 'POST' && url.pathname === '/subscribe') ||
        (request.method === 'DELETE' && url.pathname === '/unsubscribe')) {
      if (!isAllowedOrigin(request, env)) return new Response('Forbidden', { status: 403 })
    }

    if (request.method === 'GET' && url.pathname === '/lightning') {
      if (!isAllowedOrigin(request, env)) return new Response('Forbidden', { status: 403 })
      const { body, status } = await lookupLightning(request, url, env)
      return jsonResponse(body, status, { ...headers, 'Cache-Control': 'no-store' })
    }

    try {
      if (request.method === 'POST' && url.pathname === '/subscribe') {
        const parsed = await readJson(request)
        if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400, headers)

        const validated = validateSubscribePayload(parsed.body)
        if (!validated.ok) return jsonResponse({ error: validated.error }, 400, headers)

        const kvKey = await subscriptionKey(validated.value.subscription.endpoint)
        const previousRaw = await env.ASTRO_SUBSCRIPTIONS.get(kvKey)
        let previous = null
        if (previousRaw) {
          try { previous = JSON.parse(previousRaw) } catch { /* replace malformed records */ }
        }

        const now = new Date().toISOString()
        const value = {
          ...validated.value,
          lastNotified: typeof previous?.lastNotified === 'string' ? previous.lastNotified : null,
          subscribedAt: previous?.subscribedAt ?? now,
          updatedAt: now,
        }

        await env.ASTRO_SUBSCRIPTIONS.put(kvKey, JSON.stringify(value), {
          expirationTtl: SUBSCRIPTION_TTL,
        })

        return jsonResponse({ ok: true, key: kvKey, updated: Boolean(previous) }, 200, headers)
      }

      if (request.method === 'DELETE' && url.pathname === '/unsubscribe') {
        const parsed = await readJson(request)
        if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400, headers)

        const validated = validateUnsubscribePayload(parsed.body)
        if (!validated.ok) return jsonResponse({ error: validated.error }, 400, headers)

        await env.ASTRO_SUBSCRIPTIONS.delete(await subscriptionKey(validated.endpoint))
        return jsonResponse({ ok: true }, 200, headers)
      }

      return new Response('Not Found', { status: 404 })
    } catch (err) {
      console.error('[subscribe] request failed', err)
      return jsonResponse({ error: 'Notification service unavailable' }, 500, headers)
    }
  },
}
