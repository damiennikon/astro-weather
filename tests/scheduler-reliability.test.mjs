import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isRetryableError,
  listSubscriptionKeys,
  normalizeLocationKey,
  withRetry,
} from '../workers/scheduler/reliability.js'

test('KV subscription listing follows every page and removes duplicate keys', async () => {
  const calls = []
  const pages = new Map([
    [null, { keys: [{ name: 'sub:a' }, { name: 'sub:b' }], list_complete: false, cursor: 'next' }],
    ['next', { keys: [{ name: 'sub:b' }, { name: 'sub:c' }], list_complete: true }],
  ])
  const namespace = {
    async list(options) {
      const cursor = options.cursor ?? null
      calls.push(options)
      return pages.get(cursor)
    },
  }

  assert.deepEqual(await listSubscriptionKeys(namespace), ['sub:a', 'sub:b', 'sub:c'])
  assert.deepEqual(calls, [{ prefix: 'sub:' }, { prefix: 'sub:', cursor: 'next' }])
})

test('normalized coordinates share a forecast cache key at forecast-grid precision', () => {
  assert.equal(
    normalizeLocationKey(-27.471, 152.981, 'Australia/Brisbane'),
    normalizeLocationKey(-27.474, 152.984, 'Australia/Brisbane'),
  )
  assert.notEqual(
    normalizeLocationKey(-27.47, 152.98, 'Australia/Brisbane'),
    normalizeLocationKey(-27.47, 152.98, 'Australia/Sydney'),
  )
})

test('transient failures retry with bounded exponential delays', async () => {
  let attempts = 0
  const delays = []
  const result = await withRetry(
    async () => {
      attempts += 1
      if (attempts < 3) throw Object.assign(new Error('busy'), { status: 503 })
      return 'ok'
    },
    { sleepImpl: async (delay) => delays.push(delay) },
  )

  assert.equal(result, 'ok')
  assert.equal(attempts, 3)
  assert.deepEqual(delays, [250, 500])
})

test('permanent failures are not retried', async () => {
  let attempts = 0
  await assert.rejects(
    withRetry(
      async () => {
        attempts += 1
        throw Object.assign(new Error('bad request'), { status: 400 })
      },
      { sleepImpl: async () => {} },
    ),
    /bad request/,
  )
  assert.equal(attempts, 1)
  assert.equal(isRetryableError({ statusCode: 429 }), true)
  assert.equal(isRetryableError({ statusCode: 404 }), false)
})
