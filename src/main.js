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
  },
})
