import { requestAndSubscribe, unsubscribe, getSubscriptionStatus } from './notifications.js'

const STORAGE_KEY = 'astro-location'
const RED_MODE_KEY = 'astro-red-mode'

const VERDICT_LABEL = {
  great: 'Great',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  verypoor: 'Very Poor',
  unavailable: 'No Data',
}

// scoreHour() short-circuits on a hard veto and returns just {score, verdict, vetoed} —
// no component breakdown, since the veto overrides the weighted formula entirely.
const VETO_LABEL = {
  'cloud>70': 'Score capped — cloud cover above 70% overrides the component breakdown.',
  'cloud>50': 'Score capped — cloud cover above 50% overrides the component breakdown.',
  brightmoon: 'Score capped — bright moon (>80% illuminated, above the horizon) overrides the component breakdown.',
}

export class App {
  constructor() {
    this.root = document.querySelector('#app')
    this.state = {
      location: null,
      nights: null,
      expandedOutlookIndex: null,
      modalContext: null,
      satelliteVisible: false,
    }
    this.worker = null
  }

  init() {
    this.renderShell()
    this.bindShellEvents()
    this.applyStoredRedMode()
    this.initBellState()

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
          <h1 class="app-title">Astro Weather</h1>
          <div class="header-actions">
            <button id="red-mode-btn" class="icon-btn" aria-label="Toggle Red Mode" title="Red Mode">🌙</button>
            <button id="notif-btn" class="icon-btn" aria-label="Notifications" title="Notifications">🔔</button>
          </div>
        </div>
        <div class="location-row">
          <span id="location-name" class="location-name">Loading…</span>
          <button id="change-location-btn" class="link-btn">Change</button>
        </div>
      </header>

      <main id="main-content">
        <section id="tonight-panel" class="panel" hidden>
          <h2 class="panel-title">Tonight</h2>
          <div class="ephemeris-banner">
            <div class="ephemeris-item"><span class="ephemeris-icon">🌑</span><span id="astro-dark-range"></span></div>
            <div class="ephemeris-item"><span class="ephemeris-icon">🌕</span><span id="moon-range"></span></div>
            <div class="ephemeris-item"><span class="ephemeris-icon">🌌</span><span id="mw-range"></span></div>
          </div>
          <div id="summary-metrics"></div>
          <div id="optimal-window-callout" class="optimal-window"></div>
          <div id="tonight-hourly" class="hourly-scroll"></div>
        </section>

        <section id="outlook-panel" class="panel" hidden>
          <h2 class="panel-title">6-Day Outlook</h2>
          <div id="outlook-list" class="outlook-list"></div>
        </section>

        <section id="satellite-panel" class="panel">
          <button id="satellite-toggle" class="secondary-btn">Show Satellite View</button>
          <div id="satellite-container" class="satellite-container" hidden></div>
        </section>
      </main>

      <div id="loading-overlay" class="loading-overlay" hidden>
        <div class="stars" aria-hidden="true"></div>
        <p id="loading-step" class="loading-step">Loading…</p>
      </div>

      <div id="location-prompt" class="modal-overlay" hidden>
        <div class="modal-card">
          <button id="location-prompt-close" class="modal-close" aria-label="Close" hidden>×</button>
          <h2>Choose a Location</h2>
          <button id="use-my-location-btn" class="primary-btn">📍 Use My Location</button>
          <div class="search-wrap">
            <input id="location-search" type="text" placeholder="Search for a town or suburb…" autocomplete="off" />
            <div id="search-results" class="search-results" hidden></div>
          </div>
          <p id="location-error" class="location-error" hidden></p>
        </div>
      </div>

      <div id="confidence-modal" class="modal-overlay" hidden>
        <div class="modal-card">
          <button id="confidence-modal-close" class="modal-close" aria-label="Close">×</button>
          <h2 id="confidence-modal-time"></h2>
          <div id="confidence-modal-body"></div>
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
    this.root.querySelector('#change-location-btn').addEventListener('click', () => this.openLocationPrompt(true))
    this.root.querySelector('#location-prompt-close').addEventListener('click', () => this.closeLocationPrompt())
    this.root.querySelector('#use-my-location-btn').addEventListener('click', () => this.handleUseMyLocation())
    this.root.querySelector('#confidence-modal-close').addEventListener('click', () => this.closeConfidenceModal())
    this.root.querySelector('#satellite-toggle').addEventListener('click', () => this.toggleSatellite())

    const searchInput = this.root.querySelector('#location-search')
    let debounceTimer = null
    searchInput.addEventListener('input', () => {
      clearTimeout(debounceTimer)
      const query = searchInput.value.trim()
      if (query.length < 2) {
        this.renderSearchResults([])
        return
      }
      debounceTimer = setTimeout(() => this.handleSearch(query), 300)
    })

    this.root.querySelector('#tonight-hourly').addEventListener('click', (e) => this.handleHourCardClick(e))
    this.root.querySelector('#outlook-list').addEventListener('click', (e) => this.handleOutlookClick(e))

    this.root.querySelector('#notif-modal-close').addEventListener('click', () => {
      this.root.querySelector('#notif-modal').setAttribute('hidden', '')
    })

    this.root.querySelectorAll('.modal-overlay').forEach((overlay) => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.setAttribute('hidden', '')
      })
    })
  }

  // ---------------------------------------------------------------------
  // Red Mode
  // ---------------------------------------------------------------------

  applyStoredRedMode() {
    const stored = localStorage.getItem(RED_MODE_KEY)
    if (stored === 'true') document.body.classList.add('red-mode')
  }

  toggleRedMode() {
    const enabled = document.body.classList.toggle('red-mode')
    localStorage.setItem(RED_MODE_KEY, String(enabled))
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
    try {
      const position = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          timeout: 20000,
          maximumAge: 60000,
        })
      )
      const lat = position.coords.latitude
      const lng = position.coords.longitude
      const name = await reverseGeocode(lat, lng)
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
      this.selectLocation({ lat, lng, name, timezone })
    } catch (err) {
      const code = err?.code
      if (code === 1) {
        this.showLocationError('Location access was denied. Enable location permission in your browser settings and try again.')
      } else if (code === 3) {
        this.showLocationError('Location request timed out. Move outdoors for a better GPS signal, then try again — or search instead.')
      } else {
        this.showLocationError('Your location could not be determined. Try searching instead.')
      }
    }
  }

  async handleSearch(query) {
    try {
      const results = await searchLocations(query)
      this.renderSearchResults(results)
    } catch {
      this.renderSearchResults([])
    }
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
    saveLocation(location)
    this.state.location = location
    this.setLocationLabel(location.name)
    this.closeLocationPrompt()
    this.fetchForecast(location)
  }

  setLocationLabel(name) {
    this.root.querySelector('#location-name').textContent = name
  }

  // ---------------------------------------------------------------------
  // Worker / forecast fetching
  // ---------------------------------------------------------------------

  fetchForecast(location) {
    this.showLoading(true, 'Starting forecast…')
    if (this.worker) this.worker.terminate()
    this.worker = new Worker(new URL('./weatherWorker.js', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event) => this.handleWorkerMessage(event)
    this.worker.onerror = () => {
      this.showLoading(false)
      this.showLocationError('Something went wrong fetching the forecast.')
    }
    this.worker.postMessage({
      type: 'FETCH_FORECAST',
      lat: location.lat,
      lng: location.lng,
      timezone: location.timezone,
    })
  }

  handleWorkerMessage(event) {
    const { type } = event.data
    if (type === 'PROGRESS') {
      this.showLoading(true, event.data.step)
    } else if (type === 'FORECAST_READY') {
      this.state.nights = event.data.nights
      this.showLoading(false)
      this.renderTonight(event.data.nights[0])
      this.renderOutlook(event.data.nights)
    } else if (type === 'FORECAST_ERROR') {
      this.showLoading(false)
      this.showLocationError(`Forecast failed: ${event.data.message}`)
      this.openLocationPrompt(true)
    }
  }

  showLoading(visible, step) {
    const overlay = this.root.querySelector('#loading-overlay')
    overlay.toggleAttribute('hidden', !visible)
    if (visible && step) this.root.querySelector('#loading-step').textContent = step
  }

  // ---------------------------------------------------------------------
  // Tonight panel
  // ---------------------------------------------------------------------

  renderTonight(night) {
    this.root.querySelector('#tonight-panel').removeAttribute('hidden')

    this.root.querySelector('#astro-dark-range').textContent =
      night.astroStart && night.astroEnd
        ? `Astro Dark: ${formatTime(night.astroStart)} – ${formatTime(night.astroEnd)}`
        : 'Astro Dark: unavailable'

    this.root.querySelector('#moon-range').textContent = formatMoonRange(night)
    this.root.querySelector('#mw-range').textContent = formatMilkyWayRange(night)

    this.root.querySelector('#summary-metrics').innerHTML = renderNightSummary(night)
    this.root.querySelector('#optimal-window-callout').textContent = formatOptimalWindow(night.optimalWindow)

    this.root.querySelector('#tonight-hourly').innerHTML = renderHourlyScroll(night, 0)
  }

  // ---------------------------------------------------------------------
  // 7-day outlook
  // ---------------------------------------------------------------------

  renderOutlook(nights) {
    const panel = this.root.querySelector('#outlook-panel')
    panel.removeAttribute('hidden')
    const list = this.root.querySelector('#outlook-list')

    list.innerHTML = nights
      .slice(1)
      .map((night, i) => {
        const nightIndex = i + 1
        const expanded = this.state.expandedOutlookIndex === nightIndex
        const avgScore = night.nightAvg.score
        const verdict = scoreToVerdict(avgScore)
        return `
        <div class="outlook-card" data-night-index="${nightIndex}">
          <button class="outlook-summary" data-action="toggle" data-night-index="${nightIndex}">
            <span class="outlook-date">${formatNightDate(night.date)}</span>
            <span class="outlook-score-badge verdict-${verdict}">${avgScore !== null ? Math.round(avgScore) : '—'}</span>
            <span class="outlook-stats">
              ☁ ${formatPercent(night.nightAvg.cloud)}
              💧 ${formatPercent(night.nightAvg.humidity)}
              🌕 ${formatPercent(night.nightAvg.moonIllum !== null ? night.nightAvg.moonIllum * 100 : null)}
            </span>
          </button>
          <div class="outlook-expanded" ${expanded ? '' : 'hidden'}>
            ${expanded ? `<div class="hourly-scroll">${renderHourlyScroll(night, nightIndex)}</div>` : ''}
          </div>
        </div>`
      })
      .join('')
  }

  handleOutlookClick(e) {
    const toggleBtn = e.target.closest('[data-action="toggle"]')
    if (toggleBtn) {
      const nightIndex = Number(toggleBtn.dataset.nightIndex)
      this.state.expandedOutlookIndex = this.state.expandedOutlookIndex === nightIndex ? null : nightIndex
      this.renderOutlook(this.state.nights)
      return
    }
    this.handleHourCardClick(e)
  }

  // ---------------------------------------------------------------------
  // Confidence modal
  // ---------------------------------------------------------------------

  handleHourCardClick(e) {
    const card = e.target.closest('.hour-card')
    if (!card) return
    const nightIndex = Number(card.dataset.nightIndex)
    const hourIndex = Number(card.dataset.hourIndex)
    const night = this.state.nights[nightIndex]
    const hour = night.hours[hourIndex]
    this.openConfidenceModal(night, hour)
  }

  openConfidenceModal(night, hour) {
    this.root.querySelector('#confidence-modal-time').textContent = formatTime(hour.time)
    this.root.querySelector('#confidence-modal-body').innerHTML = renderConfidenceModalBody(hour)
    this.root.querySelector('#confidence-modal').removeAttribute('hidden')
  }

  closeConfidenceModal() {
    this.root.querySelector('#confidence-modal').setAttribute('hidden', '')
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

async function searchLocations(query) {
  const params = new URLSearchParams({
    name: query,
    count: 5,
    language: 'en',
    format: 'json',
    countryCode: 'AU',
  })
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`)
  const json = await res.json()
  return json.results ?? []
}

async function reverseGeocode(lat, lng) {
  const params = new URLSearchParams({ lat, lon: lng, format: 'json' })
  const res = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`)
  const json = await res.json()
  return json.address?.suburb ?? json.address?.city ?? json.display_name ?? 'Unknown location'
}

// ---------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------

function formatTime(date) {
  if (!date) return '—'
  const d = date instanceof Date ? date : new Date(date)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatPercent(value) {
  return value === null || value === undefined ? '—' : `${Math.round(value)}%`
}

function formatNightDate(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`)
  return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })
}

function formatMoonRange(night) {
  const upAtStart = night.hours[0]?.moonAlt > 0
  if (!night.moonrise && !night.moonset) {
    return upAtStart ? 'Moon: Up all night' : 'Moon: Below horizon all night'
  }
  const parts = []
  if (night.moonrise) parts.push(`rises ${formatTime(night.moonrise)}`)
  if (night.moonset) parts.push(`sets ${formatTime(night.moonset)}`)
  return `Moon: ${parts.join(' / ')}`
}

function formatMilkyWayRange(night) {
  const visibleAtStart = night.hours[0]?.mwVisible
  if (!night.mwRise && !night.mwSet) {
    return visibleAtStart ? 'Milky Way: Visible all night' : 'Milky Way: Not visible tonight'
  }
  const parts = []
  if (night.mwRise) parts.push(`rises ${formatTime(night.mwRise)}`)
  if (night.mwSet) parts.push(`sets ${formatTime(night.mwSet)}`)
  return `Milky Way: ${parts.join(' / ')}`
}

function formatOptimalWindow(window) {
  if (!window) return 'No clear darkness window tonight'
  return `Best window: ${formatTime(window.startHour)} – ${formatTime(window.endHour)} (${window.blockSize} hr${window.blockSize > 1 ? 's' : ''}, avg score: ${Math.round(window.avg)})`
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

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

// ---------------------------------------------------------------------
// Hourly scroll rendering (shared by Tonight panel + Outlook expansion)
// ---------------------------------------------------------------------

function renderHourlyScroll(night, nightIndex) {
  let html = ''
  let lastIsDark = null
  night.hours.forEach((hour, hourIndex) => {
    if (lastIsDark !== null && hour.isDark !== lastIsDark) {
      html += `<div class="hour-divider">${hour.isDark ? 'Astro Dark Begins' : 'Astro Dark Ends'}</div>`
    }
    lastIsDark = hour.isDark
    html += renderHourCard(hour, nightIndex, hourIndex)
  })
  return html
}

function renderHourCard(hour, nightIndex, hourIndex) {
  const timeLabel = formatTime(hour.time)
  if (hour.isDark) {
    const verdict = hour.verdict ?? 'unavailable'
    return `
      <button class="hour-card dark" data-night-index="${nightIndex}" data-hour-index="${hourIndex}" title="${VERDICT_LABEL[verdict] ?? ''}">
        <span class="hour-time">${timeLabel}</span>
        <span class="verdict-dot verdict-${verdict}"></span>
        <span class="hour-score">${hour.score ?? '—'}</span>
        <span class="hour-cloud">${formatPercent(hour.cloud)}</span>
      </button>`
  }
  return `
    <button class="hour-card daylight" data-night-index="${nightIndex}" data-hour-index="${hourIndex}">
      <span class="hour-time">${timeLabel}</span>
      <span class="sun-icon">🌅</span>
      <span class="hour-cloud">${formatPercent(hour.cloud)}</span>
      <span class="hour-temp">${hour.temp !== null ? Math.round(hour.temp) + '°' : '—'}</span>
    </button>`
}

// ---------------------------------------------------------------------
// Confidence modal body
// ---------------------------------------------------------------------

function renderConfidenceModalBody(hour) {
  const agreementBadge = {
    agree: '<span class="agreement-badge agree">✓ Models Agree</span>',
    mixed: '<span class="agreement-badge mixed">⚠ Mixed</span>',
    disagree: '<span class="agreement-badge disagree">✗ Low Confidence</span>',
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

  const scoreBars = hour.isDark
    ? hour.components
      ? `
      <div class="score-breakdown">
        <p class="score-breakdown-legend">Bar = this factor's own score out of 100. "wt" = how much it counts toward the total.</p>
        ${scoreBar('Cloud', 35, hour.components.cloudScore)}
        ${scoreBar('Moon', 30, hour.components.moonScore)}
        ${scoreBar('Humidity', 15, hour.components.humidScore)}
        ${scoreBar('Dew', 10, hour.components.dewScore)}
        ${scoreBar('Wind', 10, hour.components.windScore)}
      </div>`
      : `<p class="score-veto-note">${VETO_LABEL[hour.vetoed] ?? 'Score capped by a hard veto condition — the weighted component breakdown does not apply.'}</p>`
    : ''

  return `
    ${table}
    <div class="agreement-row">${agreementBadge ?? ''}</div>
    ${scoreBars}
  `
}

function scoreBar(label, weightPct, value) {
  const pct = value ?? 0
  return `
    <div class="score-bar-row">
      <span class="score-bar-label">${label} <small>wt ${weightPct}%</small></span>
      <div class="score-bar-track"><div class="score-bar-fill" style="width:${pct}%"></div></div>
      <span class="score-bar-value">${value !== null && value !== undefined ? `${value}/100` : '—'}</span>
    </div>`
}
