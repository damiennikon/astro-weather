// Thin worker shell. All pipeline logic lives in forecast.js so the scheduled push
// worker and the tests build nights through exactly the same code path.
import { buildForecast } from './forecast.js'

self.onmessage = async (event) => {
  const { type, lat, lng, timezone } = event.data
  if (type !== 'FETCH_FORECAST') return

  try {
    const { nights, meta } = await buildForecast(lat, lng, timezone, {
      onProgress: (step) => self.postMessage({ type: 'PROGRESS', step }),
    })
    self.postMessage({ type: 'FORECAST_READY', nights, meta })
  } catch (err) {
    self.postMessage({
      type: 'FORECAST_ERROR',
      message: err.message,
      code: err.code ?? 'UNKNOWN',
      failures: err.failures ?? null,
    })
  }
}
