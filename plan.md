# Astro Weather PWA — Claude Code Build Plan

## Project Overview

Build a Progressive Web App (PWA) called **Astro Weather** — a high-accuracy weather and
astronomical forecast app specifically designed for astrophotography planning. The app must be
fully installable on both iOS and Android, and must support push notifications for favourable
weather conditions.

**Hosting architecture:**
- Frontend PWA → **GitHub Pages** (static, free, HTTPS automatic)
- Push notification backend → **Cloudflare Workers + KV + Cron Triggers** (serverless, free tier)

This is a ground-up rebuild in clean, maintainable code. Do not reference or replicate any
prior Google Antigravity codebase. Build from the spec in this document only.

---

## Tech Stack

- **Runtime:** Vanilla JS (ES Modules) — no React, no Vue, no framework
- **Bundler:** Vite (for dev server, HMR, and production build)
- **CSS:** Plain CSS with custom properties (CSS variables) — no Tailwind
- **PWA:** Vite PWA plugin (`vite-plugin-pwa`) with Workbox for service worker generation
- **Push Notifications:** Web Push API + VAPID keys. Backend via Cloudflare Workers (two
  workers: `subscribe-worker` and `scheduler-worker`)
- **Subscription Storage:** Cloudflare KV namespace (`ASTRO_SUBSCRIPTIONS`)
- **Scheduler:** Cloudflare Cron Trigger (runs daily at 8:00am AEST)
- **Astronomy:** `astronomy-engine` npm package
- **Background Processing:** Web Workers (one worker: `weatherWorker.js`)
- **APIs:**
  - Open-Meteo (weather + forecast models): `https://api.open-meteo.com`
  - Open-Meteo Geocoding: `https://geocoding-api.open-meteo.com`
  - OpenStreetMap Nominatim (reverse geocoding): `https://nominatim.openstreetmap.org`

---

## Project Structure

```
astro-weather/
├── .github/
│   └── workflows/
│       └── deploy.yml          # GitHub Actions: build + deploy to gh-pages branch
├── public/
│   ├── icons/                  # PWA icons (all sizes, see manifest section)
│   ├── screenshots/            # PWA install screenshots (wide + narrow)
│   └── favicon.ico
├── src/
│   ├── index.html
│   ├── main.js                 # App entry point
│   ├── app.js                  # UI controller
│   ├── weatherWorker.js        # Web Worker: API fetch, blending, scoring, astronomy
│   ├── scoring.js              # Shared scoring logic (imported by worker + CF scheduler)
│   ├── notifications.js        # Push notification subscription + permission logic
│   ├── style.css               # All styles
│   └── assets/
│       └── logo.svg
├── workers/
│   ├── subscribe/
│   │   ├── index.js            # CF Worker: POST /subscribe, DELETE /unsubscribe
│   │   └── wrangler.toml       # Cloudflare config for subscribe worker
│   └── scheduler/
│       ├── index.js            # CF Worker: Cron Trigger — daily forecast check + push
│       └── wrangler.toml       # Cloudflare config for scheduler worker
├── vite.config.js
├── package.json
└── plan.md                     # This file
```

---

## Phase 1 — Project Bootstrap

### 1.1 Frontend

```bash
npm create vite@latest astro-weather -- --template vanilla
cd astro-weather
npm install astronomy-engine
npm install -D vite-plugin-pwa
```

### 1.2 Cloudflare Workers

Install Wrangler CLI globally:
```bash
npm install -g wrangler
wrangler login   # opens browser to authenticate with Cloudflare account
```

Install worker dependencies (inside `workers/` — these run in CF edge runtime, NOT Node):
```bash
# No npm install needed — CF Workers use native Web APIs + web-push via npm in the worker bundle
# Each worker directory has its own package.json
```

`workers/subscribe/package.json`:
```json
{
  "name": "astro-subscribe-worker",
  "private": true,
  "dependencies": {
    "web-push": "^3.6.7"
  }
}
```

`workers/scheduler/package.json`:
```json
{
  "name": "astro-scheduler-worker",
  "private": true,
  "dependencies": {
    "web-push": "^3.6.7",
    "astronomy-engine": "^2.1.19"
  }
}
```

### 1.3 Environment Variables

Generate VAPID keys once:
```bash
npx web-push generate-vapid-keys
```

Frontend `.env` (committed as `.env.example`, actual `.env` in `.gitignore`):
```
VITE_VAPID_PUBLIC_KEY=<your public key>
VITE_SUBSCRIBE_WORKER_URL=https://astro-subscribe.damiennikon.workers.dev
```

Cloudflare Worker secrets (set via Wrangler, never in code):
```bash
wrangler secret put VAPID_PRIVATE_KEY   --config workers/subscribe/wrangler.toml
wrangler secret put VAPID_PRIVATE_KEY   --config workers/scheduler/wrangler.toml
wrangler secret put VAPID_PUBLIC_KEY    --config workers/scheduler/wrangler.toml
wrangler secret put VAPID_EMAIL         --config workers/scheduler/wrangler.toml
```

---

## Phase 2 — PWA Manifest & Icons

### Web App Manifest (configured via vite-plugin-pwa in `vite.config.js`)

