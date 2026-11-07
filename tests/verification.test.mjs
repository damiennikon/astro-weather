import assert from 'node:assert/strict'
import test from 'node:test'
import { collectForecastRun, buildBatchForecastUrl, splitBatchPayload } from '../workers/verification/collector.js'
import { parseBomStationPayload, stationFeedUrl } from '../workers/verification/observations.js'
import { buildVerificationRows, leadBand, summarizeErrors, summarizeVerification } from '../workers/verification/metrics.js'
import { REFERENCE_SITES } from '../workers/verification/sites.js'
import { collectionBudget, resourceWarnings } from '../workers/verification/usage.js'
import { retentionPlan, runRetention } from '../workers/verification/retention.js'

const START = Date.parse('2026-11-07T00:00:00Z')

function hourlyPayload(siteIndex, modelKey) {
  const times = Array.from({ length: 192 }, (_, index) => START / 1000 + index * 3600)
  const offset = { ecmwf: 1, ukmo: 2, icon: 3 }[modelKey] + siteIndex
  const values = (base) => times.map((_, index) => base + (index % 5))
  const hourly = {
    time: times,
    cloud_cover_low: values(10 + offset),
    cloud_cover_mid: values(20 + offset),
    cloud_cover_high: values(30 + offset),
    temperature_2m: values(18 + offset),
    relative_humidity_2m: values(60),
    dew_point_2m: values(10),
    wind_speed_10m: values(5),
  }
  if (modelKey !== 'ukmo') hourly.wind_speed_250hPa = values(30)
  return {
    latitude: -27.5 + siteIndex / 100,
    longitude: 153.1 + siteIndex / 100,
    elevation: 10 + siteIndex,
    hourly,
  }
}

function fakeFetch() {
  return async (url) => {
    const modelId = new URL(url).searchParams.get('models')
    const modelKey = modelId.includes('ecmwf') ? 'ecmwf' : modelId.includes('ukmo') ? 'ukmo' : 'icon'
    const sites = REFERENCE_SITES.map((_, index) => hourlyPayload(index, modelKey))
    return { ok: true, status: 200, json: async () => sites }
  }
}

test('verification URL batches the fixed sites without changing the live forecast URL', () => {
  const url = buildBatchForecastUrl(REFERENCE_SITES, 'ecmwf')
  const parsed = new URL(url)
  assert.equal(parsed.searchParams.get('models'), 'ecmwf_ifs025')
  assert.equal(parsed.searchParams.get('forecast_days'), '8')
  assert.equal(parsed.searchParams.get('latitude').split(',').length, 6)
  assert.match(parsed.searchParams.get('hourly'), /cloud_cover_low/)
})

test('collector preserves immutable snapshots, forecast hours and production diagnostics', async () => {
  const result = await collectForecastRun({
    now: new Date(START),
    scheduledAt: new Date(START),
    fetchImpl: fakeFetch(),
    includeScoringDiagnostics: true,
  })

  assert.equal(result.run.status, 'complete')
  assert.equal(result.run.scoringDiagnostics, 'production-compatible')
  assert.equal(result.snapshots.length, 18)
  assert.equal(result.forecastHours.length, 18 * 192)
  assert.equal(result.ensembleHours.length, 6 * 192)
  assert.equal(result.snapshots[0].modelRunAt, null)
  assert.equal(result.snapshots[0].retrievedAt, new Date(START).toISOString())
  assert.equal(result.snapshots[0].rawObjectKey.includes(result.run.runId), true)
  assert.equal(result.ensembleHours.some((hour) => hour.scoreComponents !== null), true)
  assert.equal(result.ensembleHours.every((hour) => hour.model === 'production-ensemble'), true)
  assert.equal(result.baselineHours.length, 6 * 192)
  assert.equal(result.baselineHours.every((hour) => hour.model === 'equal-weight'), true)
})

test('free-tier collector mode keeps diagnostics lightweight without changing production code', async () => {
  const result = await collectForecastRun({
    now: new Date(START),
    scheduledAt: new Date(START),
    fetchImpl: fakeFetch(),
  })
  assert.equal(result.run.scoringDiagnostics, 'disabled-for-free-tier-budget')
  assert.equal(result.ensembleHours[0].scoreComponents, null)
  assert.equal(result.ensembleHours[0].confidence, 'full')
  assert.equal(result.ensembleHours[0].agreement, 'agree')
})

test('collector records a model dropout without discarding the other models', async () => {
  let calls = 0
  const fetchImpl = async (url) => {
    calls += 1
    if (new URL(url).searchParams.get('models') === 'ukmo_seamless') {
      return { ok: false, status: 503, json: async () => ({ reason: 'temporary outage' }) }
    }
    return fakeFetch()(url)
  }

  const result = await collectForecastRun({
    now: new Date(START),
    scheduledAt: new Date(START),
    fetchImpl,
  })

  assert.equal(calls, 3)
  assert.equal(result.run.status, 'partial')
  assert.equal(result.run.failures[0].model, 'ukmo')
  assert.equal(result.snapshots.length, 12)
  assert.ok(result.ensembleHours.every((hour) => hour.modelAvailability.includes('ecmwf')))
})

