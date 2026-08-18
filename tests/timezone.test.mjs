// Fix 1 — forecast hours must be indexed against the *site's* timezone, not the viewer's.
//
// Scenario from the architecture review: a browser in Australia/Brisbane (UTC+10)
// viewing a site in Australia/Perth (UTC+8). The fixture encodes each hour's Perth
// local hour-of-day as its cloud value, so a correct pipeline reads cloud === 22 at
// the instant Perth's clock says 22:00. The old browser-clock indexing read cloud
// === 20 there — a two-hour offset, silently.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildForecast } from '../src/forecast.js'
import { zonedParts, zonedToUtc } from '../src/timezone.js'
import { buildFixture, okResponse } from './helpers/openMeteoFixture.mjs'

const PERTH = { lat: -31.95, lng: 115.86, tz: 'Australia/Perth' }
const START = { year: 2026, month: 8, day: 18 }

function perthFetch() {
  const body = buildFixture({ timeZone: PERTH.tz, startYmd: START, format: 'unixtime' })
  return async () => okResponse(body)
}

test('hours are indexed by the site timezone, not the browser timezone', async () => {
  assert.equal(process.env.TZ, 'Australia/Brisbane', 'run with TZ=Australia/Brisbane')

  const { nights } = await buildForecast(PERTH.lat, PERTH.lng, PERTH.tz, {
    fetchImpl: perthFetch(),
    now: zonedToUtc(START.year, START.month, START.day, 12, 0, PERTH.tz),
  })

  const night = nights[0]
  assert.equal(night.date, '2026-08-18', 'night is labelled with the site civil date')

  for (const hour of night.hours) {
    const perthHour = zonedParts(hour.time, PERTH.tz).hour
    assert.equal(
      Math.round(hour.cloud),
      perthHour,
      `hour at ${hour.time.toISOString()} is Perth ${perthHour}:00 but carries cloud ${hour.cloud}`
    )
  }
})

test('display window starts at 17:00 local to the site', async () => {
  const { nights } = await buildForecast(PERTH.lat, PERTH.lng, PERTH.tz, {
    fetchImpl: perthFetch(),
    now: zonedToUtc(START.year, START.month, START.day, 12, 0, PERTH.tz),
  })

  const first = nights[0].hours[0]
  assert.equal(zonedParts(first.time, PERTH.tz).hour, 17)
  // 17:00 Perth is 19:00 Brisbane — the old code anchored on the latter.
  assert.equal(zonedParts(first.time, 'Australia/Brisbane').hour, 19)
})

test('a site east of the viewer is handled symmetrically', async () => {
  const SYD = { lat: -33.87, lng: 151.21, tz: 'Australia/Sydney' }
  const body = buildFixture({ timeZone: SYD.tz, startYmd: { year: 2026, month: 12, day: 5 } })

  const { nights } = await buildForecast(SYD.lat, SYD.lng, SYD.tz, {
    fetchImpl: async () => okResponse(body),
    now: zonedToUtc(2026, 12, 5, 12, 0, SYD.tz),
  })

  // December: Sydney is on AEDT (+11), Brisbane stays on AEST (+10).
  for (const hour of nights[0].hours) {
    assert.equal(Math.round(hour.cloud), zonedParts(hour.time, SYD.tz).hour)
  }
  assert.equal(nights[0].date, '2026-12-05')
})
