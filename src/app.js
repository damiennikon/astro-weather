import {
  requestAndSubscribe,
  syncSubscriptionLocation,
  unsubscribe,
  getSubscriptionStatus,
} from './notifications.js'
import { formatTimeInZone, formatCivilDate, zonedDateString, safeTimeZone } from './timezone.js'
import {
  isActiveNight, defaultNightIndex, skyReading, nextDashboardBoundary, bestWindowSegments, formatDashboardHour,
} from './dashboardForecast.js'
import { paintHeroClouds } from './heroSky.js'
import { renderCloudChart } from './cloudChart.js'
import { createLightningIndicator } from './lightning.js'

const STORAGE_KEY = 'astro-location'
const RED_MODE_KEY = 'astro-red-mode'
const DISCLAIMER_DISMISSED_KEY = 'astro-disclaimer-dismissed'
const OBSERVATORY_IMAGE = new URL('./assets/observatory.webp', import.meta.url).href

const VERDICT_LABEL = {
  great: 'Great',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  verypoor: 'Very Poor',
  unavailable: 'No Data',
}

const CONFIDENCE_LABEL = {
  full: 'Full data',
  partial: 'Partial data',
  unavailable: 'No data',
}

const MODEL_LABEL = { ecmwf: 'ECMWF', ukmo: 'UKMO', icon: 'ICON' }

// Ceilings only ever lower the weighted score, so the component breakdown always
// applies — these explain why the final score sits below it.
const VETO_LABEL = {
  cloud: 'heavy cloud cover',
  moon: 'a bright moon above the horizon',
}

export class App {
  constructor() {
    this.root = document.querySelector('#app')
    this.state = {
      location: null,
      nights: null,
      meta: null,
      forecastLocation: null,
      forecastFetchedAt: null,
      refreshFailed: false,
      selectedNightDate: null,
      dashboardNightIndex: null,
      modalContext: null,
      satelliteVisible: false,
    }
    this.worker = null
    this.dashboardTimer = null
  }

  init() {
    this.renderShell()
    this.lightning = createLightningIndicator(
      this.root.querySelector('#nearby-lightning'),
      this.root.querySelector('#lightning-source'),
    )
    this.bindShellEvents()
    this.applyStoredRedMode()
    this.initBellState()
    this.maybeShowDisclaimer()

    const saved = loadLocation()
    if (saved) {
      this.state.location = saved
      this.setLocationLabel(saved.name)
      this.fetchForecast(saved)
    } else {
      this.openLocationPrompt(false)
    }
  }

  // ---------------------------------------------------------------------
  // Shell / static markup
  // ---------------------------------------------------------------------

  renderShell() {
    this.root.innerHTML = `
      <header class="app-header">
        <div class="header-top">
          <h1 class="app-title">Astro<span>Weather</span></h1>
          <div class="header-actions">
            <button id="red-mode-btn" class="icon-btn" aria-label="Red Mode" aria-pressed="false" title="Red Mode">🌙</button>
            <button id="notif-btn" class="icon-btn" aria-label="Notifications" title="Notifications">🔔</button>
          </div>
        </div>
        <div class="location-row">
          <span id="location-name" class="location-name">Loading…</span>
          <span id="nearby-lightning" class="nearby-lightning" role="status"></span>
          <button id="change-location-btn" class="link-btn">Change</button>
        </div>
      </header>

      <main id="main-content">
        <div id="forecast-status" class="forecast-status" hidden>
          <p id="forecast-freshness" role="status"></p>
          <button id="forecast-refresh-btn" class="link-btn">Refresh forecast</button>
        </div>
        <p id="forecast-refresh-warning" class="data-notice" role="status" hidden></p>
        <div id="data-notice" class="data-notice" hidden></div>

        <section id="forecast-error" class="panel forecast-error" hidden>
          <h2 class="panel-title">Forecast unavailable</h2>
          <p id="forecast-error-detail" class="forecast-error-detail"></p>
          <button id="forecast-retry-btn" class="primary-btn">Try again</button>
        </section>

        <section id="tonight-panel" class="night-dashboard" aria-label="Observing night forecast" hidden>
          <section id="tonight-hero" class="night-hero" aria-labelledby="hero-night-label">
            <div id="hero-readout" class="hero-readout"></div>
            <figure class="hero-illustration">
              <div id="hero-sky" class="hero-sky" aria-hidden="true" data-sky="unavailable">
                <div class="hero-photo-plane">
                  <img id="hero-photo" src="${OBSERVATORY_IMAGE}" width="1024" height="1024" alt="" decoding="async">
                  <div class="hero-sky-cutout">
                    <canvas id="hero-clouds" width="420" height="420"></canvas>
                    <div class="hero-neutral-sky"></div>
                  </div>
                </div>
              </div>
              <figcaption id="hero-sky-label" class="hero-sky-label">Sky illustration</figcaption>
            </figure>
          </section>
          <div id="tonight-hourly"></div>
          <section id="upcoming-nights" class="dashboard-surface upcoming-nights" aria-labelledby="upcoming-nights-title">
            <h3 id="upcoming-nights-title">Upcoming nights</h3>
            <nav id="night-picker" class="night-picker" aria-label="Observing nights"></nav>
          </section>
          <details class="dashboard-surface astro-details">
            <summary>Astro details</summary>
            <p id="night-score" class="night-score"></p>
            <div id="optimal-window-callout" class="dashboard-surface window-panel"></div>
            <div class="night-details-grid">
              <section class="dashboard-surface" aria-labelledby="cloud-layers-title">
                <div class="dashboard-heading"><h3 id="cloud-layers-title">Cloud layers</h3><span id="selected-cloud-hour"></span></div>
                <div id="hour-cloud-layers"></div>
                <button id="hour-models-btn" class="link-btn dashboard-link" type="button">Compare models</button>
              </section>
              <section class="dashboard-surface" aria-labelledby="observing-title">
                <div class="dashboard-heading"><h3 id="observing-title">Observing conditions</h3><span id="selected-conditions-hour"></span></div>
                <dl id="hour-conditions" class="conditions-list"></dl>
                <details class="night-averages"><summary>Dark-hours averages</summary><div id="summary-metrics"></div></details>
              </section>
            </div>
            <section class="dashboard-surface astronomy-panel" aria-labelledby="astronomy-title">
              <h3 id="astronomy-title">Astronomy</h3>
              <dl class="astronomy-grid">
                <div><dt>Moon illumination</dt><dd id="moon-illumination"></dd></div>
                <div><dt>Moonrise / moonset</dt><dd id="moon-range"></dd></div>
                <div><dt>Milky Way</dt><dd id="mw-range"></dd></div>
              </dl>
            </section>
          </details>
        </section>

        <section id="satellite-panel" class="panel">
          <button id="satellite-toggle" class="secondary-btn">Show Satellite View</button>
          <div id="satellite-container" class="satellite-container" hidden></div>
        </section>
        <p id="lightning-source" class="lightning-source" hidden>
          Lightning data <a href="https://www.xweather.com/">powered by Vaisala Xweather</a>
        </p>
      </main>

      <div id="loading-overlay" class="loading-overlay" hidden>
        <div class="stars" aria-hidden="true"></div>
        <p id="loading-step" class="loading-step">Loading…</p>
      </div>

      <div id="disclaimer-modal" class="modal-overlay disclaimer-modal" hidden>
        <div class="modal-card">
          <h2>Before You Head Out</h2>
          <p class="disclaimer-text">AstroWeather is an assistant to help determine whether it is ok to head out to shoot the cosmos. Data is obtained and combined from 3 sources, and sometimes they get it wrong. I would still stick your head outside and look up before heading out.</p>
          <button id="disclaimer-ok-btn" class="primary-btn">Got it</button>
          <button id="disclaimer-dont-show-btn" class="link-btn">Don't show this again</button>
        </div>
      </div>

      <div id="location-prompt" class="modal-overlay" hidden>
        <div class="modal-card">
          <button id="location-prompt-close" class="modal-close" aria-label="Close" hidden>×</button>
          <h2>Choose a Location</h2>
          <button id="use-my-location-btn" class="primary-btn">📍 Use My Location</button>
          <div class="search-wrap">
            <input id="location-search" type="text" placeholder="Search for a town or suburb…" autocomplete="off" />
            <div id="search-results" class="search-results" hidden></div>
            <p id="search-status" class="search-status" hidden></p>
          </div>
          <p id="location-error" class="location-error" hidden></p>
        </div>
      </div>

      <div id="confidence-modal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="confidence-modal-time" hidden>
        <div class="modal-card">
          <button id="confidence-modal-close" class="modal-close" aria-label="Close">×</button>
          <h2 id="confidence-modal-time"></h2>
          <div id="confidence-modal-body"></div>
          <p class="confidence-modal-footnote">
            Each hour's score (0–100) blends five factors: Cloud, Moon, Humidity, Dew Spread and Wind. The
            "wt" percentage under each label is that factor's fixed share of the total — not a live reading — and
            the number is its own 0–100 score, not a percentage. A low Moon score usually means the moon is bright
            <em>and</em> above the horizon; if it's below the horizon the Moon always scores 100 regardless of its
            phase. Severe cloud or moonlight can also cap the final score below the weighted total shown here.
          </p>
        </div>
      </div>

      <button id="update-banner" class="update-banner" hidden>🔄 Update available — tap to reload</button>

      <div id="notif-modal" class="modal-overlay" hidden>
        <div class="modal-card">
          <button id="notif-modal-close" class="modal-close" aria-label="Close">×</button>
          <h2>Enable Notifications</h2>
          <p id="notif-modal-body"></p>
        </div>
      </div>

      <div id="notif-toast" class="notif-toast" hidden></div>
    `
  }

