// Thin worker shell. All pipeline logic lives in forecast.js so the scheduled push
// worker and the tests build nights through exactly the same code path.
import { buildForecast, MODELS } from './forecast.js'
import { CACHED_FORECAST_HEADER } from './forecastCache.js'

self.onmessage = async (event) => {
  const { type, lat, lng, timezone } = event.data
  if (type !== 'FETCH_FORECAST') return

  try {
    const cachedModelIds = new Set()
    const { nights, meta } = await buildForecast(lat, lng, timezone, {
      fetchImpl: async (url, options) => {
        const response = await fetch(url, { ...options, cache: 'no-store' })
        if (response.headers.has(CACHED_FORECAST_HEADER)) {
          cachedModelIds.add(new URL(url).searchParams.get('models'))
        }
        return response
      },
      onProgress: (step) => self.postMessage({ type: 'PROGRESS', step }),
    })
    const cached = meta.available.filter((model) => cachedModelIds.has(MODELS[model]))
    self.postMessage({ type: 'FORECAST_READY', nights, meta: { ...meta, cached } })
  } catch (err) {
    self.postMessage({
      type: 'FORECAST_ERROR',
      message: err.message,
      code: err.code ?? 'UNKNOWN',
      failures: err.failures ?? null,
    })
  }
}
