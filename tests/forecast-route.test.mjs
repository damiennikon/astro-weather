import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import { buildUrl, MODELS, FORECAST_TIMEOUT_MS } from '../src/forecast.js'
import { CACHED_FORECAST_HEADER, FORECAST_FETCHED_AT_HEADER } from '../src/forecastCache.js'
import { buildFixture } from './helpers/openMeteoFixture.mjs'

const SITE = { lat: -27.68, lng: 153.19, timezone: 'Australia/Brisbane' }
const NOW = Date.parse('2026-11-14T06:00:00Z')
const FIXTURE = buildFixture({ timeZone: SITE.timezone, startYmd: { year: 2026, month: 11, day: 14 } })
const urlFor = (model = 'ecmwf', site = SITE) =>
  buildUrl(site.lat, site.lng, site.timezone, MODELS[model], model !== 'ukmo')
const forecastResponse = (at = NOW, fixture = FIXTURE) =>
  Response.json(fixture, { headers: { date: new Date(at).toUTCString() } })

const listeners = new Map()
const scope = {
  __WB_MANIFEST: [],
  location: new URL('https://astro.example/astro-weather/sw.js'),
  addEventListener(type, listener) {
    if (!listeners.has(type)) listeners.set(type, [])
    listeners.get(type).push(listener)
  },
}
globalThis.FetchEvent = class {}
globalThis.self = scope
globalThis.location = scope.location
process.env.NODE_ENV = 'production'

// Register src/sw.js with the real Workbox router and strategy. Replace only
// IndexedDB housekeeping; Cache Storage and fetch events are supplied below.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './CacheExpiration.js' && context.parentURL.includes('/workbox-expiration/')) {
      const source = 'export class CacheExpiration { async expireEntries() {} async updateTimestamp() {} }'
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
    }
    if (/^workbox-[\w-]+$/.test(specifier)) return nextResolve(`${specifier}/index.js`, context)
    return nextResolve(specifier, context)
  },
})
await import('../src/sw.js').finally(() => hooks.deregister())

function setupRoute(t, upstream) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW })
  t.mock.method(globalThis, 'fetch', (input, options) =>
    input instanceof Request ? upstream(new Request(input, options)) : handleRequest(input, options),
  )
  const entries = new Map()
  const key = (request, options) => options?.ignoreSearch ? request.url.split('?')[0] : request.url
  const cache = {
    async match(request, options) {
      const match = [...entries].find(([url]) => key({ url }, options) === key(request, options))
      return match?.[1].clone()
    },
    async put(request, response) { entries.set(key(request), response.clone()) },
  }
  globalThis.caches = scope.caches = {
    match: (request, options) => options.cacheName === 'open-meteo-cache' ? cache.match(request, options) : undefined,
    open: async (name) => {
      assert.equal(name, 'open-meteo-cache')
      return cache
    },
  }
  const executions = []
  t.after(async () => {
    t.mock.timers.tick(FORECAST_TIMEOUT_MS)
    await setImmediate()
    t.mock.timers.tick(1)
    await Promise.allSettled(executions.flat())
  })
  function handleRequest(url, options) {
    const request = new Request(url, options)
    const lifetime = []
    executions.push(lifetime)
    let result
    const event = {
      request,
      waitUntil: (promise) => lifetime.push(promise),
      respondWith: (promise) => { result = Promise.resolve(promise) },
    }
    for (const listener of listeners.get('fetch')) listener(event)
    assert.ok(result, 'the request matched the service worker forecast route')
    // Some scenarios intentionally reject before the test awaits the result.
    result.catch(() => {})
    return result
  }
  return {
    async flush() {
      await setImmediate()
      t.mock.timers.tick(1)
      await Promise.allSettled(executions.flat())
    },
    seed(url, response) { entries.set(url, response) },
    stored(url) { return entries.get(url)?.clone() },
    request: handleRequest,
  }
}

function stall(request) {
  return new Promise((_, reject) => {
    if (request.signal.aborted) reject(request.signal.reason)
    else request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
  })
}

test('a stalled forecast takes the matching cache before the worker deadline', { timeout: 2000 }, async (t) => {
  const route = setupRoute(t, stall)
  const url = urlFor()
  route.seed(url, forecastResponse(NOW - 30 * 60_000))
  const controller = new AbortController()
  setTimeout(() => controller.abort(), FORECAST_TIMEOUT_MS)
  let result
  const pending = route.request(url, { signal: controller.signal })
  pending.then((response) => { result = response }, () => {})
  await setImmediate()
  t.mock.timers.tick(9_999)
  await setImmediate()
  assert.equal(result, undefined)
  t.mock.timers.tick(1)
  await setImmediate()
  assert.equal((await pending).headers.get(CACHED_FORECAST_HEADER), '1')
  assert.equal(Number(result.headers.get(FORECAST_FETCHED_AT_HEADER)), NOW - 30 * 60_000)
  assert.deepEqual(await result.json(), FIXTURE)
  assert.equal(controller.signal.aborted, false)
})