  bindShellEvents() {
    this.root.querySelector('#red-mode-btn').addEventListener('click', () => this.toggleRedMode())
    this.root.querySelector('#notif-btn').addEventListener('click', () => this.handleNotificationBell())
    this.root.querySelector('#disclaimer-ok-btn').addEventListener('click', () => this.dismissDisclaimer(false))
    this.root.querySelector('#disclaimer-dont-show-btn').addEventListener('click', () => this.dismissDisclaimer(true))
    this.root.querySelector('#change-location-btn').addEventListener('click', () => this.openLocationPrompt(true))
    this.root.querySelector('#location-prompt-close').addEventListener('click', () => this.closeLocationPrompt())
    this.root.querySelector('#use-my-location-btn').addEventListener('click', () => this.handleUseMyLocation())
    this.root.querySelector('#confidence-modal-close').addEventListener('click', () => this.closeConfidenceModal())
    this.root.querySelector('#satellite-toggle').addEventListener('click', () => this.toggleSatellite())
    const refreshForecast = () => {
      if (this.state.location) this.fetchForecast(this.state.location)
    }
    this.root.querySelector('#forecast-retry-btn').addEventListener('click', refreshForecast)
    this.root.querySelector('#forecast-refresh-btn').addEventListener('click', refreshForecast)
    this.root.querySelector('#night-picker').addEventListener('click', (event) => {
      const button = event.target.closest('[data-select-night]')
      if (!button) return
      this.state.selectedNightDate = button.dataset.selectNight
      this.renderDashboard(new Date(), true)
    })
    this.root.querySelector('#hour-models-btn').addEventListener('click', (event) => {
      const night = this.state.nights?.[this.state.dashboardNightIndex]
      const hour = night?.hours[this.state.dashboardHourIndex]
      if (hour) this.openConfidenceModal(night, hour, event.currentTarget)
    })
    const heroPhoto = this.root.querySelector('#hero-photo')
    const markPhotoUnavailable = () => {
      this.root.querySelector('#hero-sky').classList.add('hero-photo-failed')
    }
    heroPhoto.addEventListener('error', markPhotoUnavailable)
    if (heroPhoto.complete && !heroPhoto.naturalWidth) markPhotoUnavailable()
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return
      if (this.state.nights) this.renderDashboard()
      if (this.state.location) void this.lightning?.check(this.state.location)
    })
    this.root.querySelector('#confidence-modal').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        this.closeConfidenceModal()
      } else if (event.key === 'Tab') {
        // The close button is the only tab stop in this read-only dialog.
        event.preventDefault()
        this.root.querySelector('#confidence-modal-close').focus()
      }
    })

    const searchInput = this.root.querySelector('#location-search')
    let debounceTimer = null
    searchInput.addEventListener('input', () => {
      clearTimeout(debounceTimer)
      const query = searchInput.value.trim()
      if (query.length < 2) {
        this.renderSearchResults([])
        this.setSearchStatus(null)
        return
      }
      debounceTimer = setTimeout(() => this.handleSearch(query), 300)
    })
    // Mobile keyboards submit with Enter/"Search" — run the search immediately
    // instead of leaving the user waiting on a debounce they can't see.
    searchInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      clearTimeout(debounceTimer)
      const query = searchInput.value.trim()
      if (query.length >= 2) this.handleSearch(query)
    })

    this.root.querySelector('#tonight-hourly').addEventListener('click', (e) => this.handleHourCardClick(e))

    this.root.querySelector('#notif-modal-close').addEventListener('click', () => {
      this.root.querySelector('#notif-modal').setAttribute('hidden', '')
    })

    this.root.querySelectorAll('.modal-overlay').forEach((overlay) => {
      overlay.addEventListener('click', (e) => {
        if (e.target !== overlay) return
        if (overlay.id === 'confidence-modal') this.closeConfidenceModal()
        else overlay.setAttribute('hidden', '')
      })
    })
  }

  // ---------------------------------------------------------------------
  // Red Mode
  // ---------------------------------------------------------------------

  applyStoredRedMode() {
    const stored = localStorage.getItem(RED_MODE_KEY)
    const enabled = stored === 'true'
    document.body.classList.toggle('red-mode', enabled)
    this.root.querySelector('#red-mode-btn').setAttribute('aria-pressed', String(enabled))
  }

  toggleRedMode() {
    const enabled = document.body.classList.toggle('red-mode')
    this.root.querySelector('#red-mode-btn').setAttribute('aria-pressed', String(enabled))
    localStorage.setItem(RED_MODE_KEY, String(enabled))
  }

  // ---------------------------------------------------------------------
  // Disclaimer modal
  // ---------------------------------------------------------------------

  maybeShowDisclaimer() {
    if (localStorage.getItem(DISCLAIMER_DISMISSED_KEY) === 'true') return
    this.root.querySelector('#disclaimer-modal').removeAttribute('hidden')
  }

  dismissDisclaimer(permanently) {
    if (permanently) {
      try {
        localStorage.setItem(DISCLAIMER_DISMISSED_KEY, 'true')
      } catch (err) {
        console.warn('[disclaimer] could not save dismissal to localStorage', err)
      }
    }
    this.root.querySelector('#disclaimer-modal').setAttribute('hidden', '')
  }

  // ---------------------------------------------------------------------
  // Notification bell
  // ---------------------------------------------------------------------

  async initBellState() {
    if ('Notification' in window && Notification.permission === 'denied') {
      this.updateBellIcon('denied')
      return
    }
    const status = await getSubscriptionStatus()
    this.updateBellIcon(status)
  }

  async handleNotificationBell() {
    if ('Notification' in window && Notification.permission === 'denied') {
      this.updateBellIcon('denied')
      this.showNotifToast('Notifications are blocked. Enable them in your browser settings.')
      return
    }

    const status = await getSubscriptionStatus()

    if (status === 'unsupported') {
      this.showNotifToast("Push notifications aren't supported in this browser.")
      return
    }

    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
    const isStandalone = window.navigator.standalone === true
    if (isIOS && !isStandalone) {
      this.openNotifModal('Add Astro Weather to your Home Screen first, then tap the bell to enable clear sky alerts.')
      return
    }

    if (status === 'subscribed') {
      if (confirm('Disable clear sky push notifications?')) {
        await unsubscribe()
        this.updateBellIcon('unsubscribed')
        this.showNotifToast('Notifications disabled.')
      }
      return
    }

    const result = await requestAndSubscribe()
    if (result.ok) {
      this.updateBellIcon('subscribed')
      this.showNotifToast("You'll be notified when clear skies are coming!")
    } else if (result.reason === 'denied') {
      this.updateBellIcon('denied')
      this.showNotifToast('Notifications blocked. Enable them in your browser settings.')
    } else if (result.reason === 'ios-not-installed') {
      this.openNotifModal('Add Astro Weather to your Home Screen first, then tap the bell to enable clear sky alerts.')
    } else if (result.reason === 'server-error') {
      this.showNotifToast('Could not connect to notification server. Try again later.')
    }
  }

  updateBellIcon(state) {
    const btn = this.root.querySelector('#notif-btn')
    btn.dataset.notifState = state
    if (state === 'subscribed') {
      btn.textContent = '🔔'
      btn.classList.add('notif-active')
      btn.classList.remove('notif-denied')
    } else if (state === 'denied') {
      btn.textContent = '🔕'
      btn.classList.remove('notif-active')
      btn.classList.add('notif-denied')
    } else {
      btn.textContent = '🔔'
      btn.classList.remove('notif-active', 'notif-denied')
    }
  }

  showNotifToast(message, duration = 3500) {
    const toast = this.root.querySelector('#notif-toast')
    toast.textContent = message
    toast.removeAttribute('hidden')
    clearTimeout(this._toastTimer)
    this._toastTimer = setTimeout(() => toast.setAttribute('hidden', ''), duration)
  }

  openNotifModal(message) {
    this.root.querySelector('#notif-modal-body').textContent = message
    this.root.querySelector('#notif-modal').removeAttribute('hidden')
  }

  // ---------------------------------------------------------------------
  // Location handling
  // ---------------------------------------------------------------------

  openLocationPrompt(canClose) {
    const prompt = this.root.querySelector('#location-prompt')
    const closeBtn = this.root.querySelector('#location-prompt-close')
    closeBtn.toggleAttribute('hidden', !canClose)
    this.root.querySelector('#location-error').setAttribute('hidden', '')
    this.root.querySelector('#location-search').value = ''
    this.renderSearchResults([])
    this.setSearchStatus(null)
    prompt.removeAttribute('hidden')
  }

  closeLocationPrompt() {
    this.root.querySelector('#location-prompt').setAttribute('hidden', '')
  }

  showLocationError(message) {
    const el = this.root.querySelector('#location-error')
    el.textContent = message
    el.removeAttribute('hidden')
  }

  async handleUseMyLocation() {
    if (!('geolocation' in navigator)) {
      this.showLocationError('Geolocation is not supported in this browser.')
      return
    }
    const btn = this.root.querySelector('#use-my-location-btn')
    const originalLabel = btn.textContent
    btn.disabled = true
    btn.textContent = '📡 Locating…'
    this.root.querySelector('#location-error').setAttribute('hidden', '')

    let position
    try {
      position = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          timeout: 20000,
          maximumAge: 60000,
        })
      )
    } catch (err) {
      console.warn('[location] getCurrentPosition failed', err)
      const code = err?.code
      if (code === 1) {
        this.showLocationError('Location access was denied. Enable location permission in your browser settings and try again.')
      } else if (code === 3) {
        this.showLocationError('Location request timed out. Move outdoors for a better GPS signal, then try again — or search instead.')
      } else {
        this.showLocationError('Your location could not be determined. Try searching instead.')
      }
      btn.disabled = false
      btn.textContent = originalLabel
      return
    }

    try {
      const lat = position.coords.latitude
      const lng = position.coords.longitude

      // Reverse geocoding only supplies a display name — it must never block the
      // forecast. If Nominatim is slow, down, or unreachable, fall back to
      // showing coordinates and carry on.
      btn.textContent = '📡 Naming your location…'
      let name
      try {
        name = await reverseGeocode(lat, lng)
      } catch (err) {
        console.warn('[location] reverse geocode failed, using coordinates', err)
        name = formatCoords(lat, lng)
      }

      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
      this.selectLocation({ lat, lng, name, timezone })
    } catch (err) {
      console.warn('[location] failed after position was acquired', err)
      this.showLocationError('Your position was found but the forecast could not be started. Please try again.')
    } finally {
      btn.disabled = false
      btn.textContent = originalLabel
    }
  }

  async handleSearch(query) {
    // Guard against out-of-order responses: a slow response for an older query
    // must not clobber the results of a newer one.
    const seq = (this._searchSeq = (this._searchSeq ?? 0) + 1)
    this.setSearchStatus('Searching…')
    try {
      const results = await searchLocations(query)
      if (seq !== this._searchSeq) return
      console.log(`[search] "${query}" returned ${results.length} result(s)`)
      this.renderSearchResults(results)
      this.setSearchStatus(
        results.length === 0 ? 'No matching locations found — try the nearest town or suburb.' : null
      )
    } catch (err) {
      if (seq !== this._searchSeq) return
      console.warn(`[search] "${query}" failed`, err)
      this.renderSearchResults([])
      this.setSearchStatus('Location search failed — check your connection and try again.')
    }
  }

  setSearchStatus(message) {
    const el = this.root.querySelector('#search-status')
    if (!message) {
      el.setAttribute('hidden', '')
      return
    }
    el.textContent = message
    el.removeAttribute('hidden')
  }

  renderSearchResults(results) {
    const container = this.root.querySelector('#search-results')
    if (results.length === 0) {
      container.innerHTML = ''
      container.setAttribute('hidden', '')
      return
    }
    container.innerHTML = results
      .map(
        (r, i) => `
        <button class="search-result" data-index="${i}">
          <span class="search-result-name">${escapeHtml(r.name)}</span>
          <span class="search-result-meta">${escapeHtml([r.admin1, r.country].filter(Boolean).join(', '))}</span>
        </button>`
      )
      .join('')
    container.removeAttribute('hidden')
    this._searchResults = results
    container.querySelectorAll('.search-result').forEach((btn) => {
      btn.addEventListener('click', () => {
        const r = this._searchResults[Number(btn.dataset.index)]
        this.selectLocation({
          lat: r.latitude,
          lng: r.longitude,
          name: [r.name, r.admin1].filter(Boolean).join(', '),
          timezone: r.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        })
      })
    })
  }

  selectLocation(location) {
    // localStorage can throw (e.g. private browsing) — persistence failing
    // should not stop this session's forecast.
    try {
      saveLocation(location)
    } catch (err) {
      console.warn('[location] could not save location to localStorage', err)
    }
    this.state.location = location
    this.setLocationLabel(location.name)
    this.closeLocationPrompt()
    syncSubscriptionLocation(location).then((result) => {
      if (!result.ok && result.reason !== 'unsubscribed' && result.reason !== 'unsupported') {
        console.warn('[notifications] could not update subscription location', result.reason)
      }
    })
    this.fetchForecast(location)
  }

  setLocationLabel(name) {
    this.root.querySelector('#location-name').textContent = name
  }

  // ---------------------------------------------------------------------
  // Worker / forecast fetching
  // ---------------------------------------------------------------------

  fetchForecast(location) {
    void this.lightning?.check(location)
    const previous = this.state.forecastLocation
    if (!previous || previous.lat !== location.lat || previous.lng !== location.lng ||
        previous.timezone !== location.timezone) {
      this.clearForecast()
    }
    this.showForecastError(null)
    this.showLoading(!this.state.nights, 'Starting forecast…')
    this.worker?.terminate()
    this.worker = null

    try {
      const worker = new Worker(new URL('./weatherWorker.js', import.meta.url), { type: 'module' })
      this.worker = worker
      worker.onmessage = (event) => {
        if (this.worker === worker) this.handleWorkerMessage(event)
      }
      worker.onerror = () => {
        if (this.worker === worker) this.finishForecast({ message: 'Something went wrong fetching the forecast.' })
      }
      this.renderForecastStatus()
      worker.postMessage({
        type: 'FETCH_FORECAST',
        lat: location.lat,
        lng: location.lng,
        timezone: location.timezone,
      })
    } catch {
      this.finishForecast({ message: 'The forecast could not be started. Try again in a moment.' })
    }
  }

  handleWorkerMessage(event) {
    const { type } = event.data
    if (type === 'PROGRESS') {
      if (!this.state.nights) this.showLoading(true, event.data.step)
    } else if (type === 'FORECAST_READY') {
      const { nights, meta, inProgressNight } = event.data
      if (!nights?.length) {
        this.finishForecast({ message: 'No forecast nights were returned.' })
        return
      }
      if (this.state.nights && meta?.cached?.length && meta.cached.length === meta.available.length) {
        this.finishForecast({ message: 'Only cached model data was available.' })
        return
      }
      this.state.nights = inProgressNight ? [
        { ...inProgressNight.night, wholeNightSummaryAvailable: inProgressNight.wholeNightSummaryAvailable },
        ...nights,
      ] : nights
      this.state.meta = meta ?? null
      this.state.forecastLocation = this.state.location
      this.state.forecastFetchedAt = meta?.cached?.length ? null : new Date()
      this.state.refreshFailed = false
      this.closeConfidenceModal()
      this.renderDataNotice(this.state.meta)
      this.renderDashboard(new Date(), true)
      this.finishForecast()
    } else if (type === 'FORECAST_ERROR') {
      this.finishForecast(event.data)
    }
  }

  finishForecast(error = null) {
    this.worker?.terminate()
    this.worker = null
    this.showLoading(false)
    if (error && this.state.nights) {
      this.state.refreshFailed = true
    } else {
      this.showForecastError(error)
    }
    this.renderForecastStatus()
  }

  clearForecast() {
    clearTimeout(this.dashboardTimer)
    this.state.nights = null
    this.state.meta = null
    this.state.forecastLocation = null
    this.state.forecastFetchedAt = null
    this.state.refreshFailed = false
    this.state.selectedNightDate = null
    this.state.dashboardNightIndex = null
    this.selectedForecastHour = null
    this.closeConfidenceModal()
    this.root.querySelector('#tonight-panel').setAttribute('hidden', '')
    this.renderDataNotice(null)
    this.renderForecastStatus()
  }

  renderForecastStatus() {
    const { nights, meta, forecastFetchedAt, refreshFailed } = this.state
    this.root.querySelector('#forecast-status').toggleAttribute('hidden', !nights)
    const warning = this.root.querySelector('#forecast-refresh-warning')
    warning.toggleAttribute('hidden', !refreshFailed)
    if (!nights) return

    const timeZone = safeTimeZone(meta?.timezone ?? this.state.location?.timezone)
    const cached = (meta?.cached ?? []).map((model) => MODEL_LABEL[model] ?? model)
    const status = this.root.querySelector('#forecast-freshness')
    if (cached.length) {
      status.textContent = `Using cached data for ${cached.join(', ')}. Those models could not be refreshed.`
    } else if (forecastFetchedAt) {
      const day = formatCivilDate(zonedDateString(forecastFetchedAt, timeZone), timeZone)
      status.textContent = `Last fetched ${day} at ${formatTime(forecastFetchedAt, timeZone)} (site time)`
    }

    if (refreshFailed) {
      const night = formatCivilDate(nights[0].date, timeZone)
      warning.textContent = `Refresh failed. Showing the previous forecast, starting ${night}.`
    }
    const button = this.root.querySelector('#forecast-refresh-btn')
    button.disabled = Boolean(this.worker)
    button.textContent = this.worker ? 'Refreshing…' : 'Refresh forecast'
  }

  showForecastError(error) {
    const panel = this.root.querySelector('#forecast-error')
    if (!error) {
      panel.setAttribute('hidden', '')
      return
    }
    const detail = (error.failures ?? []).map((f) => `${MODEL_LABEL[f.model] ?? f.model}: ${f.reason}`).join(' · ')
    this.root.querySelector('#forecast-error-detail').textContent = detail
      ? `No weather model could be reached. ${detail}`
      : error.message ?? 'Try again in a moment.'
    panel.removeAttribute('hidden')
  }

  // One or two models are missing: the blend still runs on whatever arrived, but the
  // user is told which opinions are absent and how much confidence that costs.
  renderDataNotice(meta) {
    const el = this.root.querySelector('#data-notice')
    if (!meta?.degraded) {
      el.setAttribute('hidden', '')
      return
    }
    const missing = meta.missing.map((m) => {
      const failure = meta.failures?.find((item) => item.model === m)
      const reason = failure?.reason?.includes('timed out') ? ' (timed out)' : ''
      return `${MODEL_LABEL[m] ?? m}${reason}`
    }).join(' and ')
    const present = meta.available.map((m) => MODEL_LABEL[m] ?? m).join(' + ')
    const pct = Math.round(meta.weightCoverage * 100)
    el.innerHTML = `
      <span class="data-notice-icon" aria-hidden="true">⚠</span>
      <span><strong>Model data unavailable</strong> — ${escapeHtml(missing)}.
      Blended from ${escapeHtml(present)} only (${pct}% of the usual ensemble weight).</span>`
    el.removeAttribute('hidden')
  }

  showLoading(visible, step) {
    const overlay = this.root.querySelector('#loading-overlay')
    overlay.toggleAttribute('hidden', !visible)
    if (visible && step) this.root.querySelector('#loading-step').textContent = step
  }

  // ---------------------------------------------------------------------
  // Tonight panel
  // ---------------------------------------------------------------------

  renderDashboard(now = new Date(), redraw = false) {
    const { nights, selectedNightDate } = this.state
    if (!nights?.length) return
    const timeZone = this.state.meta?.timezone ?? this.state.location?.timezone
    const currentIndex = defaultNightIndex(nights, now, timeZone)
    const requestedIndex = nights.findIndex((night) => night.date === selectedNightDate)
    const index = requestedIndex < 0 ? currentIndex : requestedIndex
    if (requestedIndex < 0) this.state.selectedNightDate = null
    this.renderNightPicker(index, now, timeZone)
    if (redraw || index !== this.state.dashboardNightIndex) {
      this.state.dashboardNightIndex = index
      this.renderTonight(nights[index], index, now)
    } else if (this.selectedForecastHour == null) {
      this.cloudChart.selectHour(this.defaultForecastHour(nights[index], now))
    }
    clearTimeout(this.dashboardTimer)
    const next = nextDashboardBoundary(nights, now, timeZone)
    this.dashboardTimer = setTimeout(() => this.renderDashboard(), Math.max(1, next - Date.now()))
  }

  renderNightPicker(selectedIndex, now, timeZone) {
    const picker = this.root.querySelector('#night-picker')
    this.root.querySelector('#upcoming-nights').hidden = this.state.nights.length < 2
    const today = zonedDateString(now, safeTimeZone(timeZone))
    const markup = this.state.nights.map((night, index) => {
      const label = night.date === today ? 'Tonight' : isActiveNight(night, now) ? 'In progress' : ''
      const date = formatNightDate(night.date, timeZone)
      const score = night.wholeNightSummaryAvailable === false ? null : night.nightAvg?.score ?? null
      const verdict = scoreToVerdict(score)
      const scoreText = score === null ? '—' : Math.round(score)
      const scoreLabel = score === null ? 'suitability score unavailable' : `suitability ${scoreText} out of 100, ${VERDICT_LABEL[verdict]}`
      const buttonLabel = [label, date, scoreLabel].filter(Boolean).join(', ')
      return `
        <button type="button" data-select-night="${escapeHtml(night.date)}" aria-pressed="${index === selectedIndex}" aria-label="${escapeHtml(buttonLabel)}">
          <span class="night-picker-date">${label ? `<strong>${label}</strong>` : ''}<span>${date}</span></span>
          <span class="night-picker-score verdict-text-${verdict}" aria-hidden="true">${scoreText}</span>
        </button>`
    }).join('')
    if (markup === this.nightPickerMarkup) return
    this.nightPickerMarkup = markup
    const focused = document.activeElement?.dataset?.selectNight
    const left = picker.scrollLeft
    picker.innerHTML = markup
    picker.scrollLeft = left
    if (focused) {
      [...picker.children].find((button) => button.dataset.selectNight === focused)?.focus({ preventScroll: true })
    }
  }

  renderTonight(night, nightIndex, now) {
    this.root.querySelector('#tonight-panel').removeAttribute('hidden')
    const timeZone = this.state.meta?.timezone ?? this.state.location?.timezone
    const fullSummary = night.wholeNightSummaryAvailable !== false
    const avgScore = fullSummary ? night.nightAvg.score : null
    const avgCloud = fullSummary ? night.nightAvg.cloud : null
    const cloudContext = !fullSummary ? 'Earlier forecast hours unavailable'
      : night.hours.some(({ isDark, cloud }) => isDark && cloud == null) ? 'Astronomical darkness · Partial data'
      : 'During astronomical darkness'
    const verdict = scoreToVerdict(avgScore)
    const coverage = this.state.meta?.available?.length
    const today = zonedDateString(now, safeTimeZone(timeZone))
    const nightTitle = night.date === today ? 'Tonight' : formatNightDate(night.date, timeZone)

    this.root.querySelector('#hero-readout').innerHTML = `
      <h2 id="hero-night-label">${nightTitle}</h2>
      <p class="hero-cloud-average"><strong>${formatPercent(avgCloud)}</strong><span>Average cloud cover<small>${cloudContext}</small></span></p>`
    this.root.querySelector('#night-score').innerHTML = `
      <strong>Astro score ${avgScore === null ? '—' : `${Math.round(avgScore)} / 100`}</strong>
      <span>${VERDICT_LABEL[verdict]} · ${fullSummary ? CONFIDENCE_LABEL[night.confidence] ?? 'Unknown confidence' : 'Partial night · earlier data unavailable'}${coverage != null ? ` · ${coverage}/3 models` : ''}</span>`

    this.root.querySelector('#moon-illumination').textContent = `${formatPercent(night.moonIllum == null ? null : night.moonIllum * 100)} at site midnight`
    this.root.querySelector('#moon-range').textContent = formatMoonRange(night, timeZone)
    this.root.querySelector('#mw-range').textContent = formatMilkyWayRange(night, timeZone)
    this.root.querySelector('#summary-metrics').innerHTML = fullSummary
      ? renderNightSummary(night)
      : '<p>Whole-night averages unavailable. Earlier hours are missing.</p>'
    this.root.querySelector('#optimal-window-callout').innerHTML = renderBestWindow(night, timeZone)

    if (this.chartNightDate !== night.date) this.selectedForecastHour = null
    this.chartNightDate = night.date
    this.cloudChart = renderCloudChart(this.root.querySelector('#tonight-hourly'), night, nightIndex, timeZone, (index, manual) => {
      if (manual) this.selectedForecastHour = +night.hours[index].time
      this.renderHourDetails(night, index)
    })
    const selected = night.hours.findIndex(({ time }) => +time === this.selectedForecastHour)
    if (selected < 0) this.selectedForecastHour = null
    this.cloudChart.selectHour(selected < 0 ? this.defaultForecastHour(night, now) : selected)
  }

  defaultForecastHour(night, now) {
    const reading = skyReading(night, now)
    const currentHour = night.hours.findIndex((hour) => reading.hour && +hour.time === +reading.hour)
    const firstDark = night.hours.findIndex((hour) => hour.isDark && hour.cloud != null)
    const usableHour = night.hours.findIndex((hour) => hour.cloud != null)
    return [currentHour, firstDark, usableHour, 0].find((index) => index >= 0)
  }

  updateHeroSky(cloud) {
    const canvas = this.root.querySelector('#hero-clouds')
    const sky = this.root.querySelector('#hero-sky')
    sky.dataset.sky = cloud == null || !paintHeroClouds(canvas, cloud) ? 'unavailable' : 'forecast'
    this.root.querySelector('#hero-sky-label').textContent = cloud == null
      ? 'Cloud forecast unavailable'
      : 'Sky illustration'
  }

  renderHourDetails(night, index) {
    const hour = night.hours[index]
    if (!hour) return
    this.state.dashboardHourIndex = index
    this.updateHeroSky(hour.cloud)
    const time = formatDashboardHour(night, hour.time, this.state.meta?.timezone ?? this.state.location?.timezone)
    this.root.querySelector('#selected-cloud-hour').textContent = `${time} · ${formatPercent(hour.cloud)} total`
    this.root.querySelector('#selected-conditions-hour').textContent = time
    this.root.querySelector('#hour-cloud-layers').innerHTML = renderCloudLayers(hour)
    this.root.querySelector('#hour-conditions').innerHTML = renderHourConditions(hour)
  }

  // ---------------------------------------------------------------------
  // Confidence modal
  // ---------------------------------------------------------------------

  handleHourCardClick(e) {
    const card = e.target.closest('[data-hour-index]')
    if (!card) return
    const nightIndex = Number(card.dataset.nightIndex)
    const hourIndex = Number(card.dataset.hourIndex)
    const night = this.state.nights[nightIndex]
    const hour = night.hours[hourIndex]
    this.cloudChart.selectHour(hourIndex, true)
    this.openConfidenceModal(night, hour, card)
  }

  openConfidenceModal(night, hour, trigger = null) {
    const tz = this.state.meta?.timezone ?? this.state.location?.timezone
    const date = formatCivilDate(zonedDateString(hour.time, safeTimeZone(tz)), tz)
    this.root.querySelector('#confidence-modal-time').textContent = `${formatDashboardHour(night, hour.time, tz)} · ${date}`
    this.root.querySelector('#confidence-modal-body').innerHTML = renderConfidenceModalBody(hour)
    this.root.querySelector('#confidence-modal').removeAttribute('hidden')
    this.confidenceTrigger = trigger
    this.root.querySelector('#confidence-modal-close').focus?.()
  }

  closeConfidenceModal() {
    this.root.querySelector('#confidence-modal').setAttribute('hidden', '')
    this.confidenceTrigger?.focus()
    this.confidenceTrigger = null
  }

  // ---------------------------------------------------------------------
  // Satellite view
  // ---------------------------------------------------------------------

  toggleSatellite() {
    this.state.satelliteVisible = !this.state.satelliteVisible
    const container = this.root.querySelector('#satellite-container')
    const btn = this.root.querySelector('#satellite-toggle')
    if (this.state.satelliteVisible && this.state.location) {
      const { lat, lng } = this.state.location
      container.innerHTML = `<iframe
        title="Satellite view"
        loading="lazy"
        src="https://embed.windy.com/embed2.html?lat=${lat}&lon=${lng}&zoom=7&level=surface&overlay=satellite&menu=&message=&marker=&calendar=&pressure=&type=map&location=coordinates&detail=&metricWind=km%2Fh&metricTemp=%C2%B0C&radarRange=-1"
        frameborder="0"
      ></iframe>`
      container.removeAttribute('hidden')
      btn.textContent = 'Hide Satellite View'
    } else {
      container.setAttribute('hidden', '')
      container.innerHTML = ''
      btn.textContent = 'Show Satellite View'
    }
  }

  // ---------------------------------------------------------------------
  // Update banner (called from main.js on SW needRefresh)
  // ---------------------------------------------------------------------

  showUpdateBanner(onClick) {
    const banner = this.root.querySelector('#update-banner')
    banner.removeAttribute('hidden')
    banner.addEventListener(
      'click',
      () => {
        onClick()
      },
      { once: true }
    )
  }
}

