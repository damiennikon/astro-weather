import * as Astronomy from 'astronomy-engine'
import {
  addDays,
  safeTimeZone,
  zonedParts,
} from '../../src/timezone.js'
import {
  buildNight,
  combineCloudLayers,
  hourKey,
  indexHourly,
  blendCloud,
  MODEL_WEIGHTS,
} from '../../src/forecast.js'
import { FORECAST_API_BASE, FORECAST_PROVIDER, MODEL_FIELDS, MODEL_IDS, VERIFICATION_CALCULATION_VERSION, VERIFICATION_SCHEMA_VERSION } from './config.js'
import { PILOT_HORIZON_DAYS, REFERENCE_SITES, SITE_TIMEZONE } from './sites.js'

const MODEL_KEYS = Object.freeze(Object.keys(MODEL_IDS))

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function iso(value) {
  return new Date(value).toISOString()
}

function modelRunTime(payload) {
  const candidate = payload?.model_run ?? payload?.model_run_time ?? payload?.run
  if (candidate === undefined || candidate === null || candidate === '') return null
  const date = new Date(typeof candidate === 'number' ? candidate * 1000 : candidate)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function readField(payload, field, index) {
  const value = payload?.hourly?.[field]?.[index]
  return finite(value)
}

function validationError(message) {
  throw new Error(`invalid Open-Meteo verification response: ${message}`)
}

export function buildBatchForecastUrl(sites, modelKey, baseUrl = FORECAST_API_BASE) {
  const modelId = MODEL_IDS[modelKey]
  if (!modelId) throw new Error(`Unknown verification model: ${modelKey}`)
  const params = new URLSearchParams({
    latitude: sites.map((site) => site.latitude).join(','),
    longitude: sites.map((site) => site.longitude).join(','),
    hourly: MODEL_FIELDS[modelKey].join(','),
    models: modelId,
    timezone: 'UTC',
    timeformat: 'unixtime',
    forecast_days: String(PILOT_HORIZON_DAYS),
    wind_speed_unit: 'kmh',
    temperature_unit: 'celsius',
  })
  return `${baseUrl}?${params.toString()}`
}

export function validateForecastPayload(payload, modelKey) {
  if (!payload || typeof payload !== 'object') validationError('body was not an object')
  const times = payload.hourly?.time
  if (!Array.isArray(times) || times.length === 0) validationError('hourly.time is missing or empty')
  if (times.some((value) => !Number.isFinite(value))) validationError('hourly.time contains a non-numeric value')

  for (const field of MODEL_FIELDS[modelKey] ?? []) {
    const values = payload.hourly[field]
    if (!Array.isArray(values)) validationError(`hourly.${field} is missing`)
    if (values.length !== times.length) validationError(`hourly.${field} length differs from hourly.time`)
    if (values.some((value) => value !== null && !Number.isFinite(value))) {
      validationError(`hourly.${field} contains a non-numeric value`)
    }
  }
  return payload
}

export function splitBatchPayload(body, sites, modelKey) {
  const payloads = Array.isArray(body) ? body : sites.length === 1 ? [body] : null
  if (!payloads || payloads.length !== sites.length) {
    validationError(`expected one payload per site, received ${Array.isArray(body) ? body.length : 'one object'}`)
  }
  return payloads.map((payload, index) => ({ site: sites[index], payload: validateForecastPayload(payload, modelKey) }))
}

async function fetchModelBatch(sites, modelKey, fetchImpl, baseUrl) {
  const response = await fetchImpl(buildBatchForecastUrl(sites, modelKey, baseUrl))
  let body = null
  try {
    body = await response.json()
  } catch {
    throw new Error(`Open-Meteo returned HTTP ${response.status ?? 'unknown'} with an unreadable body`)
  }
  if (response.ok === false || body?.error) {
    throw new Error(String(body?.reason ?? `Open-Meteo returned HTTP ${response.status ?? 'unknown'}`))
  }
  return { body, responseStatus: response.status ?? 200 }
}

function diagnosticIndex(site, responses, now) {
  const timezone = safeTimeZone(SITE_TIMEZONE)
  const models = Object.fromEntries(
    MODEL_KEYS.map((key) => [key, { response: responses[key] ?? null, index: indexHourly(responses[key]) }])
  )
  const observer = new Astronomy.Observer(site.latitude, site.longitude, site.elevationM ?? 0)
  const today = zonedParts(now, timezone)
  const index = new Map()
  for (let day = 0; day < PILOT_HORIZON_DAYS; day++) {
    const night = buildNight(addDays(today, day), timezone, observer, models)
    for (const hour of night.hours) index.set(hourKey(hour.time), hour)
  }
  return index
}

function modelAvailability(responses) {
  return MODEL_KEYS.filter((key) => responses[key] !== null && responses[key] !== undefined)
}

function responseTimes(responses) {
  return [...new Set(
    MODEL_KEYS.flatMap((key) => responses[key]?.hourly?.time ?? [])
  )].sort((a, b) => a - b)
}

function weightedSurface(responses, field, timeIndex) {
  const values = MODEL_KEYS.map((key) => readField(responses[key], field, timeIndex[key]))
  const present = values.filter((value) => value !== null)
  return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0) / present.length
}