test('a response that sends headers and then stalls still falls back at ten seconds', { timeout: 2000 }, async (t) => {
  const route = setupRoute(t, async (request) => new Response(new ReadableStream({
    start(controller) {
      request.signal.addEventListener('abort', () => controller.error(request.signal.reason), { once: true })
    },
  })))
  const url = urlFor()
  route.seed(url, forecastResponse(NOW - 60_000))
  const controller = new AbortController()
  setTimeout(() => controller.abort(), FORECAST_TIMEOUT_MS)
  const pending = route.request(url, { signal: controller.signal })
  await setImmediate()
  t.mock.timers.tick(10_000)
  const response = await pending
  assert.equal(response.headers.get(CACHED_FORECAST_HEADER), '1')
  assert.deepEqual(await response.json(), FIXTURE)
})

test('a gateway 503 uses the cache without replacing the successful response', async (t) => {
  const route = setupRoute(t, async () => new Response('Service unavailable', { status: 503 }))
  const url = urlFor()
  route.seed(url, forecastResponse(NOW - 30 * 60_000))
  const response = await route.request(url)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get(CACHED_FORECAST_HEADER), '1')
  t.mock.timers.tick(1)
  assert.deepEqual(await route.stored(url).json(), FIXTURE)
})


// Exercise the worker as a fresh launch would: it has no in-memory forecast.
// Its fetch still goes through the registered service worker route.
await import('../src/weatherWorker.js')
async function launchForecast(site = SITE) {
  const messages = []
  scope.postMessage = (message) => messages.push(message)
  await scope.onmessage({ data: { type: 'FETCH_FORECAST', ...site } })
  return messages.at(-1)
}

test('a timeout cache miss keeps waiting for a live response', async (t) => {
  const route = setupRoute(t, (request) => Promise.race([
    stall(request),
    new Promise((resolve) => setTimeout(() => resolve(forecastResponse()), 12_000)),
  ]))
  let settled = false
  const responsePromise = route.request(urlFor()).finally(() => { settled = true })
  await setImmediate()
  t.mock.timers.tick(10_000)
  await setImmediate()
  assert.equal(settled, false)
  t.mock.timers.tick(2_000)
  const response = await responsePromise
  assert.equal(response.headers.has(CACHED_FORECAST_HEADER), false)
  assert.equal(Number(response.headers.get(FORECAST_FETCHED_AT_HEADER)), NOW + 12_000)
  assert.deepEqual(await response.json(), FIXTURE)
})

test('an empty cache and three stalled requests still give the worker its 15-second deadline', async (t) => {
  setupRoute(t, stall)
  let result
  const pending = launchForecast().then((message) => { result = message })
  await setImmediate()
  t.mock.timers.tick(10_000)
  await setImmediate()
  assert.equal(result, undefined)
  t.mock.timers.tick(FORECAST_TIMEOUT_MS - 10_000)
  await pending
  assert.equal(result.type, 'FORECAST_ERROR')
  assert.equal(result.failures.length, 3)
  for (const { reason } of result.failures) assert.match(reason, /timed out after 15s/)
})

test('a fresh launch blends live and cached models with their original timestamps', async (t) => {
  let canFetch = true
  const route = setupRoute(t, async (request) => {
    assert.equal(request.cache, 'no-store')
    const model = new URL(request.url).searchParams.get('models')
    if (!canFetch && model === MODELS.ukmo) return new Response(null, { status: 502 })
    if (!canFetch && model === MODELS.icon) throw new TypeError('Network error')
    return Response.json(FIXTURE)
  })
  for (const model of ['ukmo', 'icon']) {
    const response = await route.request(urlFor(model), { cache: 'no-store' })
    assert.equal(response.headers.has(CACHED_FORECAST_HEADER), false)
    await response.json()
  }
  await route.flush()
  assert.equal(route.stored(urlFor('ecmwf')), undefined)
  assert.equal(route.stored(urlFor('ukmo')).headers.has(CACHED_FORECAST_HEADER), false)
  const fetchedAt = Number(route.stored(urlFor('ukmo')).headers.get(FORECAST_FETCHED_AT_HEADER))
  assert.equal(fetchedAt, NOW)

  canFetch = false
  t.mock.timers.tick(20 * 60_000)
  const ready = await launchForecast()
  assert.equal(ready.type, 'FORECAST_READY')
  assert.deepEqual(ready.meta.available, ['ecmwf', 'ukmo', 'icon'])
  assert.deepEqual(ready.meta.cached, ['ukmo', 'icon'])
  assert.deepEqual(ready.meta.cachedFetchedAt, { ukmo: NOW, icon: NOW })
  assert.ok(ready.nights[0].scoredHourCount > 0)
  assert.equal(Number(route.stored(urlFor('ukmo')).headers.get(FORECAST_FETCHED_AT_HEADER)), NOW)
})