// ---------------------------------------------------------------------
// Location storage
// ---------------------------------------------------------------------

function loadLocation() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function saveLocation(location) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(location))
}

// ---------------------------------------------------------------------
// Geocoding
// ---------------------------------------------------------------------

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function searchLocations(query) {
  const params = new URLSearchParams({
    name: query,
    count: 5,
    language: 'en',
    format: 'json',
    countryCode: 'AU',
  })
  const url = `https://geocoding-api.open-meteo.com/v1/search?${params}`
  console.log('[search] requesting', url)
  const res = await fetchWithTimeout(url, 10000)
  if (!res.ok) throw new Error(`Geocoding request failed: HTTP ${res.status}`)
  const json = await res.json()
  return json.results ?? []
}

async function reverseGeocode(lat, lng) {
  const params = new URLSearchParams({ lat, lon: lng, format: 'json' })
  const res = await fetchWithTimeout(`https://nominatim.openstreetmap.org/reverse?${params}`, 8000)
  if (!res.ok) throw new Error(`Reverse geocoding failed: HTTP ${res.status}`)
  const json = await res.json()
  return (
    json.address?.suburb ??
    json.address?.city ??
    json.address?.town ??
    json.address?.village ??
    json.address?.municipality ??
    json.display_name ??
    formatCoords(lat, lng)
  )
}

