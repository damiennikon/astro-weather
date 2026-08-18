import webpush from 'web-push'
import { buildForecast } from '../../src/forecast.js'
import { zonedParts, safeTimeZone, formatYmd } from '../../src/timezone.js'
import { findGoodNight } from './nightSelection.js'

// Subscriptions taken before the client started sending a timezone have none stored.
// Every subscriber to date is Australian east-coast, so fall back there rather than
// to UTC, which would put the night boundary in the middle of the evening.
const FALLBACK_TIMEZONE = 'Australia/Brisbane'

const NIGHTS_AHEAD = 3

export default {
  async scheduled(event, env, ctx) {
    // An unhandled rejection here abandons every subscriber after the failure point,
    // silently. Log it instead.
    ctx.waitUntil(runScheduler(env).catch((err) => console.error('[scheduler] run failed', err)))
  },

  async fetch(request, env) {
    if (new URL(request.url).pathname === '/trigger') {
      await runScheduler(env)
      return new Response('Scheduler ran OK', { status: 200 })
    }
    return new Response('Not Found', { status: 404 })
  },
}

async function runScheduler(env, now = new Date()) {
  webpush.setVapidDetails(env.VAPID_EMAIL, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY)

  const list = await env.ASTRO_SUBSCRIPTIONS.list({ prefix: 'sub:' })

  for (const key of list.keys) {
    // One malformed record, one upstream timeout, one push-service hiccup must not
    // take down the rest of the run.
    try {
      await processSubscriber(env, key.name, now)
    } catch (err) {
      console.error(`[scheduler] ${key.name} failed`, err)
    }
  }
}

async function processSubscriber(env, keyName, now) {
  const raw = await env.ASTRO_SUBSCRIPTIONS.get(keyName)
  if (!raw) return

  const entry = JSON.parse(raw)
  const timezone = safeTimeZone(entry.timezone ?? FALLBACK_TIMEZONE)

  // Dedupe on the subscriber's own calendar day. The old code used the UTC date,
  // which at the 22:00 UTC cron is the *previous* day everywhere east of Greenwich.
  const today = formatYmd(zonedParts(now, timezone))
  if (entry.lastNotified === today) return

  const { nights } = await buildForecast(entry.lat, entry.lng, timezone, {
    now,
    maxNights: NIGHTS_AHEAD,
  })

  const goodNight = findGoodNight(nights, now, timezone)
  if (!goodNight) return

  const payload = JSON.stringify({
    title: `🌌 Clear skies ahead — ${entry.locationName}`,
    body:
      `${goodNight.label} (${goodNight.dateLabel}) looks ${goodNight.verdict}! Avg score ${goodNight.score}/100. ` +
      `Cloud ${goodNight.cloud}%, Moon ${goodNight.moon}%.`,
    url: 'https://damiennikon.github.io/astro-weather/',
  })

  try {
    await webpush.sendNotification(entry.subscription, payload)
    entry.lastNotified = today
    await env.ASTRO_SUBSCRIPTIONS.put(keyName, JSON.stringify(entry), {
      expirationTtl: 60 * 60 * 24 * 365,
    })
  } catch (err) {
    // 410 Gone and 404 Not Found both mean the endpoint is permanently dead.
    if (err.statusCode === 410 || err.statusCode === 404) {
      await env.ASTRO_SUBSCRIPTIONS.delete(keyName)
    } else {
      throw err
    }
  }
}

export { runScheduler }