test('a cache-only launch trims nights to the hours actually covered by the cached model', async (t) => {
  const route = setupRoute(t, async () => new Response(null, { status: 504 }))
  const short = structuredClone(FIXTURE)
  for (const values of Object.values(short.hourly)) values.length = 53 // ends before 06:00 on the second morning
  route.seed(urlFor(), forecastResponse(NOW - 30 * 60_000, short))
  const ready = await launchForecast()
  assert.equal(ready.type, 'FORECAST_READY')
  assert.deepEqual(ready.meta.available, ['ecmwf'])
  assert.deepEqual(ready.meta.cached, ['ecmwf'])
  assert.deepEqual(ready.nights.map(({ date }) => date), ['2026-11-14'])
})

test('expired, undated and insufficient-coverage entries are cache misses', async (t) => {
  const route = setupRoute(t, async () => new Response(null, { status: 503 }))
  const url = urlFor()
  // No HTTP Date on a new entry: age must still be enforced on the first read.
  route.seed(url, Response.json(FIXTURE, {
    headers: { [FORECAST_FETCHED_AT_HEADER]: String(NOW - 60 * 60_000 - 1) },
  }))
  const noCoverage = structuredClone(FIXTURE)
  noCoverage.hourly.cloud_cover_low[22] = null
  route.seed(urlFor('ukmo'), forecastResponse(NOW, noCoverage))
  // A legacy entry with no original fetch time cannot prove freshness.
  route.seed(urlFor('icon'), Response.json(FIXTURE))
  const result = await launchForecast()
  assert.equal(result.type, 'FORECAST_ERROR')
  assert.equal(result.failures.length, 3)
  for (const { reason } of result.failures) assert.match(reason, /HTTP 503/)
})

test('after midnight, fallback requires coverage from the current hour through dawn', async (t) => {
  const route = setupRoute(t, async () => new Response(null, { status: 503 }))
  const now = Date.parse('2026-11-14T15:30:00Z') // 01:30 at the observing site
  t.mock.timers.setTime(now)
  const midnightStart = buildFixture({
    timeZone: SITE.timezone, startYmd: { year: 2026, month: 11, day: 15 },
  })
  const missingCurrentHour = structuredClone(midnightStart)
  missingCurrentHour.hourly.cloud_cover_low[1] = null
  route.seed(urlFor('ecmwf'), forecastResponse(now - 600_000, midnightStart))
  route.seed(urlFor('ukmo'), forecastResponse(now - 600_000, missingCurrentHour))

  const ready = await launchForecast()
  assert.equal(ready.type, 'FORECAST_READY')
  assert.deepEqual(ready.meta.cached, ['ecmwf'])
  assert.equal(ready.inProgressNight.night.date, '2026-11-14')
  assert.equal(ready.inProgressNight.wholeNightSummaryAvailable, false)
})

test('a location change or request parameter change cannot reuse a fresh entry', async (t) => {
  const route = setupRoute(t, async () => new Response(null, { status: 503 }))
  const url = new URL(urlFor())
  route.seed(url.href, forecastResponse())
  url.searchParams.set('temperature_unit', 'fahrenheit')
  for (const differentUrl of [url.href, urlFor('ecmwf', { ...SITE, lat: -27.47 }), urlFor('icon')]) {
    const response = await route.request(differentUrl)
    assert.equal(response.status, 503)
    assert.equal(route.stored(differentUrl), undefined)
  }
})

test('a malformed HTTP 200 cannot replace a good forecast', async (t) => {
  const route = setupRoute(t, async () => Response.json({ error: true, reason: 'Upstream error' }))
  const url = urlFor()
  route.seed(url, forecastResponse(NOW - 60_000))
  const response = await route.request(url)
  assert.equal(response.headers.get(CACHED_FORECAST_HEADER), '1')
  await route.flush()
  assert.deepEqual(await route.stored(url).json(), FIXTURE)
})
