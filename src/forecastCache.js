export const CACHED_FORECAST_HEADER = 'x-astro-weather-cached'
export const FORECAST_FETCHED_AT_HEADER = 'x-astro-weather-fetched-at'
export const FORECAST_CACHE_MAX_AGE_SECONDS = 3600

export function forecastFetchedAt(response) {
  const timestamp = response.headers.get(FORECAST_FETCHED_AT_HEADER)
  // Older entries can only be used if their original Date header was visible
  // to the service worker. A cache read must never reset the age.
  const fetchedAt = timestamp === null ? Date.parse(response.headers.get('date')) : Number(timestamp)
  return Number.isFinite(fetchedAt) && fetchedAt > 0 ? fetchedAt : null
}

export function withForecastHeaders(response, fetchedAt, cached = false) {
  const headers = new Headers(response.headers)
  headers.set(FORECAST_FETCHED_AT_HEADER, String(fetchedAt))
  if (cached) headers.set(CACHED_FORECAST_HEADER, '1')
  else headers.delete(CACHED_FORECAST_HEADER)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