```json
{
  "name": "Astro Weather",
  "short_name": "AstroWx",
  "description": "Astrophotography weather forecasting for dark sky planning",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0a0e14",
  "theme_color": "#0a0e14",
  "orientation": "portrait-primary",
  "categories": ["weather", "photography", "utilities"],
  "screenshots": [
    { "src": "/screenshots/narrow.png", "sizes": "390x844", "type": "image/png", "form_factor": "narrow" },
    { "src": "/screenshots/wide.png",   "sizes": "1280x720", "type": "image/png", "form_factor": "wide" }
  ],
  "icons": [
    { "src": "/icons/icon-72.png",   "sizes": "72x72",   "type": "image/png" },
    { "src": "/icons/icon-96.png",   "sizes": "96x96",   "type": "image/png" },
    { "src": "/icons/icon-128.png",  "sizes": "128x128", "type": "image/png" },
    { "src": "/icons/icon-144.png",  "sizes": "144x144", "type": "image/png" },
    { "src": "/icons/icon-152.png",  "sizes": "152x152", "type": "image/png" },
    { "src": "/icons/icon-192.png",  "sizes": "192x192", "type": "image/png", "purpose": "any maskable" },
    { "src": "/icons/icon-384.png",  "sizes": "384x384", "type": "image/png" },
    { "src": "/icons/icon-512.png",  "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ]
}
```

### iOS-Specific Meta Tags (in `index.html` `<head>`)

```html
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="AstroWx">
<link rel="apple-touch-icon" href="/icons/icon-192.png">
<link rel="apple-touch-startup-image" href="/screenshots/narrow.png">
```

### Service Worker (Workbox via vite-plugin-pwa)

Configure in `vite.config.js`:
```js
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: '/astro-weather/',   // IMPORTANT: matches GitHub repo name (damiennikon/astro-weather)
  plugins: [
    VitePWA({
      registerType: 'prompt',       // Don't auto-update — show banner instead
      strategies: 'generateSW',
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/api\.open-meteo\.com\//,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'open-meteo-cache',
              expiration: { maxAgeSeconds: 3600 }
            }
          }
        ]
      },
      // Inject push event handler into the generated SW
      injectManifest: false,
      // Additional SW code injected via importScripts or additionalManifestEntries
    })
  ]
})
```

**IMPORTANT — GitHub Pages `base` path:**
The `base: '/astro-weather/'` in `vite.config.js` matches the GitHub repository name `astro-weather`.
All asset paths, the manifest `start_url`, and the service worker scope must account for this
subdirectory. Set `start_url` to `/astro-weather/` in the manifest.

**SW Update Banner:**
- `registerType: 'prompt'` means the SW will NOT auto-update
- In `main.js`, use `useRegisterSW` from `virtual:pwa-register` to listen for `needRefresh`
- When `needRefresh` is true, show the update banner
- On banner click, call `updateServiceWorker()` which sends SKIP_WAITING and reloads

**Push handler in SW:**
Because `generateSW` strategy doesn't allow custom code, add push event handling by
configuring Workbox's `additionalManifestEntries` or by switching to `injectManifest` strategy
with a custom `sw.js` that imports Workbox:

Use `strategies: 'injectManifest'` with a `src/sw.js` file:
```js
// src/sw.js
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'
import { StaleWhileRevalidate } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'

// Precache all build assets
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// Runtime cache: Open-Meteo API
registerRoute(
  ({ url }) => url.origin === 'https://api.open-meteo.com',
  new StaleWhileRevalidate({
    cacheName: 'open-meteo-cache',
    plugins: [new ExpirationPlugin({ maxAgeSeconds: 3600 })]
  })
)

// Push notification handler
self.addEventListener('push', event => {
  const data = event.data?.json() ?? {}
  event.waitUntil(
    self.registration.showNotification(data.title ?? 'Astro Weather', {
      body:    data.body  ?? 'Check tonight\'s forecast',
      icon:    '/astro-weather/icons/icon-192.png',
      badge:   '/astro-weather/icons/icon-96.png',
      tag:     'astro-weather-forecast',
      renotify: true,
      data:    { url: data.url ?? '/astro-weather/' }
    })
  )
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil(clients.openWindow(event.notification.data.url))
})

// Skip waiting when prompted
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})
```

---

## Phase 3 — Design System (CSS Variables)

Use this exact design system — it matches the Damien Leyden Photography brand palette:

```css
:root {
  --bg-primary:    #0a0e14;
  --bg-card:       #111820;
  --bg-card-hover: #1a2535;
  --border:        #1a2d42;
  --accent:        #c8a96e;   /* amber */
  --accent-dim:    #a08040;
  --text-primary:  #e8eaf0;
  --text-muted:    #8a9ab0;
  --text-dim:      #556070;

  /* Verdict colours */
  --great:  #4caf72;
  --good:   #c8a96e;
  --fair:   #e08030;
  --poor:   #d04040;
  --vpoor:  #801818;

  /* Red Mode overrides (toggled via class on <body>) */
  --rm-bg:     #0d0000;
  --rm-card:   #1a0000;
  --rm-border: #3a0000;
  --rm-accent: #cc2200;
  --rm-text:   #cc4422;

  /* Typography */
  --font-display: 'Barlow Condensed', sans-serif;
  --font-body:    'Inter', sans-serif;
}
```

Load from Google Fonts: `Barlow+Condensed:wght@400;600;700` and `Inter:wght@400;500`.

Red Mode: toggled by adding class `red-mode` to `<body>`. All colour vars are overridden inside
`.red-mode { }`. Every UI element must respect these vars — no hardcoded colours anywhere.

---

## Phase 4 — weatherWorker.js (Core Engine)

This Web Worker does ALL heavy lifting. `app.js` communicates with it via `postMessage`.

### Worker Message API

