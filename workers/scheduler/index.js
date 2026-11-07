import webpush from 'web-push'
import { buildForecast } from '../../src/forecast.js'
import { zonedParts, safeTimeZone, formatYmd } from '../../src/timezone.js'
import { findGoodNight } from './nightSelection.js'
import { isAuthorizedTrigger } from './triggerAuth.js'
import {
  isRetryableError,
  listSubscriptionKeys,
  normalizeLocationKey,
  withRetry,
} from './reliability.js'

// Subscriptions taken before the client started sending a timezone have none stored.
// Every subscriber to date is Australian east-coast, so fall back there rather than
// to UTC, which would put the night boundary in the middle of the evening.
const FALLBACK_TIMEZONE = 'Australia/Brisbane'

const NIGHTS_AHEAD = 3
const FORECAST_TIMEOUT_MS = 15_000
const SUBSCRIPTION_TTL = 60 * 60 * 24 * 365

export default {
  async scheduled(event, env, ctx) {
    // An unhandled rejection here abandons every subscriber after the failure point,
    // silently. Log it instead.
    ctx.waitUntil(runScheduler(env).catch((err) => console.error('[scheduler] run failed', err)))
  },

  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/trigger') {
      if (!isAuthorizedTrigger(request, env.SCHEDULER_TRIGGER_SECRET)) {
        // Do not reveal that an internal trigger endpoint exists to unauthenticated callers.
        return new Response('Not Found', { status: 404 })
      }

      try {
        await runScheduler(env)
        return new Response('Scheduler ran OK', { status: 200 })
      } catch (err) {
        console.error('[scheduler] manual trigger failed', err)
        return new Response('Scheduler failed', { status: 500 })
      }
    }

    return new Response('Not Found', { status: 404 })
  },
}

async function runScheduler(env, now = new Date()) {
  webpush.setVapidDetails(env.VAPID_EMAIL, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY)

  const keys = await listSubscriptionKeys(env.ASTRO_SUBSCRIPTIONS)
  const forecastCache = new Map()

  for (const keyName of keys) {
    // One malformed record, one upstream timeout, one push-service hiccup must not
    // take down the rest of the run.
    try {
      await processSubscriber(env, keyName, now, forecastCache)
    } catch (err) {
      console.error(`[scheduler] ${keyName} failed`, err)
    }
  }
}

async function processSubscriber(env, keyName, now, forecastCache) {
  const raw = await env.ASTRO_SUBSCRIPTIONS.get(keyName)
  if (!raw) return

  const entry = JSON.parse(raw)
  const timezone = safeTimeZone(entry.timezone ?? FALLBACK_TIMEZONE)

  // Dedupe on the subscriber's own calendar day. The old code used the UTC date,
  // which at the 22:00 UTC cron is the *previous* day everywhere east of Greenwich.
  const today = formatYmd(zonedParts(now, timezone))
  if (entry.lastNotified === today) {
    await touchSubscription(env, keyName, entry)
    return
  }

  const locationKey = normalizeLocationKey(entry.lat, entry.lng, timezone)
  let forecastPromise = forecastCache.get(locationKey)
  if (!forecastPromise) {
    forecastPromise = buildForecast(entry.lat, entry.lng, timezone, {
      fetchImpl: fetchForecast,
      now,
      maxNights: NIGHTS_AHEAD,
    })
    forecastCache.set(locationKey, forecastPromise)
  }

  const { nights } = await forecastPromise

  const goodNight = findGoodNight(nights, now, timezone)
  if (!goodNight) {
    await touchSubscription(env, keyName, entry)
    return
  }

  const payload = JSON.stringify({
    title: `🌌 Clear skies ahead — ${entry.locationName}`,
    body:
      `${goodNight.label} (${goodNight.dateLabel}) looks ${goodNight.verdict}! Avg score ${goodNight.score}/100. ` +
      `Cloud ${goodNight.cloud}%, Moon ${goodNight.moon}%.`,
    url: 'https://damiennikon.github.io/astro-weather/',
  })

  try {
    await withRetry(
      () => webpush.sendNotification(entry.subscription, payload),
      { shouldRetry: isRetryableError },
    )
    entry.lastNotified = today
    await touchSubscription(env, keyName, entry)
  } catch (err) {
    // 410 Gone and 404 Not Found both mean the endpoint is permanently dead.
    if (err.statusCode === 410 || err.statusCode === 404) {
      await env.ASTRO_SUBSCRIPTIONS.delete(keyName)
    } else {
      throw err
    }
  }
}

async function touchSubscription(env, keyName, entry) {
  await env.ASTRO_SUBSCRIPTIONS.put(keyName, JSON.stringify(entry), {
    expirationTtl: SUBSCRIPTION_TTL,
  })
}

async function fetchForecast(url) {
  return withRetry(async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FORECAST_TIMEOUT_MS)

    try {
      const response = await fetch(url, { signal: controller.signal })
      if (response.ok || !isRetryableError(response)) return response

      const error = new Error(`Open-Meteo returned HTTP ${response.status}`)
      error.status = response.status
      throw error
    } finally {
      clearTimeout(timeout)
    }
  })
}

export { listSubscriptionKeys, normalizeLocationKey, runScheduler, withRetry }