test('BOM station parser normalizes timestamps, missing values and wind units', () => {
  const observations = parseBomStationPayload({
    observations: {
      data: [{
        wmo: '040764',
        name: 'GOLD COAST SEAWAY',
        aifstime_utc: '20261107000000',
        air_temp: '24.5',
        rel_hum: '70',
        dewpt: '18.5',
        wind_spd_kt: '10',
        rain_trace: '-',
      }],
    },
  }, { siteId: 'gold-coast', stationId: '040764' })

  assert.equal(observations.length, 1)
  assert.equal(observations[0].temperature_c, 24.5)
  assert.equal(observations[0].wind_speed_kmh, 18.52)
  assert.equal(observations[0].rainfall_since_9am_mm, null)
  assert.match(stationFeedUrl('94580'), /IDQ60901\.94580\.json$/)
})

test('verification matching never fabricates missing observations', () => {
  const forecasts = [{
    snapshotId: 's1', model: 'ecmwf', siteId: 'warwick', classification: 'inland',
    validAt: '2026-11-07T00:00:00Z', leadMinutes: 120, temperature_2m: 20,
  }]
  const observations = [{
    observationId: 'o1', siteId: 'warwick', observedAt: '2026-11-07T02:00:00Z', temperature_c: 18,
  }]
  assert.equal(buildVerificationRows({ forecasts, observations, toleranceMinutes: 30 }).length, 0)
})

test('verification metrics calculate deterministic error summaries and lead bands', () => {
  assert.equal(leadBand(0), '0-12h')
  assert.equal(leadBand(12 * 60), '12-24h')
  assert.equal(leadBand(96 * 60), null)
  assert.deepEqual(summarizeErrors([1, -1, 3]), {
    sampleCount: 3,
    mae: 5 / 3,
    rmse: Math.sqrt(11 / 3),
    meanBias: 1,
    medianAbsoluteError: 1,
  })
})

test('verification summaries retain model, location, season and sample dimensions', () => {
  const observations = [{
    observationId: 'o1', siteId: 'brisbane-airport', observedAt: '2026-11-07T00:00:00Z',
    temperature_c: 20, relative_humidity_pct: 50, dew_point_c: 10, wind_speed_kmh: 5,
  }]
  const forecasts = [{
    snapshotId: 's1', model: 'production-ensemble', siteId: 'brisbane-airport', classification: 'coastal',
    validAt: '2026-11-07T00:00:00Z', leadMinutes: 60, temperature_2m: 22,
    relative_humidity_2m: 55, dew_point_2m: 12, wind_speed_10m: 8,
  }]
  const rows = buildVerificationRows({ forecasts, observations })
  const summaries = summarizeVerification(rows)
  assert.equal(summaries.length, 4)
  assert.ok(summaries.every((summary) => summary.model === 'production-ensemble'))
  assert.ok(summaries.every((summary) => summary.observationCount === 1))
})

test('batch payload validation rejects a missing site response', () => {
  assert.throws(
    () => splitBatchPayload([], REFERENCE_SITES, 'ecmwf'),
    /expected one payload per site/
  )
})

test('usage guards warn before the free-tier limit and suspend over-limit collection', () => {
  const budget = collectionBudget()
  assert.equal(budget.modelRequestsPerDay, 12)
  assert.equal(budget.observationRequestsPerDay, 24)
  assert.equal(budget.totalExternalRequestsPerDay, 36)
  assert.equal(budget.forecastHoursPerDay, 13_824)
  assert.equal(budget.ensembleRowsPerDay, 9_216)
  assert.equal(budget.observationRowsPerDay, 3_720)
  assert.equal(budget.estimatedD1RowsPerDay, 26_760)
  const warnings = resourceWarnings({ d1RowsWrittenPerDay: 85_000, kvWritesPerDay: 800 })
  assert.equal(warnings.find((item) => item.resource === 'd1RowsWrittenPerDay').level, 'warn')
  assert.equal(warnings.find((item) => item.resource === 'kvWritesPerDay').level, 'warn')
  const suspended = resourceWarnings({ d1RowsWrittenPerDay: 100_001 })
  assert.equal(suspended.find((item) => item.resource === 'd1RowsWrittenPerDay').level, 'suspend')
})

test('retention is explicit dry-run only during the pilot', async () => {
  const plan = retentionPlan({ now: '2026-11-07T00:00:00Z' })
  assert.equal(plan.enabled, false)
  assert.equal(plan.approvalRequired, true)
  assert.match(plan.action, /dry-run/)
  assert.deepEqual(await runRetention(), { deleted: false, reason: 'explicit retention approval is required' })
  await assert.rejects(() => runRetention({ approved: true }), /not enabled/)
})