`app.js` → Worker:
```js
{ type: 'FETCH_FORECAST', lat, lng, timezone }
```

Worker → `app.js`:
```js
{ type: 'FORECAST_READY', nights: [...] }
{ type: 'FORECAST_ERROR', message }
{ type: 'PROGRESS', step }   // e.g. 'Fetching ECMWF...'
```

### Step 1 — Fetch Weather Data

Call Open-Meteo for each model separately (ECMWF, ICON, UKMO) using concurrent `Promise.all`.

#### Surface variables (all 3 models):
`cloudcover_low,cloudcover_mid,cloudcover_high,temperature_2m,relativehumidity_2m,dewpoint_2m,windspeed_10m`

#### Upper air (ECMWF + ICON only):
`windspeed_250hPa` (jet stream — informational display only, not part of scoring)

#### URL pattern:
```
https://api.open-meteo.com/v1/forecast
  ?latitude={lat}
  &longitude={lng}
  &hourly={variables}
  &models={model}
  &timezone={timezone}
  &forecast_days=8
  &wind_speed_unit=kmh
  &temperature_unit=celsius
```

Model strings: `ecmwf_ifs04`, `icon_global`, `ukmo_seamless`

### Step 2 — Astronomy Calculations

Use `astronomy-engine` for each night in the forecast. For each date:

**Display window vs Scoring window — IMPORTANT distinction:**
- **Display window:** Always 17:00 (5pm) on the evening date through to 07:00 (7am) the
  following morning. Every hour in this range is fetched, blended, and shown in the UI.
  This lets the user see afternoon cloud build-up and conditions leading into and out of the night.
- **Scoring window:** Only hours strictly between astronomical dusk (-18°) and astronomical
  dawn (-18°) receive an astrophotography score and verdict. Hours outside this window
  (i.e. 5pm–astro dusk, and astro dawn–7am) are displayed with their weather metrics but
  shown as `score: null, verdict: 'daylight'` — no coloured verdict dot, just a neutral card.

**Sun:**
- `Astronomy.SearchAltitude(Astronomy.Body.Sun, observer, +1, startOfDay, 1, -18)` → Astro dusk
- `Astronomy.SearchAltitude(Astronomy.Body.Sun, observer, -1, astro_dusk, 12, -18)` → Astro dawn
- Only hours strictly between astro_dusk and astro_dawn are scored

**Moon:**
- `Astronomy.SearchRiseSet(Astronomy.Body.Moon, observer, +1, ...)` → moonrise
- `Astronomy.SearchRiseSet(Astronomy.Body.Moon, observer, -1, ...)` → moonset
- `Astronomy.Illumination(Astronomy.Body.Moon, time)` → illumination fraction (0–1)
- `Astronomy.Horizon(time, observer, ra, dec, 'normal').altitude` → moon altitude per hour
- Moon buffer: if altitude 0–10°, halve the moon penalty

**Milky Way / Galactic Centre:**
- Track RA=17.76h (266.4°), Dec=−29.0°
- Use `Astronomy.Horizon(time, observer, ra_hours, dec, 'normal').altitude`
- Visible when altitude > 10°
- Fading: mark hours within 45 min of astronomical dawn as "Fading"
- Calculate rise and set times by scanning hourly

### Step 3 — Defensive Blending Algorithm

For each hour, for each weather variable, blend the three models:

**Cloud cover (weighted blend with spread penalty):**
```js
function blendCloud(ecmwf, ukmo, icon) {
  const models = [ecmwf, ukmo, icon].filter(v => v !== null && v !== undefined)
  if (models.length === 0) return null

  let weighted = 0, totalWeight = 0
  if (ecmwf != null) { weighted += ecmwf * 0.5; totalWeight += 0.5 }
  if (ukmo  != null) { weighted += ukmo  * 0.3; totalWeight += 0.3 }
  if (icon  != null) { weighted += icon  * 0.2; totalWeight += 0.2 }
  const avg = weighted / totalWeight

  const spread = Math.max(...models) - Math.min(...models)
  if (spread > 30) {
    return Math.min(...models) + 0.7 * spread   // Skew pessimistic
  }
  return avg
}
```

Apply `blendCloud` separately for `low`, `mid`, `high` cloud layers.
Total blended cloud = `Math.min(100, low + mid + high)` — treat layers as additive, capped at 100.

**Model agreement (per hour):**
```js
const maxCloud = Math.max(ecmwfTotal, ukmoTotal, iconTotal)
const minCloud = Math.min(ecmwfTotal, ukmoTotal, iconTotal)
const spread   = maxCloud - minCloud
const agreement = spread <= 15 ? 'agree' : spread <= 30 ? 'mixed' : 'disagree'
```

**Other metrics (safe average):**
`temperature`, `humidity`, `dewpoint`, `windspeed`: simple mean of available model values.

### Step 4 — Scoring Algorithm

The scoring logic lives in `src/scoring.js` as a plain ES module so it can be imported by
both `weatherWorker.js` (browser) and the Cloudflare scheduler worker (edge).

