import {
  validateForecastPayload, nightDisplayWindow, coversForecastHours,
} from './forecast.js'
import { addDays, safeTimeZone, zonedParts } from './timezone.js'
import {
  forecastFetchedAt, withForecastHeaders, FORECAST_CACHE_MAX_AGE_SECONDS,
} from './forecastCache.js'

function requestedFields(url) {
  return new URL(url).searchParams.get('hourly')?.split(',') ?? []
}

function coversCurrentForecast(payload, url, now) {
  const timeZone = safeTimeZone(new URL(url).searchParams.get('timezone'))
  const today = zonedParts(now, timeZone)
  const tonight = nightDisplayWindow(today, timeZone)
  if (!coversForecastHours(payload, tonight.displayStart, tonight.displayEnd)) return false

  // After midnight the dashboard also shows the previous night until 07:00.
  // Earlier hours may be absent from an Open-Meteo response fetched today.
  const active = nightDisplayWindow(addDays(today, -1), timeZone)
  return now >= active.displayEnd || coversForecastHours(payload, active.displayStart, active.displayEnd, now)
}

export const forecastCachePlugin = {
  async fetchDidSucceed({ request, response, state }) {
    // Workbox falls back on rejected fetches, not on HTTP error responses.
    if (response.status >= 500 && response.status <= 599) {
      state.failedResponse = response
      throw new Error(`HTTP ${response.status}`)
    }
    if (response.status !== 200) return response

    // Race the complete response, not just its headers. A stalled body must
    // still give the cache a chance and a malformed payload must not replace it.
    let payload
    try {
      payload = validateForecastPayload(await response.clone().json(), requestedFields(request.url))
    } catch (error) {
      state.failedResponse = response
      throw error
    }
    const now = new Date()
    state.cacheable = coversCurrentForecast(payload, request.url, now)
    return withForecastHeaders(response, +now)
  },

  cacheWillUpdate({ response, state }) {
    return response.status === 200 && state.cacheable ? response : null
  },

  handlerDidError({ state }) {
    // If both network and cache failed, preserve the upstream diagnosis.
    return state.failedResponse
  },

  async cachedResponseWillBeUsed({ request, cachedResponse }) {
    if (cachedResponse?.status !== 200) return null
    const now = new Date()
    const fetchedAt = forecastFetchedAt(cachedResponse)
    if (fetchedAt === null || fetchedAt > +now || +now - fetchedAt > FORECAST_CACHE_MAX_AGE_SECONDS * 1000) {
      return null
    }
    try {
      const payload = validateForecastPayload(await cachedResponse.clone().json(), requestedFields(request.url))
      if (!coversCurrentForecast(payload, request.url, now)) return null
      return withForecastHeaders(cachedResponse, fetchedAt, true)
    } catch {
      // Invalid cache contents count as a miss so the live request can continue.
      return null
    }
  },
}
