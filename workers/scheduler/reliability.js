const DEFAULT_RETRIES = 2
const DEFAULT_RETRY_DELAY_MS = 250

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export function isRetryableError(error) {
  const status = error?.statusCode ?? error?.status
  return status == null || status === 408 || status === 429 || status >= 500
}

export async function withRetry(operation, {
  retries = DEFAULT_RETRIES,
  delayMs = DEFAULT_RETRY_DELAY_MS,
  shouldRetry = isRetryableError,
  sleepImpl = sleep,
} = {}) {
  let attempt = 0

  while (true) {
    try {
      return await operation(attempt)
    } catch (error) {
      if (attempt >= retries || !shouldRetry(error)) throw error
      attempt += 1
      await sleepImpl(delayMs * 2 ** (attempt - 1))
    }
  }
}

export async function listSubscriptionKeys(namespace) {
  const names = []
  const seen = new Set()
  let cursor = null

  while (true) {
    const options = cursor ? { prefix: 'sub:', cursor } : { prefix: 'sub:' }
    const page = await namespace.list(options)

    for (const key of page.keys ?? []) {
      if (!seen.has(key.name)) {
        seen.add(key.name)
        names.push(key.name)
      }
    }

    if (page.list_complete || !page.cursor) return names
    if (page.cursor === cursor) throw new Error('KV subscription listing cursor did not advance')
    cursor = page.cursor
  }
}

export function normalizeLocationKey(lat, lng, timezone) {
  return `${Number(lat).toFixed(2)},${Number(lng).toFixed(2)},${timezone}`
}
