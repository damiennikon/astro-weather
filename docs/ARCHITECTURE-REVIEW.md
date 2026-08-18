# Astro Weather — Architecture & Data-Quality Review

**Date:** 2026-08-18 · **Scope:** code review only, no implementation · **Commit reviewed:** `d63bb35`

Reviewed: `src/` (live Vite tree), `workers/scheduler`, `workers/subscribe`, `plan.md`,
`.github/workflows/deploy.yml`, `vite.config.js`. No live infrastructure, dashboards, or
deployed endpoints were touched.

One limitation worth stating up front: outbound network egress from the review environment is
restricted, so I could not probe `geocoding-api.open-meteo.com`, `api.open-meteo.com`, or
WillyWeather to confirm live API behaviour. Findings that depend on an external API contract are
marked **[verify]** with the exact one-line check to run.

---

## Summary of severities

| # | Finding | Severity | Area |
|---|---------|----------|------|
| 1 | Location timezone is ignored when indexing forecast hours — silently wrong data | **Critical** | Data correctness |
| 2 | Scheduler fabricates the moon (30% of the score) and mislabels the night | **Critical** | Notifications |
| 3 | `Promise.all` with no `res.ok` check — total upstream failure renders as "0/100, Very Poor" | **High** | Resilience |
| 4 | Veto caps are floors as well as ceilings — adding cloud can *raise* the score | **High** | Scoring |
| 5 | WillyWeather cannot be dropped in where Open-Meteo sits — needs a proxy and breaks the blend | **High** | Data source |
| 6 | Push subscription location is frozen at subscribe time | **High** | Notifications |
| 7 | Spread penalty has a 16-point cliff at exactly 30% and discards the model weights | **Medium** | Ensemble |
| 8 | 50/30/20 has no empirical basis; dynamic weighting is not worth it yet | **Medium** | Ensemble |
| 9 | Location search: `countryCode=AU` + GeoNames coverage gap on dark-sky sites | **Medium** | Known bug |
| 10 | Scheduler will break at ~12 subscribers (subrequest limit) and 1000 (KV pagination) | **Medium** | Scheduling |
| 11 | Unauthenticated `/trigger` endpoint on the scheduler worker | **Medium** | Security |
| 12 | ~2,000 lines of dead duplicate source at repo root shadowing the live tree | **Medium** | Maintainability |
| 13 | Missing variables: AOD/transparency, seeing proxy, precipitation, visibility | **Medium** | Scoring |
| 14 | Bortle: feasible, but must not be a weighted score component | **Low** (design) | Feature |
| 15 | iOS A2HS prompt: feasible; the install page already exists but is never deployed | **Low** | Feature |
| 16 | No tests anywhere, on pure functions that are trivially testable | **Low** | Quality |

---

## 1. Location timezone is ignored when indexing forecast hours — **Critical**

`src/weatherWorker.js`

The API is requested in the *selected location's* timezone (`buildUrl` line 45, `timezone` comes
from the geocoding result via `src/app.js:426`), so `hourly.time` comes back as local-naive strings
for that location. But the lookup key is generated from the **browser's** clock:

```js
// src/weatherWorker.js:126
function meteoKey(date) {
  return `${date.getFullYear()}-...T${pad(date.getHours())}:00`   // browser-local
}
```

and the display window is likewise anchored to browser-local 17:00 (`buildNight`, line 191).

The dark window itself (`Astronomy.SearchAltitude`) is computed in absolute time and is correct.
So the code pairs a *correct* dark window with the *wrong hour's* weather. The lookup does not
fail — the key exists in the array — it just resolves to a different hour. There is no error, no
warning, and nothing in the UI that would reveal it.

Failure cases, all realistic for an Australian user base:

- Brisbane browser, Perth site → every cloud/humidity/wind value shifted **2 hours**.
- Sydney browser, Brisbane site, October–April → shifted **1 hour** (DST).
- Adelaide ↔ east coast → **30 minutes**, which rounds into a whole-hour bucket error.
- Any user planning a trip interstate — i.e. the app's core use case.

"Use My Location" is unaffected, because it stores the browser's own timezone
(`src/app.js:359`), which makes this hide well in local testing.

**Fix approach.** Stop round-tripping through local-naive strings. Request
`&timeformat=unixtime` (or `timezone=UTC`) and index by epoch seconds; derive the display window
from the location's timezone with `Intl.DateTimeFormat(..., { timeZone })` rather than
`Date.prototype.getHours()`. The same substitution fixes `buildNight`'s day offset, which
currently rolls over on the browser's midnight rather than the site's.

---

## 2. Scheduler fabricates the moon and mislabels the night — **Critical**

`workers/scheduler/index.js`

