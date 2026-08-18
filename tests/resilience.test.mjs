// Fix 3 — a single model failing must cost that model's weight, not the forecast;
// a total upstream failure must surface as an error, never as low scores.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildForecast, ForecastUnavailableError } from '../src/forecast.js'
import { zonedToUtc } from '../src/timezone.js'
import { buildFixture, okResponse, errorPayloadResponse } from './helpers/openMeteoFixture.mjs'

const SITE = { lat: -27.47, lng: 152.98, tz: 'Australia/Brisbane' }
const START = { year: 2026, month: 8, day: 18 }
const NOW = zonedToUtc(START.year, START.month, START.day, 12, 0, SITE.tz)

// Clear skies for everyone, so any score movement comes from availability alone.
function clearFixture() {
  const body = buildFixture({ timeZone: SITE.tz, startYmd: START })
  body.hourly.cloudcover_low = body.hourly.cloudcover_low.map(() => 0)
  return body
}

function routeByModel(handlers) {
  return async (url) => {
    const model = new URL(url).searchParams.get('models')
    const key = model.startsWith('ecmwf') ? 'ecmwf' : model.startsWith('ukmo') ? 'ukmo' : 'icon'
    const handler = handlers[key]
    if (typeof handler === 'function') return handler()
    return okResponse(handler)
  }
}

const run = (fetchImpl) => buildForecast(SITE.lat, SITE.lng, SITE.tz, { fetchImpl, now: NOW })

test('all three models present: full confidence', async () => {
  const body = clearFixture()
  const { nights, meta } = await run(routeByModel({ ecmwf: body, ukmo: body, icon: body }))

  assert.equal(meta.degraded, false)
  assert.deepEqual(meta.available, ['ecmwf', 'ukmo', 'icon'])
  assert.equal(meta.weightCoverage, 1)
  assert.ok(nights[0].nightAvg.score > 0)
  assert.equal(nights[0].dataStatus, 'ok')
})

test('ICON fails: forecast still renders on the remaining two, flagged degraded', async () => {
  const body = clearFixture()
  const { nights, meta } = await run(
    routeByModel({ ecmwf: body, ukmo: body, icon: () => Promise.reject(new Error('network down')) })
  )

  assert.equal(meta.degraded, true)
  assert.deepEqual(meta.available, ['ecmwf', 'ukmo'])
  assert.deepEqual(meta.missing, ['icon'])
  assert.equal(Math.round(meta.weightCoverage * 100), 80)

  const night = nights[0]
  assert.equal(night.dataStatus, 'ok', 'every dark hour is still scoreable')
  assert.ok(night.scoredHourCount > 0)
  assert.ok(night.nightAvg.score > 0, 'losing one model must not zero the score')
  assert.equal(night.hours.find((h) => h.isDark).cloudIcon, null)
})

test('ICON returns an Open-Meteo error payload: treated as failed, not as null data', async () => {
  const body = clearFixture()
  const { nights, meta } = await run(
    routeByModel({ ecmwf: body, ukmo: body, icon: () => errorPayloadResponse('Cannot initialize icon_global') })
  )

  assert.deepEqual(meta.missing, ['icon'])
  assert.match(meta.failures[0].reason, /icon_global/)
  assert.ok(nights[0].nightAvg.score > 0)
})

test('only one model survives: scored, but agreement reports single-model', async () => {
  const body = clearFixture()
  const fail = () => Promise.reject(new Error('network down'))
  const { nights, meta } = await run(routeByModel({ ecmwf: body, ukmo: fail, icon: fail }))

  assert.deepEqual(meta.available, ['ecmwf'])
  assert.equal(meta.weightCoverage, 0.5)
  const darkHour = nights[0].hours.find((h) => h.isDark)
  assert.equal(darkHour.agreement, 'single')
  assert.ok(darkHour.score > 0)
})

test('total failure throws ForecastUnavailableError instead of scoring zeros', async () => {
  const fail = () => Promise.reject(new Error('network down'))
  await assert.rejects(
    () => run(routeByModel({ ecmwf: fail, ukmo: fail, icon: fail })),
    (err) => {
      assert.ok(err instanceof ForecastUnavailableError)
      assert.equal(err.code, 'UPSTREAM_UNAVAILABLE')
      assert.equal(err.failures.length, 3)
      return true
    }
  )
})

test('total failure via error payloads also throws, not 0/100', async () => {
  const bad = () => errorPayloadResponse('API rate limit exceeded')
  await assert.rejects(
    () => run(routeByModel({ ecmwf: bad, ukmo: bad, icon: bad })),
    (err) => err.code === 'UPSTREAM_UNAVAILABLE' && /rate limit/.test(err.message)
  )
})

test('an hour with no model data scores null, and is excluded from the average', async () => {
  // Truncate every model an hour into astronomical dark: the remaining dark hours
  // have no data at all. Those must not be averaged in as zeros.
  const body = clearFixture()
  const truncated = structuredClone(body)
  const cut = 20 // 20:00 local on day 0
  for (const field of Object.keys(truncated.hourly)) {
    if (field === 'time') continue
    truncated.hourly[field] = truncated.hourly[field].map((v, i) => (i >= cut ? null : v))
  }

  const { nights } = await run(routeByModel({ ecmwf: truncated, ukmo: truncated, icon: truncated }))
  const night = nights[0]
  const darkHours = night.hours.filter((h) => h.isDark)
  const blank = darkHours.filter((h) => h.score === null)

  assert.ok(blank.length > 0, 'fixture should leave some dark hours without data')
  for (const h of blank) assert.equal(h.verdict, 'unavailable')
  assert.equal(night.dataStatus, 'partial')
  assert.equal(night.scoredHourCount, darkHours.length - blank.length)

  // The average is over scored hours only. Averaging the nulls in as 0 would give
  // scoredAvg * scored/total, which is strictly lower.
  const scored = darkHours.filter((h) => h.score !== null)
  const expected = scored.reduce((s, h) => s + h.score, 0) / scored.length
  assert.ok(Math.abs(night.nightAvg.score - expected) < 1e-9)
  assert.ok(night.nightAvg.score > expected * (scored.length / darkHours.length))
})
