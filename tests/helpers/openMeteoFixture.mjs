// Builds a synthetic Open-Meteo response from a single source of truth.
//
// The cloud value at every hour is set to that hour's *local hour-of-day at the
// site*, so any timezone error shows up directly: read the hour whose absolute
// instant is 22:00 local and you must get cloud === 22. Off-by-N in the indexing
// produces cloud === 22 - N.

import { zonedParts, zonedToUtc } from '../../src/timezone.js'

export function buildFixture({ timeZone, startYmd, days = 8, format = 'unixtime' }) {
  const start = zonedToUtc(startYmd.year, startYmd.month, startYmd.day, 0, 0, timeZone)
  const time = []
  const cloudcover_low = []
  const zeros = []

  for (let i = 0; i < days * 24; i++) {
    const instant = new Date(start.getTime() + i * 3600 * 1000)
    const localHour = zonedParts(instant, timeZone).hour
    time.push(format === 'unixtime' ? Math.floor(instant.getTime() / 1000) : localNaive(instant, timeZone))
    cloudcover_low.push(localHour)
    zeros.push(0)
  }

  return {
    hourly: {
      time,
      cloudcover_low,
      cloudcover_mid: [...zeros],
      cloudcover_high: [...zeros],
      temperature_2m: zeros.map(() => 15),
      relativehumidity_2m: zeros.map(() => 40),
      dewpoint_2m: zeros.map(() => 2),
      windspeed_10m: zeros.map(() => 5),
      windspeed_250hPa: zeros.map(() => 60),
    },
  }
}

// The local-naive 'YYYY-MM-DDTHH:00' strings Open-Meteo returns without timeformat=unixtime.
function localNaive(instant, timeZone) {
  const p = zonedParts(instant, timeZone)
  const pad = (n) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:00`
}

export function okResponse(body) {
  return { ok: true, status: 200, json: async () => body }
}

export function errorPayloadResponse(reason) {
  // Open-Meteo answers bad parameters with a JSON body, not a transport error.
  return { ok: false, status: 400, json: async () => ({ error: true, reason }) }
}
