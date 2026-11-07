const VARIABLES = Object.freeze([
  ['temperature_2m', 'temperature_c'],
  ['relative_humidity_2m', 'relative_humidity_pct'],
  ['dew_point_2m', 'dew_point_c'],
  ['wind_speed_10m', 'wind_speed_kmh'],
])

export const LEAD_BANDS = Object.freeze([
  { id: '0-12h', minMinutes: 0, maxMinutes: 12 * 60 },
  { id: '12-24h', minMinutes: 12 * 60, maxMinutes: 24 * 60 },
  { id: '24-48h', minMinutes: 24 * 60, maxMinutes: 48 * 60 },
  { id: '48-96h', minMinutes: 48 * 60, maxMinutes: 96 * 60 },
])

function finite(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function leadBand(leadMinutes) {
  const lead = finite(leadMinutes)
  if (lead === null || lead < 0) return null
  return LEAD_BANDS.find((band) => lead >= band.minMinutes && lead < band.maxMinutes)?.id ?? null
}

export function seasonForUtc(value) {
  const month = new Date(value).getUTCMonth() + 1
  if (month === 12 || month <= 2) return 'summer'
  if (month <= 5) return 'autumn'
  if (month <= 8) return 'winter'
  return 'spring'
}

export function summarizeErrors(errors) {
  const clean = errors.map(finite).filter((value) => value !== null)
  if (clean.length === 0) {
    return { sampleCount: 0, mae: null, rmse: null, meanBias: null, medianAbsoluteError: null }
  }
  const absolute = clean.map((value) => Math.abs(value))
  return {
    sampleCount: clean.length,
    mae: absolute.reduce((sum, value) => sum + value, 0) / clean.length,
    rmse: Math.sqrt(clean.reduce((sum, value) => sum + value ** 2, 0) / clean.length),
    meanBias: clean.reduce((sum, value) => sum + value, 0) / clean.length,
    medianAbsoluteError: median(absolute),
  }
}

export function findObservationMatch(forecast, observations, toleranceMinutes = 45) {
  const forecastTime = new Date(forecast.validAt).getTime()
  if (!Number.isFinite(forecastTime)) return null
  let best = null
  let bestDistance = Infinity
  for (const observation of observations) {
    const observationTime = new Date(observation.observedAt).getTime()
    const distance = Math.abs(observationTime - forecastTime)
    if (distance <= toleranceMinutes * 60_000 && distance < bestDistance) {
      best = observation
      bestDistance = distance
    }
  }
  return best
}

export function buildVerificationRows({ forecasts, observations, toleranceMinutes = 45 }) {
  const rows = []
  for (const forecast of forecasts) {
    const candidates = observations.filter((observation) => observation.siteId === forecast.siteId)
    const observation = findObservationMatch(forecast, candidates, toleranceMinutes)
    if (!observation) continue

    for (const [forecastField, observationField] of VARIABLES) {
      const predicted = finite(forecast[forecastField])
      const actual = finite(observation[observationField])
      if (predicted === null || actual === null) continue
      const validAt = new Date(forecast.validAt).toISOString()
      rows.push({
        snapshotId: forecast.snapshotId,
        model: forecast.model,
        siteId: forecast.siteId,
        classification: forecast.classification,
        validAt,
        leadMinutes: forecast.leadMinutes ?? forecast.retrievalLeadMinutes,
        leadBasis: forecast.leadBasis ?? (forecast.leadMinutes == null ? 'retrieval' : 'model-run'),
        hourOfDay: new Date(validAt).getUTCHours(),
        season: seasonForUtc(validAt),
        variable: forecastField,
        predicted,
        actual,
        error: predicted - actual,
        observationId: observation.observationId,
      })
    }
  }
  return rows
}

function groupKey(row) {
  return [
    row.model,
    row.siteId,
    row.classification,
    row.variable,
    row.leadBasis,
    leadBand(row.leadMinutes) ?? 'unknown-lead',
    row.hourOfDay,
    row.season,
  ].join('|')
}

export function summarizeVerification(rows) {
  const groups = new Map()
  for (const row of rows) {
    const key = groupKey(row)
    const group = groups.get(key) ?? {
      model: row.model,
      siteId: row.siteId,
      classification: row.classification,
      variable: row.variable,
      leadBasis: row.leadBasis,
      leadBand: leadBand(row.leadMinutes),
      hourOfDay: row.hourOfDay,
      season: row.season,
      errors: [],
      observationIds: new Set(),
    }
    group.errors.push(row.error)
    group.observationIds.add(row.observationId)
    groups.set(key, group)
  }

  return [...groups.values()].map((group) => ({
    model: group.model,
    siteId: group.siteId,
    classification: group.classification,
    variable: group.variable,
    leadBasis: group.leadBasis,
    leadBand: group.leadBand,
    hourOfDay: group.hourOfDay,
    season: group.season,
    observationCount: group.observationIds.size,
    ...summarizeErrors(group.errors),
  }))
}

export function resourceUsageSummary({ collectionRuns, modelRequests, observationRequests, forecastHours, rawBytes }) {
  const days = Math.max(1, collectionRuns / 4)
  return {
    collectionRuns,
    modelRequests,
    observationRequests,
    forecastHours,
    rawBytes,
    estimatedDailyModelRequests: modelRequests / days,
    estimatedDailyForecastHours: forecastHours / days,
  }
}
