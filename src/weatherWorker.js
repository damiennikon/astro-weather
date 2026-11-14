// Thin worker shell. All pipeline logic lives in forecast.js so the scheduled push
// worker and the tests build nights through exactly the same code path.
import { buildForecast, MODELS, coversForecastHours } from './forecast.js'
import { hasUpcomingCloudData } from './dashboardForecast.js'
import { CACHED_FORECAST_HEADER, forecastFetchedAt } from './forecastCache.js'

self.onmessage = async (event) => {
  const { type, lat, lng, timezone } = event.data
  if (type !== 'FETCH_FORECAST') return

  try {
    const cachedResponses = new Map()
    const modelForId = Object.fromEntries(Object.entries(MODELS).map(([model, id]) => [id, model]))
    const { nights, meta, inProgressNight } = await buildForecast(lat, lng, timezone, {
      includeInProgressNight: true,
      fetchImpl: async (url, options) => {
        const response = await fetch(url, { ...options, cache: 'no-store' })
        if (response.headers.has(CACHED_FORECAST_HEADER)) {
          const model = modelForId[new URL(url).searchParams.get('models')]
          cachedResponses.set(model, forecastFetchedAt(response))
        }
        return response
      },
      hasDisplayCoverage: (model, response, start, end) =>
        !cachedResponses.has(model) || coversForecastHours(response, start, end),
      onProgress: (step) => self.postMessage({ type: 'PROGRESS', step }),
    })
    if (!hasUpcomingCloudData([inProgressNight?.night, ...nights], new Date())) {
      self.postMessage({ type: 'FORECAST_ERROR', message: 'No model data covers the upcoming forecast hours.' })
      return
    }

    const cached = meta.available.filter((model) => cachedResponses.has(model))
    const cachedFetchedAt = Object.fromEntries(cached.map((model) => [model, cachedResponses.get(model)]))
    self.postMessage({ type: 'FORECAST_READY', nights, inProgressNight, meta: { ...meta, cached, cachedFetchedAt } })
  } catch (err) {
    self.postMessage({
      type: 'FORECAST_ERROR',
      message: err.message,
      code: err.code ?? 'UNKNOWN',
      failures: err.failures ?? null,
    })
  }
}
