import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildForecast } from '../src/forecast.js'
import {
  bestWindowSegments, defaultNightIndex, formatDashboardHour, nextDashboardBoundary, skyReading,
} from '../src/dashboardForecast.js'
import { cloudAppearance, paintHeroClouds } from '../src/heroSky.js'
import { buildFixture, okResponse } from './helpers/openMeteoFixture.mjs'

const BRISBANE = 'Australia/Brisbane'
const instant = (value) => new Date(value)

test('cold midnight load adds an opt-in display night from the same three fetches', async () => {
  const body = buildFixture({ timeZone: BRISBANE, startYmd: { year: 2026, month: 8, day: 19 } })
  let calls = 0
  const fetchImpl = async () => {
    calls++
    return okResponse(body)
  }
  const now = instant('2026-08-18T14:30:00Z') // 00:30 Brisbane on 19 August.
  const baseline = await buildForecast(-27.47, 153.03, BRISBANE, { now, fetchImpl })
  const { inProgressNight, ...regular } = await buildForecast(-27.47, 153.03, BRISBANE, {
    now, fetchImpl, includeInProgressNight: true,
  })
  assert.equal(calls, 6)
  assert.deepEqual(regular, baseline)
  assert.equal(baseline.nights[0].date, '2026-08-19')
  const { night, wholeNightSummaryAvailable } = inProgressNight
  assert.equal(night.date, '2026-08-18')
  assert.equal(wholeNightSummaryAvailable, false)
  assert.equal(night.hours[0].cloud, null)
  assert.deepEqual(skyReading(night, now, BRISBANE), {
    hour: instant('2026-08-18T14:00:00Z'), cloud: 0,
  })
  assert.equal(defaultNightIndex([night, ...baseline.nights], now, BRISBANE), 0)
})

test('current, future and unavailable sky readings remain separate as the hour rolls over', () => {
  const night = {
    date: '2026-08-18',
    displayStart: instant('2026-08-18T07:00:00Z'),
    displayEnd: instant('2026-08-18T21:00:00Z'),
    hours: [
      { time: instant('2026-08-18T13:00:00Z'), cloud: 8 },
      { time: instant('2026-08-18T14:00:00Z'), cloud: 25 },
      { time: instant('2026-08-18T16:00:00Z'), cloud: null },
    ],
    nightAvg: { cloud: 28 },
  }
  const future = {
    date: '2026-08-19', displayStart: instant('2026-08-19T07:00:00Z'),
    displayEnd: instant('2026-08-19T21:00:00Z'), hours: [], nightAvg: { cloud: 75 },
  }
  const beforeMidnight = instant('2026-08-18T13:59:59Z')
  assert.equal(skyReading(night, beforeMidnight, BRISBANE).cloud, 8)
  assert.equal(skyReading(future, beforeMidnight, BRISBANE).cloud, 75)
  assert.equal(nextDashboardBoundary([night, future], beforeMidnight, BRISBANE), +night.hours[1].time)
  const midnight = instant('2026-08-18T14:00:00Z')
  assert.equal(skyReading(night, midnight, BRISBANE).cloud, 25)
  assert.equal(skyReading(future, midnight, BRISBANE, night.date).cloud, 75)
  assert.deepEqual(skyReading(night, instant('2026-08-18T15:00:00Z'), BRISBANE), { cloud: null, hour: null })
  assert.equal(skyReading(night, instant('2026-08-18T16:15:00Z'), BRISBANE).cloud, null)
  const dawn = instant('2026-08-18T21:00:00Z')
  assert.equal(skyReading(night, dawn, BRISBANE).cloud, null)
  assert.equal(skyReading(future, dawn, BRISBANE).cloud, null)
  assert.equal(defaultNightIndex([night, future], dawn, BRISBANE), 1)
})

test('Sydney daylight-saving repeat selects each 02:00 by its own instant', () => {
  const timeZone = 'Australia/Sydney'
  const first = instant('2026-04-04T15:00:00Z')
  const second = instant('2026-04-04T16:00:00Z')
  const night = {
    date: '2026-04-04', displayStart: instant('2026-04-04T06:00:00Z'),
    displayEnd: instant('2026-04-04T20:00:00Z'), nightAvg: { cloud: 33 },
    hours: [{ time: first, cloud: 8 }, { time: second, cloud: 75 }],
  }
  assert.equal(skyReading(night, instant('2026-04-04T15:50:00Z'), timeZone).cloud, 8)
  assert.equal(skyReading(night, instant('2026-04-04T16:10:00Z'), timeZone).cloud, 75)
  const earlyLabel = formatDashboardHour(night, first, timeZone)
  const lateLabel = formatDashboardHour(night, second, timeZone)
  assert.match(earlyLabel, /^02:00 /)
  assert.match(lateLabel, /^02:00 /)
  assert.notEqual(earlyLabel, lateLabel)
})

test('the window highlights only actual scored intervals, keeping missing hours empty', () => {
  const start = instant('2026-08-18T10:00:00Z')
  const gap = instant('2026-08-18T11:00:00Z')
  const end = instant('2026-08-18T12:00:00Z')
  const night = {
    displayStart: start, displayEnd: instant('2026-08-18T14:00:00Z'),
    optimalWindow: { startHour: start, endHour: end },
    hours: [{ time: start, score: 88 }, { time: gap, score: null }, { time: end, score: 85 }],
  }
  assert.deepEqual(bestWindowSegments(night), [{ left: 0, width: 25 }, { left: 50, width: 25 }])
  assert.deepEqual(bestWindowSegments({ ...night, wholeNightSummaryAvailable: false }), [])
})

test('the reactive sky paints zero cloud through 5%, grows smoothly, and clears for unavailable data', () => {
  const width = 96, height = 96
  let alpha = 0
  let paints = 0
  const canvas = {
    width, height,
    getContext: () => ({
      clearRect() { alpha = 0 },
      createImageData: () => ({ data: new Uint8ClampedArray(width * height * 4) }),
      putImageData({ data }) {
        paints++
        alpha = 0
        for (let i = 3; i < data.length; i += 4) alpha += data[i]
      },
    }),
  }
  assert.equal(cloudAppearance(null).kind, 'unavailable')
  for (let value = 0; value <= 5; value++) {
    assert.equal(cloudAppearance(value).kind, 'clear')
    assert.equal(paintHeroClouds(canvas, value), true)
    assert.equal(alpha, 0)
  }
  assert.equal(paints, 0)
  assert.ok(cloudAppearance(5.01).opacity > 0)
  let previous = 0
  for (const value of [6, 8, 10, 20, 30, 50, 70, 85, 100]) {
    assert.equal(paintHeroClouds(canvas, value), true)
    assert.ok(alpha > previous)
    previous = alpha
  }
  assert.equal(alpha, width * height * 255)
  paintHeroClouds(canvas, 100)
  assert.equal(paints, 9, 'same forecast cloud should not repaint')
  paintHeroClouds(canvas, null)
  assert.equal(alpha, 0)
})