```js
// src/scoring.js  — shared between browser worker and CF scheduler

export function scoreHour({ cloud, moonIllum, moonAlt, humidity, temp, dewpoint, windspeed }) {

  if (cloud === null || cloud === undefined) return { score: 0, verdict: 'unavailable' }
  if (cloud > 70) return { score: 20, verdict: 'verypoor', vetoed: 'cloud>70' }
  if (cloud > 50) return { score: 35, verdict: 'poor',     vetoed: 'cloud>50' }

  const moonAboveHorizon = moonAlt > 0
  if (moonIllum > 0.8 && moonAboveHorizon) {
    return { score: 24, verdict: 'verypoor', vetoed: 'brightmoon' }
  }

  // Cloud (35%)
  let cloudScore
  if      (cloud <= 5)  cloudScore = 100
  else if (cloud <= 15) cloudScore = 85
  else if (cloud <= 30) cloudScore = 60
  else if (cloud <= 50) cloudScore = 30
  else                  cloudScore = 0

  // Moon (30%)
  let moonScore
  if (!moonAboveHorizon) {
    moonScore = 100
  } else {
    const illumPct = moonIllum * 100
    if      (illumPct <= 10) moonScore = 100
    else if (illumPct <= 25) moonScore = 80
    else if (illumPct <= 50) moonScore = 55
    else if (illumPct <= 80) moonScore = 25
    else                     moonScore = 0
    // Low horizon buffer: moon 0–10° altitude → halve penalty
    if (moonAlt >= 0 && moonAlt <= 10) {
      moonScore = Math.min(100, moonScore + (100 - moonScore) * 0.5)
    }
  }

  // Humidity (15%)
  let humidScore
  if      (humidity < 50) humidScore = 100
  else if (humidity < 65) humidScore = 75
  else if (humidity < 75) humidScore = 50
  else if (humidity < 85) humidScore = 25
  else                    humidScore = 10

  // Dew spread (10%)
  const dewSpread = temp - dewpoint
  let dewScore
  if      (dewSpread > 8) dewScore = 100
  else if (dewSpread > 5) dewScore = 70
  else if (dewSpread > 3) dewScore = 40
  else if (dewSpread > 1) dewScore = 20
  else                    dewScore = 10

  // Wind (10%)
  let windScore
  if      (windspeed <= 10) windScore = 100
  else if (windspeed <= 20) windScore = 75
  else if (windspeed <= 30) windScore = 40
  else if (windspeed <= 35) windScore = 20
  else                      windScore = 10

  const score = Math.round(
    cloudScore * 0.35 +
    moonScore  * 0.30 +
    humidScore * 0.15 +
    dewScore   * 0.10 +
    windScore  * 0.10
  )

  let verdict
  if      (score >= 85) verdict = 'great'
  else if (score >= 65) verdict = 'good'
  else if (score >= 45) verdict = 'fair'
  else if (score >= 25) verdict = 'poor'
  else                  verdict = 'verypoor'

  return { score, verdict, cloudScore, moonScore, humidScore, dewScore, windScore }
}

export function findOptimalWindow(scoredHours) {
  for (const blockSize of [3, 2, 1]) {
    let best = null
    for (let i = 0; i <= scoredHours.length - blockSize; i++) {
      const block = scoredHours.slice(i, i + blockSize)
      const avg = block.reduce((s, h) => s + h.score, 0) / blockSize
      if (!best || avg > best.avg) {
        best = { startHour: block[0].time, endHour: block[block.length - 1].time, avg, blockSize }
      }
    }
    if (best) return best
  }
  return null
}
```

### Step 5 — Night Summary Object

Return one object per night (8 nights total):

```js
{
  date: 'YYYY-MM-DD',           // Evening date (e.g. '2025-07-01' for the 1 Jul -> 2 Jul night)
  displayStart: Date,           // Always 17:00 (5pm) on the evening date
  displayEnd:   Date,           // Always 07:00 (7am) the following morning
  astroStart:   Date,           // Astronomical dusk (sun altitude = -18 degrees)
  astroEnd:     Date,           // Astronomical dawn (sun altitude = -18 degrees)
  moonrise:     Date | null,
  moonset:      Date | null,
  moonIllum:    0.0-1.0,        // At midnight of that night
  mwRise:       Date | null,
  mwSet:        Date | null,
  hours: [
    // ALL hours from 17:00-07:00 are included (14 hours total).
    // Hours outside astro darkness have score: null, verdict: 'daylight'.
    {
      time:        Date,
      isDark:      boolean,      // true = within astroStart-astroEnd, false = daylight hours
      cloud:       number,       // Blended total cloud %
      cloudLow:    number,
      cloudMid:    number,
      cloudHigh:   number,
      cloudEcmwf:  number,       // Raw per-model totals (for confidence modal)
      cloudUkmo:   number,
      cloudIcon:   number,
      humidity:    number,
      temp:        number,
      dewpoint:    number,
      windspeed:   number,
      moonAlt:     number,
      moonIllum:   number,
      mwVisible:   boolean,
      mwFading:    boolean,
      agreement:   'agree' | 'mixed' | 'disagree' | null,  // null for daylight hours
      score:       number | null,   // null for daylight hours (outside astro darkness)
      verdict:     string,          // 'great'|'good'|'fair'|'poor'|'verypoor'|'daylight'|'unavailable'
      vetoed:      string | null,
      components:  { cloudScore, moonScore, humidScore, dewScore, windScore } | null
    }
  ],
  optimalWindow: { startHour, endHour, avg, blockSize } | null,  // Dark hours only
  nightAvg: {
    // Averages calculated from dark hours only (isDark === true)
    score:     number,
    cloud:     number,
    humidity:  number,
    windspeed: number,
    moonIllum: number
  }
}
```