function diagnosticForTime(site, responses, retrievedAt, time, diagnostics) {
  const byModel = Object.fromEntries(
    MODEL_KEYS.map((key) => [key, { response: responses[key], index: indexHourly(responses[key]) }])
  )
  const modelIndex = Object.fromEntries(
    MODEL_KEYS.map((key) => [key, byModel[key].index.get(time) ?? -1])
  )
  const available = modelAvailability(responses)
  const totals = Object.fromEntries(
    MODEL_KEYS.map((key) => {
      const index = modelIndex[key]
      return [key, combineCloudLayers(
        readField(responses[key], 'cloud_cover_low', index),
        readField(responses[key], 'cloud_cover_mid', index),
        readField(responses[key], 'cloud_cover_high', index),
      )]
    })
  )
  const cloud = blendCloud(totals.ecmwf, totals.ukmo, totals.icon)
  const presentTotals = Object.values(totals).filter((value) => value !== null)
  const disagreement = presentTotals.length >= 2 ? Math.max(...presentTotals) - Math.min(...presentTotals) : null
  const diagnostic = diagnostics?.get(time) ?? null
  const validAt = new Date(time * 1000)
  return {
    siteId: site.id,
    validAt: validAt.toISOString(),
    retrievalLeadMinutes: Math.round((validAt.getTime() - new Date(retrievedAt).getTime()) / 60_000),
    cloud_low: weightedSurface(responses, 'cloud_cover_low', modelIndex),
    cloud_mid: weightedSurface(responses, 'cloud_cover_mid', modelIndex),
    cloud_high: weightedSurface(responses, 'cloud_cover_high', modelIndex),
    cloud_total: cloud,
    temperature_2m: weightedSurface(responses, 'temperature_2m', modelIndex),
    relative_humidity_2m: weightedSurface(responses, 'relative_humidity_2m', modelIndex),
    dew_point_2m: weightedSurface(responses, 'dew_point_2m', modelIndex),
    wind_speed_10m: weightedSurface(responses, 'wind_speed_10m', modelIndex),
    modelCloudTotals: totals,
    modelAvailability: available,
    weightCoverage: available.reduce((sum, key) => sum + MODEL_WEIGHTS[key], 0),
    disagreement,
    agreement: diagnostic?.agreement ?? (presentTotals.length >= 2
      ? disagreement <= 15 ? 'agree' : disagreement <= 30 ? 'mixed' : 'disagree'
      : presentTotals.length === 1 ? 'single' : null),
    confidence: diagnostic?.confidence ?? (available.length === 0 ? 'unavailable' : available.length === MODEL_KEYS.length ? 'full' : 'partial'),
    score: diagnostic?.score ?? null,
    verdict: diagnostic?.verdict ?? null,
    scoreComponents: diagnostic?.components ?? null,
    missingData: diagnostic?.missingData ?? [],
    vetoed: diagnostic?.vetoed ?? null,
    uncappedScore: diagnostic?.uncappedScore ?? null,
    cap: diagnostic?.cap ?? null,
  }
}