function formatCoords(lat, lng) {
  const latLabel = `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'}`
  const lngLabel = `${Math.abs(lng).toFixed(2)}°${lng < 0 ? 'W' : 'E'}`
  return `${latLabel}, ${lngLabel}`
}

// ---------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------

function formatTime(date, timeZone) {
  return formatTimeInZone(date, timeZone)
}

function formatPercent(value) {
  return value === null || value === undefined ? '—' : `${Math.round(value)}%`
}

function formatNightDate(dateStr, timeZone) {
  return formatCivilDate(dateStr, timeZone)
}

function formatMoonRange(night, timeZone) {
  const upAtStart = night.hours[0]?.moonAlt > 0
  if (!night.moonrise && !night.moonset) {
    return upAtStart ? 'Moon: Up all night' : 'Moon: Below horizon all night'
  }
  const parts = []
  if (night.moonrise) parts.push(`rises ${formatTime(night.moonrise, timeZone)}`)
  if (night.moonset) parts.push(`sets ${formatTime(night.moonset, timeZone)}`)
  return `Moon: ${parts.join(' / ')}`
}

function formatMilkyWayRange(night, timeZone) {
  const visibleAtStart = night.hours[0]?.mwVisible
  if (!night.mwRise && !night.mwSet) {
    return visibleAtStart ? 'Milky Way: Visible all night' : 'Milky Way: Not visible tonight'
  }
  const parts = []
  if (night.mwRise) parts.push(`rises ${formatTime(night.mwRise, timeZone)}`)
  if (night.mwSet) parts.push(`sets ${formatTime(night.mwSet, timeZone)}`)
  return `Milky Way: ${parts.join(' / ')}`
}

