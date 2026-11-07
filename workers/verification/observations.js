import { BOM_OBSERVATION_PROVIDER, BOM_STATION_FEED_BASE } from './config.js'
import { REFERENCE_SITES } from './sites.js'

function numberOrNull(value) {
  if (value === null || value === undefined || value === '' || value === '-') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function firstValue(row, names) {
  for (const name of names) {
    const value = numberOrNull(row?.[name])
    if (value !== null) return value
  }
  return null
}

function parseTimestamp(row) {
  const candidate = row?.aifstime_utc ?? row?.observation_time_utc ?? row?.observation_time
  if (!candidate) return null
  if (/^\d{14}$/.test(String(candidate))) {
    const text = String(candidate)
    const date = new Date(Date.UTC(
      Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8)),
      Number(text.slice(8, 10)), Number(text.slice(10, 12)), Number(text.slice(12, 14)),
    ))
    return Number.isFinite(date.getTime()) ? date.toISOString() : null
  }
  const date = new Date(candidate)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

export function stationFeedUrl(feedId, baseUrl = BOM_STATION_FEED_BASE) {
  return `${baseUrl}/IDQ60901.${feedId}.json`.replace(/\/$/, '')
}

export function parseBomStationPayload(payload, { siteId, stationId, stationName } = {}) {
  const rows = payload?.observations?.data ?? payload?.data ?? []
  if (!Array.isArray(rows)) throw new Error('BOM observation response did not contain an observations.data array')

  return rows
    .map((row, index) => {
      const observedAt = parseTimestamp(row)
      if (!observedAt) return null
      const windKmh = firstValue(row, ['wind_spd_kmh'])
      const windKnots = firstValue(row, ['wind_spd_kt'])
      return {
        observationId: `${BOM_OBSERVATION_PROVIDER}:${stationId}:${row.aifstime_utc ?? row.observation_time_utc ?? index}`,
        source: BOM_OBSERVATION_PROVIDER,
        siteId,
        stationId: String(stationId ?? row.wmo ?? row.station_id),
        stationName: row.name ?? stationName ?? null,
        observedAt,
        retrievedAt: new Date().toISOString(),
        temperature_c: firstValue(row, ['air_temp', 'temperature_c']),
        relative_humidity_pct: firstValue(row, ['rel_hum', 'relative_humidity_pct']),
        dew_point_c: firstValue(row, ['dewpt', 'dew_point_c']),
        wind_speed_kmh: windKmh ?? (windKnots === null ? null : windKnots * 1.852),
        rainfall_since_9am_mm: firstValue(row, ['rain_trace', 'rainfall_since_9am_mm']),
        quality: {
          sourceQuality: 'real-time, not fully quality controlled',
          missingFields: ['temperature_c', 'relative_humidity_pct', 'dew_point_c', 'wind_speed_kmh', 'rainfall_since_9am_mm']
            .filter((field) => ({
              temperature_c: firstValue(row, ['air_temp', 'temperature_c']),
              relative_humidity_pct: firstValue(row, ['rel_hum', 'relative_humidity_pct']),
              dew_point_c: firstValue(row, ['dewpt', 'dew_point_c']),
              wind_speed_kmh: windKmh ?? windKnots,
              rainfall_since_9am_mm: firstValue(row, ['rain_trace', 'rainfall_since_9am_mm']),
            })[field] === null),
        },
        raw: row,
      }
    })
    .filter(Boolean)
}

export async function collectBomObservations({
  sites = REFERENCE_SITES,
  fetchImpl = fetch,
  now = new Date(),
  baseUrl = BOM_STATION_FEED_BASE,
} = {}) {
  const observations = []
  const failures = []
  const feedIds = [...new Set(sites.map((site) => site.observationFeedId))]
  const sitesByFeed = new Map()
  for (const site of sites) {
    const list = sitesByFeed.get(site.observationFeedId) ?? []
    list.push(site)
    sitesByFeed.set(site.observationFeedId, list)
  }

  for (const feedId of feedIds) {
    const stationSites = sitesByFeed.get(feedId) ?? []
    const representative = stationSites[0]
    const stationId = representative.observationStationId
    try {
      const response = await fetchImpl(stationFeedUrl(feedId, baseUrl))
      const payload = await response.json()
      if (response.ok === false || payload?.error) throw new Error(String(payload?.reason ?? `BOM HTTP ${response.status}`))
      for (const site of stationSites) {
        observations.push(...parseBomStationPayload(payload, {
          siteId: site.id,
          stationId,
          stationName: representative.observationStationName,
        }).map((observation) => ({ ...observation, retrievedAt: new Date(now).toISOString() })))
      }
    } catch (error) {
      failures.push({ feedId, stationId, reason: error.message })
    }
  }

  return { observations, failures }
}
