export const CACHED_FORECAST_HEADER = 'x-astro-weather-cached'

// Mark only the response returned to the app. Keep the stored copy unmodified
// so Workbox can still apply its normal expiry rules.
export function markCachedForecast({ cachedResponse }) {
  if (!cachedResponse?.ok) return null
  const headers = new Headers(cachedResponse.headers)
  headers.set(CACHED_FORECAST_HEADER, '1')
  return new Response(cachedResponse.body, {
    status: cachedResponse.status,
    statusText: cachedResponse.statusText,
    headers,
  })
}