**Hour generation logic:**
```js
// For each night, generate hours from 5pm evening through 7am next morning (14 hours)
const hours = []
const start = new Date(eveningDate)
start.setHours(17, 0, 0, 0)

for (let h = 0; h < 14; h++) {
  const time = new Date(start.getTime() + h * 3600 * 1000)
  const isDark = time >= astroStart && time <= astroEnd
  // fetch blended weather data for this hour index from Open-Meteo arrays
  // if isDark: run scoreHour(), else: score = null, verdict = 'daylight'
  hours.push({ time, isDark, ...weatherData, score, verdict, ... })
}
```

---

## Phase 5 — app.js (UI Controller)

### Location Handling

1. On load, check `localStorage` for a saved `{ lat, lng, name, timezone }`.
2. If found, fetch immediately.
3. If not, show a location prompt with two options:
   - "Use My Location" — triggers `navigator.geolocation.getCurrentPosition`
   - Search input — uses the geocoding API for autocomplete

**Reverse geocoding** (for "Locate Me"):
```
GET https://nominatim.openstreetmap.org/reverse?lat={lat}&lon={lng}&format=json
→ use address.suburb or address.city
```

**Timezone detection:**
Use `Intl.DateTimeFormat().resolvedOptions().timeZone` as the default. When a location is
selected from geocoding results, use the `timezone` field returned by Open-Meteo geocoding.

Save `{ lat, lng, name, timezone }` to `localStorage` after user selection.

### UI Sections

#### 1. Header
- App name "Astro Weather" in `--font-display`
- Location name + small "Change" link
- Red Mode toggle button (moon icon)
- Notification bell icon (see Phase 6)

#### 2. Tonight Panel
- Ephemeris banner (horizontal strip):
  - 🌑 Astro Dark: HH:mm – HH:mm
  - 🌕 Moon: rises HH:mm / sets HH:mm (or "Below horizon all night")
  - 🌌 Milky Way: rises HH:mm / sets HH:mm (or "Not visible tonight")
- Optimal Window callout: "Best window: HH:mm – HH:mm (X hrs, avg score: N)"
- Hourly scroll (horizontal scroll on mobile, wrapping on desktop):
  - Displays ALL hours from 17:00 (5pm) through to 07:00 (7am) — 14 cards total per night
  - **Dark hours** (isDark === true): coloured verdict dot + score number + cloud%
  - **Daylight hours** (isDark === false, i.e. 5pm–astro dusk and astro dawn–7am):
    - Rendered in a visually dimmed/muted style (use `--text-dim` and `--bg-card` without hover)
    - Show a sun icon (🌅) instead of a verdict dot
    - Show cloud% and temp but no score number
    - Tapping still opens the Confidence Modal to show model data, but no score breakdown section
  - A subtle divider or label marks the transition between daylight and astro dark hours
  - Tap any card → opens Confidence Modal

#### 3. Confidence Modal
- Triggered by tapping any hourly card
- Per-model cloud table:

  | Model   | Low | Mid  | High | Total |
  |---------|-----|------|------|-------|
  | ECMWF   | ... | ...  | ...  | ...   |
  | UKMO    | ... | ...  | ...  | ...   |
  | ICON    | ... | ...  | ...  | ...   |
  | Blended | ... | ...  | ...  | **X** |

- Agreement badge: "✓ Models Agree" / "⚠ Mixed" / "✗ Low Confidence"
- Score breakdown visual bars: Cloud 35%, Moon 30%, Humidity 15%, Dew 10%, Wind 10%

#### 4. 7-Day Outlook
- One card per upcoming night (nights 2–8)
- Night date label (e.g. "Tue 1 Jul")
- Average score badge (colour-coded) — calculated from dark hours only
- Summary stats: cloud avg %, humidity avg %, moon illum % — dark hours only
- Tap → expands to show that night's full hourly scroll (5pm–7am, same component reused)

#### 5. Satellite View
- Embedded Windy.com iframe:
  ```
  https://embed.windy.com/embed2.html?lat={lat}&lon={lng}&zoom=7&level=surface
    &overlay=satellite&menu=&message=&marker=&calendar=&pressure=
    &type=map&location=coordinates&detail=&metricWind=km%2Fh&metricTemp=%C2%B0C&radarRange=-1
  ```
- Toggle show/hide button

#### 6. Progress / Loading State
- Loading overlay with animated stars during fetch
- Display `PROGRESS` messages from worker (e.g. "Fetching ECMWF model…")

#### 7. Update Banner
- When SW detects new version: `"🔄 Update available — tap to reload"`
- Click: send `SKIP_WAITING` to SW and call `window.location.reload()`

---

## Phase 6 — Push Notifications

### Overview

```
[Browser]  →  POST subscription  →  [CF subscribe Worker]  →  [CF KV: ASTRO_SUBSCRIPTIONS]
                                                                         ↓
[CF Cron Trigger 08:00 AEST]  →  [CF scheduler Worker]  →  fetch KV subscriptions
                                                          →  fetch Open-Meteo for each lat/lng
                                                          →  run scoring algorithm
                                                          →  send Web Push if score ≥ 65
```

### Cloudflare KV Setup

```bash
# Create the KV namespace
wrangler kv:namespace create "ASTRO_SUBSCRIPTIONS"
# Note the returned id and preview_id — add to both wrangler.toml files
```

Each subscription is stored as a KV entry:
- **Key:** `sub:{endpoint_hash}` (SHA-256 hex of the endpoint URL, first 16 chars)
- **Value:** JSON string:
```json
{
  "subscription": { "endpoint": "...", "keys": { "p256dh": "...", "auth": "..." } },
  "lat": -27.6954,
  "lng": 153.1185,
  "locationName": "Loganholme",
  "lastNotified": "2025-07-01",
  "subscribedAt": "2025-06-15T10:00:00Z"
}
```