Three independent defects compound here, and all of them are invisible to the user receiving the
push.

**2a. The moon is hardcoded.**

```js
// line 225
const moonIllum = 0.3
const moonAlt   = 30
```

The moon is 30% of the scoring weight and the trigger for a hard veto. `astronomy-engine` is
already a declared dependency of this very worker (`workers/scheduler/package.json`) and is not
imported. The practical result: on a full-moon night the scheduler scores the sky as if the moon
were a 30% crescent, clears the `moonIllum > 0.8` veto, and pushes *"🌌 Clear skies ahead"* for a
night the app itself rates 24/100. The notification and the app disagree by design, which is
worse than no notification.

**2b. The night label is off by one, and each "night" is two half-nights spliced together.**

The cron is `0 22 * * *` (`wrangler.toml`), and Cloudflare crons are UTC — that is 08:00
Brisbane the following day. `dateStr` is derived from `new Date().toISOString()` (UTC), while the
forecast comes back in `Australia/Brisbane`. At fire time the UTC date is still the *previous*
Brisbane day, so:

- `dayOffset = 0` ("Tonight") matches **zero** hours and is always skipped.
- `dayOffset = 1` ("Tomorrow night") is actually **tonight**.
- Every notification is therefore labelled one day later than the night it describes.

Separately, the hour filter is `h >= 20 || h <= 5` **within a single calendar date** (line 170).
Hours 00:00–05:00 and 20:00–23:00 of the same date are not one night — they are the tail of the
previous night and the head of the next. The average blends them, and at 08:00 local the 00:00–05:00
half is already in the past.

**2c. Fixed 20:00–05:00 is not astronomical darkness.** In Hobart in January astronomical dark
starts near 22:30; in Cairns in June it starts near 19:00. The browser worker does this properly
with `SearchAltitude(-18°)`; the scheduler does not.

**Fix approach.** These are all the same root cause: the scheduler reimplements
`buildNight`/`buildHour` badly instead of sharing them. `src/scoring.js` is already shared across
both runtimes — extract the night-construction and astronomy logic the same way, so the push and
the UI cannot diverge. Pin the cron to a UTC time that maps to a stable local hour and derive
dates in the subscriber's timezone (which means storing it at subscribe time — see #6).

---

## 3. No `res.ok` check; total upstream failure renders as a confident bad forecast — **High**

`src/weatherWorker.js:56-62`

```js
const ecmwfPromise = fetch(buildUrl(...)).then((r) => r.json())
...
const [ecmwf, icon, ukmo] = await Promise.all([...])
```

Two separate problems.

**3a. No `Promise.allSettled`, so one model takes down all three.** The code immediately below is
written on the opposite assumption — `minCoverageEnd`'s comment says *"A model that failed to
return any data at all (e.g. a transient API error) is excluded rather than collapsing the whole
forecast to zero nights"*, and `blendCloud` correctly renormalises the weights when a model is
missing. That graceful-degradation path is **unreachable for a failed fetch**, because
`Promise.all` rejects first and the worker posts `FORECAST_ERROR`. Losing ICON — 20% of the
blend — currently costs the user the entire forecast.

**3b. No HTTP status check, so an error body is parsed as a forecast.** Open-Meteo returns
`200`-shaped JSON `{"error": true, "reason": "..."}` for parameter problems and rate limits.
`r.json()` parses it happily, `response.hourly` is `undefined`, and everything downstream reads
`null`. Then:

- `findCoverageEnd` returns `null` for that model;
- if *all three* fail this way, `minCoverageEnd` returns `null`, and `buildForecast:83` falls
  through to `nights = candidates` — **all 8 nights kept**;
- every hour has `cloud === null`, and `scoreHour` returns `{ score: 0, verdict: 'unavailable' }`;
- `nightAvg.score` averages those zeros in (`buildNight:225` — `average()` filters `null`, but
  these are `0`).

The user sees eight nights of **"0/100 — Very Poor"**. That is not a degraded forecast, it is a
confident wrong answer that would keep someone home on a clear night. Note this is exactly the
failure mode the `ecmwf_ifs04` deprecation comment at line 7 describes, so it has plausibly
already happened once.

The scheduler has the identical `res.ok` gap (`workers/scheduler/index.js:76`), where it manifests
as `reference.hourly.time` being empty → zero nights → **notifications silently stop forever**
with no log line.

**Fix approach.** `Promise.allSettled`; check `res.ok` **and** `!json.error` before accepting a
model; treat a model as absent rather than as all-null. Then make "insufficient data" a distinct
UI state — propagate `verdict: 'unavailable'` with a `null` score instead of `0`, exclude those
hours from `nightAvg` and `findOptimalWindow`, and require at least one model (ideally two) before
rendering a night at all. Worth surfacing which models are contributing, since the blend already
tracks it.

