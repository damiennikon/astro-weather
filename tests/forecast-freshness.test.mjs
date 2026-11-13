import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { CACHED_FORECAST_HEADER, markCachedForecast } from '../src/forecastCache.js'
import { buildForecast } from '../src/forecast.js'
import { buildFixture, okResponse } from './helpers/openMeteoFixture.mjs'

// The notification module reads Vite build settings on import. These tests
// exercise the real App forecast lifecycle without a notification service.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './notifications.js' && context.parentURL === new URL('../src/app.js', import.meta.url).href) {
      const names = ['requestAndSubscribe', 'syncSubscriptionLocation', 'unsubscribe', 'getSubscriptionStatus']
      const source = names.map((name) => `export function ${name}() {}`).join(';')
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
const { App } = await import('../src/app.js').finally(() => hooks.deregister())

const SITE = { name: 'Perth', lat: -31.95, lng: 115.86, timezone: 'Australia/Perth' }
const OTHER_SITE = { name: 'Brisbane', lat: -27.47, lng: 153.03, timezone: 'Australia/Brisbane' }
const ALL_FAILED = {
  type: 'FORECAST_ERROR',
  code: 'UPSTREAM_UNAVAILABLE',
  failures: ['ecmwf', 'ukmo', 'icon'].map((model) => ({ model, reason: 'offline' })),
}
const NIGHTS = [{ date: '2026-08-19' }]

function setupApp(t) {
  const nodes = new Map()
  const root = {
    querySelector(selector) {
      if (!nodes.has(selector)) {
        const attrs = new Set(['hidden'])
        nodes.set(selector, {
          dataset: {},
          style: {},
          setAttribute: (name) => attrs.add(name),
          removeAttribute: (name) => attrs.delete(name),
          toggleAttribute: (name, force) => force ? attrs.add(name) : attrs.delete(name),
          hasAttribute: (name) => attrs.has(name),
          addEventListener() {},
          querySelector: (child) => root.querySelector(child),
        })
      }
      return nodes.get(selector)
    },
    querySelectorAll: () => [],
  }
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-18T17:30:00Z') })
  const workers = []
  const oldDocument = globalThis.document
  const oldWorker = globalThis.Worker
  globalThis.document = { querySelector: () => root }
  globalThis.Worker = class {
    constructor() { workers.push(this) }
    postMessage() {}
    terminate() {}
    send(data) { this.onmessage({ data }) }
  }
  t.after(() => {
    globalThis.document = oldDocument
    globalThis.Worker = oldWorker
  })
  const app = new App()
  t.after(() => clearTimeout(app.dashboardTimer))
  app.state.location = SITE
  app.renderTonight = () => root.querySelector('#tonight-panel').removeAttribute('hidden')
  return { app, workers, get: root.querySelector, hidden: (selector) => root.querySelector(selector).hasAttribute('hidden') }
}

test('all models failing on first load shows a retry and no forecast', (t) => {
  const { app, workers, get, hidden } = setupApp(t)
  app.fetchForecast(SITE)
  workers[0].send(ALL_FAILED)
  assert.equal(hidden('#forecast-error'), false)
  assert.match(get('#forecast-error-detail').textContent, /ECMWF: offline.*UKMO: offline.*ICON: offline/)
  assert.equal(hidden('#forecast-status'), true)
  assert.equal(hidden('#tonight-panel'), true)
  assert.equal(hidden('#loading-overlay'), true)
})

test('the night picker shows comparable scores and keeps unavailable scores distinct from zero', (t) => {
  const { app, get } = setupApp(t)
  app.renderShell()
  assert.match(app.root.innerHTML, /id="night-picker"/)
  assert.match(app.root.innerHTML, /id="satellite-panel"/)
  assert.doesNotMatch(app.root.innerHTML, /id="outlook-panel"/)

  app.state.nights = [
    { date: '2026-08-18', wholeNightSummaryAvailable: false, nightAvg: { score: 83 } },
    { date: '2026-08-19', nightAvg: { score: 68.2 } },
    { date: '2026-08-20', nightAvg: { score: 0 } },
  ]
  app.renderNightPicker(1, new Date(), SITE.timezone)
  const markup = get('#night-picker').innerHTML
  assert.match(markup, /data-select-night="2026-08-18" aria-pressed="false" aria-label="[^"]*score unavailable">[\s\S]*?verdict-text-unavailable" aria-hidden="true">—/)
  assert.match(markup, /data-select-night="2026-08-19" aria-pressed="true" aria-label="Tonight,[^"]*suitability 68 out of 100, Good">[\s\S]*?verdict-text-good" aria-hidden="true">68/)
  assert.match(markup, /data-select-night="2026-08-20" aria-pressed="false" aria-label="[^"]*suitability 0 out of 100, Very Poor">[\s\S]*?verdict-text-verypoor" aria-hidden="true">0/)
})

