import './style.css'
import { registerSW } from 'virtual:pwa-register'
import { App } from './app.js'

const app = new App()
app.init()

const updateSW = registerSW({
  onNeedRefresh() {
    app.showUpdateBanner(() => updateSW(true))
  },
})