**Caching.** `src/sw.js:16` registers `StaleWhileRevalidate` on `api.open-meteo.com` with a 1-hour
expiry, which is the right primitive. But `ExpirationPlugin({ maxAgeSeconds: 3600 })` only bounds
*eviction* — under SWR the stale entry is still served, so a user offline for two days may get a
two-day-old forecast presented as current with no staleness indicator. There is no
`maxEntries`, so the cache grows one entry per (lat, lng, model) forever. And critically: the
`fetch` inside the Web Worker **is** intercepted by the SW, but the response is never inspected
for age, so the app cannot distinguish "cached" from "live". Recommend recording
`date.getTime()` per forecast and showing "as of HH:MM" whenever it exceeds ~90 minutes.

---

## 4. Veto caps are floors as well as ceilings — **High**

`src/scoring.js:4-11`

Each veto `return`s a **fixed** score, so it clamps from below as well as above. Verified by
executing the real `scoreHour`:

```
clear sky (0% cloud) + full moon up  →  24  "Very Poor"
60% cloud            + full moon up  →  35  "Poor"
95% cloud            + full moon up  →  20  "Very Poor"
```

**Adding 60% cloud to a full-moon night improves the score by 11 points and lifts it a whole
verdict band.** The cloud check runs first (line 5-6), so it pre-empts the moon veto and hands
back the more generous constant. This is a genuine ordering inversion, not just a rough edge.

The boundaries are also very sharp. Again from the real function:

| Input change | Score |
|---|---|
| cloud 50.0% → 50.1% (otherwise ideal) | **76 → 35** |
| moon illum 0.80 → 0.81 (clear sky) | **78 → 24** |
| moon altitude +0.5° → −0.5° (full moon) | **24 → 100** |

A 0.1% change in a blended, uncertain cloud value moves the verdict from "Good" to "Poor". Given
the forecast's own uncertainty is routinely ±20%, the cliff position is noise.

The moon-altitude case also shows the "low horizon buffer" at lines 32-35 — which exists precisely
to soften a moon near the horizon — is **dead code whenever `moonIllum > 0.8`**, because the veto
at line 9 returns before it. That is the exact case it was written for.

**Fix approach.** Keep vetoes as *ceilings only*: `score = Math.min(computedScore, cap)` rather
than `return cap`. Ordering then becomes monotone automatically, and a clear-but-moonlit night
correctly outranks a clouded-and-moonlit one. Replace the step functions with monotone continuous
curves (a logistic on cloud, a `moonIllum × f(altitude)` product on the moon) so small input
changes produce small output changes. That also removes the need for a separate moon veto — a
product term drives the score down on its own.

Two smaller notes in the same file:

- `findOptimalWindow` always prefers a 3-hour block and never falls back to a better 1-hour block,
  and it returns a "best window" even when every hour scores 5. It should return `null` below some
  usable threshold.
- The verdict thresholds (85/65/45/25) and the veto constants (35, 24, 20) are unrelated numbers;
  the vetoes land mid-band, which is why the inversion above crosses a band boundary.

---

## 5. WillyWeather cannot slot in where Open-Meteo sits — **High**

This is the finding most likely to change your plan, so it is worth being concrete about
*why* it is not a drop-in swap. Three blockers, in increasing order of severity:

**5a. The API key cannot live in the client.** The app is a static GitHub Pages site and all
forecast fetching happens in a browser Web Worker (`src/app.js:457`). A WillyWeather key is paid
and billed per request; shipping it in a JS bundle publishes it. `.env.example` and the build
already inline `VITE_*` vars into the bundle, so the existing pattern would leak it. **[verify]**
Separately, WillyWeather's API is not expected to send `Access-Control-Allow-Origin`, so a direct
browser fetch would fail CORS regardless — check with
`curl -I -H 'Origin: https://damiennikon.github.io' 'https://api.willyweather.com.au/v2/{key}/locations/search.json?query=test'`.

Either way the conclusion is the same: **WillyWeather forces a server-side proxy**. You already
run two Cloudflare Workers, so the marginal cost is low — add a third (or a route on the existing
one) that holds the key as a secret, fetches upstream, normalises to the app's internal hourly
shape, and caches aggressively (Cache API keyed on rounded lat/lng + hour) so you are not billed
per user per refresh.

