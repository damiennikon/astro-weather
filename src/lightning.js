const workerUrl = import.meta.env?.VITE_SUBSCRIBE_WORKER_URL
const MINUTE_MS = 60_000

export function createLightningIndicator(element, source, endpoint = workerUrl) {
  const message = document.createElement('span')
  const icon = document.createElement('span')
  icon.className = 'nearby-lightning-icon'
  icon.setAttribute('aria-hidden', 'true')
  icon.hidden = true
  icon.textContent = '!'
  element.append(icon, message)

  let request
  let timer

  function show(text, detected = false) {
    icon.hidden = !detected
    element.classList.toggle('lightning-message', Boolean(text))
    element.classList.toggle('lightning-detected', detected)
    if (message.textContent !== text) message.textContent = text
  }

  function showDetection({ distanceKm, detectedAt, expiresAt }) {
    const now = Date.now()
    if (now >= expiresAt) {
      show('')
      return
    }
    const age = Math.max(0, now - detectedAt)
    const minutes = Math.floor(age / MINUTE_MS)
    const elapsed = minutes === 0 ? 'less than 1 min ago' : `${minutes} min ago`
    const distance = distanceKm < 1 ? 'less than 1 km' : `${Math.round(distanceKm)} km`
    show(`Lightning nearby · ${distance} away · ${elapsed}`, true)
    timer = setTimeout(() => showDetection({ distanceKm, detectedAt, expiresAt }),
      Math.min(expiresAt - now, MINUTE_MS - age % MINUTE_MS))
  }

  return {
    async check({ lat, lng }) {
      if (!endpoint) return
      clearTimeout(timer)
      request?.abort()
      show('')
      source.hidden = true
      const controller = new AbortController()
      request = controller
      const deadline = setTimeout(() => controller.abort(), 8000)
      try {
        const url = new URL('lightning', `${endpoint.replace(/\/$/, '')}/`)
        url.search = new URLSearchParams({ lat, lng })
        const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
        if (!response.ok) throw new Error('Lightning data unavailable')
        const data = await response.json()
        if (request !== controller) return
        if (controller.signal.aborted) throw new Error('Lightning lookup timed out')
        if (data?.status === 'none') {
          source.hidden = false
          return
        }
        const { distanceKm, detectedAt, expiresAt } = data
        if (data.status !== 'detected' || !Number.isFinite(distanceKm) || distanceKm < 0 ||
            !Number.isFinite(detectedAt) || !Number.isFinite(expiresAt) ||
            expiresAt <= detectedAt || expiresAt - detectedAt > 5 * MINUTE_MS) {
          throw new Error('Invalid lightning data')
        }
        source.hidden = false
        showDetection(data)
      } catch {
        if (request === controller) show('Lightning data unavailable')
      } finally {
        clearTimeout(deadline)
      }
    },
  }
}
