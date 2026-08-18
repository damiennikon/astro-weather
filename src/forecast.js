// Forecast pipeline — pure and runtime-agnostic so the browser worker, the
// scheduled push worker, and the tests all build nights the same way.

import * as Astronomy from 'astronomy-engine'
import { scoreHour, findOptimalWindow } from './scoring.js'
import { safeTimeZone, zonedParts, zonedToUtc, addDays, formatYmd } from './timezone.js'

const SURFACE_VARS =
  'cloudcover_low,cloudcover_mid,cloudcover_high,temperature_2m,relativehumidity_2m,dewpoint_2m,windspeed_10m'
const UPPER_VARS = 'windspeed_250hPa'
// NOTE: plan specifies 'ecmwf_ifs04', but Open-Meteo has deprecated that id —
// it now silently returns all-null values. 'ecmwf_ifs025' is the current equivalent.
export const MODELS = { ecmwf: 'ecmwf_ifs025', ukmo: 'ukmo_seamless', icon: 'icon_global' }

// Nominal blend weights. Exported so callers can report how much of the ensemble
// actually made it into a given forecast.
export const MODEL_WEIGHTS = { ecmwf: 0.5, ukmo: 0.3, icon: 0.2 }

const UPPER_AIR_MODELS = new Set(['ecmwf', 'icon']) // UKMO seamless has no 250hPa winds

// NOTE: UKMO's real forecast horizon is ~7.5 days and ICON's ~8 days regardless of
// forecast_days requested, and that boundary shifts by the hour as "now" advances —
// a fixed night count drifts stale. MAX_NIGHTS is just a generous candidate cap;
// buildForecast() trims the actual returned nights to whichever ones fall fully
// inside every model's real (non-null) data coverage — see findCoverageEnd().
const MAX_NIGHTS = 8
const DISPLAY_HOURS = 14 // 17:00 -> 07:00
const GALACTIC_CENTER_RA = 17.76 // hours
const GALACTIC_CENTER_DEC = -29.0 // degrees
const MW_ALT_THRESHOLD = 10 // degrees
const MW_FADE_WINDOW_MS = 45 * 60 * 1000

export class ForecastUnavailableError extends Error {
  constructor(message, failures) {
    super(message)
    this.name = 'ForecastUnavailableError'
    this.code = 'UPSTREAM_UNAVAILABLE'
    this.failures = failures
  }
}

export function buildUrl(lat, lng, timezone, modelId, includeUpper) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lng,
    hourly: includeUpper ? `${SURFACE_VARS},${UPPER_VARS}` : SURFACE_VARS,
    models: modelId,
    // The timezone still anchors which local days forecast_days covers, but every
    // timestamp comes back as a UTC epoch second so nothing downstream has to parse
    // a local-naive string against the wrong clock.
    timezone,
    timeformat: 'unixtime',
    forecast_days: 8,
    wind_speed_unit: 'kmh',
    temperature_unit: 'celsius',
  })
  return `https://api.open-meteo.com/v1/forecast?${params.toString()}`
}