function renderBestWindow(night, timeZone) {
  const title = '<h3>Best observing window</h3>'
  if (night.wholeNightSummaryAvailable === false) {
    return `${title}<p>Whole-night window unavailable</p>`
  }
  const window = night.optimalWindow
  if (!window) return `${title}<p>No scored darkness window</p>`
  const segments = bestWindowSegments(night)
  const start = formatTime(window.startHour, timeZone)
  const end = formatTime(window.endHour, timeZone)
  return `
    <div class="dashboard-heading">${title}<strong>${start === end ? start : `${start}–${end}`}</strong></div>
    <div class="window-track" aria-hidden="true">${segments.map(({ left, width }) =>
      `<span style="--slot-start:${left}%;--slot-size:${width}%"></span>`,
    ).join('')}</div>
    <div class="window-axis" aria-hidden="true"><span>${formatTime(night.displayStart, timeZone)}</span><span>${formatTime(night.displayEnd, timeZone)}</span></div>
    <p>${window.blockSize} scored hour${window.blockSize === 1 ? '' : 's'} · Avg score ${Math.round(window.avg)}/100</p>`
}

function scoreToVerdict(score) {
  if (score === null || score === undefined) return 'unavailable'
  if (score >= 85) return 'great'
  if (score >= 65) return 'good'
  if (score >= 45) return 'fair'
  if (score >= 25) return 'poor'
  return 'verypoor'
}