**5b. It probably cannot feed the blend at all.** **[verify]** WillyWeather's forecast products
are precis-based — `precisCode`/`precis` ("Mostly clear"), min/max temperature, rainfall
probability, wind, UV, tides, sunrise/sunset, moon phases. What the scoring engine actually
consumes is `cloudcover_low`, `cloudcover_mid`, `cloudcover_high`, `relativehumidity_2m`,
`dewpoint_2m`, `windspeed_10m` — **hourly, numeric, and layered**. If there is no numeric
three-layer cloud fraction, then `combineCloudLayers` and `blendCloud` have nothing to work with,
and mapping a precis string onto a percentage throws away exactly the resolution the app exists to
provide. Confirm before committing budget:
`curl -s 'https://api.willyweather.com.au/v2/{key}/locations/{id}/weather.json?forecasts=weather&days=3' | jq '.forecasts.weather.days[0].entries[0]'`
and check for a numeric cloud field.

**5c. It is a single deterministic forecast, not an ensemble member.** This is the architectural
point. ECMWF/UKMO/ICON are three independent NWP models, and the whole value of the blend — the
spread penalty, the agree/mixed/disagree indicator — comes from their *disagreement*. WillyWeather
resells BOM output; it is one opinion. Adding it as a fourth weighted member is defensible;
replacing the ensemble with it is not, because you would lose the confidence signal entirely.

**Recommended shape.** Keep the ensemble on Open-Meteo. Introduce a `providers/` layer with one
adapter per source returning a normalised hourly record, so `weatherWorker.js` stops knowing about
Open-Meteo's URL shape. Then:

- If 5b resolves favourably (numeric cloud exists) → add WillyWeather as a fourth member at a
  modest weight, behind the proxy, with the spread penalty computed over four members.
