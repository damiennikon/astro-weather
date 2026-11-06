import { test } from 'node:test'
import assert from 'node:assert/strict'
import subscribeWorker, {
  validateSubscribePayload,
} from '../workers/subscribe/index.js'
import { isAuthorizedTrigger } from '../workers/scheduler/triggerAuth.js'

const ORIGIN = 'https://damiennikon.github.io'
const ENDPOINT = 'https://push.example.test/send/abc'
const BASE_BODY = {
  subscription: {
    endpoint: ENDPOINT,
    keys: { p256dh: 'public-key', auth: 'auth-key' },
  },
  lat: -27.47,
  lng: 152.98,
  locationName: 'Mount Nebo',
  timezone: 'Australia/Brisbane',
}

class MemoryKV {
  constructor() {
    this.values = new Map()
  }

  async get(key) { return this.values.get(key) ?? null }
  async put(key, value) { this.values.set(key, value) }
  async delete(key) { this.values.delete(key) }
}

function env() {
  return { ALLOWED_ORIGIN: ORIGIN, ASTRO_SUBSCRIPTIONS: new MemoryKV() }
}

function subscribeRequest(body, options = {}) {
  return new Request('https://subscribe.example.test/subscribe', {
    method: 'POST',
    headers: {
      Origin: options.origin ?? ORIGIN,
      'Content-Type': 'application/json',
    },
    body: options.rawBody ?? JSON.stringify(body),
  })
}

test('subscription payload validation rejects invalid coordinates and keys', () => {
  assert.equal(validateSubscribePayload({ ...BASE_BODY, lat: 91 }).ok, false)
  assert.equal(validateSubscribePayload({ ...BASE_BODY, lng: Number.NaN }).ok, false)
  assert.equal(validateSubscribePayload({
    ...BASE_BODY,
    subscription: { endpoint: ENDPOINT, keys: {} },
  }).ok, false)
})

test('subscribe rejects malformed JSON and untrusted origins', async () => {
  const malformed = await subscribeWorker.fetch(
    subscribeRequest(null, { rawBody: '{' }), env()
  )
  assert.equal(malformed.status, 400)

  const untrusted = await subscribeWorker.fetch(
    subscribeRequest(BASE_BODY, { origin: 'https://evil.example' }), env()
  )
  assert.equal(untrusted.status, 403)
})

test('resubscribing updates location without resetting notification state', async () => {
  const testEnv = env()
  const first = await subscribeWorker.fetch(subscribeRequest(BASE_BODY), testEnv)
  assert.equal(first.status, 200)
  const { key } = await first.json()
  const stored = JSON.parse(await testEnv.ASTRO_SUBSCRIPTIONS.get(key))
  stored.lastNotified = '2026-11-06'
  await testEnv.ASTRO_SUBSCRIPTIONS.put(key, JSON.stringify(stored))

  const second = await subscribeWorker.fetch(subscribeRequest({
    ...BASE_BODY,
    lat: -28.64,
    lng: 153.61,
    locationName: 'Nightcap National Park',
    timezone: 'Australia/Sydney',
  }), testEnv)
  assert.equal(second.status, 200)

  const updated = JSON.parse(await testEnv.ASTRO_SUBSCRIPTIONS.get(key))
  assert.equal(updated.lat, -28.64)
  assert.equal(updated.lng, 153.61)
  assert.equal(updated.locationName, 'Nightcap National Park')
  assert.equal(updated.timezone, 'Australia/Sydney')
  assert.equal(updated.lastNotified, '2026-11-06')
  assert.equal(updated.subscribedAt, stored.subscribedAt)
  assert.ok(updated.updatedAt)
})

test('scheduler trigger requires the configured bearer secret', () => {
  const makeRequest = (authorization) => new Request('https://scheduler.example.test/trigger', {
    method: 'POST',
    headers: authorization ? { Authorization: authorization } : {},
  })

  assert.equal(isAuthorizedTrigger(makeRequest(), 'stage-3-secret'), false)
  assert.equal(isAuthorizedTrigger(makeRequest('Bearer wrong'), 'stage-3-secret'), false)
  assert.equal(isAuthorizedTrigger(makeRequest('Bearer stage-3-secret'), 'stage-3-secret'), true)
  assert.equal(isAuthorizedTrigger(makeRequest('Bearer stage-3-secret-extra'), 'stage-3-secret'), false)
})