// Open-Meteo answers parameter problems and rate limits with a JSON body rather
// than a transport error, so a bare `await res.json()` yields an object that looks
// like a response but has no `hourly` — which downstream reads as "every value is
// null" and scores out as a confident 0/100. Reject those here instead.
export async function fetchModel(url, fetchImpl = fetch) {
  const res = await fetchImpl(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  if (json?.error) throw new Error(String(json.reason ?? 'upstream error'))
  if (!Array.isArray(json?.hourly?.time) || json.hourly.time.length === 0) {
    throw new Error('response contained no hourly data')
  }
  return json
}

// Fetches all three models independently. One model failing costs the blend that
// model's weight and nothing more; only losing all three is fatal.
export async function fetchModels(lat, lng, timezone, { fetchImpl = fetch, onProgress } = {}) {
  const ids = Object.keys(MODELS)
  onProgress?.('Fetching ECMWF, UKMO & ICON models...')

  const settled = await Promise.allSettled(
    ids.map((id) => fetchModel(buildUrl(lat, lng, timezone, MODELS[id], UPPER_AIR_MODELS.has(id)), fetchImpl))
  )

  const responses = {}
  const failures = []
  ids.forEach((id, i) => {
    const result = settled[i]
    if (result.status === 'fulfilled') {
      responses[id] = result.value
    } else {
      responses[id] = null
      failures.push({ model: id, reason: result.reason?.message ?? String(result.reason) })
    }
  })

  const available = ids.filter((id) => responses[id] !== null)
  if (available.length === 0) {
    throw new ForecastUnavailableError(
      `No forecast model could be reached (${failures.map((f) => `${f.model}: ${f.reason}`).join('; ')})`,
      failures
    )
  }

  return {
    responses,
    available,
    failures,
    // How much of the nominal ensemble weight actually arrived — 1.0 when all three
    // are present, 0.5 when only ECMWF is, and so on.
    weightCoverage: available.reduce((sum, id) => sum + MODEL_WEIGHTS[id], 0),
  }
}

export async function buildForecast(lat, lng, timezone, options = {}) {
  const { onProgress } = options
  const tz = safeTimeZone(timezone)

  const fetched = await fetchModels(lat, lng, tz, options)

  onProgress?.('Calculating astronomy...')
  const observer = new Astronomy.Observer(lat, lng, 0)
  const models = {}
  for (const id of Object.keys(MODELS)) {
    models[id] = { response: fetched.responses[id], index: indexHourly(fetched.responses[id]) }
  }

  onProgress?.('Blending models & scoring...')
  const coverageEnd = minCoverageEnd(fetched.available.map((id) => fetched.responses[id]))

  const today = zonedParts(options.now ?? new Date(), tz)
  const candidates = []
  for (let n = 0; n < MAX_NIGHTS; n++) {
    candidates.push(buildNight(addDays(today, n), tz, observer, models))
  }

  // Only keep nights whose scored (dark-hour) window is fully inside every model's
  // real data coverage — a night with a partially-null dark window would otherwise
  // render with dashes for its later hours.
  const nights = coverageEnd
    ? candidates.filter((night) => night.astroEnd !== null && night.astroEnd <= coverageEnd)
    : candidates
  if (nights.length === 0 && candidates.length > 0) nights.push(candidates[0])

  return {
    nights,
    meta: {
      timezone: tz,
      available: fetched.available,
      missing: fetched.failures.map((f) => f.model),
      failures: fetched.failures,
      weightCoverage: fetched.weightCoverage,
      degraded: fetched.failures.length > 0,
    },
  }
}

// Walks each model's hourly cloud arrays from the start and returns the timestamp of
// the last hour where low/mid/high are all still non-null. Open-Meteo returns nulls
// once a model's real forecast horizon is exceeded, regardless of forecast_days requested.
export function findCoverageEnd(response) {
  const times = response?.hourly?.time ?? []
  const low = response?.hourly?.cloudcover_low ?? []
  const mid = response?.hourly?.cloudcover_mid ?? []
  const high = response?.hourly?.cloudcover_high ?? []
  let lastValidIdx = -1
  for (let i = 0; i < times.length; i++) {
    if (low[i] != null && mid[i] != null && high[i] != null) {
      lastValidIdx = i
    } else {
      break
    }
  }
  return lastValidIdx >= 0 ? new Date(times[lastValidIdx] * 1000) : null
}

// The binding constraint is whichever model runs out of real data soonest.
export function minCoverageEnd(responses) {
  const ends = responses.map(findCoverageEnd).filter((e) => e !== null)
  if (ends.length === 0) return null
  return new Date(Math.min(...ends.map((e) => e.getTime())))
}

// Keyed on the UTC epoch second, so a lookup can never resolve to the wrong hour
// because the viewer happens to sit in a different timezone from the site.
export function indexHourly(response) {
  const map = new Map()
  const times = response?.hourly?.time ?? []
  times.forEach((t, i) => map.set(t, i))
  return map
}

export function hourKey(date) {
  return Math.floor(date.getTime() / 1000)
}

function readHourly(model, key, field) {
  const i = model.index.get(key)
  if (i === undefined) return null
  const v = model.response?.hourly?.[field]?.[i]
  return v === undefined || v === null ? null : v
}

export function blendCloud(ecmwf, ukmo, icon) {
  const values = [ecmwf, ukmo, icon].filter((v) => v !== null && v !== undefined)
  if (values.length === 0) return null

  let weighted = 0
  let totalWeight = 0
  if (ecmwf != null) {
    weighted += ecmwf * MODEL_WEIGHTS.ecmwf
    totalWeight += MODEL_WEIGHTS.ecmwf
  }
  if (ukmo != null) {
    weighted += ukmo * MODEL_WEIGHTS.ukmo
    totalWeight += MODEL_WEIGHTS.ukmo
  }
  if (icon != null) {
    weighted += icon * MODEL_WEIGHTS.icon
    totalWeight += MODEL_WEIGHTS.icon
  }
  const avg = weighted / totalWeight

  const spread = Math.max(...values) - Math.min(...values)
  if (spread > 30) {
    return Math.min(...values) + 0.7 * spread // Skew pessimistic
  }
  return avg
}

// Cloud layers are treated as independent overlapping planes: combined coverage is
// the probability that at least one layer obscures the sky, not a plain sum. A naive
// additive sum double-counts the sky area where layers overlap (e.g. low=60% +
// mid=50% would wrongly claim 100%+ cover when the true combined obscuration is 80%).
export function combineCloudLayers(low, mid, high) {
  if (low === null && mid === null && high === null) return null
  const clearSky = (1 - (low ?? 0) / 100) * (1 - (mid ?? 0) / 100) * (1 - (high ?? 0) / 100)
  return 100 * (1 - clearSky)
}

function average(values) {
  const valid = values.filter((v) => v !== null && v !== undefined)
  if (valid.length === 0) return null
  return valid.reduce((s, v) => s + v, 0) / valid.length
}

// `ymd` is a civil date in the site's timezone, so the night rolls over at the
// site's midnight rather than the viewer's.
export function buildNight(ymd, timeZone, observer, models) {
  const displayStart = zonedToUtc(ymd.year, ymd.month, ymd.day, 17, 0, timeZone)
  const displayEnd = new Date(displayStart.getTime() + DISPLAY_HOURS * 3600 * 1000)
  const noon = zonedToUtc(ymd.year, ymd.month, ymd.day, 12, 0, timeZone)
  const midnight = zonedToUtc(ymd.year, ymd.month, ymd.day + 1, 0, 0, timeZone)

  // SearchAltitude direction: +1 = ascending through altitude, -1 = descending.
  // Dusk is the sun descending below -18°; dawn is it ascending back above -18°.
  const astroStartTime = Astronomy.SearchAltitude(Astronomy.Body.Sun, observer, -1, noon, 1, -18)
  const astroEndTime = astroStartTime
    ? Astronomy.SearchAltitude(Astronomy.Body.Sun, observer, +1, astroStartTime, 1, -18)
    : null

  const astroStart = astroStartTime ? astroStartTime.date : null
  const astroEnd = astroEndTime ? astroEndTime.date : null

  const moonriseTime = Astronomy.SearchRiseSet(Astronomy.Body.Moon, observer, +1, displayStart, 1)
  const moonsetTime = Astronomy.SearchRiseSet(Astronomy.Body.Moon, observer, -1, displayStart, 1)
  const moonIllumNight = Astronomy.Illumination(Astronomy.Body.Moon, midnight).phase_fraction

  const hours = []
  for (let h = 0; h < DISPLAY_HOURS; h++) {
    const time = new Date(displayStart.getTime() + h * 3600 * 1000)
    const isDark = astroStart !== null && astroEnd !== null && time >= astroStart && time <= astroEnd
    hours.push(buildHour(time, isDark, astroEnd, observer, models))
  }

  const darkHours = hours.filter((h) => h.isDark)
  // Hours with no usable model data score `null`, not 0 — averaging a 0 in would
  // turn missing data into a confident "very poor" verdict.
  const scoredHours = darkHours.filter((h) => h.score !== null)
  const optimalWindow = findOptimalWindow(scoredHours.map((h) => ({ time: h.time, score: h.score })))
  const nightAvg = {
    score: average(scoredHours.map((h) => h.score)),
    cloud: average(darkHours.map((h) => h.cloud)),
    humidity: average(darkHours.map((h) => h.humidity)),
    windspeed: average(darkHours.map((h) => h.windspeed)),
    moonIllum: average(darkHours.map((h) => h.moonIllum)),
  }

  const { mwRise, mwSet } = findMilkyWayTransitions(hours)

  return {
    date: formatYmd(ymd),
    displayStart,
    displayEnd,
    astroStart,
    astroEnd,
    moonrise: moonriseTime ? moonriseTime.date : null,
    moonset: moonsetTime ? moonsetTime.date : null,
    moonIllum: moonIllumNight,
    mwRise,
    mwSet,
    hours,
    optimalWindow,
    nightAvg,
    darkHourCount: darkHours.length,
    scoredHourCount: scoredHours.length,
    dataStatus: scoredHours.length === 0 ? 'unavailable' : scoredHours.length < darkHours.length ? 'partial' : 'ok',
  }
}

function buildHour(time, isDark, astroEnd, observer, models) {
  const key = hourKey(time)
  const layer = (id, field) => readHourly(models[id], key, field)

  const cloudLow = blendCloud(layer('ecmwf', 'cloudcover_low'), layer('ukmo', 'cloudcover_low'), layer('icon', 'cloudcover_low'))
  const cloudMid = blendCloud(layer('ecmwf', 'cloudcover_mid'), layer('ukmo', 'cloudcover_mid'), layer('icon', 'cloudcover_mid'))
  const cloudHigh = blendCloud(layer('ecmwf', 'cloudcover_high'), layer('ukmo', 'cloudcover_high'), layer('icon', 'cloudcover_high'))
  const cloud = combineCloudLayers(cloudLow, cloudMid, cloudHigh)

  const cloudEcmwf = combineCloudLayers(layer('ecmwf', 'cloudcover_low'), layer('ecmwf', 'cloudcover_mid'), layer('ecmwf', 'cloudcover_high'))
  const cloudUkmo = combineCloudLayers(layer('ukmo', 'cloudcover_low'), layer('ukmo', 'cloudcover_mid'), layer('ukmo', 'cloudcover_high'))
  const cloudIcon = combineCloudLayers(layer('icon', 'cloudcover_low'), layer('icon', 'cloudcover_mid'), layer('icon', 'cloudcover_high'))

  // Agreement needs at least two opinions to mean anything. With one model left the
  // honest answer is "unknown", not "agree".
  const perModel = [cloudEcmwf, cloudUkmo, cloudIcon].filter((v) => v !== null)
  let agreement = null
  if (isDark && perModel.length >= 2) {
    const spread = Math.max(...perModel) - Math.min(...perModel)
    agreement = spread <= 15 ? 'agree' : spread <= 30 ? 'mixed' : 'disagree'
  } else if (isDark && perModel.length === 1) {
    agreement = 'single'
  }

  const surface = (field) => average([layer('ecmwf', field), layer('ukmo', field), layer('icon', field)])
  const temp = surface('temperature_2m')
  const humidity = surface('relativehumidity_2m')
  const dewpoint = surface('dewpoint_2m')
  const windspeed = surface('windspeed_10m')

  // Jet stream — informational display only, not part of scoring (UKMO doesn't provide it)
  const jetstream = average([layer('ecmwf', 'windspeed_250hPa'), layer('icon', 'windspeed_250hPa')])

  const moonEq = Astronomy.Equator(Astronomy.Body.Moon, time, observer, true, true)
  const moonAlt = Astronomy.Horizon(time, observer, moonEq.ra, moonEq.dec, 'normal').altitude
  const moonIllum = Astronomy.Illumination(Astronomy.Body.Moon, time).phase_fraction

  const mwAlt = Astronomy.Horizon(time, observer, GALACTIC_CENTER_RA, GALACTIC_CENTER_DEC, 'normal').altitude
  const mwVisible = mwAlt > MW_ALT_THRESHOLD
  const mwFading = mwVisible && astroEnd !== null && Math.abs(time.getTime() - astroEnd.getTime()) <= MW_FADE_WINDOW_MS

  let score = null
  let verdict = 'daylight'
  let vetoed = null
  let components = null

  if (isDark) {
    const result = scoreHour({ cloud, moonIllum, moonAlt, humidity, temp, dewpoint, windspeed })
    score = result.score
    verdict = result.verdict
    vetoed = result.vetoed ?? null
    components =
      result.cloudScore !== undefined
        ? {
            cloudScore: result.cloudScore,
            moonScore: result.moonScore,
            humidScore: result.humidScore,
            dewScore: result.dewScore,
            windScore: result.windScore,
          }
        : null
  }

  return {
    time,
    isDark,
    cloud,
    cloudLow,
    cloudMid,
    cloudHigh,
    cloudEcmwf,
    cloudUkmo,
    cloudIcon,
    humidity,
    temp,
    dewpoint,
    windspeed,
    jetstream,
    moonAlt,
    moonIllum,
    mwVisible,
    mwFading,
    agreement,
    score,
    verdict,
    vetoed,
    components,
  }
}

function findMilkyWayTransitions(hours) {
  let mwRise = null
  let mwSet = null
  for (let i = 0; i < hours.length; i++) {
    const prevVisible = i > 0 ? hours[i - 1].mwVisible : false
    if (hours[i].mwVisible && !prevVisible) mwRise = hours[i].time
    if (!hours[i].mwVisible && prevVisible && mwSet === null) mwSet = hours[i].time
  }
  return { mwRise, mwSet }
}
