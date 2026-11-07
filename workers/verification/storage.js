import { VERIFICATION_CALCULATION_VERSION } from './config.js'
import { buildVerificationRows, summarizeVerification } from './metrics.js'

function json(value) {
  return JSON.stringify(value ?? null)
}

async function inChunks(items, size, callback) {
  for (let index = 0; index < items.length; index += size) {
    await callback(items.slice(index, index + size))
  }
}

// D1 counts each db.batch() call as one query/subrequest. The Free plan allows
// 50 D1 queries per Worker invocation, so keep batches large enough to leave
// room for the external fetches, R2 writes, KV state and summary queries while
// staying below the documented 2,000-statement batch example.
const D1_BATCH_STATEMENT_LIMIT = 1_000

function requireBinding(env, name) {
  if (!env?.[name]) throw new Error(`Missing Cloudflare binding: ${name}`)
  return env[name]
}

export function createCloudflareStore(env) {
  const db = requireBinding(env, 'VERIFICATION_DB')
  const archive = requireBinding(env, 'VERIFICATION_ARCHIVE')

  async function batch(statements) {
    if (statements.length === 0) return
    await inChunks(statements, D1_BATCH_STATEMENT_LIMIT, (chunk) => db.batch(chunk))
  }

  return {
    async persistCycle({ forecastResult, observationResult, now = new Date() }) {
      const { run, snapshots, forecastHours, ensembleHours, baselineHours = [], rawPayloads } = forecastResult
      const allEnsembles = [...ensembleHours, ...baselineHours]
      const observations = observationResult?.observations ?? []

      for (const raw of rawPayloads) {
        await archive.put(raw.objectKey, JSON.stringify(raw.payload), {
          httpMetadata: { contentType: 'application/json' },
        })
      }

      await batch([
        db.prepare(`INSERT OR IGNORE INTO verification_runs
          (run_id, scheduled_at, started_at, completed_at, status, site_count, model_count, horizon_days, scoring_diagnostics, failures_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(run.runId, run.scheduledAt, run.startedAt, run.completedAt, run.status, run.siteCount, run.modelCount, run.horizonDays, run.scoringDiagnostics, json(run.failures)),
        ...snapshots.map((snapshot) => db.prepare(`INSERT OR IGNORE INTO forecast_snapshots
          (snapshot_id, collection_run_id, site_id, provider, model, model_id, model_run_at, retrieved_at, timezone,
           latitude, longitude, elevation_m, grid_latitude, grid_longitude, grid_elevation_m, availability, completeness,
           missing_fields_json, raw_object_key, schema_version, calculation_version)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(snapshot.snapshotId, snapshot.collectionRunId, snapshot.siteId, snapshot.provider, snapshot.model, snapshot.modelId,
            snapshot.modelRunAt, snapshot.retrievedAt, snapshot.timezone, snapshot.latitude, snapshot.longitude, snapshot.elevationM,
            snapshot.gridLatitude, snapshot.gridLongitude, snapshot.gridElevationM, snapshot.availability, snapshot.completeness,
            json(snapshot.missingFields), snapshot.rawObjectKey, snapshot.schemaVersion, snapshot.calculationVersion)),
      ])

      await batch(forecastHours.map((hour) => db.prepare(`INSERT OR IGNORE INTO forecast_hours
        (snapshot_id, site_id, model, valid_at, lead_minutes, retrieval_lead_minutes, cloud_cover_low, cloud_cover_mid,
         cloud_cover_high, temperature_2m, relative_humidity_2m, dew_point_2m, wind_speed_10m)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(hour.snapshotId, hour.siteId, hour.model, hour.validAt, hour.leadMinutes, hour.retrievalLeadMinutes,
          hour.cloud_cover_low, hour.cloud_cover_mid, hour.cloud_cover_high, hour.temperature_2m, hour.relative_humidity_2m,
          hour.dew_point_2m, hour.wind_speed_10m)))

      await batch(allEnsembles.map((hour) => db.prepare(`INSERT OR IGNORE INTO ensemble_hours
        (collection_run_id, site_id, ensemble_type, valid_at, retrieval_lead_minutes, cloud_low, cloud_mid, cloud_high, cloud_total,
         temperature_2m, relative_humidity_2m, dew_point_2m, wind_speed_10m, model_cloud_totals_json,
         model_availability_json, weight_coverage, disagreement, agreement, confidence, score, verdict,
         score_components_json, missing_data_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(run.runId, hour.siteId, hour.model, hour.validAt, hour.retrievalLeadMinutes, hour.cloud_low, hour.cloud_mid, hour.cloud_high,
          hour.cloud_total, hour.temperature_2m, hour.relative_humidity_2m, hour.dew_point_2m, hour.wind_speed_10m,
          json(hour.modelCloudTotals), json(hour.modelAvailability), hour.weightCoverage, hour.disagreement, hour.agreement,
          hour.confidence, hour.score, hour.verdict, json(hour.scoreComponents), json(hour.missingData))))

      await batch(observations.map((observation) => db.prepare(`INSERT OR IGNORE INTO observations
        (observation_id, source, site_id, station_id, station_name, observed_at, retrieved_at, temperature_c,
         relative_humidity_pct, dew_point_c, wind_speed_kmh, rainfall_since_9am_mm, quality_json, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(observation.observationId, observation.source, observation.siteId, observation.stationId, observation.stationName,
          observation.observedAt, observation.retrievedAt, observation.temperature_c, observation.relative_humidity_pct,
          observation.dew_point_c, observation.wind_speed_kmh, observation.rainfall_since_9am_mm, json(observation.quality), json(observation.raw))))

      const verificationRows = buildVerificationRows({ forecasts: [...forecastHours, ...allEnsembles], observations })
      const metrics = summarizeVerification(verificationRows)
      const calculatedAt = new Date(now).toISOString()
      await batch(metrics.map((metric) => {
        const metricId = [metric.model, metric.siteId, metric.variable, metric.leadBasis, metric.leadBand, metric.hourOfDay, metric.season, VERIFICATION_CALCULATION_VERSION].join(':')
        return db.prepare(`INSERT OR REPLACE INTO verification_metrics
          (metric_id, model, site_id, classification, variable, lead_basis, lead_band, hour_of_day, season, observation_count,
           sample_count, mae, rmse, mean_bias, median_absolute_error, calculation_version, calculated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(metricId, metric.model, metric.siteId, metric.classification, metric.variable, metric.leadBasis, metric.leadBand, metric.hourOfDay,
            metric.season, metric.observationCount, metric.sampleCount, metric.mae, metric.rmse, metric.meanBias,
            metric.medianAbsoluteError, VERIFICATION_CALCULATION_VERSION, calculatedAt)
      }))

      return { run, observationsStored: observations.length, verificationRows: verificationRows.length, metricsStored: metrics.length }
    },

    async report(limit = 500) {
      const safeLimit = Math.min(2000, Math.max(1, Number(limit) || 500))
      const [runs, metrics] = await Promise.all([
        db.prepare('SELECT * FROM verification_runs ORDER BY scheduled_at DESC LIMIT ?').bind(safeLimit).all(),
        db.prepare('SELECT * FROM verification_metrics ORDER BY calculated_at DESC LIMIT ?').bind(safeLimit).all(),
      ])
      return { runs: runs.results ?? [], metrics: metrics.results ?? [] }
    },

    async usage() {
      const [snapshots, hours, observations] = await Promise.all([
        db.prepare('SELECT COUNT(*) AS count FROM forecast_snapshots').first(),
        db.prepare('SELECT COUNT(*) AS count FROM forecast_hours').first(),
        db.prepare('SELECT COUNT(*) AS count FROM observations').first(),
      ])
      return {
        forecastSnapshots: Number(snapshots?.count ?? 0),
        forecastHours: Number(hours?.count ?? 0),
        observations: Number(observations?.count ?? 0),
        rawArchiveSize: 'not available from D1; inspect R2 Overview manually',
      }
    },
  }
}

export function createMemoryStore() {
  const cycles = []
  return {
    cycles,
    async persistCycle(input) {
      cycles.push(input)
      return {
        run: input.forecastResult.run,
        observationsStored: input.observationResult?.observations?.length ?? 0,
        verificationRows: buildVerificationRows({
          forecasts: [...input.forecastResult.forecastHours, ...input.forecastResult.ensembleHours, ...(input.forecastResult.baselineHours ?? [])],
          observations: input.observationResult?.observations ?? [],
        }).length,
        metricsStored: summarizeVerification(buildVerificationRows({
          forecasts: [...input.forecastResult.forecastHours, ...input.forecastResult.ensembleHours, ...(input.forecastResult.baselineHours ?? [])],
          observations: input.observationResult?.observations ?? [],
        })).length,
      }
    },
  }
}