function cloudVerdict(v) {
  if (v === null || v === undefined) return 'unavailable'
  if (v <= 5)  return 'great'
  if (v <= 15) return 'good'
  if (v <= 30) return 'fair'
  if (v <= 50) return 'poor'
  return 'verypoor'
}

function humidVerdict(v) {
  if (v === null || v === undefined) return 'unavailable'
  if (v < 50) return 'great'
  if (v < 65) return 'good'
  if (v < 75) return 'fair'
  if (v < 85) return 'poor'
  return 'verypoor'
}

function windVerdict(v) {
  if (v === null || v === undefined) return 'unavailable'
  if (v <= 10) return 'great'
  if (v <= 20) return 'good'
  if (v <= 30) return 'fair'
  if (v <= 35) return 'poor'
  return 'verypoor'
}

function dewVerdict(v) {
  if (v === null || v === undefined) return 'unavailable'
  if (v > 8) return 'great'
  if (v > 5) return 'good'
  if (v > 3) return 'fair'
  if (v > 1) return 'poor'
  return 'verypoor'
}

function moonIllumVerdict(pct) {
  if (pct === null || pct === undefined) return 'unavailable'
  if (pct <= 10) return 'great'
  if (pct <= 25) return 'good'
  if (pct <= 50) return 'fair'
  if (pct <= 80) return 'poor'
  return 'verypoor'
}