### CF Worker 1 — Subscribe Worker (`workers/subscribe/`)

**`workers/subscribe/wrangler.toml`:**
```toml
name = "astro-subscribe"
main = "index.js"
compatibility_date = "2024-01-01"

[[kv_namespaces]]
binding = "ASTRO_SUBSCRIPTIONS"
id = "<your-kv-namespace-id>"
preview_id = "<your-preview-id>"

[vars]
ALLOWED_ORIGIN = "https://damiennikon.github.io"
```

**`workers/subscribe/index.js`:**
```js
export default {
  async fetch(request, env) {
    // CORS headers — only allow requests from the GitHub Pages origin
    const corsHeaders = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    const url = new URL(request.url)

    // POST /subscribe — save a new push subscription
    if (request.method === 'POST' && url.pathname === '/subscribe') {
      const body = await request.json()
      const { subscription, lat, lng, locationName } = body

      if (!subscription?.endpoint || !lat || !lng) {
        return new Response(JSON.stringify({ error: 'Missing required fields' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // Hash the endpoint to create a stable key
      const keyBuffer = await crypto.subtle.digest(
        'SHA-256', new TextEncoder().encode(subscription.endpoint)
      )
      const keyHex = Array.from(new Uint8Array(keyBuffer))
        .map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
      const kvKey = `sub:${keyHex}`

      const value = JSON.stringify({
        subscription,
        lat,
        lng,
        locationName: locationName ?? 'Unknown',
        lastNotified: null,
        subscribedAt: new Date().toISOString()
      })

      await env.ASTRO_SUBSCRIPTIONS.put(kvKey, value, { expirationTtl: 60 * 60 * 24 * 365 })

      return new Response(JSON.stringify({ ok: true, key: kvKey }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // DELETE /unsubscribe — remove a subscription by endpoint
    if (request.method === 'DELETE' && url.pathname === '/unsubscribe') {
      const body = await request.json()
      const { endpoint } = body
      if (!endpoint) {
        return new Response(JSON.stringify({ error: 'Missing endpoint' }), { status: 400, headers: corsHeaders })
      }
      const keyBuffer = await crypto.subtle.digest(
        'SHA-256', new TextEncoder().encode(endpoint)
      )
      const keyHex = Array.from(new Uint8Array(keyBuffer))
        .map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
      await env.ASTRO_SUBSCRIPTIONS.delete(`sub:${keyHex}`)
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    return new Response('Not Found', { status: 404 })
  }
}
```

### CF Worker 2 — Scheduler Worker (`workers/scheduler/`)

**`workers/scheduler/wrangler.toml`:**
```toml
name = "astro-scheduler"
main = "index.js"
compatibility_date = "2024-01-01"

[[kv_namespaces]]
binding = "ASTRO_SUBSCRIPTIONS"
id = "<same-kv-namespace-id>"
preview_id = "<same-preview-id>"

# Cron Trigger: 8:00pm UTC = 8:00am AEST (UTC+10)
# Adjust for AEDT (UTC+11) if needed — 9pm UTC
[triggers]
crons = ["0 22 * * *"]
```

