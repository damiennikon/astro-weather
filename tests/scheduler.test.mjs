// Fix 2 — the scheduled push worker must use the real moon, label the night with
// the correct local date, and treat a night as one continuous dark period.
//
// Anchor case: Friday 28 August 2026, the next full moon (99.8% illuminated at
// Brisbane midnight). Skies are perfectly clear in the fixture, so the *only* thing
// that can stop a "Clear skies ahead" push is the moon.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildForecast } from '../src/forecast.js'
import { zonedParts, zonedToUtc } from '../src/timezone.js'
import { findGoodNight } from '../workers/scheduler/nightSelection.js'
import { buildFixture, okResponse } from './helpers/openMeteoFixture.mjs'

const SITE = { lat: -27.47, lng: 152.98, tz: 'Australia/Brisbane', name: 'Mount Nebo' }
const FULL_MOON_DAY = { year: 2026, month: 8, day: 28 }
// The cron is 0 22 * * * UTC, which is 08:00 the next morning in Brisbane.
const CRON_FIRES_AT = new Date('2026-08-28T22:00:00Z')

function clearSkyFetch(startYmd) {
  const body = buildFixture({ timeZone: SITE.tz, startYmd })
  body.hourly.cloudcover_low = body.hourly.cloudcover_low.map(() => 0)
  return async () => okResponse(body)
}

async function nightsAt(now, startYmd) {
  const { nights } = await buildForecast(SITE.lat, SITE.lng, SITE.tz, {
    fetchImpl: clearSkyFetch(startYmd),
    now,
    maxNights: 3,
  })
  return nights
}

test('the full moon night is scored with the real moon and does not notify', async () => {
  const now = zonedToUtc(FULL_MOON_DAY.year, FULL_MOON_DAY.month, FULL_MOON_DAY.day, 8, 0, SITE.tz)
  const nights = await nightsAt(now, FULL_MOON_DAY)
  const night = nights[0]

  assert.equal(night.date, '2026-08-28')
  assert.ok(night.moonIllum > 0.95, `expected a full moon, got ${night.moonIllum}`)

  // Clear skies, but the moon is up almost all night.
  assert.ok(
    night.nightAvg.score < 65,
    `full-moon night scored ${night.nightAvg.score}, which would still trigger a push`
  )
  assert.equal(findGoodNight(nights, now, SITE.tz), null, 'no notification on a full-moon night')
})

test('the old hardcoded moon would have notified on that same night', async () => {
  // moonIllum = 0.3, moonAlt = 30 — what the scheduler used to pass regardless of
  // the actual sky. Re-scoring the same clear hours with those values shows the
  // notification the old code would have sent.
  const { scoreHour } = await import('../src/scoring.js')
  const now = zonedToUtc(FULL_MOON_DAY.year, FULL_MOON_DAY.month, FULL_MOON_DAY.day, 8, 0, SITE.tz)
  const night = (await nightsAt(now, FULL_MOON_DAY))[0]
  const dark = night.hours.filter((h) => h.isDark)

  const fabricated =
    dark.reduce(
      (sum, h) =>
        sum +
        scoreHour({
          cloud: h.cloud,
          moonIllum: 0.3,
          moonAlt: 30,
          humidity: h.humidity,
          temp: h.temp,
          dewpoint: h.dewpoint,
          windspeed: h.windspeed,
        }).score,
      0
    ) / dark.length

  assert.ok(fabricated >= 65, `fabricated-moon score was ${fabricated}`)
  assert.ok(
    fabricated - night.nightAvg.score > 30,
    `real moon ${night.nightAvg.score.toFixed(1)} vs fabricated ${fabricated.toFixed(1)}`
  )
})