const METRIC_SUBLABEL = {
  great: 'Great', good: 'Good', fair: 'Fair', poor: 'Poor', verypoor: 'Very Poor', unavailable: '—',
}

function renderNightSummary(night) {
  const avg = night.nightAvg
  const darkHours = night.hours.filter(h => h.isDark && h.temp !== null && h.dewpoint !== null)
  const avgDewSpread = darkHours.length > 0
    ? darkHours.reduce((s, h) => s + (h.temp - h.dewpoint), 0) / darkHours.length
    : null
  const moonPct = avg.moonIllum !== null ? avg.moonIllum * 100 : null

  const metrics = [
    { label: 'Cloud',      value: formatPercent(avg.cloud),                                      verdict: cloudVerdict(avg.cloud) },
    { label: 'Humidity',   value: formatPercent(avg.humidity),                                   verdict: humidVerdict(avg.humidity) },
    { label: 'Wind',       value: avg.windspeed !== null ? `${Math.round(avg.windspeed)} km/h` : '—', verdict: windVerdict(avg.windspeed) },
    { label: 'Dew Spread', value: avgDewSpread !== null ? `${avgDewSpread.toFixed(1)}°`         : '—', verdict: dewVerdict(avgDewSpread) },
    { label: 'Moon',       value: formatPercent(moonPct),                                        verdict: moonIllumVerdict(moonPct) },
  ]

  return `<div class="summary-metrics">${metrics.map(m => `
    <div class="metric-card">
      <span class="metric-label">${m.label}</span>
      <span class="metric-value">${m.value}</span>
      <span class="metric-sublabel verdict-text-${m.verdict}">${METRIC_SUBLABEL[m.verdict] ?? '—'}</span>
    </div>`).join('')}</div>`
}

