import { scoreHour } from '../../src/scoring.js'
import webpush from 'web-push'

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduler(env))
  },

  async fetch(request, env) {
    if (new URL(request.url).pathname === '/trigger') {
      await runScheduler(env)
      return new Response('Scheduler ran OK', { status: 200 })
    }
    return new Response('Not Found', { status: 404 })
  }
}

async function runScheduler(env) {
  webpush.setVapidDetails(
    env.VAPID_EMAIL,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  )

  const list = await env.ASTRO_SUBSCRIPTIONS.list({ prefix: 'sub:' })
  const today = new Date().toISOString().slice(0, 10)

  for (const key of list.keys) {
    const raw = await env.ASTRO_SUBSCRIPTIONS.get(key.name)
    if (!raw) continue

    const entry = JSON.parse(raw)

    if (entry.lastNotified === today) continue

    const forecast = await fetchForecast(entry.lat, entry.lng)
    if (!forecast) continue

    const goodNight = findGoodNight(forecast)
    if (!goodNight) continue

    const payload = JSON.stringify({
      title: `🌌 Clear skies ahead — ${entry.locationName}`,
      body:  `${goodNight.label} looks ${goodNight.verdict}! Avg score ${goodNight.score}/100. ` +
             `Cloud ${goodNight.cloud}%, Moon ${goodNight.moon}%.`,
      url:   'https://damiennikon.github.io/astro-weather/'
    })

    try {
      await webpush.sendNotification(entry.subscription, payload)
      entry.lastNotified = today
      await env.ASTRO_SUBSCRIPTIONS.put(key.name, JSON.stringify(entry), {
        expirationTtl: 60 * 60 * 24 * 365
      })
    } catch (err) {
      if (err.statusCode === 410) {
        await env.ASTRO_SUBSCRIPTIONS.delete(key.name)
      }
    }
  }
}

const HOURLY_VARS = 'cloudcover_low,cloudcover_mid,cloudcover_high,temperature_2m,relativehumidity_2m,dewpoint_2m,windspeed_10m'
const MODELS = { ecmwf: 'ecmwf_ifs025', ukmo: 'ukmo_seamless', icon: 'icon_global' }

// One request PER model, matching the browser weatherWorker. A combined
// multi-model request suffixes every hourly field with the model id
// (cloudcover_low_ecmwf_ifs025, ...), so plain field reads come back
// undefined and the scoring runs entirely on fallback values.
export async function fetchForecast(lat, lng) {
  const fetchModel = async (model) => {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
                `&hourly=${HOURLY_VARS}&models=${model}` +
                `&timezone=Australia%2FBrisbane&forecast_days=4&wind_speed_unit=kmh&temperature_unit=celsius`
    try {
      const res = await fetch(url)
      return await res.json()
    } catch {
      return null
    }
  }

  const [ecmwf, ukmo, icon] = await Promise.all([
    fetchModel(MODELS.ecmwf),
    fetchModel(MODELS.ukmo),
    fetchModel(MODELS.icon),
  ])
  if (!ecmwf && !ukmo && !icon) return null
  return { ecmwf, ukmo, icon }
}

// --- Blending helpers — these mirror weatherWorker.js so the notification
// trigger and the app UI agree about cloud cover. ---