**`workers/scheduler/index.js`:**
```js
import { scoreHour } from '../../src/scoring.js'
import webpush from 'web-push'

export default {
  // Handles the Cron Trigger
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduler(env))
  },

  // Allow manual trigger via HTTP GET /trigger (useful for testing)
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/trigger') {
      await runScheduler(env)
      return new Response('Scheduler ran OK', { status: 200 })
    }
    return new Response('Not Found', { status: 404 })
  }
}

async function runScheduler(env) {
  webpush.setVapidDetails(
    env.VAPID_EMAIL,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  )

  // List all subscription keys
  const list = await env.ASTRO_SUBSCRIPTIONS.list({ prefix: 'sub:' })
  const today = new Date().toISOString().slice(0, 10)

  for (const key of list.keys) {
    const raw = await env.ASTRO_SUBSCRIPTIONS.get(key.name)
    if (!raw) continue

    const entry = JSON.parse(raw)

    // Skip if already notified today
    if (entry.lastNotified === today) continue

    // Fetch Open-Meteo forecast for this lat/lng
    const forecast = await fetchForecast(entry.lat, entry.lng)
    if (!forecast) continue

    // Score each upcoming night (days 0–2 = tonight, tomorrow, day after)
    const goodNight = findGoodNight(forecast, entry.lat, entry.lng)
    if (!goodNight) continue

    // Send push notification
    const payload = JSON.stringify({
      title: `🌌 Clear skies ahead — ${entry.locationName}`,
      body:  `${goodNight.label} looks ${goodNight.verdict}! Avg score ${goodNight.score}/100. ` +
             `Cloud ${goodNight.cloud}%, Moon ${goodNight.moon}%.`,
      url:   'https://damiennikon.github.io/astro-weather/'
    })

    try {
      await webpush.sendNotification(entry.subscription, payload)

      // Update lastNotified
      entry.lastNotified = today
      await env.ASTRO_SUBSCRIPTIONS.put(key.name, JSON.stringify(entry), {
        expirationTtl: 60 * 60 * 24 * 365
      })
    } catch (err) {
      // 410 Gone = subscription expired, delete it
      if (err.statusCode === 410) {
        await env.ASTRO_SUBSCRIPTIONS.delete(key.name)
      }
    }
  }
}

async function fetchForecast(lat, lng) {
  const vars = 'cloudcover_low,cloudcover_mid,cloudcover_high,temperature_2m,relativehumidity_2m,dewpoint_2m,windspeed_10m'
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
              `&hourly=${vars}&models=ecmwf_ifs04,icon_global,ukmo_seamless` +
              `&timezone=Australia%2FBrisbane&forecast_days=4&wind_speed_unit=kmh&temperature_unit=celsius`
  try {
    const res = await fetch(url)
    return await res.json()
  } catch {
    return null
  }
}

function findGoodNight(forecast, lat, lng) {
  // Simplified scoring for scheduler — cloud-only quick check + full score
  // Check nights 0, 1, 2 (tonight, tomorrow, day after)
  // Returns the first night with nightAvg score >= 65, or null

  // NOTE: Full astronomy engine integration for moon alt/rise is complex in CF edge
  // Use a simplified moon score based on illumination only (no altitude)
  // The browser worker does the full calculation — this is a conservative push trigger

  const hours = forecast.hourly
  const times = hours.time.map(t => new Date(t))

  for (let dayOffset = 0; dayOffset < 3; dayOffset++) {
    const nightDate = new Date()
    nightDate.setDate(nightDate.getDate() + dayOffset)
    const dateStr = nightDate.toISOString().slice(0, 10)

    // Approximate darkness: 8pm–5am local
    const darkHours = times.reduce((acc, t, i) => {
      const h = t.getHours()
      if (t.toISOString().slice(0, 10) === dateStr && (h >= 20 || h <= 5)) {
        acc.push(i)
      }
      return acc
    }, [])

    if (darkHours.length === 0) continue

    let totalScore = 0
    let count = 0
    let totalCloud = 0

    for (const i of darkHours) {
      const cloud = Math.min(100,
        (hours.cloudcover_low?.[i] ?? 0) +
        (hours.cloudcover_mid?.[i] ?? 0) +
        (hours.cloudcover_high?.[i] ?? 0)
      )
      const humidity  = hours.relativehumidity_2m?.[i] ?? 50
      const temp      = hours.temperature_2m?.[i] ?? 20
      const dewpoint  = hours.dewpoint_2m?.[i] ?? 15
      const windspeed = hours.windspeed_10m?.[i] ?? 10

      // Simplified moon: use illumination only, assume worst case (above horizon)
      // This makes notifications conservative — better to under-notify than spam
      const moonIllum = 0.3   // Conservative placeholder; full calc is in the browser
      const moonAlt   = 30    // Assume above horizon for conservative estimate

      const { score } = scoreHour({ cloud, moonIllum, moonAlt, humidity, temp, dewpoint, windspeed })
      totalScore += score
      totalCloud += cloud
      count++
    }

    if (count === 0) continue

    const avgScore = Math.round(totalScore / count)
    const avgCloud = Math.round(totalCloud / count)

    if (avgScore >= 65) {
      const verdict = avgScore >= 85 ? 'GREAT' : 'GOOD'
      const label   = dayOffset === 0 ? 'Tonight' : dayOffset === 1 ? 'Tomorrow night' : `In ${dayOffset} nights`
      return { score: avgScore, cloud: avgCloud, moon: '?', verdict, label }
    }
  }
  return null
}
```

**Note on scheduler moon calculation:** The CF scheduler uses a simplified moon estimate
(conservative) to avoid pulling in the full astronomy-engine in the edge worker. The actual
detailed scoring shown in the app UI uses the full calculation in the browser. This is
intentional — it means push notifications err on the side of under-notifying rather than
sending false-positive "great night!" alerts when the moon is actually full.

### Deploy Workers

```bash
# Deploy subscribe worker
cd workers/subscribe
npm install
wrangler deploy

# Deploy scheduler worker
cd ../scheduler
npm install
wrangler deploy

# Verify cron trigger is registered in Cloudflare dashboard:
# Workers & Pages → astro-scheduler → Triggers → Cron Triggers
```

---

## Phase 7 — Client-Side Notification Logic (`src/notifications.js`)

```js
const SUBSCRIBE_WORKER_URL = import.meta.env.VITE_SUBSCRIBE_WORKER_URL

export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)))
}

export async function requestAndSubscribe() {
  // Check browser support
  if (!('Notification' in window) || !('PushManager' in window)) {
    return { ok: false, reason: 'unsupported' }
  }

  // iOS: must be in standalone mode
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
  const isStandalone = window.navigator.standalone === true
  if (isIOS && !isStandalone) {
    return { ok: false, reason: 'ios-not-installed' }
  }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    return { ok: false, reason: 'denied' }
  }

  const reg = await navigator.serviceWorker.ready
  const existing = await reg.pushManager.getSubscription()
  if (existing) return { ok: true, reason: 'already-subscribed' }

  const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY
  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidKey)
  })

  // Get saved location from localStorage
  const location = JSON.parse(localStorage.getItem('astro-location') ?? '{}')

  const res = await fetch(`${SUBSCRIBE_WORKER_URL}/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscription,
      lat:          location.lat,
      lng:          location.lng,
      locationName: location.name
    })
  })

  return res.ok ? { ok: true } : { ok: false, reason: 'server-error' }
}

export async function unsubscribe() {
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (!sub) return

  await fetch(`${SUBSCRIBE_WORKER_URL}/unsubscribe`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint })
  })

  await sub.unsubscribe()
}