function equalWeightHour(site, responses, retrievedAt, time) {
  const indices = Object.fromEntries(
    MODEL_KEYS.map((key) => [key, indexHourly(responses[key]).get(time) ?? -1])
  )
  const available = modelAvailability(responses)
  const averageField = (field) => {
    const values = available.map((key) => readField(responses[key], field, indices[key])).filter((value) => value !== null)
    return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
  }
  const totals = Object.fromEntries(available.map((key) => [key, combineCloudLayers(
    readField(responses[key], 'cloud_cover_low', indices[key]),
    readField(responses[key], 'cloud_cover_mid', indices[key]),
    readField(responses[key], 'cloud_cover_high', indices[key]),
  )]))
  const presentTotals = Object.values(totals).filter((value) => value !== null)
  return {
    model: 'equal-weight',
    siteId: site.id,
    validAt: new Date(time * 1000).toISOString(),
    retrievalLeadMinutes: Math.round((new Date(time * 1000).getTime() - new Date(retrievedAt).getTime()) / 60_000),
    cloud_low: averageField('cloud_cover_low'),
    cloud_mid: averageField('cloud_cover_mid'),
    cloud_high: averageField('cloud_cover_high'),
    cloud_total: presentTotals.length === 0 ? null : presentTotals.reduce((sum, value) => sum + value, 0) / presentTotals.length,
    temperature_2m: averageField('temperature_2m'),
    relative_humidity_2m: averageField('relative_humidity_2m'),
    dew_point_2m: averageField('dew_point_2m'),
    wind_speed_10m: averageField('wind_speed_10m'),
    modelCloudTotals: totals,
    modelAvailability: available,
    weightCoverage: available.length / MODEL_KEYS.length,
    disagreement: presentTotals.length >= 2 ? Math.max(...presentTotals) - Math.min(...presentTotals) : null,
    agreement: null,
    confidence: null,
    score: null,
    verdict: null,
    scoreComponents: null,
    missingData: [],
  }
}

function makeSnapshot(site, modelKey, payload, runId, retrievedAt) {
  const times = payload.hourly.time
  const modelRunAt = modelRunTime(payload)
  const availableFields = MODEL_FIELDS[modelKey].filter((field) => Array.isArray(payload.hourly[field]))
  const completeness = availableFields.length / MODEL_FIELDS[modelKey].length
  const missingFields = MODEL_FIELDS[modelKey].filter((field) => !availableFields.includes(field))
  const snapshotId = `${runId}:${modelKey}:${site.id}`
  return {
    snapshotId,
    collectionRunId: runId,
    siteId: site.id,
    provider: FORECAST_PROVIDER,
    model: modelKey,
    modelId: MODEL_IDS[modelKey],
    modelRunAt,
    retrievedAt: iso(retrievedAt),
    timezone: 'UTC',
    latitude: site.latitude,
    longitude: site.longitude,
    elevationM: site.elevationM,
    gridLatitude: finite(payload.latitude),
    gridLongitude: finite(payload.longitude),
    gridElevationM: finite(payload.elevation),
    availability: completeness === 1 ? 'complete' : 'partial',
    completeness,
    missingFields,
    schemaVersion: VERIFICATION_SCHEMA_VERSION,
    calculationVersion: VERIFICATION_CALCULATION_VERSION,
    rawObjectKey: `forecasts/${runId}/${modelKey}/batch.json`,
    hours: times.map((time, index) => {
      const validAt = new Date(time * 1000)
      return {
        snapshotId,
        siteId: site.id,
        model: modelKey,
        validAt: validAt.toISOString(),
        leadMinutes: modelRunAt === null ? null : Math.round((validAt.getTime() - new Date(modelRunAt).getTime()) / 60_000),
        retrievalLeadMinutes: Math.round((validAt.getTime() - new Date(retrievedAt).getTime()) / 60_000),
        cloud_cover_low: readField(payload, 'cloud_cover_low', index),
        cloud_cover_mid: readField(payload, 'cloud_cover_mid', index),
        cloud_cover_high: readField(payload, 'cloud_cover_high', index),
        temperature_2m: readField(payload, 'temperature_2m', index),
        relative_humidity_2m: readField(payload, 'relative_humidity_2m', index),
        dew_point_2m: readField(payload, 'dew_point_2m', index),
        wind_speed_10m: readField(payload, 'wind_speed_10m', index),
      }
    }),
  }
}