function indexHourly(response) {
  const map = new Map()
  const times = response?.hourly?.time ?? []
  times.forEach((t, i) => map.set(t, i))
  return map
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

// Overlap (probabilistic independent-layers) formula, not an additive sum —
// same as weatherWorker.js combineCloudLayers.
function combineCloudLayers(low, mid, high) {
  if (low === null && mid === null && high === null) return null
  const clearSky = (1 - (low ?? 0) / 100) * (1 - (mid ?? 0) / 100) * (1 - (high ?? 0) / 100)
  return 100 * (1 - clearSky)
}

function average(values) {
  const valid = values.filter((v) => v !== null && v !== undefined)
  if (valid.length === 0) return null
  return valid.reduce((s, v) => s + v, 0) / valid.length
}

// Scores the 3 candidate nights (tonight, tomorrow, day after) and returns
// per-night averages. Exported separately from findGoodNight so it can be
// exercised against live data without a subscription round-trip.
export function scoreNights(forecast) {
  const { ecmwf, ukmo, icon } = forecast
  const reference = ecmwf ?? ukmo ?? icon
  const refTimes = reference?.hourly?.time ?? []
  const times = refTimes.map((t) => new Date(t))
  const ecmwfIndex = indexHourly(ecmwf)
  const ukmoIndex = indexHourly(ukmo)
  const iconIndex = indexHourly(icon)

  const nights = []
  for (let dayOffset = 0; dayOffset < 3; dayOffset++) {
    const nightDate = new Date()
    nightDate.setDate(nightDate.getDate() + dayOffset)
    const dateStr = nightDate.toISOString().slice(0, 10)

    const darkHours = times.reduce((acc, t, i) => {
      const h = t.getHours()
      if (t.toISOString().slice(0, 10) === dateStr && (h >= 20 || h <= 5)) {
        acc.push(i)
      }
      return acc
    }, [])

    let totalScore = 0
    let count = 0
    let totalCloud = 0

    for (const i of darkHours) {
      const key = refTimes[i]

      const cloudLow = blendCloud(
        readHourly(ecmwf, ecmwfIndex, key, 'cloudcover_low'),
        readHourly(ukmo, ukmoIndex, key, 'cloudcover_low'),
        readHourly(icon, iconIndex, key, 'cloudcover_low')
      )
      const cloudMid = blendCloud(
        readHourly(ecmwf, ecmwfIndex, key, 'cloudcover_mid'),
        readHourly(ukmo, ukmoIndex, key, 'cloudcover_mid'),
        readHourly(icon, iconIndex, key, 'cloudcover_mid')
      )
      const cloudHigh = blendCloud(
        readHourly(ecmwf, ecmwfIndex, key, 'cloudcover_high'),
        readHourly(ukmo, ukmoIndex, key, 'cloudcover_high'),
        readHourly(icon, iconIndex, key, 'cloudcover_high')
      )
      const cloud = combineCloudLayers(cloudLow, cloudMid, cloudHigh)

      // No model has data for this hour — skip it rather than scoring
      // fabricated values.
      if (cloud === null) continue

      const humidity = average([
        readHourly(ecmwf, ecmwfIndex, key, 'relativehumidity_2m'),
        readHourly(ukmo, ukmoIndex, key, 'relativehumidity_2m'),
        readHourly(icon, iconIndex, key, 'relativehumidity_2m'),
      ])
      const temp = average([
        readHourly(ecmwf, ecmwfIndex, key, 'temperature_2m'),
        readHourly(ukmo, ukmoIndex, key, 'temperature_2m'),
        readHourly(icon, iconIndex, key, 'temperature_2m'),
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

      // Conservative moon estimate — no altitude, assume above horizon
      const moonIllum = 0.3
      const moonAlt   = 30

      const { score } = scoreHour({ cloud, moonIllum, moonAlt, humidity, temp, dewpoint, windspeed })
      totalScore += score
      totalCloud += cloud
      count++
    }

    if (count === 0) continue

    nights.push({
      dayOffset,
      label: dayOffset === 0 ? 'Tonight' : dayOffset === 1 ? 'Tomorrow night' : `In ${dayOffset} nights`,
      score: Math.round(totalScore / count),
      cloud: Math.round(totalCloud / count),
      hourCount: count,
    })
  }
  return nights
}

export function findGoodNight(forecast) {
  for (const night of scoreNights(forecast)) {
    if (night.score >= 65) {
      const verdict = night.score >= 85 ? 'GREAT' : 'GOOD'
      return { score: night.score, cloud: night.cloud, moon: '?', verdict, label: night.label }
    }
  }
  return null
}