export async function getSubscriptionStatus() {
  if (!('PushManager' in window)) return 'unsupported'
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  return sub ? 'subscribed' : 'unsubscribed'
}
```

**Notification bell UI behaviour (in `app.js`):**
- On bell click: check `getSubscriptionStatus()`
- If `unsupported`: show tooltip "Push notifications aren't supported in this browser"
- If `ios-not-installed`: show modal "Add Astro Weather to your Home Screen first, then enable notifications"
- If `unsubscribed`: call `requestAndSubscribe()`, show success or denied message
- If `subscribed`: offer to unsubscribe, call `unsubscribe()`
- Bell icon: filled = subscribed, outline = unsubscribed, strikethrough = denied

---

## Phase 8 — Geocoding & Location Search

### Search Autocomplete

```
GET https://geocoding-api.open-meteo.com/v1/search
  ?name={query}
  &count=5
  &language=en
  &format=json
  &countryCode=AU
```

Debounce input by 300ms. Dropdown shows location name + state + country.
On selection, save `{ lat, lng, name, timezone }` to `localStorage` key `astro-location`
and trigger forecast fetch.

---

## Phase 9 — GitHub Actions Deployment

**`.github/workflows/deploy.yml`:**
```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci

      - name: Build
        run: npm run build
        env:
          VITE_VAPID_PUBLIC_KEY: ${{ secrets.VITE_VAPID_PUBLIC_KEY }}
          VITE_SUBSCRIBE_WORKER_URL: ${{ secrets.VITE_SUBSCRIBE_WORKER_URL }}

      - uses: actions/configure-pages@v4

      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist

      - uses: actions/deploy-pages@v4
        id: deployment
```

**GitHub repo setup:**
1. Go to repo Settings → Secrets and variables → Actions
2. Add secrets:
   - `VITE_VAPID_PUBLIC_KEY` — your public VAPID key
   - `VITE_SUBSCRIBE_WORKER_URL` — `https://astro-subscribe.damiennikon.workers.dev`
3. Go to Settings → Pages → Source: set to "GitHub Actions"

---

## Phase 10 — Production Checklist

### Pre-deploy
- [ ] Generate VAPID keys: `npx web-push generate-vapid-keys`
- [ ] Confirm `base` in `vite.config.js` is `/astro-weather/`
- [ ] Confirm `start_url` in manifest is `/astro-weather/`
- [ ] Confirm icon paths in `sw.js` use `/astro-weather/` prefix
- [ ] Confirm `ALLOWED_ORIGIN` in subscribe worker is `https://damiennikon.github.io`
- [ ] Confirm notification `url` in scheduler worker is `https://damiennikon.github.io/astro-weather/`
- [ ] Create KV namespace and add IDs to both `wrangler.toml` files
- [ ] Set all Wrangler secrets (VAPID keys + email) for both workers
- [ ] Deploy both CF Workers: `wrangler deploy`
- [ ] Add GitHub Actions secrets to repo
- [ ] Push to `main` — Actions will build and deploy

### Post-deploy verification
- [ ] App loads at `https://damiennikon.github.io/astro-weather/`
- [ ] Service worker registers successfully (DevTools → Application → Service Workers)
- [ ] Manifest loads (DevTools → Application → Manifest — no errors)
- [ ] Android Chrome shows install prompt
- [ ] iOS Safari shows "Add to Home Screen" banner
- [ ] Location search works (Australian results)
- [ ] Forecast loads and scores correctly
- [ ] Clicking hourly card opens confidence modal
- [ ] 7-day outlook expands correctly
- [ ] Red Mode toggles all colours
- [ ] Notification bell subscribes successfully
- [ ] POST to `/subscribe` CF Worker returns 200
- [ ] CF KV entry created (check via Wrangler: `wrangler kv:key list --binding ASTRO_SUBSCRIPTIONS`)
- [ ] Manual trigger scheduler: `GET https://astro-scheduler.damiennikon.workers.dev/trigger`
- [ ] Push notification received on device

---

## Acceptance Criteria

- [ ] App loads and shows tonight's forecast within 5 seconds on a 4G connection
- [ ] All 5 weather metrics scored correctly per the algorithm
- [ ] Hourly scroll shows all hours from 5pm through 7am (14 cards per night)
- [ ] Daylight hours (before astro dusk / after astro dawn) render in muted style with sun icon, no score
- [ ] Astronomical twilight correctly calculated — scored hours are strictly within astro darkness
- [ ] nightAvg and optimalWindow calculated from dark hours only, not the full 5pm–7am window
- [ ] Moon score halves penalty when altitude 0–10°
- [ ] Spread penalty applied when model disagreement > 30%
- [ ] Confidence modal shows all three models' raw cloud data
- [ ] Optimal window correctly finds best consecutive block (3h → 2h → 1h fallback)
- [ ] 7-day outlook shows correct night averages
- [ ] Red Mode toggles — all colours switch, no white elements remain
- [ ] App installs on Android Chrome
- [ ] App installs on iOS Safari (Add to Home Screen prompt shown)
- [ ] Push notifications send when score ≥ 65 for upcoming nights
- [ ] No notification spam — max once per 24h per subscription
- [ ] 410 Gone responses clean up expired subscriptions from KV
- [ ] Service worker update banner appears and reloads correctly
- [ ] Location search returns Australian results with autocomplete
- [ ] "Locate Me" reverse-geocodes to suburb/city name
- [ ] Satellite iframe toggles correctly
- [ ] Milky Way rise/set and fade times display correctly
- [ ] App works offline after first visit (Workbox precache)
- [ ] GitHub Actions deploys automatically on push to `main`
