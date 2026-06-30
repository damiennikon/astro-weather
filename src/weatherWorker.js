import * as Astronomy from 'astronomy-engine'
import { scoreHour, findOptimalWindow } from './scoring.js'

const SURFACE_VARS =
  'cloudcover_low,cloudcover_mid,cloudcover_high,temperature_2m,relativehumidity_2m,dewpoint_2m,windspeed_10m'
const UPPER_VARS = 'windspeed_250hPa'
// NOTE: plan specifies 'ecmwf_ifs04', but Open-Meteo has deprecated that id —
// it now silently returns all-null values. 'ecmwf_ifs025' is the current equivalent.
const MODELS = { ecmwf: 'ecmwf_ifs025', icon: 'icon_global', ukmo: 'ukmo_seamless' }

const NIGHTS = 8
const DISPLAY_HOURS = 14 // 17:00 -> 07:00
const GALACTIC_CENTER_RA = 17.76 // hours
const GALACTIC_CENTER_DEC = -29.0 // degrees
const MW_ALT_THRESHOLD = 10 // degrees
const MW_FADE_WINDOW_MS = 45 * 60 * 1000

self.onmessage = async (event) => {
  const { type, lat, lng, timezone } = event.data
  if (type !== 'FETCH_FORECAST') return

  try {
    const nights = await buildForecast(lat, lng, timezone)
    self.postMessage({ type: 'FORECAST_READY', nights })
  } catch (err) {
    self.postMessage({ type: 'FORECAST_ERROR', message: err.message })
  }
}

function postProgress(step) {
  self.postMessage({ type: 'PROGRESS', step })
}

function buildUrl(lat, lng, timezone, model, includeUpper) {
  const vars = includeUpper ? `${SURFACE_VARS},${UPPER_VARS}` : SURFACE_VARS
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lng,
    hourly: vars,
    models: model,
    timezone,
    forecast_days: 8,
    wind_speed_unit: 'kmh',
    temperature_unit: 'celsius',
  })
  return `https://api.open-meteo.com/v1/forecast?${params.toString()}`
}

async function buildForecast(lat, lng, timezone) {
  postProgress('Fetching ECMWF model...')
  const ecmwfPromise = fetch(buildUrl(lat, lng, timezone, MODELS.ecmwf, true)).then((r) => r.json())
  postProgress('Fetching ICON model...')
  const iconPromise = fetch(buildUrl(lat, lng, timezone, MODELS.icon, true)).then((r) => r.json())
  postProgress('Fetching UKMO model...')
  const ukmoPromise = fetch(buildUrl(lat, lng, timezone, MODELS.ukmo, false)).then((r) => r.json())

  const [ecmwf, icon, ukmo] = await Promise.all([ecmwfPromise, iconPromise, ukmoPromise])

  postProgress('Calculating astronomy...')
  const observer = new Astronomy.Observer(lat, lng, 0)
  const ecmwfIndex = indexHourly(ecmwf)
  const iconIndex = indexHourly(icon)
  const ukmoIndex = indexHourly(ukmo)

  postProgress('Blending models & scoring...')
  const models = { ecmwf, ecmwfIndex, icon, iconIndex, ukmo, ukmoIndex }

  const nights = []
  for (let n = 0; n < NIGHTS; n++) {
    nights.push(buildNight(n, observer, models))
  }
  return nights
}

function indexHourly(response) {
  const map = new Map()
  const times = response?.hourly?.time ?? []
  times.forEach((t, i) => map.set(t, i))
  return map
}