test('the hybrid dashboard renders the active post-midnight forecast and switches to a future night', async (t) => {
  const { app, workers, get, hidden } = setupApp(t)
  app.renderTonight = App.prototype.renderTonight.bind(app)
  const canvas = get('#hero-clouds')
  canvas.width = canvas.height = 48
  canvas.getContext = () => ({
    clearRect() {},
    createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    putImageData() {},
  })
  const body = buildFixture({ timeZone: SITE.timezone, startYmd: { year: 2026, month: 8, day: 19 } })
  const { nights, meta, inProgressNight } = await buildForecast(SITE.lat, SITE.lng, SITE.timezone, {
    now: new Date(), fetchImpl: async () => okResponse(body), includeInProgressNight: true,
  })
  app.fetchForecast(SITE)
  workers[0].send({ type: 'FORECAST_READY', nights, meta, inProgressNight })
  assert.equal(hidden('#tonight-panel'), false)
  assert.match(get('#night-picker').innerHTML, /In progress/)
  assert.match(get('#hero-readout').innerHTML, /Earlier forecast hours unavailable/)
  assert.equal(get('#hero-sky-label').textContent, 'Sky illustration')
  assert.equal(get('#tonight-selected-cloud').textContent, '1%')
  assert.match(get('#selected-cloud-hour').textContent, /01:00 · 1% total/)
  assert.match(get('#optimal-window-callout').innerHTML, /Whole-night window unavailable/)

  const future = nights[0] // The upcoming evening still counts as future after midnight.
  app.state.selectedNightDate = future.date
  app.renderDashboard(new Date(), true)
  const firstDark = future.hours.find(({ isDark }) => isDark)
  assert.equal(get('#tonight-selected-cloud').textContent, `${Math.round(firstDark.cloud)}%`)
  assert.equal(get('#tonight-selected-temp').textContent, `${Math.round(firstDark.temp)}°C`)
  assert.match(get('#hero-readout').innerHTML, /Average cloud cover/)
  assert.match(get('#tonight-hourly').innerHTML, /data-night-index="1"/)
  const hourlyAxis = get('#tonight-hourly').innerHTML.match(/class="tonight-chart-x[^"]*" aria-hidden="true">([\s\S]*?)<\/div>/)[1]
  assert.equal([...hourlyAxis.matchAll(/class="tonight-chart-tick"/g)].length, future.hours.length)
  assert.match(hourlyAxis, /--time-position: 0%[^>]*>\s*<span>5<\/span> <span>pm<\/span>/)
  assert.match(hourlyAxis, /<span>12<\/span> <span>am<\/span>/)
  assert.match(hourlyAxis, /--time-position: 100%[^>]*>\s*<span>6<\/span> <span>am<\/span>/)
  assert.match(get('#hour-cloud-layers').innerHTML, /Low.*Mid.*High/s)

  const last = future.hours.at(-1)
  app.cloudChart.selectHour(future.hours.length - 1, true)
  app.renderDashboard(new Date(), true)
  assert.equal(app.selectedForecastHour, +last.time)
  assert.equal(get('#tonight-selected-cloud').textContent, `${Math.round(last.cloud)}%`)
})

test('same-site refresh failure keeps the previous forecast and its original site-local fetch time', (t) => {
  const { app, workers, get, hidden } = setupApp(t)
  app.fetchForecast(SITE)
  workers[0].send({ type: 'FORECAST_READY', nights: NIGHTS, meta: { timezone: SITE.timezone } })
  assert.match(get('#forecast-freshness').textContent, /Wed, 19 Aug at 01:30 \(site time\)/)

  t.mock.timers.setTime(Date.parse('2026-08-18T18:00:00Z'))
  app.fetchForecast(SITE)
  assert.equal(get('#forecast-refresh-btn').disabled, true)
  assert.equal(hidden('#loading-overlay'), true)
  workers[1].send(ALL_FAILED)
  assert.equal(app.state.nights, NIGHTS)
  assert.equal(hidden('#tonight-panel'), false)
  assert.equal(hidden('#forecast-error'), true)
  assert.equal(hidden('#forecast-refresh-warning'), false)
  assert.match(get('#forecast-refresh-warning').textContent, /Refresh failed.*Wed, 19 Aug/)
  assert.match(get('#forecast-freshness').textContent, /01:30/)

  app.fetchForecast(SITE)
  workers[2].send({ type: 'FORECAST_READY', nights: NIGHTS, meta: { timezone: SITE.timezone } })
  assert.equal(hidden('#forecast-refresh-warning'), true)
  assert.equal(get('#forecast-refresh-btn').disabled, false)
  assert.match(get('#forecast-freshness').textContent, /02:00/)
})

