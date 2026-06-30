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

async function fetchForecast(lat, lng) {
  const vars = 'cloudcover_low,cloudcover_mid,cloudcover_high,temperature_2m,relativehumidity_2m,dewpoint_2m,windspeed_10m'
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
              `&hourly=${vars}&models=ecmwf_ifs025,icon_global,ukmo_seamless` +
              `&timezone=Australia%2FBrisbane&forecast_days=4&wind_speed_unit=kmh&temperature_unit=celsius`
  try {
    const res = await fetch(url)
    return await res.json()
  } catch {
    return null
  }
}

function findGoodNight(forecast) {
  const hours = forecast.hourly
  const times = hours.time.map(t => new Date(t))

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

    if (darkHours.length === 0) continue

    let totalScore = 0
    let count = 0
    let totalCloud = 0

    for (const i of darkHours) {
      const cloud = Math.min(100,
        (hours.cloudcover_low?.[i] ?? 0) +
        (hours.cloudcover_mid?.[i] ?? 0) +
        (hours.cloudcover_high?.[i] ?? 0)
      )
      const humidity  = hours.relativehumidity_2m?.[i] ?? 50
      const temp      = hours.temperature_2m?.[i] ?? 20
      const dewpoint  = hours.dewpoint_2m?.[i] ?? 15
      const windspeed = hours.windspeed_10m?.[i] ?? 10

      // Conservative moon estimate — no altitude, assume above horizon
      const moonIllum = 0.3
      const moonAlt   = 30

      const { score } = scoreHour({ cloud, moonIllum, moonAlt, humidity, temp, dewpoint, windspeed })
      totalScore += score
      totalCloud += cloud
      count++
    }

    if (count === 0) continue

    const avgScore = Math.round(totalScore / count)
    const avgCloud = Math.round(totalCloud / count)

    if (avgScore >= 65) {
      const verdict = avgScore >= 85 ? 'GREAT' : 'GOOD'
      const label   = dayOffset === 0 ? 'Tonight' : dayOffset === 1 ? 'Tomorrow night' : `In ${dayOffset} nights`
      return { score: avgScore, cloud: avgCloud, moon: '?', verdict, label }
    }
  }
  return null
}