- If it does not → use WillyWeather for what it is genuinely better at: **location search**
  (see #9 — its Australian gazetteer would fix that bug outright) and as a *cross-check* badge
  ("BOM says: Mostly Clear") rather than a scored input. That is a much cheaper integration and
  does not compromise the ensemble.

On the note in the dead root `app.js:851` — the reasoning that UKMO is a sound BOM substitute
because ACCESS is UM-derived is correct and worth keeping. It is currently only in the
undeployed copy, so users no longer see it.

---

## 6. Push subscription location is frozen at subscribe time — **High**

`src/notifications.js:36-47`, `src/app.js:433`

`requestAndSubscribe()` reads `astro-location` from localStorage and POSTs it once. `selectLocation()`
never re-POSTs. Worse, the early return at `notifications.js:28`:

```js
const existing = await reg.pushManager.getSubscription()
if (existing) return { ok: true, reason: 'already-subscribed' }
```

means even deliberately re-tapping the bell after moving will not update the stored coordinates.
Someone who subscribes in Brisbane and then sets their location to a dark site 200 km west keeps
receiving Brisbane forecasts indefinitely, with the dark site's name nowhere in the picture.

Also missing: the subscriber's **timezone** is never sent, which is what forces the scheduler's
hardcoded `Australia/Brisbane` in #2.

**Fix approach.** Make `selectLocation()` fire an idempotent `POST /subscribe` (upsert on the
hashed endpoint key, which the subscribe worker already does) whenever a subscription exists.
Include `timezone`. Remove the `already-subscribed` short-circuit, or keep it only for the
permission flow. Also handle `pushsubscriptionchange` in the service worker — browsers rotate
endpoints, and today that silently orphans the KV record until it 410s.

---

## 7. Spread penalty: a 16-point cliff at 30%, and it discards the weights — **Medium**

`src/weatherWorker.js:138-163`

```js
const spread = Math.max(...models) - Math.min(...models)
if (spread > 30) return Math.min(...models) + 0.7 * spread
return avg
```

Verified against the real function:

| Model values (E, U, I) | Spread | Result |
|---|---|---|
| 0, 0, 30 | 30 | **6.0** |
| 0, 0, 31 | 31 | **21.7** |
| 10, 10, 40 | 30 | **16.0** |
| 10, 10, 41 | 31 | **31.7** |

One percentage point of movement in the *lowest-weighted* model swings the blended cloud by ~16
points. Combined with the veto cliff in #4, that single point can move a night from "Good" to
"Poor".

Three further issues:

- **The weights are thrown away.** Above the threshold the result depends only on min and max.
  ECMWF at 0 / UKMO at 0 / ICON at 60 gives the same answer as ICON at 0 / UKMO at 0 / ECMWF at 60,
  even though the first is two strong models outvoting the weakest and the second is the reverse.
  The 50/30/20 weighting is silently disabled in exactly the situation where it matters most.
- **It compounds across layers.** The penalty is applied independently to low, mid, and high
  (lines 265-267) and the three penalised values are then combined multiplicatively by
  `combineCloudLayers`. Three 70th-percentile-pessimistic layers multiply into something well
  past pessimistic. With (0, 50, 100) on each layer the penalty yields 70 per layer, and combined
  coverage lands at ~97%.
- **The threshold is duplicated but not shared.** The agreement indicator (line 279) uses 15/30 on
  the *combined* cloud value while the penalty uses 30 on *per-layer* values, so the UI can show
  "agree" on an hour whose blend was penalised, and vice versa.

**Fix approach.** Make the penalty continuous and weight-aware: compute the weighted mean and the
weighted standard deviation, then `blended = mean + k · σ` with `k ≈ 0.5–0.8`. That is monotone,
has no cliff, respects the weights, and gives you a real per-hour uncertainty number you can drive
the agree/mixed/disagree badge from — one threshold constant instead of two disagreeing ones.
Apply it to the *combined* cloud value, or accept and document the compounding.

---

## 8. Is 50/30/20 defensible? Is dynamic weighting better? — **Medium**

**On 50/30/20:** the ordering is right, the numbers are arbitrary. ECMWF HRES leads global
deterministic verification scores, so first place is well supported. UKMO second for Australia is
a reasonable call for the reason given in the old copy (ACCESS is UM-derived, so UKMO is the
closest proxy to the BOM model you lost). ICON third is fair — it is a strong model but weaker
over the Southern Hemisphere, where it has less assimilated data. `plan.md:407-421` states the
weights but gives no verification basis, and there is no comment in the code either.

The important caveat: **skill rankings for total cloud cover do not match skill rankings for
500 hPa geopotential height**, which is what the headline ECMWF-leads-everything claim is
measured on. Cloud is a parameterised, near-surface quantity where the ordering is much closer
and much more regime-dependent. So 50/30/20 is a defensible prior, but it is a prior, and it
should be labelled as one in the code.

**On dynamic per-model, per-location weighting:** correct in principle, and I would not build it
yet. It needs a verification loop the app does not have — persisted forecasts, an observed-truth
source to score them against, and enough samples per location before the weights beat the prior.
Realistically that is months of accumulation per site, and with three members the achievable gain
over a fixed prior is small; published multi-model work generally finds the gap between optimal
static weights and adaptive weights is modest relative to the gap between one model and any blend.
You already captured most of the available benefit by blending at all.

**Cheaper intermediate steps, in order of value per unit of work:**

1. Fix the spread penalty (#7) so the weights actually apply. Highest value, lowest cost.
2. Log forecasts to KV against later observations. Cheap to add now, and it is the prerequisite
   for anything adaptive — without it you can never evaluate a weight change.
3. **Lead-time-dependent weighting** — a well-established, safe win. ECMWF's advantage grows with
   lead time; at 24 hours the models are close, at 7 days they are not. Ramping ECMWF from ~0.40
   at day 1 to ~0.60 at day 7 is defensible from published skill curves and needs no local data.
4. Only then, once (2) has a year of data, consider per-location tuning.

---

## 9. Location search bug — **Medium**

`src/app.js:666-679`

Commit `d63bb35` made the failures *visible* (status messages, timeout, sequence guard) but did
not address the underlying cause, which its own message identifies: *"real dark-site queries like
'Mount Nebo' return no geocoding matches"*. Two candidate root causes; they are not exclusive and
the fix is the same either way.

**9a. `countryCode=AU` — [verify].**

```js
const params = new URLSearchParams({
  name: query, count: 5, language: 'en', format: 'json', countryCode: 'AU',
})
```

This traces straight from `plan.md:1121-1131`, which specifies the parameter. Open-Meteo's
geocoding endpoint **silently ignores unrecognised query parameters** rather than returning 400.
So if `countryCode` is not a supported filter, every search is running unfiltered and worldwide,
and `count=5` fills with overseas matches — "Bathurst" would surface Bathurst, Canada and
Bathurst, Gambia, potentially pushing Bathurst NSW out of the top five entirely. That presents to
the user as "search is broken" even though the request succeeded.

One-line check:
`curl -s 'https://geocoding-api.open-meteo.com/v1/search?name=Bathurst&count=10&format=json&countryCode=AU' | jq '[.results[].country_code]'`
— if that returns anything other than all `"AU"`, the filter is being ignored.

**9b. GeoNames coverage.** Open-Meteo's geocoder is backed by the GeoNames populated-places
dataset. It indexes towns and suburbs; it does **not** index national parks, state forests,
lookouts, observatories, or dark-sky reserves. Every high-value destination for this app's users
— Warrumbungle, Mount Nebo, Cocoparra, Girraween — is missing by construction, not by bug.
Matching is also prefix-oriented, so "Mt Nebo" fails where "Mount Nebo" might succeed, and any
query containing a comma ("Bathurst, NSW") will not match.

**Fix approach.** Layered, in order:

1. Drop or verify `countryCode`; if unsupported, filter client-side on `country_code === 'AU'`
   and raise `count` to ~20 so the AU results survive the filter.
2. Normalise the query — strip a trailing state suffix after a comma, expand `Mt`→`Mount`,
   `Nth`→`North`, etc.
3. Add a **direct lat/lng entry** path. Astrophotographers routinely have exact coordinates for
   their sites and cannot search for them by name in any gazetteer. This is the smallest change
   with the largest real-world benefit, and it is not currently possible in the UI.
4. Add "save this site" so a found location can be pinned and renamed — the app already persists
   only one location under a single `astro-location` key.
5. If you go ahead with WillyWeather, its `search.json` is an Australian-specific gazetteer with
   far better rural coverage, and it would fold this fix into that migration.

Minor, same file: `escapeHtml` is applied to `r.name` and `r.admin1` (line 412) — good — but the
result list is rebuilt with `innerHTML` and re-bound on every keystroke, and `_searchResults` is
stored on the instance while indices are read from `data-index`. A response landing between render
and click could mis-map the selection. Storing the record on the element via a closure would be
sturdier.

---

## 10. Scheduler scaling and reliability — **Medium**

`workers/scheduler/index.js`

- **~12-subscriber ceiling.** The loop issues 3 Open-Meteo fetches per subscriber, serially, in
  one invocation. Cloudflare caps subrequests per invocation (50 on the free plan). At roughly 3
  fetches + 2 KV ops each, the run throws partway through and everyone after that point gets
  nothing. There is no dedupe for subscribers sharing coordinates and no cross-subscriber cache,
  even though most subscribers will cluster in a handful of locations.
- **KV pagination ignored.** `list({ prefix: 'sub:' })` returns at most 1000 keys;
  `list_complete` and `cursor` are never checked, so subscriber 1001 silently never hears from the
  app again.
- **One bad record kills the whole run.** `ctx.waitUntil(runScheduler(env))` has no `.catch()`,
  and the only `try` inside the loop wraps `sendNotification`. An unparseable KV value
  (`JSON.parse`, line 32) or a fetch rejection aborts every remaining subscriber. Nothing is
  logged.
- **Only 410 is treated as gone.** Push services also return **404** for a permanently
  deactivated endpoint (RFC 8030); those records accumulate forever. There is no retry or backoff
  on 429/5xx, so a transient push-service blip drops that night's notification silently.
- **`expirationTtl` only refreshes on send.** A subscriber whose skies are never good enough to
  trigger a push has their record silently expire after 365 days.
- **`moon: '?'`** (line 252) renders literally in the notification body as `Moon ?%`.

**Fix approach.** Group subscribers by rounded coordinates and fetch once per unique location;
paginate the KV listing; wrap each subscriber in its own `try/catch` with a `console.error`;
`ctx.waitUntil(runScheduler(env).catch(...))`; delete on 404 as well as 410. Once past a few dozen
subscribers, move from a single cron loop to a Queue with the cron as producer, so retries and
concurrency are handled for you.

---

## 11. Unauthenticated `/trigger` endpoint — **Medium**

`workers/scheduler/index.js:9-15`

```js
async fetch(request, env) {
  if (new URL(request.url).pathname === '/trigger') {
    await runScheduler(env)
    return new Response('Scheduler ran OK', { status: 200 })
  }
```

Anyone who learns the worker URL can force a full scheduler run on demand. The `lastNotified`
check limits push spam to one per subscriber per UTC day, but not the Open-Meteo fetches or the
KV reads — a loop against this endpoint burns your quota on both, at no cost to the caller.

**Fix approach.** Require a shared secret header compared with `crypto.subtle.timingSafeEqual`,
or remove the endpoint and trigger manually via `wrangler`.

Related, `workers/subscribe/index.js`: the CORS headers are correct for browsers but do not
constrain non-browser clients — `curl` can POST arbitrary subscription records. Worth validating
the `Origin` header server-side, bounding `lat`/`lng` to plausible ranges, capping
`locationName` length, and wrapping `await request.json()` (line 16) which currently throws an
unhandled 500 on a malformed body. Also, `/unsubscribe` authenticates on nothing but knowledge of
the endpoint URL. Both `compatibility_date` values are stale (2024-01-01, 2024-09-23).

---

## 12. ~2,000 lines of dead duplicate source at repo root — **Medium**

`vite.config.js` sets `root: 'src'`, so **only `src/` is built and deployed**. These root files
are dead:

`app.js` (879 lines), `weatherWorker.js` (472), `style.css` (606), `sw.js` (57), `index.html`,
`install.html` (240), `manifest.json`, `astronomy.browser.min.js`, `icon-192x192.png`,
`icon-512x512.png`, `telescope.png`

They are not stale by a little: normalised, root `weatherWorker.js` differs from `src/` by 843
lines. The concrete hazards, all of which have already bitten:

- The BOM/UKMO explanation users need (#5) lives only in root `app.js:851` and is not deployed.
- The iOS install guide with a `beforeinstallprompt` handler lives only in root `install.html`
  and is not deployed (#15).
- Root `manifest.json` has `"start_url": "."` and icon paths that would 404 under
  `/astro-weather/`; the live manifest is generated by VitePWA. Anything that links the root one
  breaks.
- Any grep, code search, or AI agent working in this repo hits the wrong file roughly half the
  time.

**Fix approach.** Delete them in one commit — git history retains them — after porting the BOM
explainer and the install guide into `src/`.

---

## 13. Missing scoring variables — **Medium**

The current five (cloud, moon, humidity, dew spread, wind) cover *whether you can see the sky*.
They say little about *how good the image will be*. In rough order of value per unit of work:

**13a. Aerosol optical depth / transparency — highest value, and nearly free.** Open-Meteo's Air
Quality API (`air-quality-api.open-meteo.com/v1/air-quality`) is a separate free endpoint exposing
CAMS-derived `aerosol_optical_depth`, `dust`, `pm10`, and `pm2_5`. This directly measures what
astrophotographers call transparency, and it is the variable most often missing from generic
weather-based astro tools. It matters acutely in Australia — bushfire smoke and dust haze produce
perfectly cloud-free nights that are photographically useless, and the current engine would score
those 95/100. Suggested weight ~10%, taken from cloud. One extra fetch, no new provider, no key.

**13b. A seeing proxy — you already have the data and are not using it.** `windspeed_250hPa` is
fetched (`SURFACE_VARS`/`UPPER_VARS`, line 6) and surfaced as `jetstream` on every hour object,
but `src/weatherWorker.js:303` marks it *"informational display only, not part of scoring"*. Jet
stream speed at 200–300 hPa is the standard proxy for upper-level turbulence and is what drives
the seeing forecasts on Meteoblue and Clear Outside. Add `windspeed_500hPa` and
`boundary_layer_height` (both available on the same endpoint) for a fuller picture: strong 250 hPa
flow plus a shallow boundary layer is the classic bad-seeing signature.

Note the reason given for excluding it — "UKMO doesn't provide it" — is not a blocker, because
`average()` already skips missing members and `scoreHour` already renormalises around `null`
components (lines 76-84). The machinery to handle a two-model variable is in place.

Seeing matters far more for planetary and lunar work than for wide-field Milky Way shots, so
consider weighting it by target type rather than applying it flat.

**13c. Precipitation and visibility — currently absent entirely.** There is no `precipitation`,
`rain`, or `visibility` variable anywhere. Low cloud cover usually implies no rain, but "usually"
is not a basis for leaving expensive gear outside overnight. `visibility` is also the most direct
available fog signal — better than inferring it from dew spread, which is what the 10% dew term is
doing indirectly. A precipitation-probability veto is a small, high-confidence addition.

**13d. Smaller ones.** Moon *angular distance from the target* matters more than illumination
alone (a 60% moon 120° away is workable; the same moon 20° away is not) — though that needs a
target concept the app does not yet have. Temperature trend through the night predicts dew
formation on optics better than a single-hour dew spread. And astronomical twilight is treated as
binary; the last 30 minutes before true dark are usable for brighter targets.

---

## 14. Bortle scale integration — **Low (feasibility: yes, with a design caveat)**

Feasible, and worth doing. But the obvious implementation is the wrong one.

**The caveat: Bortle must not be a weighted scoring component.** Light pollution is a *static
property of a site*, not an hourly variable. Adding it as, say, a 15% weighted term would apply
the same constant to all 14 hours of every night, which changes no ranking, no optimal window, and
no verdict ordering — it would just shift every number down and make scores incomparable across
sites. All cost, no signal.

**Where it actually belongs — two places:**

1. **As a modulator on the moon term.** This is the real interaction and it is genuinely
   non-obvious. At Bortle 8 the sky is already bright, so a 50% moon costs you comparatively
   little. At Bortle 2 that same moon is the dominant light source and ruins the night. So the
   moon penalty should scale *inversely* with sky brightness. This makes the score more accurate
   in a way nothing else in the engine can, and it needs no new weight — it reshapes the existing
   30%.
2. **As a separate site-quality badge and target-suitability gate**, shown alongside the score
   rather than folded into it. "Bortle 4 — Milky Way core visible" is directly actionable; a
   3-point score adjustment is not. It also lets you gate the existing Milky Way visibility
   feature (`mwVisible`, `mwRise`/`mwSet`), which currently reports the galactic core as visible
   from the middle of Sydney.

**Data sources, cheapest first:**

- **Manual, per-saved-location.** A Bortle picker on the location record. Zero infrastructure,
  works offline, and users of this kind of app generally know their sites' Bortle rating.
  Recommended as the first step, and it pairs naturally with the "save this site" feature
  suggested in #9.
- **VIIRS / World Atlas raster.** The Falchi 2016 World Atlas is the canonical dataset. There is
  no free official API; the usual routes are scraping `lightpollutionmap.info`'s undocumented
  endpoints (fragile, and check their terms) or bundling a downsampled raster. A coarse global
  raster at ~1 km, cropped to Australia and quantised to Bortle bands, is a few MB — deliverable
  as a static asset the service worker can precache, with a nearest-pixel lookup in the worker.
  That is the robust answer and needs no runtime dependency.
- Note that neither source captures the *local* horizon glow that actually limits a site, so treat
  any automatic value as a default the user can override.

---

## 15. iOS "Add to Home Screen" prompt — **Low (feasibility: yes, straightforward)**

Feasibility check only, as requested.

**Current state.** The PWA groundwork is in place: `apple-mobile-web-app-capable`,
`apple-touch-icon`, `apple-mobile-web-app-title`, and a startup image are all set in
`src/index.html`. There is **no A2HS prompt in the deployed app**. A polished install guide with a
`beforeinstallprompt` handler exists at root `install.html:198` — but it sits outside the Vite
root and is never built or deployed (#12).

**Feasibility: straightforward.** iOS Safari does not fire `beforeinstallprompt` and has no
programmatic install API, so the only option is the standard pattern: detect iOS Safari, detect
that the app is not already standalone, and show a dismissible instructional banner pointing at
Share → Add to Home Screen. Persist the dismissal in localStorage. A few dozen lines.

**Two gotchas worth flagging now**, because both already affect the existing notification gate:

- `window.navigator.standalone === true` (`src/app.js:225`, `src/notifications.js:16`) is the
  legacy iOS check. It still works for home-screen apps, but pair it with
  `matchMedia('(display-mode: standalone)')` for correctness and for non-iOS parity.
- **iPadOS reports a macOS user agent by default.** The `/iphone|ipad|ipod/i` test at
  `src/app.js:224` and `src/notifications.js:15` therefore returns `false` on most iPads. Today
  that means the iOS notification gate is skipped on iPad and the push subscribe attempt fails in
  a confusing way; it would equally mean the install banner never appears there. Detect via
  `navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)` as well.

This is genuinely worth doing given #6 and the notification flow — iOS requires the app to be
installed before push works at all, so the install prompt is a prerequisite for your notification
feature reaching any iPhone user.

---

## 16. No tests — **Low**

There is no test runner, no test directory, and no CI check beyond `npm run build`
(`.github/workflows/deploy.yml`). `src/scoring.js` is 109 lines of pure, exported, dependency-free
functions, and the blending helpers in `weatherWorker.js` are equally pure. Every numeric claim in
findings #4 and #7 above was produced by importing `scoreHour` directly and calling it — that took
one command.

A dozen table-driven cases over `scoreHour` and `blendCloud` would pin the veto ordering, the
cliff behaviour, and the null-renormalisation, and would have caught the scheduler's divergence
from the browser worker (#2) the moment it was introduced. Given the whole value proposition of
the app is numerical accuracy, this is the cheapest available insurance.

---

## Suggested order of work

Grouped by dependency rather than strictly by severity — several of these share a fix.

**First — silent wrong answers.** #1 (timezone) and #3 (`allSettled` + `res.ok` + `unavailable`
handling). These are the two places where the app confidently displays incorrect data, which is
worse for a planning tool than displaying an error. They also both live in `weatherWorker.js` and
touch the same code paths.

**Second — the notification path.** #2, #6, #11. As it stands, the scheduler pushes a score
computed from a fabricated moon, for the wrong night, to a possibly stale location, and can be
triggered by anyone. Extracting shared night-construction (#2) is the bulk of the work and #6
follows from it.

**Third — scoring integrity.** #4 (vetoes as ceilings, continuous curves) and #7 (weighted-σ
spread penalty). Together these remove every cliff in the pipeline. #16 belongs here — write the
tests as you change the maths, since that is the moment the table pays for itself.

**Fourth — decide the WillyWeather question.** Run the two `[verify]` checks in #5 before
committing to a paid tier. The answer determines whether it becomes a fourth ensemble member or
a search provider plus cross-check badge, and those are very different amounts of work.

**Then, as capacity allows.** #9 (search, with lat/lng entry as the quick win), #12 (delete the
dead tree — do this before any large refactor, so you are not editing the wrong file), #13a (AOD,
the best accuracy-per-hour available), #13b (wire up the jet stream you already fetch), #10, #14,
#15.
