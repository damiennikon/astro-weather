// src/scoring.js  — shared between the browser worker and the CF scheduler

// Every component is a monotone piecewise-linear curve through the anchor points the
// original step functions used, so the calibration is preserved but a 0.1% change in
// an input can no longer move the score by a whole verdict band.
//
// `anchors` are [input, score] pairs in ascending input order; values outside the
// range clamp to the nearest end.
function interpolate(anchors, x) {
  if (x <= anchors[0][0]) return anchors[0][1]
  const last = anchors[anchors.length - 1]
  if (x >= last[0]) return last[1]
  for (let i = 1; i < anchors.length; i++) {
    const [x0, y0] = anchors[i - 1]
    const [x1, y1] = anchors[i]
    if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0)
  }
  return last[1]
}

// --- Component curves ----------------------------------------------------

const CLOUD_SCORE = [
  [0, 100],
  [5, 100],
  [15, 85],
  [30, 60],
  [50, 30],
  [70, 8],
  [100, 0],
]

const MOON_ILLUM_SCORE = [
  [0, 100],
  [10, 100],
  [25, 80],
  [50, 55],
  [80, 25],
  [100, 0],
]

// How much of the moon's penalty actually applies at a given altitude. Moonlight
// does not switch off the instant the moon crosses the horizon — it fades in over
// the first few degrees and saturates once the moon is well up. This replaces the
// old 0-10° "low horizon buffer", which sat *after* the bright-moon veto returned
// and so was dead code in exactly the case it was written for.
const MOON_ALT_FACTOR = [
  [-6, 0],
  [0, 0.35],
  [10, 0.7],
  [30, 1],
  [90, 1],
]

const HUMIDITY_SCORE = [
  [0, 100],
  [50, 100],
  [65, 75],
  [75, 50],
  [85, 25],
  [100, 10],
]

const DEW_SPREAD_SCORE = [
  [0, 10],
  [1, 20],
  [3, 40],
  [5, 70],
  [8, 100],
]

const WIND_SCORE = [
  [0, 100],
  [10, 100],
  [20, 75],
  [30, 40],
  [35, 20],
  [50, 10],
  [120, 0],
]

// --- Veto ceilings -------------------------------------------------------
//
// A veto may only ever LOWER the score (applied with Math.min), never set it. The
// old code `return`ed a fixed number, which clamped from below as well as above and
// produced a genuine ordering inversion: a clear sky under a full moon scored 24
// while the same night with 60% cloud scored 35, so *adding cloud improved the
// rating by a whole band*.
//
// Each ceiling is also a ramp rather than a step. A cap that switches on at a fixed
// value is by definition a discontinuity, so these start inert (100) at the
// threshold and tighten as conditions worsen. That costs some bite just past the
// threshold — 55% cloud is no longer slammed to 35 — which is the honest trade: the
// forecast's own cloud uncertainty is far wider than the step it used to fall off.

const CLOUD_CAP = [
  [50, 100],
  [70, 35],
  [100, 20],
]

const MOON_CAP = [
  [0.8, 100],
  [0.95, 30],
  [1.0, 24],
]

export function scoreHour({ cloud, moonIllum, moonAlt, humidity, temp, dewpoint, windspeed }) {
  // A null score, not 0. Scoring missing data as zero turns "we don't know" into a
  // confident "very poor", and averaging those zeros into a night drags the whole
  // night down. Callers must exclude null scores rather than treat them as bad.
  if (cloud === null || cloud === undefined) return { score: null, verdict: 'unavailable' }

  // Cloud (35%)
  const cloudScore = interpolate(CLOUD_SCORE, cloud)

  // Moon (30%) — illumination penalty scaled by how high the moon actually is.
  const altFactor = interpolate(MOON_ALT_FACTOR, moonAlt ?? -90)
  const illumScore = interpolate(MOON_ILLUM_SCORE, (moonIllum ?? 0) * 100)
  const moonScore = 100 - (100 - illumScore) * altFactor

  // Humidity / dew / wind are null-guarded: JS relational coercion would otherwise
  // score a missing metric as perfect (null < 50 is true). A null component is
  // excluded and the remaining weights renormalised — same principle as the model
  // blend, which redistributes weight across whichever models actually have data.

  // Humidity (15%)
  const humidScore = humidity !== null && humidity !== undefined ? interpolate(HUMIDITY_SCORE, humidity) : null

  // Dew spread (10%)
  const dewScore =
    temp !== null && temp !== undefined && dewpoint !== null && dewpoint !== undefined
      ? interpolate(DEW_SPREAD_SCORE, temp - dewpoint)
      : null

  // Wind (10%)
  const windScore = windspeed !== null && windspeed !== undefined ? interpolate(WIND_SCORE, windspeed) : null

  // Integer weight units so the all-present case divides by exactly 100.
  const parts = [
    [cloudScore, 35],
    [moonScore, 30],
    [humidScore, 15],
    [dewScore, 10],
    [windScore, 10],
  ].filter(([value]) => value !== null)
  const totalWeight = parts.reduce((sum, [, weight]) => sum + weight, 0)
  const weighted = parts.reduce((sum, [value, weight]) => sum + value * weight, 0) / totalWeight

  // Ceilings. Both are monotone non-increasing in their input, and the moon ceiling
  // relaxes to inert as the moon sets, so min() of them is monotone too: more cloud,
  // a brighter moon, or a higher moon can never raise the score.
  const cloudCap = interpolate(CLOUD_CAP, cloud)
  const moonCap = 100 - (100 - interpolate(MOON_CAP, moonIllum ?? 0)) * altFactor

  const capped = Math.min(weighted, cloudCap, moonCap)
  const score = Math.round(capped)

  // Which ceiling, if any, is actually binding — reported so the UI can explain a
  // score that sits below its own component breakdown.
  let vetoed = null
  if (capped < weighted - 0.5) vetoed = cloudCap <= moonCap ? 'cloud' : 'moon'

  let verdict
  if (score >= 85) verdict = 'great'
  else if (score >= 65) verdict = 'good'
  else if (score >= 45) verdict = 'fair'
  else if (score >= 25) verdict = 'poor'
  else verdict = 'verypoor'

  return {
    score,
    verdict,
    cloudScore,
    moonScore,
    humidScore,
    dewScore,
    windScore,
    vetoed,
    uncappedScore: Math.round(weighted),
    cap: Math.round(Math.min(cloudCap, moonCap)),
  }
}

export function findOptimalWindow(hours) {
  const scoredHours = hours.filter((h) => h.score !== null && h.score !== undefined)
  for (const blockSize of [3, 2, 1]) {
    let best = null
    for (let i = 0; i <= scoredHours.length - blockSize; i++) {
      const block = scoredHours.slice(i, i + blockSize)
      const avg = block.reduce((s, h) => s + h.score, 0) / blockSize
      if (!best || avg > best.avg) {
        best = { startHour: block[0].time, endHour: block[block.length - 1].time, avg, blockSize }
      }
    }
    if (best) return best
  }
  return null
}