test('changing location clears the previous forecast and ignores superseded worker messages', (t) => {
  const { app, workers, hidden } = setupApp(t)
  app.fetchForecast(SITE)
  workers[0].send({ type: 'FORECAST_READY', nights: NIGHTS })
  app.fetchForecast(SITE)
  app.state.location = OTHER_SITE
  app.fetchForecast(OTHER_SITE)
  workers[1].send({ type: 'FORECAST_READY', nights: NIGHTS })
  workers[2].send(ALL_FAILED)
  assert.equal(app.state.nights, null)
  assert.equal(hidden('#forecast-status'), true)
  assert.equal(hidden('#tonight-panel'), true)
  assert.equal(hidden('#forecast-error'), false)
})

test('cached model data is labelled separately from unavailable models and gets no fresh timestamp', (t) => {
  const { app, workers, get, hidden } = setupApp(t)
  app.fetchForecast(SITE)
  workers[0].send({
    type: 'FORECAST_READY',
    nights: NIGHTS,
    meta: {
      cached: ['ecmwf'],
      degraded: true,
      missing: ['icon'],
      available: ['ecmwf', 'ukmo'],
      failures: [{ model: 'icon', reason: 'Forecast request timed out after 15s' }],
      weightCoverage: 0.8,
    },
  })
  assert.equal(app.state.forecastFetchedAt, null)
  assert.match(get('#forecast-freshness').textContent, /Using cached data for ECMWF/)
  assert.equal(hidden('#data-notice'), false)
  assert.match(get('#data-notice').innerHTML, /Model data unavailable.*ICON \(timed out\)/)
})

test('a cache-only refresh keeps the on-screen forecast and reports the failed refresh', (t) => {
  const { app, workers, get, hidden } = setupApp(t)
  app.fetchForecast(SITE)
  workers[0].send({ type: 'FORECAST_READY', nights: NIGHTS })
  app.fetchForecast(SITE)
  workers[1].send({
    type: 'FORECAST_READY',
    nights: [{ date: '2026-08-18' }],
    meta: { cached: ['ecmwf'], available: ['ecmwf'] },
  })
  assert.equal(app.state.nights, NIGHTS)
  assert.equal(hidden('#forecast-refresh-warning'), false)
  assert.match(get('#forecast-freshness').textContent, /Last fetched/)
})

test('different cloud estimates show model disagreement without a missing-model notice', (t) => {
  const { app, workers, get, hidden } = setupApp(t)
  app.fetchForecast(SITE)
  workers[0].send({
    type: 'FORECAST_READY',
    nights: NIGHTS,
    meta: { available: ['ecmwf', 'ukmo', 'icon'], degraded: false },
  })
  app.openConfidenceModal(NIGHTS[0], {
    time: new Date('2026-08-19T16:00:00Z'),
    agreement: 'disagree',
    cloudEcmwf: 0,
    cloudUkmo: 0,
    cloudIcon: 49,
  })
  assert.equal(hidden('#data-notice'), true)
  assert.match(get('#confidence-modal-body').innerHTML, /Models Disagree/)
  assert.match(get('#confidence-modal-body').innerHTML, /ICON.*49%/)
})

test('the forecast worker carries the cache marker through to the app for models that pass validation', async (t) => {
  const fixture = buildFixture({
    timeZone: SITE.timezone,
    startYmd: { year: 2026, month: 8, day: 19 },
  })
  const messages = []
  const oldSelf = globalThis.self
  globalThis.self = { postMessage: (message) => messages.push(message) }
  t.after(() => { globalThis.self = oldSelf })
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.cache, 'no-store')
    const model = new URL(url).searchParams.get('models')
    const response = Response.json(model.startsWith('icon') ? { error: true } : fixture)
    if (model.startsWith('ukmo')) return response
    const marked = markCachedForecast({ cachedResponse: response })
    assert.equal(response.headers.has(CACHED_FORECAST_HEADER), false)
    return marked
  })
  await import('../src/weatherWorker.js')
  await self.onmessage({ data: { type: 'FETCH_FORECAST', ...SITE } })
  const ready = messages.at(-1)
  assert.equal(ready.type, 'FORECAST_READY')
  assert.deepEqual(ready.meta.cached, ['ecmwf'])
  assert.deepEqual(ready.meta.missing, ['icon'])
})