test('a new-moon night with the same clear skies still notifies', async () => {
  // 2026-09-11 is close to new moon — the control for the test above.
  const start = { year: 2026, month: 9, day: 11 }
  const now = zonedToUtc(start.year, start.month, start.day, 8, 0, SITE.tz)
  const nights = await nightsAt(now, start)

  const good = findGoodNight(nights, now, SITE.tz)
  assert.ok(good, 'clear skies under a dark moon must still notify')
  assert.equal(good.date, '2026-09-11')
  assert.equal(good.label, 'Tonight')
  assert.ok(good.moon < 10, `moon should be reported as near-new, got ${good.moon}%`)
})

test('the night is labelled with the correct local date, not one day late', async () => {
  const start = { year: 2026, month: 9, day: 11 }
  // 22:00 UTC on the 10th is 08:00 Brisbane on the 11th — the exact cron firing that
  // used to make dayOffset=0 match zero hours and shift every label a day late.
  const now = new Date('2026-09-10T22:00:00Z')
  assert.equal(zonedParts(now, SITE.tz).day, 11, 'cron fires on the 11th Brisbane time')

  const nights = await nightsAt(now, start)
  const good = findGoodNight(nights, now, SITE.tz)

  assert.ok(good)
  assert.equal(good.date, '2026-09-11', 'the night reported is the one starting this evening')
  assert.equal(good.label, 'Tonight')
  assert.match(good.dateLabel, /Fri.*11.*Sep/)
})

test('a night is one continuous dark period spanning midnight', async () => {
  const now = zonedToUtc(FULL_MOON_DAY.year, FULL_MOON_DAY.month, FULL_MOON_DAY.day, 8, 0, SITE.tz)
  const night = (await nightsAt(now, FULL_MOON_DAY))[0]
  const dark = night.hours.filter((h) => h.isDark)

  assert.ok(dark.length > 0)
  assert.ok(night.astroStart < night.astroEnd, 'dark window runs forwards')

  // Contiguous: every dark hour is one hour after the previous one.
  for (let i = 1; i < dark.length; i++) {
    assert.equal(dark[i].time - dark[i - 1].time, 3600 * 1000, 'dark hours must be contiguous')
  }

  // It crosses local midnight: evening hours belong to the 28th, morning to the 29th.
  const days = new Set(dark.map((h) => zonedParts(h.time, SITE.tz).day))
  assert.deepEqual([...days].sort(), [28, 29], 'a night spans the date boundary')

  // The old filter ran over the whole hourly series, not a 17:00-07:00 window:
  // `h >= 20 || h <= 5` *within one calendar date* selects 00:00-05:00 and
  // 20:00-23:00 of the same date — the pre-dawn tail of the previous night spliced
  // onto the evening of the next.
  const legacy = []
  for (let h = 0; h < 24; h++) {
    if (h >= 20 || h <= 5) legacy.push(h)
  }
  assert.deepEqual(legacy, [0, 1, 2, 3, 4, 5, 20, 21, 22, 23])
  const legacyContiguous = legacy.every((h, i) => i === 0 || h === legacy[i - 1] + 1)
  assert.ok(!legacyContiguous, 'the legacy window really was a non-contiguous splice')

  // And the two halves sit on opposite sides of the actual night: 05:00 on the 28th
  // is nine hours *before* 20:00 on the 28th, with a full day in between.
  const darkHoursOfDay = dark.map((h) => zonedParts(h.time, SITE.tz).hour)
  assert.ok(darkHoursOfDay.every((h) => h >= 19 || h <= 6), `unexpected dark hours ${darkHoursOfDay}`)
})

test('the cron firing time no longer leaves the first night empty', async () => {
  // dayOffset=0 used to resolve to the UTC date, which at 22:00 UTC is the previous
  // Brisbane day and matched no forecast hours at all.
  const now = CRON_FIRES_AT
  assert.equal(zonedParts(now, SITE.tz).day, 29, 'cron fires on the 29th Brisbane time')

  const nights = await nightsAt(now, { year: 2026, month: 8, day: 29 })
  assert.equal(nights[0].date, '2026-08-29')
  assert.ok(nights[0].hours.filter((h) => h.isDark).length > 0, 'first night must have dark hours')
})
