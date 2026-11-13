const RADIUS_KM = 20
const RECENT_MS = 5 * 60 * 1000
const UNAVAILABLE = { body: { status: 'unavailable' }, status: 503 }
const NO_DETECTION = { body: { status: 'none' }, status: 200 }

function coordinate(value, maximum) {
  if (value == null || value.trim() === '') return null
  const number = Number(value)
  return Number.isFinite(number) && Math.abs(number) <= maximum ? number : null
}

function distanceBetween(lat, lng, flashLat, flashLng) {
  const toRadians = Math.PI / 180
  const halfLat = (flashLat - lat) * toRadians / 2
  const halfLng = (flashLng - lng) * toRadians / 2
  const haversine = Math.sin(halfLat) ** 2 +
    Math.cos(lat * toRadians) * Math.cos(flashLat * toRadians) * Math.sin(halfLng) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(Math.min(1, haversine)))
}

export async function lookupLightning(request, url, env) {
  const lat = coordinate(url.searchParams.get('lat'), 90)
  const lng = coordinate(url.searchParams.get('lng'), 180)
  if (lat === null || lng === null) return { body: { status: 'invalid-location' }, status: 400 }
  if (!env.XWEATHER_CLIENT_ID || !env.XWEATHER_CLIENT_SECRET || !env.LIGHTNING_RATE_LIMITER) {
    console.warn('[lightning] Required Worker binding missing')
    return UNAVAILABLE
  }

  let stage = 'rate limit'
  try {
    const { success } = await env.LIGHTNING_RATE_LIMITER.limit({
      key: request.headers.get('CF-Connecting-IP') ?? 'unknown',
    })
    if (!success) return { body: { status: 'unavailable' }, status: 429 }

    stage = 'provider request'
    const upstream = new URL('https://data.api.xweather.com/lightning/flash/closest')
    upstream.search = new URLSearchParams({
      p: `${lat},${lng}`,
      radius: `${RADIUS_KM}km`,
      limit: '10',
      client_id: env.XWEATHER_CLIENT_ID,
      client_secret: env.XWEATHER_CLIENT_SECRET,
    })
    const response = await fetch(upstream, {
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
      cache: 'no-store',
    })
    stage = 'provider response'
    const data = await response.json().catch(() => null)
    const code = data?.error?.code
    if (response.ok && code === 'warn_no_data') return NO_DETECTION
    if (!response.ok || data?.success !== true || data.error || !Array.isArray(data.response)) {
      const knownCodes = ['invalid_client', 'unauthorized', 'insufficient_scope', 'invalid_endpoint',
        'invalid_location', 'invalid_query', 'invalid_params', 'warn_no_data', 'no_data', 'rate_limit_exceeded']
      console.warn('[lightning] Xweather response unavailable', response.status,
        knownCodes.includes(code) ? code : 'unrecognized response')
      return UNAVAILABLE
    }

    const now = Date.now()
    let nearest = null
    for (const strike of data.response) {
      const flashLat = strike?.loc?.lat
      const flashLng = strike?.loc?.long
      const timestamp = strike?.ob?.timestamp
      if (!Number.isFinite(flashLat) || Math.abs(flashLat) > 90 ||
          !Number.isFinite(flashLng) || Math.abs(flashLng) > 180 || !Number.isFinite(timestamp)) {
        return UNAVAILABLE
      }
      const distanceKm = distanceBetween(lat, lng, flashLat, flashLng)
      const detectedAt = timestamp * 1000
      const expiresAt = detectedAt + RECENT_MS
      if (distanceKm > RADIUS_KM || detectedAt > now || expiresAt <= now) continue
      if (!nearest || distanceKm < nearest.distanceKm ||
          (distanceKm === nearest.distanceKm && detectedAt > nearest.detectedAt)) {
        nearest = { status: 'detected', distanceKm, detectedAt, expiresAt }
      }
    }
    return nearest ? { body: nearest, status: 200 } : NO_DETECTION
  } catch (error) {
    console.warn('[lightning] Lookup failed', stage, error instanceof TypeError ? 'TypeError' : 'runtime error')
    return UNAVAILABLE
  }
}
