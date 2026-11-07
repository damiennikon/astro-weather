# AstroWeather verification worker

This worker is intentionally separate from `workers/scheduler`. It collects only
the fixed Stage 5 pilot sites and does not read user subscriptions or alter the
live forecast pipeline.

## Bindings required after approval

The example configuration requires:

- `VERIFICATION_DB`: a D1 database initialized with `schema.sql`.
- `VERIFICATION_ARCHIVE`: an R2 Standard bucket for original Open-Meteo payloads.
- `VERIFICATION_STATE`: a KV namespace for idempotency state and short-lived failure markers.
- `VERIFICATION_TRIGGER_SECRET`: a secret used for manual reports/triggers.

No resource identifiers are included in the repository. R2/D1/KV provisioning is
deliberately a separate, manually approved step.

The free-tier collector stores model layers, ensemble values, disagreement,
availability and confidence without re-running the astronomy scorer for every
reference site. That keeps the scheduled Worker lightweight. The existing scoring
module remains unchanged; production-compatible scoring diagnostics are available
as an explicit opt-in for local analysis, not enabled by the pilot Worker.

Each collection makes three Open-Meteo requests, six BOM requests, three R2
writes and D1 batches of up to 1,000 statements. D1 batching is intentional:
Cloudflare counts a batch call as one D1 query/subrequest, leaving room under the
Workers Free 50-subrequest limit. The 10 ms CPU limit still requires validation
with a real Cloudflare run; local tests cannot prove that budget.

## Retention

The pilot does not enable automated deletion. Forecast and observation records are
append-only, and `schema.sql` keeps derived verification metrics independent from
the raw archive. A later retention change must be explicit, observable, and tested
before it can delete anything.

The initial searchable and raw retention targets are 400 days, but the retention
module is dry-run only. The Worker does not delete records or R2 objects during the
pilot.

D1 Free storage is 500 MB per database (the separate 5 GB allowance is
account-wide). The default four-collection schedule is estimated at about
26,760 primary rows per day before indexes and derived verification metrics, so
the 30-day pilot must be checked against the database-size dashboard before any
longer run is approved.

## Usage monitoring

The `usage.js` guard compares measured or estimated usage with the current free-tier
limits. A warning is emitted at 80%; an over-limit result is a suspension signal,
not a reason to enable billing. Actual account values must be checked manually in
Cloudflare Dashboard under Workers & Pages > Metrics, D1 > Metrics, R2 > Overview,
and Workers KV > Metrics.

## Cloud verification

Cloud forecasts are archived, but satellite ingestion is intentionally not part of
this worker. BOM AWS observations verify surface variables only; layered cloud
verification remains a separate design and approval item.
