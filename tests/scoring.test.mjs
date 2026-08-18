// Fix 4 — veto caps must only ever lower a score, and no input may move the score
// discontinuously.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreHour } from '../src/scoring.js'

const IDEAL = { humidity: 40, temp: 10, dewpoint: 0, windspeed: 5 }
const NO_MOON = { moonIllum: 0, moonAlt: -20 }
const score = (o) => scoreHour({ ...IDEAL, ...NO_MOON, ...o }).score

// Largest score change produced by a small step in one input across a range.
function maxJump(range, step, toInput) {
  let worst = { jump: 0 }
  for (let x = range[0]; x < range[1]; x += step) {
    const a = score(toInput(x))
    const b = score(toInput(x + step))
    const jump = Math.abs(b - a)
    if (jump > worst.jump) worst = { jump, from: x, to: x + step, a, b }
  }
  return worst
}

test('cloud 50.0 -> 50.1 no longer swings a whole verdict band', () => {
  const before = score({ cloud: 50.0 })
  const after = score({ cloud: 50.1 })
  assert.ok(Math.abs(after - before) <= 1, `50.0 -> ${before}, 50.1 -> ${after}`)
})

test('moon illum 0.80 -> 0.81 no longer swings a whole verdict band', () => {
  const before = score({ cloud: 0, moonIllum: 0.8, moonAlt: 45 })
  const after = score({ cloud: 0, moonIllum: 0.81, moonAlt: 45 })
  assert.ok(Math.abs(after - before) <= 1, `0.80 -> ${before}, 0.81 -> ${after}`)
})

test('moon crossing the horizon is continuous', () => {
  // Was a 76-point cliff: alt -0.5 scored 100 and alt +0.5 scored 24, because the
  // bright-moon veto keyed off `moonAlt > 0`. Now moonlight fades in across the
  // first few degrees at roughly 4-5 points per degree.
  const below = score({ cloud: 0, moonIllum: 1.0, moonAlt: -0.5 })
  const above = score({ cloud: 0, moonIllum: 1.0, moonAlt: 0.5 })
  assert.ok(below > above, 'a moon below the horizon must score better than one above')
  assert.ok(Math.abs(above - below) <= 5, `alt -0.5 -> ${below}, +0.5 -> ${above}`)
})

test('adding cloud never raises the score (the full-moon inversion)', () => {
  const moon = { moonIllum: 1.0, moonAlt: 45 }
  const clear = score({ cloud: 0, ...moon })
  const cloudy = score({ cloud: 60, ...moon })
  const overcast = score({ cloud: 95, ...moon })
  assert.ok(cloudy <= clear, `clear ${clear} must not be beaten by 60% cloud ${cloudy}`)
  assert.ok(overcast <= cloudy, `60% ${cloudy} must not be beaten by 95% ${overcast}`)
})

test('score is monotone non-increasing in cloud, at every moon state', () => {
  for (const moon of [NO_MOON, { moonIllum: 0.5, moonAlt: 20 }, { moonIllum: 1.0, moonAlt: 45 }]) {
    let prev = Infinity
    for (let cloud = 0; cloud <= 100; cloud += 0.5) {
      const s = score({ cloud, ...moon })
      assert.ok(s <= prev, `cloud ${cloud} scored ${s} above the previous ${prev} (moon ${JSON.stringify(moon)})`)
      prev = s
    }
  }
})

test('score is monotone non-increasing in moon illumination and altitude', () => {
  let prev = Infinity
  for (let illum = 0; illum <= 1; illum += 0.01) {
    const s = score({ cloud: 10, moonIllum: illum, moonAlt: 40 })
    assert.ok(s <= prev, `illum ${illum} scored ${s} above ${prev}`)
    prev = s
  }
  prev = Infinity
  for (let alt = -20; alt <= 90; alt += 1) {
    const s = score({ cloud: 10, moonIllum: 0.9, moonAlt: alt })
    assert.ok(s <= prev, `alt ${alt} scored ${s} above ${prev}`)
    prev = s
  }
})

test('no input produces a discontinuous jump', () => {
  const cloud = maxJump([0, 100], 0.1, (x) => ({ cloud: x }))
  const illum = maxJump([0, 1], 0.001, (x) => ({ cloud: 10, moonIllum: x, moonAlt: 45 }))
  const alt = maxJump([-20, 90], 0.1, (x) => ({ cloud: 10, moonIllum: 0.9, moonAlt: x }))
  for (const [name, w] of [['cloud', cloud], ['illum', illum], ['alt', alt]]) {
    assert.ok(w.jump <= 1, `${name}: ${w.from} -> ${w.to} jumped ${w.a} -> ${w.b}`)
  }
})

test('caps only ever lower the weighted score', () => {
  for (const cloud of [0, 25, 49, 51, 60, 71, 90, 100]) {
    for (const illum of [0, 0.5, 0.79, 0.81, 1]) {
      for (const alt of [-10, 0, 5, 45]) {
        const r = scoreHour({ ...IDEAL, cloud, moonIllum: illum, moonAlt: alt })
        assert.ok(r.score <= r.uncappedScore + 0.5, `cap raised the score at ${cloud}/${illum}/${alt}`)
      }
    }
  }
})

test('missing metrics still renormalise, and missing cloud is null not zero', () => {
  assert.equal(scoreHour({ cloud: null, ...NO_MOON, ...IDEAL }).score, null)
  const partial = scoreHour({ cloud: 0, ...NO_MOON, humidity: null, temp: null, dewpoint: null, windspeed: null })
  assert.equal(partial.score, 100, 'cloud+moon alone should renormalise to 100 under perfect conditions')
  assert.equal(partial.humidScore, null)
})
