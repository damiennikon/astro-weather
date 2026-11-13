# Lightning detections

`GET /lightning?lat=…&lng=…` uses the existing subscription Worker's allowed origin. It returns the nearest Vaisala Xweather detection within 20 km and five minutes, or an explicit empty or unavailable result. The app uses the existing `VITE_SUBSCRIBE_WORKER_URL`.

Before enabling the live badge, obtain an Xweather API client with access to the [Lightning Flash endpoint](https://www.xweather.com/docs/weather-api/endpoints/lightning-flash). Set `XWEATHER_CLIENT_ID` and `XWEATHER_CLIENT_SECRET` as [secrets on the astro-subscribe Worker](https://developers.cloudflare.com/workers/configuration/secrets/). Deploy the Worker with its configured `LIGHTNING_RATE_LIMITER` binding, then deploy the frontend.
