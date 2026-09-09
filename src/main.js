import './style.css'
import { registerSW } from 'virtual:pwa-register'
import { App } from './app.js'

const app = new App()
app.init()

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

const updateSW = registerSW({
  onNeedRefresh() {
    app.showUpdateBanner(() => updateSW(true))
  },
  onRegisteredSW(swScriptUrl, registration) {
    // A PWA tab on mobile can stay open for days without a full reload, and the
    // browser only re-checks sw.js on its own schedule (often ~24h, sometimes
    // longer) — poll explicitly so onNeedRefresh actually fires while in use.
    if (!registration) return
    setInterval(() => {
      registration.update()
    }, UPDATE_CHECK_INTERVAL_MS)

    // Reopening an installed PWA usually resumes the same suspended page rather
    // than reloading it, so a deploy that happened while it was backgrounded is
    // otherwise invisible until the hourly poll above happens to land. Checking
    // on every resume means a fresh deploy shows up the next time the app is opened.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') registration.update()
    })
  },
})