function renderCloudLayers(hour) {
  const layers = [['Low', hour.cloudLow], ['Mid', hour.cloudMid], ['High', hour.cloudHigh]]
  return layers.map(([label, value]) => `
    <div class="cloud-layer-row">
      <span>${label}</span><span class="cloud-layer-track" aria-hidden="true">
        <span style="--cloud-layer-fill:${Math.min(100, Math.max(0, value ?? 0))}%"></span>
      </span><strong>${formatPercent(value)}</strong>
    </div>`).join('')
}

function renderHourConditions(hour) {
  const spread = hour.temp == null || hour.dewpoint == null ? null : hour.temp - hour.dewpoint
  const metrics = [
    ['Temperature', hour.temp == null ? '—' : `${hour.temp.toFixed(1)} °C`, ''],
    ['Humidity', formatPercent(hour.humidity), humidVerdict(hour.humidity)],
    ['Dew spread', spread == null ? '—' : `${spread.toFixed(1)} °C`, dewVerdict(spread)],
    ['Wind', hour.windspeed == null ? '—' : `${Math.round(hour.windspeed)} km/h`, windVerdict(hour.windspeed)],
  ]
  return metrics.map(([name, value, verdict]) => `
    <div><dt>${name}</dt><dd>${value}${verdict && verdict !== 'unavailable'
      ? ` <small class="verdict-text-${verdict}">${METRIC_SUBLABEL[verdict]}</small>` : ''}</dd></div>`).join('')
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

// ---------------------------------------------------------------------
// Confidence modal body
// ---------------------------------------------------------------------

function renderConfidenceModalBody(hour) {
  const agreementBadge = {
    agree: '<span class="agreement-badge agree">✓ Models Agree</span>',
    mixed: '<span class="agreement-badge mixed">⚠ Some Model Disagreement</span>',
    disagree: '<span class="agreement-badge disagree">✗ Models Disagree</span>',
    // Only one model returned data — there is no agreement to report, and saying
    // "Models Agree" off a single opinion would overstate the confidence.
    single: '<span class="agreement-badge disagree">⚠ Single Model Only</span>',
  }[hour.agreement]

  const modelRow = (label, low, mid, high, total) => `
    <tr>
      <td>${label}</td>
      <td>${formatPercent(low)}</td>
      <td>${formatPercent(mid)}</td>
      <td>${formatPercent(high)}</td>
      <td>${formatPercent(total)}</td>
    </tr>`

  const table = `
    <table class="cloud-table">
      <thead><tr><th>Model</th><th>Low</th><th>Mid</th><th>High</th><th>Total</th></tr></thead>
      <tbody>
        <tr><td>ECMWF</td><td colspan="3"></td><td>${formatPercent(hour.cloudEcmwf)}</td></tr>
        <tr><td>UKMO</td><td colspan="3"></td><td>${formatPercent(hour.cloudUkmo)}</td></tr>
        <tr><td>ICON</td><td colspan="3"></td><td>${formatPercent(hour.cloudIcon)}</td></tr>
        <tr class="blended-row">
          <td>Blended</td><td>${formatPercent(hour.cloudLow)}</td><td>${formatPercent(hour.cloudMid)}</td>
          <td>${formatPercent(hour.cloudHigh)}</td><td><strong>${formatPercent(hour.cloud)}</strong></td>
        </tr>
      </tbody>
    </table>`

  const capNote = hour.vetoed
    ? `<p class="score-veto-note">Weighted score ${hour.uncappedScore} capped to ${hour.cap} by ${
        VETO_LABEL[hour.vetoed] ?? 'a limiting condition'
      }.</p>`
    : ''

  const confidenceNote =
    hour.confidence === 'partial'
      ? `<p class="score-veto-note">Partial data — missing ${escapeHtml((hour.missingData ?? []).join(', '))}. The numeric score is shown, but confidence is reduced.</p>`
      : ''

  const scoreBars = hour.isDark
    ? hour.components
      ? `
      <div class="score-breakdown summary-metrics">
        ${scoreMetric('Cloud', 35, hour.components.cloudScore)}
        ${scoreMetric('Moon', 30, hour.components.moonScore)}
        ${scoreMetric('Humidity', 15, hour.components.humidScore)}
        ${scoreMetric('Dew', 10, hour.components.dewScore)}
        ${scoreMetric('Wind', 10, hour.components.windScore)}
      </div>${capNote}`
      : '<p class="score-veto-note">No model data for this hour — it is excluded from the night average.</p>'
    : ''

  return `
    ${table}
    <div class="agreement-row">${agreementBadge ?? ''}</div>
    ${confidenceNote}
    ${scoreBars}
  `
}

function scoreMetric(label, weightPct, value) {
  const verdict = scoreToVerdict(value)
  return `
    <div class="metric-card">
      <span class="metric-label">${label} <span class="metric-weight">(${weightPct}% wt)</span></span>
      <span class="metric-value">${value !== null && value !== undefined ? Math.round(value) : '—'}<span class="metric-unit">/100</span></span>
      <span class="metric-sublabel verdict-text-${verdict}">${METRIC_SUBLABEL[verdict] ?? '—'}</span>
    </div>`
}