export async function collectForecastRun({
  sites = REFERENCE_SITES,
  now = new Date(),
  scheduledAt = now,
  fetchImpl = fetch,
  baseUrl = FORECAST_API_BASE,
  includeScoringDiagnostics = false,
} = {}) {
  const retrievedAt = new Date(now)
  const scheduledTime = new Date(scheduledAt)
  const runId = `verification-${scheduledTime.toISOString()}`
  const run = {
    runId,
    scheduledAt: scheduledTime.toISOString(),
    startedAt: retrievedAt.toISOString(),
    completedAt: null,
    status: 'partial',
    siteCount: sites.length,
    modelCount: MODEL_KEYS.length,
    horizonDays: PILOT_HORIZON_DAYS,
    scoringDiagnostics: includeScoringDiagnostics ? 'production-compatible' : 'disabled-for-free-tier-budget',
    failures: [],
  }

  const responsesByModel = {}
  const rawPayloads = []
  for (const modelKey of MODEL_KEYS) {
    try {
      const result = await fetchModelBatch(sites, modelKey, fetchImpl, baseUrl)
      const pairs = splitBatchPayload(result.body, sites, modelKey)
      responsesByModel[modelKey] = Object.fromEntries(pairs.map(({ site, payload }) => [site.id, payload]))
      rawPayloads.push({
        objectKey: `forecasts/${runId}/${modelKey}/batch.json`,
        provider: FORECAST_PROVIDER,
        model: modelKey,
        retrievedAt: retrievedAt.toISOString(),
        payload: result.body,
      })
    } catch (error) {
      responsesByModel[modelKey] = {}
      run.failures.push({ model: modelKey, reason: error.message })
    }
  }

  const snapshots = []
  const forecastHours = []
  const ensembleHours = []
  const baselineHours = []
  for (const site of sites) {
    const responses = Object.fromEntries(MODEL_KEYS.map((key) => [key, responsesByModel[key]?.[site.id] ?? null]))
    const diagnostics = includeScoringDiagnostics ? diagnosticIndex(site, responses, retrievedAt) : null
    for (const modelKey of MODEL_KEYS) {
      const payload = responses[modelKey]
      if (!payload) continue
      const snapshot = makeSnapshot(site, modelKey, payload, runId, retrievedAt)
      snapshots.push(snapshot)
      forecastHours.push(...snapshot.hours.map((hour) => ({
        ...hour,
        classification: site.classification,
        snapshotId: snapshot.snapshotId,
      })))
    }

    const times = responseTimes(responses)
    for (const time of times) {
      const hour = diagnosticForTime(site, responses, retrievedAt, time, diagnostics)
      const diagnostic = diagnostics?.get(time) ?? null
      ensembleHours.push({
        ...hour,
        model: 'production-ensemble',
        classification: site.classification,
        score: diagnostic?.score ?? null,
        verdict: diagnostic?.verdict ?? null,
        confidence: diagnostic?.confidence ?? hour.confidence,
        agreement: diagnostic?.agreement ?? hour.agreement,
        scoreComponents: diagnostic?.components ?? null,
        missingData: diagnostic?.missingData ?? [],
      })
      baselineHours.push({ ...equalWeightHour(site, responses, retrievedAt, time), classification: site.classification })
    }
  }

  run.completedAt = new Date().toISOString()
  run.status = run.failures.length === 0 ? 'complete' : snapshots.length > 0 ? 'partial' : 'failed'
  return { run, snapshots, forecastHours, ensembleHours, baselineHours, rawPayloads }
}

export { MODEL_KEYS }
