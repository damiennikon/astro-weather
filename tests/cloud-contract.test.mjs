import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  blendCloud,
  buildForecast,
  buildUrl,
  combineCloudLayers,
  fetchModel,
} from '../src/forecast.js'
import { zonedToUtc } from '../src/timezone.js'
import { buildFixture, okResponse } from './helpers/openMeteoFixture.mjs'

const SITE = { lat: -27.47, lng: 152.98, tz: 'Australia/Brisbane' }
const START = { year: 2026, month: 8, day: 18 }
const NOW = zonedToUtc(START.year, START.month, START.day, 12, 0, SITE.tz)

test('buildUrl requests the canonical Open-Meteo field names', () => {
  const url = new URL(buildUrl(SITE.lat, SITE.lng, SITE.tz, 'ecmwf_ifs025', true))

  assert.deepEqual(url.searchParams.get('hourly').split(','), [
    'cloud_cover_low',
    'cloud_cover_mid',
    'cloud_cover_high',
    'temperature_2m',
    'relative_humidity_2m',
    'dew_point_2m',
    'wind_speed_10m',
    'wind_speed_250hPa',
  ])
})

test('fetchModel rejects missing and mismatched required arrays', async () => {
  const body = buildFixture({ timeZone: SITE.tz, startYmd: START })
  const missing = structuredClone(body)
  delete missing.hourly.cloud_cover_mid
  await assert.rejects(
    () => fetchModel('https://example.test', async () => okResponse(missing)),
    /response missing hourly array: cloud_cover_mid/
  )

  const mismatched = structuredClone(body)
  mismatched.hourly.wind_speed_10m.pop()
  await assert.rejects(
    () => fetchModel('https://example.test', async () => okResponse(mismatched)),
    /hourly array length mismatch: wind_speed_10m/
  )
})

test('fetchModel converts an aborted upstream request into a bounded timeout error', async () => {
  const fetchImpl = async (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  })

  await assert.rejects(
    () => fetchModel('https://example.test', fetchImpl, [], 1),
    /Forecast request timed out after 0\.001s/,
  )
})

test('missing cloud layers remain unavailable instead of becoming clear sky', () => {
  assert.equal(combineCloudLayers(20, null, 10), null)
  assert.equal(combineCloudLayers(null, null, 10), null)
  assert.equal(combineCloudLayers(20, 30, 40), 66.4)
})

test('blendCloud keeps the normalized weighted mean when models disagree', () => {
  assert.equal(blendCloud(0, 0, 100), 20)
  assert.equal(blendCloud(100, 100, 0), 80)
  assert.equal(blendCloud(60, null, null), 60)
})

test('cloud total blends per-model totals while retaining layer diagnostics', async () => {
  const ecmwf = buildFixture({ timeZone: SITE.tz, startYmd: START })
  const ukmo = structuredClone(ecmwf)
  const icon = structuredClone(ecmwf)

  for (const field of ['cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high']) {
    ecmwf.hourly[field] = ecmwf.hourly[field].map(() => 0)
    ukmo.hourly[field] = ukmo.hourly[field].map(() => 0)
    icon.hourly[field] = icon.hourly[field].map(() => 0)
  }
  ukmo.hourly.cloud_cover_low = ukmo.hourly.cloud_cover_low.map(() => 100)
  icon.hourly.cloud_cover_mid = icon.hourly.cloud_cover_mid.map(() => 100)

  const routeByModel = async (url) => {
    const model = new URL(url).searchParams.get('models')
    if (model === 'ecmwf_ifs025') return okResponse(ecmwf)
    if (model === 'ukmo_seamless') return okResponse(ukmo)
    return okResponse(icon)
  }

  const forecast = await buildForecast(SITE.lat, SITE.lng, SITE.tz, { fetchImpl: routeByModel, now: NOW })
  const hour = forecast.nights[0].hours.find((candidate) => candidate.isDark)

  assert.equal(hour.cloudEcmwf, 0)
  assert.equal(hour.cloudUkmo, 100)
  assert.equal(hour.cloudIcon, 100)
  assert.equal(hour.cloudLow, 30)
  assert.equal(hour.cloudMid, 20)
  assert.equal(hour.cloudHigh, 0)
  assert.equal(hour.cloud, 50)
  assert.equal(hour.agreement, 'disagree')
})