function meteoKey(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:00`
}

function readHourly(response, index, key, field) {
  const i = index.get(key)
  if (i === undefined) return null
  const v = response?.hourly?.[field]?.[i]
  return v === undefined || v === null ? null : v
}

function blendCloud(ecmwf, ukmo, icon) {
  const models = [ecmwf, ukmo, icon].filter((v) => v !== null && v !== undefined)
  if (models.length === 0) return null

  let weighted = 0
  let totalWeight = 0
  if (ecmwf != null) {
    weighted += ecmwf * 0.5
    totalWeight += 0.5
  }
  if (ukmo != null) {
    weighted += ukmo * 0.3
    totalWeight += 0.3
  }
  if (icon != null) {
    weighted += icon * 0.2
    totalWeight += 0.2
  }
  const avg = weighted / totalWeight

  const spread = Math.max(...models) - Math.min(...models)
  if (spread > 30) {
    return Math.min(...models) + 0.7 * spread // Skew pessimistic
  }
  return avg
}

function sumCloudTotal(low, mid, high) {
  if (low === null && mid === null && high === null) return null
  return Math.min(100, (low ?? 0) + (mid ?? 0) + (high ?? 0))
}

function average(values) {
  const valid = values.filter((v) => v !== null && v !== undefined)
  if (valid.length === 0) return null
  return valid.reduce((s, v) => s + v, 0) / valid.length
}

function formatDate(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function buildNight(dayOffset, observer, models) {
  const eveningDate = new Date()
  eveningDate.setHours(0, 0, 0, 0)
  eveningDate.setDate(eveningDate.getDate() + dayOffset)

  const displayStart = new Date(eveningDate)
  displayStart.setHours(17, 0, 0, 0)
  const displayEnd = new Date(displayStart.getTime() + DISPLAY_HOURS * 3600 * 1000)

  const noon = new Date(eveningDate)
  noon.setHours(12, 0, 0, 0)

  const midnight = new Date(eveningDate)
  midnight.setHours(24, 0, 0, 0) // next day 00:00 — "midnight of that night"

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
  const optimalWindow = findOptimalWindow(darkHours.map((h) => ({ time: h.time, score: h.score })))
  const nightAvg = {
    score: average(darkHours.map((h) => h.score)),
    cloud: average(darkHours.map((h) => h.cloud)),
    humidity: average(darkHours.map((h) => h.humidity)),
    windspeed: average(darkHours.map((h) => h.windspeed)),
    moonIllum: average(darkHours.map((h) => h.moonIllum)),
  }

  const { mwRise, mwSet } = findMilkyWayTransitions(hours)

  return {
    date: formatDate(eveningDate),
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
  }
}

function buildHour(time, isDark, astroEnd, observer, models) {
  const { ecmwf, ecmwfIndex, icon, iconIndex, ukmo, ukmoIndex } = models
  const key = meteoKey(time)

  const ecmwfLow = readHourly(ecmwf, ecmwfIndex, key, 'cloudcover_low')
  const ecmwfMid = readHourly(ecmwf, ecmwfIndex, key, 'cloudcover_mid')
  const ecmwfHigh = readHourly(ecmwf, ecmwfIndex, key, 'cloudcover_high')
  const ukmoLow = readHourly(ukmo, ukmoIndex, key, 'cloudcover_low')
  const ukmoMid = readHourly(ukmo, ukmoIndex, key, 'cloudcover_mid')
  const ukmoHigh = readHourly(ukmo, ukmoIndex, key, 'cloudcover_high')
  const iconLow = readHourly(icon, iconIndex, key, 'cloudcover_low')
  const iconMid = readHourly(icon, iconIndex, key, 'cloudcover_mid')
  const iconHigh = readHourly(icon, iconIndex, key, 'cloudcover_high')

  const cloudLow = blendCloud(ecmwfLow, ukmoLow, iconLow)
  const cloudMid = blendCloud(ecmwfMid, ukmoMid, iconMid)
  const cloudHigh = blendCloud(ecmwfHigh, ukmoHigh, iconHigh)
  const cloud =
    cloudLow === null && cloudMid === null && cloudHigh === null
      ? null
      : Math.min(100, (cloudLow ?? 0) + (cloudMid ?? 0) + (cloudHigh ?? 0))

  const cloudEcmwf = sumCloudTotal(ecmwfLow, ecmwfMid, ecmwfHigh)
  const cloudUkmo = sumCloudTotal(ukmoLow, ukmoMid, ukmoHigh)
  const cloudIcon = sumCloudTotal(iconLow, iconMid, iconHigh)

  let agreement = null
  if (isDark && cloudEcmwf !== null && cloudUkmo !== null && cloudIcon !== null) {
    const maxCloud = Math.max(cloudEcmwf, cloudUkmo, cloudIcon)
    const minCloud = Math.min(cloudEcmwf, cloudUkmo, cloudIcon)
    const spread = maxCloud - minCloud
    agreement = spread <= 15 ? 'agree' : spread <= 30 ? 'mixed' : 'disagree'
  }

  const temp = average([
    readHourly(ecmwf, ecmwfIndex, key, 'temperature_2m'),
    readHourly(ukmo, ukmoIndex, key, 'temperature_2m'),
    readHourly(icon, iconIndex, key, 'temperature_2m'),
  ])
  const humidity = average([
    readHourly(ecmwf, ecmwfIndex, key, 'relativehumidity_2m'),
    readHourly(ukmo, ukmoIndex, key, 'relativehumidity_2m'),
    readHourly(icon, iconIndex, key, 'relativehumidity_2m'),
  ])
  const dewpoint = average([
    readHourly(ecmwf, ecmwfIndex, key, 'dewpoint_2m'),
    readHourly(ukmo, ukmoIndex, key, 'dewpoint_2m'),
    readHourly(icon, iconIndex, key, 'dewpoint_2m'),
  ])
  const windspeed = average([
    readHourly(ecmwf, ecmwfIndex, key, 'windspeed_10m'),
    readHourly(ukmo, ukmoIndex, key, 'windspeed_10m'),
    readHourly(icon, iconIndex, key, 'windspeed_10m'),
  ])

  // Jet stream — informational display only, not part of scoring (UKMO doesn't provide it)
  const jetstream = average([
    readHourly(ecmwf, ecmwfIndex, key, 'windspeed_250hPa'),
    readHourly(icon, iconIndex, key, 'windspeed_250hPa'),
  ])

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
