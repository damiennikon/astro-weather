import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  root: 'src',
  publicDir: '../public',
  base: '/astro-weather/', // IMPORTANT: matches GitHub repo name (damiennikon/astro-weather)
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  plugins: [
    VitePWA({
      registerType: 'prompt', // Don't auto-update — show banner instead
      strategies: 'injectManifest',
      srcDir: '.',
      filename: 'sw.js',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
      },
      manifest: {
        name: 'Astro Weather',
        short_name: 'AstroWx',
        description: 'Astrophotography weather forecasting for dark sky planning',
        start_url: '/astro-weather/',
        display: 'standalone',
        background_color: '#0a0e14',
        theme_color: '#0a0e14',
        orientation: 'portrait-primary',
        categories: ['weather', 'photography', 'utilities'],
        screenshots: [
          { src: '/astro-weather/screenshots/narrow.png', sizes: '390x844', type: 'image/png', form_factor: 'narrow' },
          { src: '/astro-weather/screenshots/wide.png', sizes: '1280x720', type: 'image/png', form_factor: 'wide' },
        ],
        icons: [
          { src: '/astro-weather/icons/icon-72.png', sizes: '72x72', type: 'image/png' },
          { src: '/astro-weather/icons/icon-96.png', sizes: '96x96', type: 'image/png' },
          { src: '/astro-weather/icons/icon-128.png', sizes: '128x128', type: 'image/png' },
          { src: '/astro-weather/icons/icon-144.png', sizes: '144x144', type: 'image/png' },
          { src: '/astro-weather/icons/icon-152.png', sizes: '152x152', type: 'image/png' },
          { src: '/astro-weather/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: '/astro-weather/icons/icon-384.png', sizes: '384x384', type: 'image/png' },
          { src: '/astro-weather/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      devOptions: {
        enabled: true,
        type: 'module',
      },
    }),
  ],
})
