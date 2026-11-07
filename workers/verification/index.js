import { collectForecastRun } from './collector.js'
import { collectBomObservations } from './observations.js'
import { createCloudflareStore } from './storage.js'
import { REFERENCE_SITES } from './sites.js'

const LOCK_TTL_SECONDS = 60 * 60
const RUN_TTL_SECONDS = 60 * 60 * 24 * 7

function authorized(request, env) {
  const secret = env.VERIFICATION_TRIGGER_SECRET
  return Boolean(secret) && request.headers.get('Authorization') === `Bearer ${secret}`
}

async function runCycle(env, now = new Date(), scheduledAt = now) {
  const scheduled = new Date(scheduledAt)
  const runId = `verification-${scheduled.toISOString()}`
  const state = env.VERIFICATION_STATE ?? null
  if (state) {
    const existing = await state.get(`run:${runId}`)
    if (existing === 'complete' || existing === 'running') return { skipped: true, runId }
    await state.put(`run:${runId}`, 'running', { expirationTtl: RUN_TTL_SECONDS })
  }

  try {
    const [forecastResult, observationResult] = await Promise.all([
      collectForecastRun({ sites: REFERENCE_SITES, now, scheduledAt }),
      collectBomObservations({ sites: REFERENCE_SITES, now, baseUrl: env.BOM_STATION_FEED_BASE }),
    ])
    const store = createCloudflareStore(env)
    const result = await store.persistCycle({ forecastResult, observationResult, now })
    if (state) await state.put(`run:${runId}`, 'complete', { expirationTtl: RUN_TTL_SECONDS })
    return { ...result, observationFailures: observationResult.failures }
  } catch (error) {
    if (state) await state.put(`run:${runId}`, `failed:${error.message}`, { expirationTtl: LOCK_TTL_SECONDS })
    throw error
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCycle(env, new Date(), new Date(event.scheduledTime)).catch((error) => {
      console.error('[verification] collection failed', error)
    }))
  },

  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true, worker: 'astro-verification', sites: REFERENCE_SITES.length })
    }

    if (!authorized(request, env)) return new Response('Not Found', { status: 404 })

    if (request.method === 'POST' && url.pathname === '/trigger') {
      try {
        const result = await runCycle(env, new Date(), new Date())
        return Response.json(result)
      } catch (error) {
        console.error('[verification] manual trigger failed', error)
        return Response.json({ ok: false, error: error.message }, { status: 500 })
      }
    }

    if (request.method === 'GET' && url.pathname === '/report') {
      try {
        const report = await createCloudflareStore(env).report(url.searchParams.get('limit'))
        return Response.json(report)
      } catch (error) {
        return Response.json({ ok: false, error: error.message }, { status: 500 })
      }
    }

    if (request.method === 'GET' && url.pathname === '/usage') {
      try {
        return Response.json(await createCloudflareStore(env).usage())
      } catch (error) {
        return Response.json({ ok: false, error: error.message }, { status: 500 })
      }
    }

    return new Response('Not Found', { status: 404 })
  },
}

export { runCycle }
